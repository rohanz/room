import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { previewCachePath, removePreviewCache, runInMergedTree, setPreviewProcessProbeForTests } from '../src/tools/files.js'
import type { Session } from '../src/session.js'

const roots: string[] = []
afterEach(() => {
  setPreviewProcessProbeForTests()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-race-'))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  fs.writeFileSync(path.join(root, '.gitignore'), 'target/\n')
  fs.writeFileSync(path.join(root, 'app.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  return { root, git, ancestor: git('rev-parse', 'HEAD'), session: { dir: root } as Session }
}
const pass = 'test "$(cat app.txt)" = merged && echo "1 passed"'

it('keeps live and uncertain owners in separate slots through preview and cleanup', async () => {
  const { root, git, ancestor, session } = fixture()
  const own = await previewCachePath(root)
  const other = path.join(path.dirname(own), '424242-other-start')
  const third = path.join(path.dirname(own), '434343-third-start')
  fs.mkdirSync(path.dirname(other), { recursive: true })
  git('worktree', 'add', '--detach', '-q', other, ancestor)
  git('worktree', 'add', '--detach', '-q', third, ancestor)
  fs.writeFileSync(path.join(other, 'app.txt'), 'first owner\n')
  fs.writeFileSync(path.join(third, 'app.txt'), 'second owner\n')
  setPreviewProcessProbeForTests(async pid => pid === 424242 ? 'other-start' : undefined)
  const result = await runInMergedTree(session, ancestor, new Map([['app.txt', 'merged\n']]), pass)
  expect(result.passed, result.text).toBe(true)
  expect(fs.existsSync(own)).toBe(true)
  await removePreviewCache(root)
  expect(fs.existsSync(other)).toBe(true)
  expect(fs.existsSync(third)).toBe(true)
  expect(fs.existsSync(own)).toBe(true)
  expect(fs.readFileSync(path.join(other, 'app.txt'), 'utf8')).toBe('first owner\n')
  expect(fs.readFileSync(path.join(third, 'app.txt'), 'utf8')).toBe('second owner\n')
}, 30_000)

it('one reclaimer wins a dead slot rename and removes its Git registration', async () => {
  const { root, git, ancestor } = fixture()
  const own = await previewCachePath(root)
  const dead = path.join(path.dirname(own), '999999999-old-start')
  fs.mkdirSync(path.dirname(dead), { recursive: true })
  git('worktree', 'add', '--detach', '-q', dead, ancestor)
  const rename = fs.promises.rename.bind(fs.promises)
  let wins = 0
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    const result = await rename(from, to)
    if (String(from) === dead) wins++
    return result
  })
  await Promise.all([removePreviewCache(root), removePreviewCache(root)])
  expect(wins).toBe(1)
  expect(fs.existsSync(dead)).toBe(false)
  expect(git('worktree', 'list', '--porcelain')).not.toContain(dead)
}, 30_000)

it('adopts a dead slot, keeps ignored output, and repairs Git registration', async () => {
  const { root, git, ancestor, session } = fixture()
  const own = await previewCachePath(root)
  const dead = path.join(path.dirname(own), '999999999-old-start')
  fs.mkdirSync(path.dirname(dead), { recursive: true })
  git('worktree', 'add', '--detach', '-q', dead, ancestor)
  fs.mkdirSync(path.join(dead, 'target'))
  fs.writeFileSync(path.join(dead, 'target', 'marker'), 'warm')
  const result = await runInMergedTree(session, ancestor, new Map([['app.txt', 'merged\n']]), `${pass} && test -f target/marker`)
  expect(result.passed, result.text).toBe(true)
  expect(result.text).toContain('(cached base)')
  expect(fs.readFileSync(path.join(own, 'target', 'marker'), 'utf8')).toBe('warm')
  expect(fs.existsSync(dead)).toBe(false)
  expect(execFileSync('git', ['-C', own, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('')
  expect(git('worktree', 'list', '--porcelain')).toContain(own)
}, 30_000)

it('migrates a dead old-format worktree with its ignored output', async () => {
  const { root, git, ancestor, session } = fixture()
  const own = await previewCachePath(root), key = path.dirname(own)
  git('worktree', 'add', '--detach', '-q', key, ancestor)
  fs.mkdirSync(path.join(key, 'target'))
  fs.writeFileSync(path.join(key, 'target', 'marker'), 'legacy')
  fs.writeFileSync(`${key}.lock`, JSON.stringify({ pid: 999999999, startTime: 'dead', nonce: 'old' }))
  const result = await runInMergedTree(session, ancestor, new Map([['app.txt', 'merged\n']]), pass)
  expect(result.passed, result.text).toBe(true)
  expect(result.text).toContain('(cached base)')
  const migrated = await previewCachePath(root)
  expect(fs.readFileSync(path.join(migrated, 'target', 'marker'), 'utf8')).toBe('legacy')
  expect(git('worktree', 'list', '--porcelain')).toContain(migrated)
}, 30_000)

it('migrates an old-format worktree with an aged ownerless lock', async () => {
  const { root, git, ancestor, session } = fixture()
  const key = path.dirname(await previewCachePath(root))
  git('worktree', 'add', '--detach', '-q', key, ancestor)
  fs.writeFileSync(`${key}.lock`, '')
  const old = new Date(Date.now() - 11 * 60_000)
  fs.utimesSync(`${key}.lock`, old, old)
  const result = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(result.text).toContain('(cached base)')
  expect(git('worktree', 'list', '--porcelain')).toContain(await previewCachePath(root))
}, 30_000)

it('leaves a live old-format worktree and creates slots beside it', async () => {
  const { root, git, ancestor, session } = fixture()
  const own = await previewCachePath(root), key = path.dirname(own)
  git('worktree', 'add', '--detach', '-q', key, ancestor)
  fs.writeFileSync(`${key}.lock`, JSON.stringify({ pid: process.pid, startTime: 'uncertain', nonce: 'live' }))
  const result = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(fs.existsSync(key)).toBe(true)
  expect(path.dirname(await previewCachePath(root))).toBe(`${key}.slots`)
}, 30_000)

it('leaves an old-format tree while a live recovery gate exists', async () => {
  const { root, git, ancestor, session } = fixture()
  const key = path.dirname(await previewCachePath(root))
  git('worktree', 'add', '--detach', '-q', key, ancestor)
  fs.writeFileSync(`${key}.lock`, '999999999')
  fs.writeFileSync(`${key}.lock.recover`, String(process.pid))
  const result = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(fs.existsSync(path.join(key, '.git'))).toBe(true)
  expect(path.dirname(await previewCachePath(root))).toBe(`${key}.slots`)
}, 30_000)

it('keeps the loop responsive during a slow asynchronous owner probe', async () => {
  const { root, git, ancestor, session } = fixture()
  const own = await previewCachePath(root)
  const other = path.join(path.dirname(own), '424242-slow-owner')
  fs.mkdirSync(path.dirname(other), { recursive: true })
  git('worktree', 'add', '--detach', '-q', other, ancestor)
  setPreviewProcessProbeForTests(async pid => {
    if (pid === 424242) await new Promise<void>(resolve => setTimeout(resolve, 120))
    return pid === 424242 ? 'slow-owner' : undefined
  })
  let maxDelay = 0, previous = performance.now()
  const timer = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - previous - 5); previous = now }, 5)
  try {
    const result = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
    expect(result.passed, result.text).toBe(true)
  } finally { clearInterval(timer) }
  expect(maxDelay).toBeLessThan(50)
}, 30_000)
