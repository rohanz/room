import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { previewCachePath, removePreviewCache, runInMergedTree, setPreviewProcessProbeForTests, waitForPreviewSweepForTests } from '../src/tools/files.js'
import type { Session } from '../src/session.js'

const roots: string[] = []
afterEach(async () => {
  await waitForPreviewSweepForTests()
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
  await removePreviewCache(root); await waitForPreviewSweepForTests()
  expect(fs.existsSync(other)).toBe(true)
  expect(fs.existsSync(third)).toBe(true)
  expect(fs.existsSync(own)).toBe(true)
  expect(fs.readFileSync(path.join(other, 'app.txt'), 'utf8')).toBe('first owner\n')
  expect(fs.readFileSync(path.join(third, 'app.txt'), 'utf8')).toBe('second owner\n')
}, 30_000)

it('one reclaimer wins a dead slot claim and removes its Git registration', async () => {
  const { root, git, ancestor } = fixture()
  const own = await previewCachePath(root)
  const dead = path.join(path.dirname(own), '999999999-old-start')
  fs.mkdirSync(path.dirname(dead), { recursive: true })
  git('worktree', 'add', '--detach', '-q', dead, ancestor)
  const link = fs.promises.link.bind(fs.promises)
  let wins = 0
  vi.spyOn(fs.promises, 'link').mockImplementation(async (from, to) => {
    const result = await link(from, to)
    if (String(to) === `${dead}.claim`) wins++
    return result
  })
  await Promise.all([removePreviewCache(root), removePreviewCache(root)]); await waitForPreviewSweepForTests()
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
  await removePreviewCache(root); await waitForPreviewSweepForTests()
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
  await removePreviewCache(root); await waitForPreviewSweepForTests()
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

it('leaves legacy trash with an old registration for manual cleanup', async () => {
  const { root, git, ancestor } = fixture()
  const own = await previewCachePath(root)
  const dead = path.join(path.dirname(own), '999999999-old-start')
  const trash = path.join(path.dirname(path.dirname(own)), `${path.basename(path.dirname(own))}.trash-interrupted`)
  fs.mkdirSync(path.dirname(dead), { recursive: true })
  git('worktree', 'add', '--detach', '-q', dead, ancestor)
  fs.renameSync(dead, trash)
  await removePreviewCache(root); await waitForPreviewSweepForTests()
  expect(fs.existsSync(trash)).toBe(true)
  await removePreviewCache(root); await waitForPreviewSweepForTests()
  expect(git('worktree', 'list', '--porcelain')).toContain(dead)
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
    await waitForPreviewSweepForTests()
    const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(slot), 'clone.json'), 'utf8')) as { path: string }
    expect(metadata.path).toBe(fs.realpathSync(clone))
    const dead = path.join(path.dirname(slot), '999999999-dead-start')
    fs.renameSync(slot, dead)
    git('worktree', 'repair', dead)
    git('worktree', 'remove', '--force', clone)
    await removePreviewCache(root); await waitForPreviewSweepForTests()
    expect(fs.existsSync(dead)).toBe(false)
    expect(git('worktree', 'list', '--porcelain')).not.toContain(dead)
  } finally { fs.rmSync(clone, { recursive: true, force: true }) }
}, 30_000)

it('leaves legacy trash with registrations instead of deleting their Git admin state', async () => {
  const { root, git, ancestor } = fixture()
  const own = await previewCachePath(root)
  const base = path.dirname(path.dirname(own))
  for (let n = 0; n < 6; n++) {
    const slot = path.join(path.dirname(own), `99999999${n}-dead-${n}`)
    fs.mkdirSync(path.dirname(slot), { recursive: true })
    git('worktree', 'add', '--detach', '-q', slot, ancestor)
    fs.renameSync(slot, path.join(base, `${path.basename(path.dirname(own))}.trash-${n}`))
  }
  await removePreviewCache(root); await waitForPreviewSweepForTests()
  expect(fs.readdirSync(base).filter(name => name.includes('.trash-'))).toHaveLength(6)
}, 30_000)

it('does not let a wrong git pointer remove an unrelated live registration', async () => {
  const { root, git, ancestor } = fixture()
  const own = await previewCachePath(root)
  const live = path.join(root, 'live-checkout')
  git('worktree', 'add', '--detach', '-q', live, ancestor)
  git('worktree', 'lock', live)
  const dead = path.join(path.dirname(own), '999999999-wrong-pointer')
  fs.mkdirSync(dead, { recursive: true })
  fs.copyFileSync(path.join(live, '.git'), path.join(dead, '.git'))
  await removePreviewCache(root); await waitForPreviewSweepForTests()
  await until(() => fs.existsSync(`${dead}.claim`))
  expect(git('worktree', 'list', '--porcelain')).toContain(live)
  expect(execFileSync('git', ['-C', live, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('')
  expect(fs.existsSync(dead)).toBe(true)
}, 30_000)

it('rejects a symlinked slot gitfile without changing another checkout index', async () => {
  const { root, git, ancestor, session } = fixture()
  const own = await previewCachePath(root)
  const live = path.join(root, 'live-checkout')
  git('worktree', 'add', '--detach', '-q', live, ancestor)
  git('worktree', 'lock', live)
  fs.writeFileSync(path.join(live, 'app.txt'), 'STAGED USER EDIT\n')
  execFileSync('git', ['-C', live, 'add', 'app.txt'])
  fs.writeFileSync(path.join(live, 'app.txt'), 'LIVE USER EDIT\n')
  const dead = path.join(path.dirname(own), '999999999-symlink')
  fs.mkdirSync(dead, { recursive: true })
  fs.symlinkSync(path.join(live, '.git'), path.join(dead, '.git'))
  const result = await runInMergedTree(session, ancestor, new Map([['app.txt', 'merged\n']]), pass)
  expect(result.passed, result.text).toBe(true)
  expect(fs.existsSync(dead)).toBe(true)
  expect(fs.existsSync(`${dead}.claim`)).toBe(true)
  expect(execFileSync('git', ['-C', live, 'show', ':app.txt'], { encoding: 'utf8' })).toBe('STAGED USER EDIT\n')
  expect(fs.readFileSync(path.join(live, 'app.txt'), 'utf8')).toBe('LIVE USER EDIT\n')
}, 30_000)

it('rejects a symlinked gitfile in an existing own slot before reset', async () => {
  const { root, git, ancestor, session } = fixture()
  const own = await previewCachePath(root)
  expect((await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')).passed).toBe(true)
  const live = path.join(root, 'live-checkout')
  git('worktree', 'add', '--detach', '-q', live, ancestor)
  git('worktree', 'lock', live)
  fs.writeFileSync(path.join(live, 'app.txt'), 'STAGED USER EDIT\n')
  execFileSync('git', ['-C', live, 'add', 'app.txt'])
  fs.unlinkSync(path.join(own, '.git'))
  fs.symlinkSync(path.join(live, '.git'), path.join(own, '.git'))
  const result = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(result.text).toContain('fresh base')
  expect(await previewCachePath(root)).not.toBe(own)
  expect(execFileSync('git', ['-C', live, 'show', ':app.txt'], { encoding: 'utf8' })).toBe('STAGED USER EDIT\n')
}, 30_000)

it('abandons a failed own-slot cleanup and checks through scratch, then uses a new generation', async () => {
  const { root, ancestor, session } = fixture()
  const own = await previewCachePath(root)
  fs.mkdirSync(own, { recursive: true })
  fs.writeFileSync(path.join(own, 'partial'), 'partial')
  const original = fs.promises.rm.bind(fs.promises)
  let injected = false
  vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
    if (String(target) === own && !injected) { injected = true; throw Object.assign(new Error('transient EBUSY'), { code: 'EBUSY' }) }
    return original(target, options)
  })
  const first = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(injected).toBe(true)
  expect(first.passed, first.text).toBe(true)
  expect(first.text).toContain('fresh base')
  const next = await previewCachePath(root)
  expect(next).not.toBe(own)
  vi.restoreAllMocks()
  const second = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(second.passed, second.text).toBe(true)
  expect(fs.existsSync(next)).toBe(true)
}, 30_000)

it('abandons an adoption interrupted after rename and checks next preview in a new generation', async () => {
  const { root, git, ancestor, session } = fixture()
  const own = await previewCachePath(root)
  const dead = path.join(path.dirname(own), '999999999-dead')
  fs.mkdirSync(path.dirname(dead), { recursive: true })
  git('worktree', 'add', '--detach', '-q', dead, ancestor)
  const original = fs.promises.rename.bind(fs.promises)
  let injected = false
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    await original(from, to)
    if (String(from) === dead && String(to) === own && !injected) { injected = true; throw new Error('repair interrupted after rename') }
  })
  const first = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(injected).toBe(true)
  expect(first.passed, first.text).toBe(true)
  expect(first.text).toContain('fresh base')
  expect(fs.existsSync(`${dead}.claim`)).toBe(true)
  vi.restoreAllMocks()
  const next = await previewCachePath(root)
  expect(next).not.toBe(own)
  const second = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(second.passed, second.text).toBe(true)
  expect(fs.existsSync(next)).toBe(true)
}, 30_000)

it('recovers in the same process when git repair fails after adoption rename', () => {
  execFileSync(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'fixtures/preview-repair-failure.mts')], {
    cwd: path.join(import.meta.dirname, '../../..'), encoding: 'utf8', timeout: 30_000,
  })
}, 35_000)

it('abandons a failed final cache clean and repeats the check in scratch', async () => {
  const { root, ancestor, session } = fixture()
  const own = await previewCachePath(root)
  const original = fs.promises.open.bind(fs.promises)
  let afterSetup = false
  let injected = false
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
    if (String(file) === path.join(own, '.git') && afterSetup && !injected) {
      injected = true
      throw Object.assign(new Error('transient validation failure'), { code: 'EBUSY' })
    }
    return original(file, flags, mode)
  })
  const result = await runInMergedTree(session, ancestor, new Map([['app.txt', 'merged\n']]), pass, new Map(), {
    mergedWrite() { afterSetup = true },
  })
  expect(injected).toBe(true)
  expect(result.passed, result.text).toBe(true)
  expect(result.text).toContain('fresh base')
  expect(await previewCachePath(root)).not.toBe(own)
}, 30_000)

it('sweeps a later key despite more than 64 live slots in an earlier key', async () => {
  const { root } = fixture()
  const own = await previewCachePath(root)
  const base = path.dirname(path.dirname(own))
  const busy = path.join(base, '00000000000000000000')
  const later = path.join(base, 'ffffffffffffffffffff')
  fs.mkdirSync(busy, { recursive: true })
  fs.mkdirSync(later, { recursive: true })
  for (let n = 0; n < 65; n++) fs.mkdirSync(path.join(busy, `${600000 + n}-live`))
  fs.writeFileSync(path.join(busy, 'clone.json'), JSON.stringify({ path: os.tmpdir() }))
  fs.writeFileSync(path.join(later, 'clone.json'), JSON.stringify({ path: path.join(root, 'vanished-clone') }))
  const dead = path.join(later, '999999999-dead')
  fs.mkdirSync(dead)
  let laterProbed = false
  setPreviewProcessProbeForTests(async pid => { if (pid === 999999999) { laterProbed = true; return null }; return 'live' })
  for (let pass = 0; pass < 12 && fs.existsSync(dead); pass++) {
    await removePreviewCache(root)
    await waitForPreviewSweepForTests()
  }
  expect(laterProbed).toBe(true)
  expect(fs.existsSync(dead)).toBe(false)
}, 30_000)

it('skips a partial dead slot so previews run, then sweeps the partial directory', async () => {
  const { root, git, ancestor, session } = fixture()
  const own = await previewCachePath(root)
  const dead = path.join(path.dirname(own), '999999999-partial')
  fs.mkdirSync(dead, { recursive: true })
  fs.writeFileSync(path.join(dead, 'partial'), 'incomplete')
  const result = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(fs.existsSync(own)).toBe(true)
  await waitForPreviewSweepForTests()
  await until(() => !fs.existsSync(dead))
}, 30_000)

it('repairs and removes a dead locked registration whose git file is missing', async () => {
  const { root, git, ancestor } = fixture()
  const own = await previewCachePath(root)
  const dead = path.join(path.dirname(own), '999999999-missing-git')
  fs.mkdirSync(path.dirname(dead), { recursive: true })
  git('worktree', 'add', '--detach', '-q', dead, ancestor)
  git('worktree', 'lock', dead)
  fs.unlinkSync(path.join(dead, '.git'))
  await removePreviewCache(root); await waitForPreviewSweepForTests()
  await until(() => !fs.existsSync(dead))
  expect(git('worktree', 'list', '--porcelain')).not.toContain(dead)
}, 30_000)

it('leaves a dead slot untouched while another process holds its claim', async () => {
  const { root, git, ancestor } = fixture()
  const own = await previewCachePath(root)
  const dead = path.join(path.dirname(own), '999999999-claimed')
  fs.mkdirSync(path.dirname(dead), { recursive: true })
  git('worktree', 'add', '--detach', '-q', dead, ancestor)
  fs.writeFileSync(`${dead}.claim`, 'dead-owner:full-token')
  await removePreviewCache(root); await waitForPreviewSweepForTests()
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(fs.existsSync(dead)).toBe(true)
  expect(fs.readFileSync(`${dead}.claim`, 'utf8')).toBe('dead-owner:full-token')
  expect(git('worktree', 'list', '--porcelain')).toContain(dead)
}, 30_000)

it('does not touch a later Git registration that reuses a removed slot admin name', async () => {
  const { root, git, ancestor } = fixture()
  const own = await previewCachePath(root)
  const dead = path.join(path.dirname(own), '999999999-reusable')
  fs.mkdirSync(path.dirname(dead), { recursive: true })
  git('worktree', 'add', '--detach', '-q', dead, ancestor)
  const pointer = fs.readFileSync(path.join(dead, '.git'), 'utf8').match(/^gitdir: (.+)$/m)![1]
  const reusedName = path.basename(path.resolve(dead, pointer))
  await Promise.all([removePreviewCache(root), removePreviewCache(root)])
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(dead)).toBe(false)
  const replacement = path.join(root, 'replacement', reusedName)
  git('worktree', 'add', '--detach', '-q', replacement, ancestor)
  git('worktree', 'lock', replacement)
  fs.writeFileSync(path.join(replacement, 'app.txt'), 'LIVE UNCOMMITTED\n')
  await removePreviewCache(root); await waitForPreviewSweepForTests()
  expect(git('worktree', 'list', '--porcelain')).toContain(replacement)
  expect(execFileSync('git', ['-C', replacement, 'status', '--porcelain'], { encoding: 'utf8' })).toContain('app.txt')
  expect(fs.readFileSync(path.join(replacement, 'app.txt'), 'utf8')).toBe('LIVE UNCOMMITTED\n')
}, 30_000)

it('limits owner probes per sweep and coalesces overlapping requests into one follow-up', async () => {
  const { root } = fixture()
  const seen: number[] = []
  let active = 0, maxActive = 0
  for (let n = 0; n < 20; n++) {
    const slot = await previewCachePath(path.join(root, `clone-${n}`), root)
    fs.mkdirSync(path.join(path.dirname(slot), `${600000 + n}-live-${n}`), { recursive: true })
  }
  setPreviewProcessProbeForTests(async pid => {
    active++
    maxActive = Math.max(maxActive, active)
    seen.push(pid)
    await new Promise(resolve => setTimeout(resolve, 40))
    active--
    return `live-${pid - 600000}`
  })
  await removePreviewCache(root)
  await until(() => seen.length > 0)
  await Promise.all([removePreviewCache(root), removePreviewCache(root), removePreviewCache(root)])
  await waitForPreviewSweepForTests()
  expect(seen.length).toBeLessThanOrEqual(16)
  expect(seen.length).toBeGreaterThanOrEqual(9)
  expect(maxActive).toBe(1)
  await removePreviewCache(root); await waitForPreviewSweepForTests()
  expect(new Set(seen).size).toBeGreaterThan(16)
}, 30_000)
