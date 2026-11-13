import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { linkWorkspaceDeps } from '../src/worker-deps.js'
import * as workerGit from '../src/worker-git.js'
import { registryForDir } from '../src/worker-registry.js'
import { retainedWorkerLines } from '../src/worker-retained.js'
import { workspaceRepo } from './fixtures/workspace-repo.js'
import { scratchRepos, setupLead } from './workers-fixture.js'

it('r3: directory rollback must not adopt a pre-existing outside directory through a replaced parent', async () => {
  const { repo, worktree } = workspaceRepo()
  scratchRepos.push(repo)
  const worker = worktree(), modules = path.join(worker, 'node_modules')
  const outside = path.join(repo, '.room/pre-existing-install'), precious = path.join(outside, '.bin')
  fs.mkdirSync(precious, { recursive: true })
  const before = fs.statSync(precious, { bigint: true })
  const mkdir = fs.mkdirSync, readdir = fs.readdirSync
  let replaced = false, failed = false
  const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation((...args: Parameters<typeof fs.mkdirSync>) => {
    const value = mkdir(...args)
    if (String(args[0]) === path.join(modules, '.bin')) {
      fs.renameSync(modules, modules + '-original')
      fs.symlinkSync(outside, modules, process.platform === 'win32' ? 'junction' : 'dir')
      replaced = true
    }
    return value
  })
  const readSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((...args: Parameters<typeof fs.readdirSync>) => {
    if (replaced && String(args[0]) === path.join(repo, 'node_modules/.bin')) {
      failed = true
      throw new Error('injected source read failure before any bin entry is linked')
    }
    return readdir(...args)
  })
  try {
    const result = await linkWorkspaceDeps(repo, worker)
    expect(replaced).toBe(true)
    expect(failed).toBe(true)
    expect(result.linked).toBe(false)
    expect(fs.existsSync(precious), result.reason).toBe(true)
    expect(fs.statSync(precious, { bigint: true }).ino).toBe(before.ino)
    expect(fs.readdirSync(precious)).toEqual([])
  } finally { mkdirSpy.mockRestore(); readSpy.mockRestore() }
})

it('r3: repeated failed dependency setups report stable paths, discard, and permit immediate tag reuse', async () => {
  const actual = await vi.importActual<typeof workerGit>('../src/worker-git.js')
  const loaded = await import('../src/worker-git.js')
  if (vi.isMockFunction(loaded.cleanupWorker)) loaded.cleanupWorker.mockImplementation(actual.cleanupWorker)
  if (vi.isMockFunction(loaded.ignoredWorkerArtifacts)) loaded.ignoredWorkerArtifacts.mockImplementation(actual.ignoredWorkerArtifacts)
  if (vi.isMockFunction(loaded.saveDiscardRecovery)) loaded.saveDiscardRecovery.mockImplementation(actual.saveDiscardRecovery)
  const { repo, head, git } = workspaceRepo()
  scratchRepos.push(repo)
  const t = setupLead(repo, head), registry = await registryForDir(repo), tag = 'repeat-r3'
  const root = path.join(repo, '.room/workers', tag), modules = path.join(root, 'node_modules')
  const symlink = fs.symlinkSync
  let priorMetadata: string[] | undefined
  for (let cycle = 0; cycle < 3; cycle++) {
    let injected = false
    const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation((...args: Parameters<typeof fs.symlinkSync>) => {
      if (String(args[1]) === path.join(modules, '@fx/b')) {
        injected = true
        throw new Error('repeated injected dependency failure')
      }
      return symlink(...args)
    })
    let reply: string
    try { reply = await t.leadTools.call('room_spawn', { tag, task: 'repeat failure', carry: false }) }
    finally { spy.mockRestore() }
    expect(injected, reply).toBe(true)
    expect(reply).toContain('spawned ' + tag)
    expect(reply).toContain(modules)
    expect(reply).toContain('retained dependency output')
    expect(retainedWorkerLines(registry.commonDir).join('\n')).toContain(modules)
    const metadata = fs.readdirSync(path.join(registry.commonDir, 'room/registry/retained')).sort()
    if (priorMetadata) expect(metadata).toEqual(priorMetadata)
    priorMetadata = metadata
    const record = (await registry.reserved(tag))!
    t.exits[cycle](0)
    await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
    const discarded = await t.leadTools.call('room_collect', { tag, discard: true, force: true })
    expect(discarded).toContain('discarded ' + tag)
    expect(fs.existsSync(root), discarded).toBe(false)
    expect(git('branch', '--list', 'room/' + tag)).toBe('')
    expect(retainedWorkerLines(registry.commonDir)).toEqual([])
  }
})
