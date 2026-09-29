import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { previewCachePath, removePreviewCache, runInMergedTree } from '../src/tools/files.js'
import type { Session } from '../src/session.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-race-'))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\ntarget/\n')
  fs.writeFileSync(path.join(root, 'app.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  return { root, ancestor: git('rev-parse', 'HEAD'), session: { dir: root } as Session }
}

it('allows only one cache owner when two callers recover a dead lock', async () => {
  const { root, ancestor, session } = fixture()
  await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  const cache = await previewCachePath(root), lock = `${cache}.lock`
  fs.writeFileSync(lock, '999999999')
  const originalRead = fs.promises.readFile.bind(fs.promises)
  let lockReads = 0
  let releaseReads!: () => void
  const bothRead = new Promise<void>(resolve => { releaseReads = resolve })
  vi.spyOn(fs.promises, 'readFile').mockImplementation(async (file, options) => {
    const value = await originalRead(file, options as never)
    if (String(file) === lock && ++lockReads <= 2) {
      if (lockReads === 2) releaseReads()
      await Promise.race([bothRead, new Promise<void>(resolve => setTimeout(resolve, 100))])
    }
    return value as never
  })
  const originalRemove = fs.promises.rm.bind(fs.promises)
  let removals = 0
  let releaseSecond!: () => void
  const secondCanRemove = new Promise<void>(resolve => { releaseSecond = resolve })
  vi.spyOn(fs.promises, 'rm').mockImplementation(async (file, options) => {
    if (String(file) === lock && ++removals === 2) await secondCanRemove
    return originalRemove(file, options)
  })
  let firstWrote!: () => void
  const firstReady = new Promise<void>(resolve => { firstWrote = resolve })
  const copied: string[] = []
  const first = runInMergedTree(session, ancestor, new Map([['app.txt', 'first\n']]),
    'sleep 0.2; test "$(cat app.txt)" = first && echo "1 passed"', new Map(),
    { baseMaterialized: () => copied.push('first'), mergedWrite: () => firstWrote() })
  const second = runInMergedTree(session, ancestor, new Map([['app.txt', 'second\n']]),
    'test "$(cat app.txt)" = second && echo "1 passed"', new Map(),
    { baseMaterialized: () => copied.push('second') })
  await Promise.race([firstReady, new Promise<void>(resolve => setTimeout(resolve, 1000))])
  releaseSecond()
  const results = await Promise.all([first, second])
  expect(results.every(result => result.passed), results.map(result => result.text).join('\n')).toBe(true)
  expect(results.filter(result => result.text.includes('(cached base)'))).toHaveLength(1)
  expect(copied).toHaveLength(1)
}, 30_000)

it('a recovery gate left by a crashed recoverer does not disable the cache for good', async () => {
  const { root, ancestor, session } = fixture()
  await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  const cache = await previewCachePath(root), lock = `${cache}.lock`
  fs.writeFileSync(lock, '999999999')
  fs.mkdirSync(`${lock}.recover`)
  const old = new Date(Date.now() - 24 * 60 * 60_000)
  fs.utimesSync(`${lock}.recover`, old, old)
  const result = await runInMergedTree(session, ancestor, new Map([['app.txt', 'merged\n']]), 'test "$(cat app.txt)" = merged && echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(result.text).toContain('(cached base)')
}, 30_000)

it('does not revoke a paused live recoverer when its gate is old', async () => {
  const { root, ancestor, session } = fixture()
  await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  const cache = await previewCachePath(root), lock = `${cache}.lock`, gate = `${lock}.recover`
  fs.writeFileSync(lock, '999999999')
  const originalRead = fs.promises.readFile.bind(fs.promises)
  let reads = 0, resume!: () => void, entered!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve })
  const continueFirst = new Promise<void>(resolve => { resume = resolve })
  vi.spyOn(fs.promises, 'readFile').mockImplementation(async (file, options) => {
    const value = await originalRead(file, options as never)
    if (String(file) === lock && ++reads === 2) {
      const old = new Date(Date.now() - 120_000)
      fs.utimesSync(gate, old, old)
      entered()
      await continueFirst
    }
    return value as never
  })
  const first = runInMergedTree(session, ancestor, new Map([['app.txt', 'first\n']]),
    'test "$(cat app.txt)" = first && echo "1 passed"')
  await paused
  const second = await runInMergedTree(session, ancestor, new Map([['app.txt', 'second\n']]),
    'test "$(cat app.txt)" = second && echo "1 passed"')
  resume()
  const earlier = await first
  expect(earlier.passed, earlier.text).toBe(true)
  expect(second.passed, second.text).toBe(true)
  expect(second.text).toContain('(fresh base)')
  expect(fs.existsSync(lock)).toBe(false)
  await expect(removePreviewCache(root)).resolves.toBeUndefined()
}, 30_000)

it('recovers old empty lock and gate residue without exposing a new empty lock', async () => {
  const { root, ancestor, session } = fixture()
  await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  const cache = await previewCachePath(root), lock = `${cache}.lock`, gate = `${lock}.recover`
  fs.writeFileSync(lock, '')
  fs.writeFileSync(gate, '')
  const old = new Date(Date.now() - 24 * 60 * 60_000)
  fs.utimesSync(lock, old, old); fs.utimesSync(gate, old, old)
  const result = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"', new Map(), {
    mergedWrite: () => expect(fs.readFileSync(lock, 'utf8').length).toBeGreaterThan(0),
  })
  expect(result.passed, result.text).toBe(true)
  expect(result.text).toContain('(cached base)')
  await expect(removePreviewCache(root)).resolves.toBeUndefined()
}, 30_000)

it('lets only one of two callers recover the same dead gate', async () => {
  const { root, ancestor, session } = fixture()
  await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  const cache = await previewCachePath(root), lock = `${cache}.lock`, gate = `${lock}.recover`
  fs.writeFileSync(lock, '999999999')
  fs.writeFileSync(gate, JSON.stringify({ pid: 999999999, startTime: 'dead', nonce: 'old' }))
  const originalRename = fs.promises.rename.bind(fs.promises)
  let entered!: () => void, resume!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve })
  const continueFirst = new Promise<void>(resolve => { resume = resolve })
  let gateMoves = 0
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    const result = await originalRename(from, to)
    if (String(from) === gate && ++gateMoves === 1) { entered(); await continueFirst }
    return result
  })
  const first = runInMergedTree(session, ancestor, new Map([['app.txt', 'first\n']]),
    'test "$(cat app.txt)" = first && echo "1 passed"')
  await paused
  const second = runInMergedTree(session, ancestor, new Map([['app.txt', 'second\n']]),
    'sleep 0.2; test "$(cat app.txt)" = second && echo "1 passed"', new Map(), { mergedWrite: () => resume() })
  const [earlier, later] = await Promise.all([first, second])
  expect(earlier.passed, earlier.text).toBe(true)
  expect(later.passed, later.text).toBe(true)
  expect([earlier, later].filter(result => result.text.includes('(cached base)'))).toHaveLength(1)
  await expect(removePreviewCache(root)).resolves.toBeUndefined()
}, 30_000)

it('publishes only a fully written lock token', async () => {
  const { root, ancestor, session } = fixture()
  const cache = await previewCachePath(root), lock = `${cache}.lock`
  const originalLink = fs.promises.link.bind(fs.promises)
  let inspected = false
  vi.spyOn(fs.promises, 'link').mockImplementation(async (from, to) => {
    if (String(to) === lock && !inspected) {
      inspected = true
      expect(fs.readFileSync(from, 'utf8')).toMatch(/"pid":/)
      expect(fs.existsSync(lock)).toBe(false)
    }
    const result = await originalLink(from, to)
    if (String(to) === lock) expect(fs.readFileSync(lock, 'utf8')).toMatch(/"pid":/)
    return result
  })
  const result = await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(inspected).toBe(true)
}, 30_000)

it('retains the acquired lock release when gate removal fails once', async () => {
  const { root, ancestor, session } = fixture()
  await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  const cache = await previewCachePath(root), lock = `${cache}.lock`, gate = `${lock}.recover`
  fs.writeFileSync(lock, '999999999')
  const originalRemove = fs.promises.rm.bind(fs.promises)
  let failed = false
  vi.spyOn(fs.promises, 'rm').mockImplementation(async (file, options) => {
    if (String(file) === gate && !failed) { failed = true; throw new Error('injected gate removal failure') }
    return originalRemove(file, options)
  })
  const result = await runInMergedTree(session, ancestor, new Map([['app.txt', 'merged\n']]),
    'test "$(cat app.txt)" = merged && echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(failed).toBe(true)
  expect(fs.existsSync(lock)).toBe(false)
  expect(fs.existsSync(gate)).toBe(false)
  await expect(removePreviewCache(root)).resolves.toBeUndefined()
}, 30_000)

it('does not remove a lock whose owner changed before release', async () => {
  const { root, ancestor, session } = fixture()
  const cache = await previewCachePath(root), lock = `${cache}.lock`
  const result = await runInMergedTree(session, ancestor, new Map([['app.txt', 'merged\n']]), 'echo "1 passed"', new Map(), {
    mergedWrite: () => fs.writeFileSync(lock, 'replacement-owner'),
  })
  expect(result.passed, result.text).toBe(true)
  expect(fs.readFileSync(lock, 'utf8')).toBe('replacement-owner')
}, 30_000)

it('holds exclusion through cache removal while a preview starts', async () => {
  const { root, ancestor, session } = fixture()
  await runInMergedTree(session, ancestor, new Map(), 'echo "1 passed"')
  const cache = await previewCachePath(root)
  const originalLstat = fs.promises.lstat.bind(fs.promises)
  let reached!: () => void, resume!: () => void
  const atCache = new Promise<void>(resolve => { reached = resolve })
  const mayRemove = new Promise<void>(resolve => { resume = resolve })
  vi.spyOn(fs.promises, 'lstat').mockImplementation(async (file, options) => {
    if (String(file) === cache) { reached(); await mayRemove }
    return originalLstat(file, options)
  })
  const removal = removePreviewCache(root)
  await atCache
  let copied = 0
  const preview = runInMergedTree(session, ancestor, new Map([['app.txt', 'merged\n']]),
    'test "$(cat app.txt)" = merged && echo "1 passed"', new Map(), { baseMaterialized: () => copied++ })
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  } finally { resume() }
  await removal
  const result = await preview
  expect(result.passed, result.text).toBe(true)
  expect(copied).toBe(1)
  expect(result.text).toContain('(fresh base)')
}, 30_000)

it('refreshes added, removed and retargeted dependency links on each cached preview', async () => {
  const { root, ancestor, session } = fixture()
  for (const name of ['one', 'two']) {
    const dir = path.join(root, 'packages', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = '${name}'\n`)
  }
  execFileSync('git', ['-C', root, 'add', 'packages'])
  execFileSync('git', ['-C', root, 'commit', '-qm', 'packages'])
  const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const modules = path.join(root, 'node_modules')
  fs.mkdirSync(modules)
  fs.symlinkSync('../packages/one', path.join(modules, 'a'))
  fs.symlinkSync('../packages/one', path.join(modules, 'removed'))
  const first = await runInMergedTree(session, base, new Map(),
    `node -e "if (require('a') !== 'one' || require('removed') !== 'one') process.exit(1); console.log('1 passed')"`)
  expect(first.passed, first.text).toBe(true)
  const cache = await previewCachePath(root)
  fs.mkdirSync(path.join(cache, 'target'), { recursive: true })
  fs.writeFileSync(path.join(cache, 'target', 'keep'), 'warm')
  fs.unlinkSync(path.join(modules, 'a'))
  fs.unlinkSync(path.join(modules, 'removed'))
  fs.symlinkSync('../packages/two', path.join(modules, 'a'))
  fs.symlinkSync('../packages/two', path.join(modules, 'added'))
  const second = await runInMergedTree(session, base, new Map(),
    `node -e "if (require('a') !== 'two' || require('added') !== 'two') process.exit(1); try { require.resolve('removed'); process.exit(1) } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e }; console.log('1 passed')"`)
  expect(second.passed, second.text).toBe(true)
  expect(second.text).toContain('(cached base)')
  expect(fs.readFileSync(path.join(cache, 'target', 'keep'), 'utf8')).toBe('warm')
}, 30_000)
