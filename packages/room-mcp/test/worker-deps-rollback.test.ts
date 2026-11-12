import fs from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import * as workerGit from '../src/worker-git.js'
import { registryForDir } from '../src/worker-registry.js'
import { workspaceRepo } from './fixtures/workspace-repo.js'
import { scratchRepos, setupLead } from './workers-fixture.js'

it.each(['local-replacement', 'foreign-parent'] as const)('reports retained %s dependency output and permits real discard and tag reuse', async mode => {
  const actual = await vi.importActual<typeof workerGit>('../src/worker-git.js')
  const loaded = await import('../src/worker-git.js')
  if (vi.isMockFunction(loaded.cleanupWorker)) loaded.cleanupWorker.mockImplementation(actual.cleanupWorker)
  if (vi.isMockFunction(loaded.ignoredWorkerArtifacts)) loaded.ignoredWorkerArtifacts.mockImplementation(actual.ignoredWorkerArtifacts)
  if (vi.isMockFunction(loaded.saveDiscardPatch)) loaded.saveDiscardPatch.mockImplementation(actual.saveDiscardPatch)
  const { repo, head } = workspaceRepo(), tag = 'retained-deps'
  scratchRepos.push(repo)
  fs.writeFileSync(path.join(repo, 'node_modules/.bin/shim.cmd'), 'dependency shim')
  const t = setupLead(repo, head), root = path.join(repo, '.room/workers', tag)
  const outside = path.join(repo, '.room/user-bin'), precious = path.join(outside, 'shim.cmd')
  fs.mkdirSync(outside, { recursive: true }); fs.writeFileSync(precious, 'pre-existing outside bytes')
  const target = path.join(root, 'node_modules/.bin/shim.cmd'), link = fs.symlinkSync, copy = fs.copyFileSync
  let failed = false, replaced = false
  const copySpy = vi.spyOn(fs, 'copyFileSync').mockImplementation((...args: Parameters<typeof fs.copyFileSync>) => {
    copy(...args)
    if (String(args[1]) !== target) return
    if (mode === 'local-replacement') {
      fs.unlinkSync(target); fs.writeFileSync(target, 'replacement shim bytes')
    } else {
      fs.renameSync(path.dirname(target), path.dirname(target) + '-original')
      fs.symlinkSync(outside, path.dirname(target), process.platform === 'win32' ? 'junction' : 'dir')
    }
    replaced = true
  })
  const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation((...args: Parameters<typeof fs.symlinkSync>) => {
    if (String(args[1]) === path.join(root, 'node_modules/@fx/b')) {
      failed = true
      throw new Error('dependency setup failed after creating shims')
    }
    return link(...args)
  })
  let spawn: string
  try { spawn = await t.leadTools.call('room_spawn', { tag, task: 'dependency failure', carry: false }) }
  finally { spy.mockRestore(); copySpy.mockRestore() }
  expect(failed, spawn).toBe(true)
  expect(replaced, spawn).toBe(true)
  expect(spawn).toContain('spawned ' + tag)
  expect(spawn).toContain(path.join(root, 'node_modules/.bin'))
  expect(fs.readFileSync(target, 'utf8')).toBe(mode === 'local-replacement' ? 'replacement shim bytes' : 'pre-existing outside bytes')
  expect(fs.readFileSync(precious, 'utf8')).toBe('pre-existing outside bytes')
  const registry = await registryForDir(repo), record = (await registry.reserved(tag))!
  t.exits[0](0)
  await vi.waitFor(async () => expect((await registry.status(record.id))?.status).toBe('done'))
  const discarded = await t.leadTools.call('room_collect', { tag, discard: true, force: true })
  expect(discarded).toContain('discarded ' + tag)
  expect(fs.existsSync(root), discarded).toBe(false)
  expect(fs.readFileSync(precious, 'utf8')).toBe('pre-existing outside bytes')
  const reused = await t.leadTools.call('room_spawn', { tag, task: 'reuse after discard', carry: false })
  expect(reused).toContain('spawned ' + tag)
  expect(reused).not.toContain('error:')
  expect(fs.readFileSync(precious, 'utf8')).toBe('pre-existing outside bytes')
})
