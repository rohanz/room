import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { git, withGitWorktreeOperation } from '../src/git.js'
import { worktreeGitDirFromDotGit } from '../src/git-dirs.js'
import { boundedGitSync } from '../src/baseline.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-worktree-queue-')), repo = path.join(root, 'repo')
  roots.push(root); fs.mkdirSync(repo)
  const run = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
  run('init', '-q', '-b', 'main'); run('config', 'user.name', 'test'); run('config', 'user.email', 'test@example.invalid')
  fs.writeFileSync(path.join(repo, 'tracked'), 'base\n'); run('add', '.'); run('commit', '-qm', 'base')
  return { repo, child: path.join(root, 'child') }
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }

it('does not let a worktree listing observe partially published commondir metadata', async () => {
  const { repo, child } = fixture()
  await git(repo, ['worktree', 'add', '-q', '--detach', child, 'HEAD'])
  const commonFile = path.join(worktreeGitDirFromDotGit(child), 'commondir'), original = fs.readFileSync(commonFile)
  const entered = gate(), finish = gate()
  const writer = withGitWorktreeOperation(repo, async () => {
    fs.writeFileSync(commonFile, ''); entered.release()
    try { await finish.promise } finally { fs.writeFileSync(commonFile, original) }
  })
  await entered.promise
  let listed = false
  const reader = git(repo, ['worktree', 'list', '--porcelain', '-z']).then(output => { listed = true; return output })
  try { await setImmediate(); expect(listed).toBe(false) }
  finally { finish.release() }
  await writer
  expect(await reader).toContain(child)
})

it('uses the same queue for linked worktrees and the common Git directory', async () => {
  const { repo, child } = fixture()
  await git(repo, ['worktree', 'add', '-q', '--detach', child, 'HEAD'])
  const entered = gate(), finish = gate()
  const first = withGitWorktreeOperation(path.join(repo, '.git'), async () => { entered.release(); await finish.promise })
  await entered.promise
  let ran = false
  const second = withGitWorktreeOperation(child, () => { ran = true })
  try { await setImmediate(); expect(ran).toBe(false) } finally { finish.release() }
  await Promise.all([first, second]); expect(ran).toBe(true)
})

it('allows another repository and nested owned operations without blocking', async () => {
  const a = fixture(), b = fixture(), entered = gate(), finish = gate()
  const first = withGitWorktreeOperation(a.repo, async () => { entered.release(); await finish.promise })
  await entered.promise
  try {
    expect(await git(b.repo, ['worktree', 'list', '--porcelain'])).toContain(b.repo)
  } finally { finish.release() }
  await first
  await withGitWorktreeOperation(a.repo, async () => {
    expect(await git(a.repo, ['worktree', 'list', '--porcelain'])).toContain(a.repo)
    expect(boundedGitSync(a.repo, ['worktree', 'list', '--porcelain']).toString()).toContain(a.repo)
  })
  expect(() => boundedGitSync(a.repo, ['worktree', 'list'])).toThrow('awaited worktree-operation scope')
})

it('does not let an escaped async context bypass a later operation', async () => {
  const { repo } = fixture(), late = gate(), entered = gate(), finish = gate()
  let ran = false, escaped!: Promise<void>
  await withGitWorktreeOperation(repo, () => {
    escaped = late.promise.then(() => withGitWorktreeOperation(repo, () => { ran = true }))
  })
  const owner = withGitWorktreeOperation(repo, async () => { entered.release(); await finish.promise })
  await entered.promise; late.release()
  try { await setImmediate(); expect(ran).toBe(false) } finally { finish.release() }
  await Promise.all([owner, escaped]); expect(ran).toBe(true)
})

it('flushes asynchronously once per operation, reenters once, and leaves ordinary Git unguarded', async () => {
  const { repo } = fixture(), guard = path.join(fs.realpathSync.native(repo), '.git', 'room', 'worktree-operation.guard')
  const synchronous = vi.spyOn(fs, 'fsyncSync'), open = fs.promises.open.bind(fs.promises)
  let flushes = 0
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args), sync = handle.sync.bind(handle)
    vi.spyOn(handle, 'sync').mockImplementation(async () => { flushes++; await sync() })
    return handle
  })
  await git(repo, ['rev-parse', 'HEAD'])
  expect(flushes).toBe(0); expect(fs.existsSync(guard)).toBe(false)
  await withGitWorktreeOperation(repo, async () => {
    const nonce = JSON.parse(fs.readFileSync(guard, 'utf8')).nonce
    await git(repo, ['worktree', 'list', '--porcelain'])
    await withGitWorktreeOperation(path.join(repo, '.git'), () => {
      expect(JSON.parse(fs.readFileSync(guard, 'utf8')).nonce).toBe(nonce)
      boundedGitSync(repo, ['worktree', 'list'])
    })
  })
  let ancestors = 0
  for (let dir = path.dirname(guard); path.dirname(dir) !== dir; dir = path.dirname(dir)) ancestors++
  // One flush per ancestor, token contents, link, temp removal, and release.
  expect(flushes).toBe(ancestors + 4)
  expect(synchronous).not.toHaveBeenCalled(); expect(fs.existsSync(guard)).toBe(false)
})
