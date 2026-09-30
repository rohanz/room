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
async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 100; n++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(check()).toBe(true)
}

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
  expect(git('worktree', 'list', '--porcelain')).toMatch(/locked room preview slot/)
}, 30_000)

it('keeps an adopting slot registered while another dead slot is deleted', async () => {
  const { root, git, ancestor, session } = fixture()
  const own = await previewCachePath(root)
  const old = path.join(path.dirname(own), '999999998-old-start')
  const other = path.join(path.dirname(own), '999999999-other-start')
  fs.mkdirSync(path.dirname(old), { recursive: true })
  git('worktree', 'add', '--detach', '-q', old, ancestor)
  git('worktree', 'add', '--detach', '-q', other, ancestor)
  fs.mkdirSync(path.join(old, 'target'))
  fs.writeFileSync(path.join(old, 'target', 'marker'), 'warm')
  let renamed!: () => void, resume!: () => void
  const atRename = new Promise<void>(resolve => { renamed = resolve })
  const hold = new Promise<void>(resolve => { resume = resolve })
  const original = fs.promises.rename.bind(fs.promises)
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    await original(from, to)
    if (String(from) === old && String(to) === own) { renamed(); await hold }
  })
  const pending = runInMergedTree(session, ancestor, new Map(), 'test -f target/marker && echo "1 passed"')
  await atRename
  expect(git('worktree', 'list', '--porcelain')).toMatch(/locked room preview slot/)
  // Worker cleanup has another prune caller; Git must preserve this locked registration.
  git('worktree', 'prune')
  await removePreviewCache(root)
  resume()
  const result = await pending
  expect(result.passed, result.text).toBe(true)
  expect(fs.readFileSync(path.join(own, 'target', 'marker'), 'utf8')).toBe('warm')
  expect(git('worktree', 'list', '--porcelain')).toContain(own)
}, 30_000)

it('leaves a dead old-format worktree untouched and uses a sidecar slot', async () => {
  const { root, git, ancestor, session } = fixture()
  const own = await previewCachePath(root), key = path.dirname(own)
  git('worktree', 'add', '--detach', '-q', key, ancestor)
  fs.mkdirSync(path.join(key, 'target'))
  fs.writeFileSync(path.join(key, 'target', 'marker'), 'legacy')
  fs.writeFileSync(`${key}.lock`, JSON.stringify({ pid: 999999999, startTime: 'dead', nonce: 'old' }))
  const result = await runInMergedTree(session, ancestor, new Map([['app.txt', 'merged\n']]), pass)
  expect(result.passed, result.text).toBe(true)
  expect(fs.readFileSync(path.join(key, 'target', 'marker'), 'utf8')).toBe('legacy')
  const slot = await previewCachePath(root)
  expect(path.dirname(slot)).toBe(`${key}.slots`)
  expect(fs.existsSync(slot)).toBe(true)
  await removePreviewCache(root)
  expect(fs.readFileSync(path.join(key, 'target', 'marker'), 'utf8')).toBe('legacy')
  expect(git('worktree', 'list', '--porcelain')).toContain(key)
}, 30_000)

it('leaves an old-format worktree with an aged ownerless lock', async () => {
  const { root, git, ancestor, session } = fixture()
  const key = path.dirname(await previewCachePath(root))
  git('worktree', 'add', '--detach', '-q', key, ancestor)
  fs.writeFileSync(`${key}.lock`, '')
  const old = new Date(Date.now() - 11 * 60_000)
  fs.utimesSync(`${key}.lock`, old, old)
  const result = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(fs.existsSync(path.join(key, '.git'))).toBe(true)
  expect(path.dirname(await previewCachePath(root))).toBe(`${key}.slots`)
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

it('recovers interrupted trash and removes only its registration', async () => {
  const { root, git, ancestor } = fixture()
  const own = await previewCachePath(root)
  const dead = path.join(path.dirname(own), '999999999-old-start')
  const trash = path.join(path.dirname(path.dirname(own)), `${path.basename(path.dirname(own))}.trash-interrupted`)
  fs.mkdirSync(path.dirname(dead), { recursive: true })
  git('worktree', 'add', '--detach', '-q', dead, ancestor)
  fs.renameSync(dead, trash)
  await removePreviewCache(root)
  expect(fs.existsSync(trash)).toBe(false)
  await removePreviewCache(root)
  expect(git('worktree', 'list', '--porcelain')).not.toContain(dead)
  expect(git('worktree', 'list', '--porcelain')).toContain(root)
}, 30_000)

it('sweeps dead slots down to the newest one while preserving live and uncertain slots', async () => {
  const { root, git, ancestor, session } = fixture()
  const own = await previewCachePath(root)
  const first = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(first.passed, first.text).toBe(true)
  const dead = [1, 2, 3].map(n => path.join(path.dirname(own), `99999999${n}-dead-${n}`))
  const live = path.join(path.dirname(own), '424242-live-start')
  const uncertain = path.join(path.dirname(own), '434343-unknown-start')
  for (const slot of [...dead, live, uncertain]) git('worktree', 'add', '--detach', '-q', slot, ancestor)
  dead.forEach((slot, i) => fs.utimesSync(slot, new Date(1000 * (i + 1)), new Date(1000 * (i + 1))))
  setPreviewProcessProbeForTests(async pid => pid === 424242 ? 'live-start' : pid === 434343 || pid === process.pid ? undefined : null)
  const result = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  await until(() => dead.filter(fs.existsSync).length === 1)
  expect(fs.existsSync(dead[2])).toBe(true)
  expect(fs.existsSync(live)).toBe(true)
  expect(fs.existsSync(uncertain)).toBe(true)
  expect(fs.existsSync(own)).toBe(true)
}, 30_000)

it('removes all dead slots for a vanished clone using recorded clone metadata', async () => {
  const { root, git, ancestor } = fixture()
  const clone = path.join(path.dirname(root), `${path.basename(root)}-clone`)
  git('worktree', 'add', '--detach', '-q', clone, ancestor)
  try {
    const slot = await previewCachePath(clone)
    const result = await runInMergedTree({ dir: clone } as Session, ancestor, new Map(), 'echo "1 passed"')
    expect(result.passed, result.text).toBe(true)
    const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(slot), 'clone.json'), 'utf8')) as { path: string }
    expect(metadata.path).toBe(fs.realpathSync(clone))
    const dead = path.join(path.dirname(slot), '999999999-dead-start')
    fs.renameSync(slot, dead)
    git('worktree', 'repair', dead)
    git('worktree', 'remove', '--force', clone)
    await removePreviewCache(root)
    expect(fs.existsSync(dead)).toBe(false)
    expect(git('worktree', 'list', '--porcelain')).not.toContain(dead)
  } finally { fs.rmSync(clone, { recursive: true, force: true }) }
}, 30_000)

it('deletes at most four abandoned trash directories per sweep', async () => {
  const { root, git, ancestor } = fixture()
  const own = await previewCachePath(root)
  const base = path.dirname(path.dirname(own))
  for (let n = 0; n < 6; n++) {
    const slot = path.join(path.dirname(own), `99999999${n}-dead-${n}`)
    fs.mkdirSync(path.dirname(slot), { recursive: true })
    git('worktree', 'add', '--detach', '-q', slot, ancestor)
    fs.renameSync(slot, path.join(base, `${path.basename(path.dirname(own))}.trash-${n}`))
  }
  await removePreviewCache(root)
  expect(fs.readdirSync(base).filter(name => name.includes('.trash-'))).toHaveLength(2)
}, 30_000)
