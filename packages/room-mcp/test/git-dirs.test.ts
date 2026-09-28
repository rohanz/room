import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { sessionDirectory } from '../src/session.js'
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

it('a host session\'s directory is one per clone, in the common gitdir, for the hooks and the MCP alike', async () => {
  const { root, worker } = repo()
  const { sessionDir } = await import('../../../plugins/room/hooks/common.mjs')
  const common = path.resolve(root, run(root, 'rev-parse', '--git-common-dir'))
  for (const dir of [root, worker]) expect(sessionDir(dir, 's1')).toBe(sessionDirectory(common, 's1'))
  expect(sessionDir(root, 's1')).not.toBe(sessionDir(root, 's2'))
})

it('does not write hook state into a checkout when a gitfile has an empty gitdir target', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-empty-gitdir-')))
  roots.push(dir)
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir:  \n')
  const { sessionDir, writeJsonAtomic } = await import('../../../plugins/room/hooks/common.mjs')
  writeJsonAtomic(path.join(sessionDir(dir, 's1'), 'state.json'), { hello: true })
  expect(fs.readdirSync(dir)).toEqual(['.git'])
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
