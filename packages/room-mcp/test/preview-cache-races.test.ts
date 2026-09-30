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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-legacy-'))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  fs.writeFileSync(path.join(root, 'app.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  return { root, git, head: git('rev-parse', 'HEAD') }
}

it('removes only dead legacy slots and their stale claims through Git', async () => {
  const { root, git, head } = fixture()
  const key = path.dirname(await previewCachePath(root))
  const dead = path.join(key, '999999999-dead-start-0')
  const live = path.join(key, '424242-live-start-0')
  fs.mkdirSync(key, { recursive: true })
  for (const slot of [dead, live]) git('worktree', 'add', '--detach', '-q', slot, head)
  fs.writeFileSync(`${dead}.claim`, JSON.stringify({ pid: 999999999, start: 'dead-start' }))
  fs.writeFileSync(`${live}.claim`, JSON.stringify({ pid: 424242, start: 'live-start' }))
  setPreviewProcessProbeForTests(async pid => pid === 424242 ? 'live-start' : null)
  const result = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(fs.existsSync(dead)).toBe(false)
  expect(fs.existsSync(`${dead}.claim`)).toBe(false)
  expect(git('worktree', 'list', '--porcelain')).not.toContain(dead)
  expect(fs.existsSync(live)).toBe(true)
  expect(fs.existsSync(`${live}.claim`)).toBe(true)
  expect(git('worktree', 'list', '--porcelain')).toContain(live)
}, 30_000)

it('does not remove a live worktree through a forged legacy gitfile', async () => {
  const { root, git, head } = fixture()
  const live = path.join(root, 'live-checkout')
  git('worktree', 'add', '--detach', '-q', live, head)
  git('worktree', 'lock', live)
  fs.writeFileSync(path.join(live, 'app.txt'), 'LIVE EDIT\n')
  const dead = path.join(path.dirname(await previewCachePath(root)), '999999999-wrong-pointer')
  fs.mkdirSync(dead, { recursive: true })
  fs.copyFileSync(path.join(live, '.git'), path.join(dead, '.git'))
  setPreviewProcessProbeForTests(async () => null)
  await removePreviewCache(root); await waitForPreviewSweepForTests()
  expect(fs.existsSync(dead)).toBe(true)
  expect(git('worktree', 'list', '--porcelain')).toContain(live)
  expect(fs.readFileSync(path.join(live, 'app.txt'), 'utf8')).toBe('LIVE EDIT\n')
}, 30_000)

it('ignores a symlinked legacy gitfile and preserves another worktree index', async () => {
  const { root, git, head } = fixture()
  const live = path.join(root, 'live-checkout')
  git('worktree', 'add', '--detach', '-q', live, head)
  fs.writeFileSync(path.join(live, 'app.txt'), 'STAGED EDIT\n')
  execFileSync('git', ['-C', live, 'add', 'app.txt'])
  const dead = path.join(path.dirname(await previewCachePath(root)), '999999999-symlink')
  fs.mkdirSync(dead, { recursive: true })
  fs.symlinkSync(path.join(live, '.git'), path.join(dead, '.git'))
  setPreviewProcessProbeForTests(async () => null)
  await removePreviewCache(root); await waitForPreviewSweepForTests()
  expect(fs.existsSync(dead)).toBe(true)
  expect(execFileSync('git', ['-C', live, 'show', ':app.txt'], { encoding: 'utf8' })).toBe('STAGED EDIT\n')
}, 30_000)

it('leaves a dead slot alone while a live legacy claimant may use it', async () => {
  const { root, git, head } = fixture()
  const key = path.dirname(await previewCachePath(root))
  const slot = path.join(key, '999999999-dead-start-0')
  fs.mkdirSync(key, { recursive: true })
  git('worktree', 'add', '--detach', '-q', slot, head)
  fs.writeFileSync(`${slot}.claim`, JSON.stringify({ pid: 424242, start: 'live-start' }))
  setPreviewProcessProbeForTests(async pid => pid === 424242 ? 'live-start' : null)
  await removePreviewCache(root)
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(slot)).toBe(true)
  expect(git('worktree', 'list', '--porcelain')).toContain(slot)
}, 30_000)

it('migrates a dead slot under another clone key on first use', async () => {
  const { root, git, head } = fixture()
  const clone = path.join(root, 'clone')
  git('worktree', 'add', '--detach', '-q', clone, head)
  const key = path.dirname(await previewCachePath(clone))
  const old = path.join(key, '999999999-dead-start-0')
  fs.mkdirSync(key, { recursive: true })
  git('worktree', 'add', '--detach', '-q', old, head)
  setPreviewProcessProbeForTests(async () => null)
  const result = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(fs.existsSync(old)).toBe(false)
  expect(git('worktree', 'list', '--porcelain')).not.toContain(old)
}, 30_000)

it('uses checkout contents on fresh fallback, including export-ignored files', async () => {
  const { root, git } = fixture()
  fs.mkdirSync(path.join(root, 'tests'))
  fs.writeFileSync(path.join(root, 'tests', 'regression.test'), 'FAIL')
  fs.writeFileSync(path.join(root, 'subst.txt'), '$Format:%H$')
  fs.writeFileSync(path.join(root, '.gitattributes'), 'tests/regression.test export-ignore\nsubst.txt export-subst\n')
  git('add', '.'); git('commit', '-qm', 'attributes')
  const head = git('rev-parse', 'HEAD')
  const cache = await previewCachePath(root)
  const command = `test -f tests/regression.test && test "$(cat subst.txt)" = '$Format:%H$' && echo "1 passed"`
  expect((await runInMergedTree({ dir: root } as Session, head, new Map(), command)).passed).toBe(true)
  fs.unlinkSync(path.join(cache, '.git'))
  fs.symlinkSync(path.join(root, '.git'), path.join(cache, '.git'))
  const fresh = await runInMergedTree({ dir: root } as Session, head, new Map(), command)
  expect(fresh.passed, fresh.text).toBe(true)
  expect(fresh.text).toContain('fresh base after cache failure')
}, 30_000)

it('does not mutate an invalid cached registration if scratch allocation fails', async () => {
  const { root, head } = fixture()
  const cache = await previewCachePath(root)
  expect((await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')).passed).toBe(true)
  fs.unlinkSync(path.join(cache, '.git'))
  fs.symlinkSync(path.join(root, '.git'), path.join(cache, '.git'))
  vi.spyOn(fs.promises, 'mkdtemp').mockRejectedValueOnce(new Error('scratch unavailable'))
  const result = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  expect(result.passed).toBe(false)
  expect(result.text).toContain('scratch unavailable; check was not run')
  expect(fs.lstatSync(path.join(cache, '.git')).isSymbolicLink()).toBe(true)
}, 30_000)

it('keeps an older direct-key worktree separate from the shared entry', async () => {
  const { root, git, head } = fixture()
  const key = path.dirname(await previewCachePath(root))
  fs.mkdirSync(path.dirname(key), { recursive: true })
  git('worktree', 'add', '--detach', '-q', key, head)
  const entry = await previewCachePath(root)
  expect(path.dirname(entry)).toBe(`${key}.slots`)
  const result = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(fs.existsSync(key)).toBe(true)
  expect(fs.existsSync(entry)).toBe(true)
}, 30_000)

it('keeps a finished check result if cache cleanup fails', async () => {
  const { root, head } = fixture()
  const entry = await previewCachePath(root)
  const original = fs.promises.open.bind(fs.promises)
  let afterSetup = false
  vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
    if (String(file) === path.join(entry, '.git') && afterSetup) {
      afterSetup = false
      throw Object.assign(new Error('transient validation failure'), { code: 'EBUSY' })
    }
    return original(file, flags, mode)
  })
  const result = await runInMergedTree({ dir: root } as Session, head, new Map([['app.txt', 'merged\n']]), 'echo "1 failed"; exit 1', new Map(), {
    mergedWrite() { afterSetup = true },
  })
  expect(result.passed).toBe(false)
  expect(result.text).toContain('1 failed')
  expect(result.text).toContain('preview cache abandoned after the check')
}, 30_000)
