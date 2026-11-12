import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { linkWorkspaceDeps } from '../src/worker-deps.js'
import { retainedWorkerLines } from '../src/worker-retained.js'
import { workspaceRepo, requireB } from './fixtures/workspace-repo.js'

const repos: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const repo of repos.splice(0)) fs.rmSync(repo, { recursive: true, force: true }) })
function fixture() { const value = workspaceRepo(); repos.push(value.repo); return value }

it('r4: existing package links must be compared with filesystem dot-dot semantics', async () => {
  const { repo, worktree } = fixture(), worker = worktree()
  fs.mkdirSync(path.join(repo, 'alias-child'))
  fs.symlinkSync(path.join(repo, 'alias-child'), path.join(worker, 'alias'))
  fs.writeFileSync(path.join(repo, 'packages/a/cli.sh'), "#!/bin/sh\nprintf 'lead-a'\n", { mode: 0o755 })
  fs.writeFileSync(path.join(worker, 'packages/a/cli.sh'), "#!/bin/sh\nprintf 'worker-a'\n", { mode: 0o755 })
  fs.symlinkSync('../@fx/a/cli.sh', path.join(repo, 'node_modules/.bin/fx-a'))
  const fresh = worktree('fresh')
  fs.writeFileSync(path.join(fresh, 'packages/a/cli.sh'), "#!/bin/sh\nprintf 'worker-a'\n", { mode: 0o755 })
  expect(await linkWorkspaceDeps(repo, fresh)).toMatchObject({ linked: true })
  expect(execFileSync(path.join(fresh, 'node_modules/.bin/fx-a')).toString()).toBe('worker-a')
  const target = path.join(worker, 'node_modules/@fx/a')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.symlinkSync('../../alias/../packages/a', target)
  // This link really loads the lead. Lexical path.resolve hides the alias traversal.
  expect(fs.realpathSync.native(target)).toBe(path.join(repo, 'packages/a'))
  expect(fs.readFileSync(path.join(target, 'index.js'), 'utf8')).toBe("module.exports = 'lead-a'\n")
  expect(path.resolve(path.dirname(target), fs.readlinkSync(target))).toBe(path.join(worker, 'packages/a'))
  const result = await linkWorkspaceDeps(repo, worker)
  const executed = result.linked ? execFileSync(path.join(worker, 'node_modules/.bin/fx-a')).toString() : undefined
  expect(result.linked, JSON.stringify({ result, executed })).toBe(false)
  expect(result.reason).toContain(path.join(worker, 'node_modules'))
  expect(fs.readlinkSync(target)).toBe('../../alias/../packages/a')
})

it('r4: pre-existing foreign partial install behind the worker root must not be extended', async () => {
  const { repo, worktree } = fixture(), worker = worktree(), foreign = worktree('foreign')
  fs.mkdirSync(path.join(foreign, 'node_modules/.bin'), { recursive: true })
  fs.renameSync(worker, worker + '-original')
  fs.symlinkSync(foreign, worker, process.platform === 'win32' ? 'junction' : 'dir')
  // All replacement is complete before setup; no filesystem hook or concurrent swap.
  const result = await linkWorkspaceDeps(repo, worker)
  expect(result.linked).toBe(false)
  expect(fs.readdirSync(path.join(foreign, 'node_modules/.bin')), JSON.stringify(result)).toEqual([])
})

it('r4: retry refuses partial output, and explicit fixture cleanup permits fresh setup to clear evidence', async () => {
  const { repo, worktree } = fixture(), worker = worktree(), common = path.join(repo, '.git')
  const symlink = fs.symlinkSync, target = path.join(worker, 'node_modules/@fx/b')
  let injected = false
  const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation((...args: Parameters<typeof fs.symlinkSync>) => {
    if (String(args[1]) === target) { injected = true; throw new Error('injected incomplete setup') }
    return symlink(...args)
  })
  const first = await linkWorkspaceDeps(repo, worker)
  spy.mockRestore()
  expect(injected).toBe(true)
  expect(first.linked).toBe(false)
  expect(retainedWorkerLines(common).length).toBeGreaterThan(0)
  const metadata = fs.readdirSync(path.join(common, 'room/registry/retained')).sort()
  const a = path.join(worker, 'node_modules/@fx/a'), inode = fs.lstatSync(a).ino
  const retry = await linkWorkspaceDeps(repo, worker)
  expect(retry.linked).toBe(false)
  expect(retry.reason).toContain('node_modules already exists in the worktree')
  expect(fs.lstatSync(a).ino).toBe(inode)
  expect(fs.existsSync(target)).toBe(false)
  expect(fs.readdirSync(path.join(common, 'room/registry/retained')).sort()).toEqual(metadata)
  expect(retainedWorkerLines(common).length).toBeGreaterThan(0)
  // Only the fixture explicitly deletes its own partial output; setup never does.
  fs.rmSync(path.join(worker, 'node_modules'), { recursive: true })
  expect(await linkWorkspaceDeps(repo, worker)).toMatchObject({ linked: true })
  expect(requireB(worker)).toBe('worker-a:third')
  expect(retainedWorkerLines(common)).toEqual([])
  expect(fs.readdirSync(path.join(common, 'room/registry/retained'))).toEqual([])
})
