import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { sessionMetadataPath } from '../src/config.js'
import { writePendingHookContext } from '../src/hooks-bridge.js'
import { prepareWorktree } from '../src/worker-git.js'
import { registryForDir } from '../src/worker-registry.js'
import { seedRegistryWorker } from './registry-fixture.js'

const roots: string[] = []
const run = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-mcp-git-dirs-')))
  roots.push(root)
  run(root, 'init', '-q')
  run(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'base')
  const worker = path.join(root, '.room', 'workers', 'one')
  fs.mkdirSync(path.dirname(worker), { recursive: true })
  run(root, 'worktree', 'add', '-qb', 'room/one', worker)
  return { root, worker }
}

it('session and hook state use private gitdirs and preserve the direct .git fallback', () => {
  const { root, worker } = repo()
  for (const dir of [root, worker]) {
    const privateDir = run(dir, 'rev-parse', '--absolute-git-dir')
    expect(sessionMetadataPath(dir)).toBe(path.join(privateDir, 'room-session.json'))
    writePendingHookContext(dir, 'pendingNotice', 'hello')
    expect(JSON.parse(fs.readFileSync(path.join(privateDir, 'room-state.json'), 'utf8')).pendingNotice).toBe('hello')
    const subdir = path.join(dir, 'subdir')
    fs.mkdirSync(subdir)
    expect(sessionMetadataPath(subdir)).toBe(path.join(subdir, '.git', 'room-session.json'))
  }
  const missing = path.join(root, 'missing')
  expect(sessionMetadataPath(missing)).toBe(path.join(missing, '.git', 'room-session.json'))
  expect(sessionMetadataPath(root)).not.toBe(sessionMetadataPath(worker))
})

it('does not write hook state into a checkout when a gitfile has an empty gitdir target', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-empty-gitdir-')))
  roots.push(dir)
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir:  \n')
  expect(sessionMetadataPath(dir)).toBe(path.join(dir, '.git', 'room-session.json'))
  writePendingHookContext(dir, 'pendingNotice', 'hello')
  expect(fs.existsSync(path.join(dir, 'room-state.json'))).toBe(false)
})

it('worker stop state lives in the common gitdir across worktrees and is keyed by worker id', async () => {
  const { root, worker } = repo()
  const { registry, record } = await seedRegistryWorker(root, 'one')
  await registry.beginStop(record.id, 'lead-session-ended')
  expect((await registryForDir(worker)).read(record.id)?.stop).toMatchObject({ reason: 'lead-session-ended', run: 1 })
  expect((await registryForDir(worker)).read('w_absent')).toBeUndefined()
})

it('a prepared worker worktree cannot be silently reused by a later launch', async () => {
  const { root } = repo()
  const prepared = await prepareWorktree(root, 'two', 'lead')
  await expect(prepareWorktree(root, 'two', 'lead')).rejects.toThrow(/unmanaged/)
  expect(prepared.dir).toBe(path.join(root, '.room', 'workers', 'two'))
})
