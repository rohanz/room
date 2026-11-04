import { disposePreviewFixture } from './fixtures/preview-disposal.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { previewCachePath, runInMergedTree, setPreviewCleanupForTests } from '../src/tools/files.js'
import { clearPreviewQuarantine, previewQuarantinePath, quarantinePreview, setPreviewCwdsForTests, tryPreviewLock, lsofCwds, procCwds } from '../src/preview-cache.js'
import type { Session } from '../src/session.js'

const posix = process.platform === 'darwin' || process.platform === 'linux'
afterEach(() => setPreviewCleanupForTests())

async function lockFreed(entry: string): Promise<void> {
  for (let n = 0; n < 100; n++) {
    const unlock = await tryPreviewLock(entry)
    if (unlock) { await unlock(); return }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('preview lock was not released')
}

async function fixture(useCache: boolean) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-deadline-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  const oldCap = process.env.ROOM_PREVIEW_CACHE_GB
  process.env.ROOM_PREVIEW_CACHE_GB = useCache ? '4' : '0'
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  fs.writeFileSync(path.join(root, 'app.txt'), 'BASE\n'); git('add', '.'); git('commit', '-qm', 'base')
  const killPidFile = (file: string) => { try { process.kill(Number(fs.readFileSync(file, 'utf8')), 'SIGKILL') } catch { /* gone */ } }
  return {
    root, head: git('rev-parse', 'HEAD'), killPidFile,
    async dispose(...pidFiles: string[]) {
      for (const file of pidFiles) killPidFile(file)
      if (oldCap === undefined) delete process.env.ROOM_PREVIEW_CACHE_GB
      else process.env.ROOM_PREVIEW_CACHE_GB = oldCap
      await disposePreviewFixture(root)
    },
  }
}

it('returns an incomplete result when an escaped process keeps the output pipe open past the grace deadline', async () => {
  if (!posix) return
  const f = await fixture(false)
  const pidFile = path.join(f.root, 'escaped.pid')
  try {
    setPreviewCleanupForTests({ graceMs: 500 })
    // A new process group the check cannot signal, holding the inherited stdout pipe.
    const escape = `node -e ${JSON.stringify(`const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:'inherit'}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref()`)}`
    const started = Date.now()
    const result = await runInMergedTree({ dir: f.root } as Session, f.head, new Map(), `${escape}; echo '1 passed'`)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result.passed, result.text).toBe(false)
    expect(result.text).toContain('command completion: incomplete')
    expect(result.text).toMatch(/cleanup did not finish/)
  } finally { await f.dispose(pidFile) }
}, 30_000)

it('quarantines a cached tree an escaped process may still use: later checks run elsewhere until it is quiet', async () => {
  if (!posix) return
  const f = await fixture(true)
  const pidFile = path.join(f.root, 'escaped.pid')
  try {
    setPreviewCleanupForTests({ graceMs: 500 })
    // A new process group the check cannot signal, keeping the cached tree as its cwd and the stdout pipe open.
    const escape = `node -e ${JSON.stringify(`const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:'inherit'}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref()`)}`
    const first = await runInMergedTree({ dir: f.root } as Session, f.head, new Map([['app.txt', 'FIRST\n']]), `${escape}; echo '1 passed'`)
    expect(first.text).toContain('command completion: incomplete')
    expect(first.text).toMatch(/quarantined/)
    const cache = await previewCachePath(f.root)
    setPreviewCleanupForTests()
    // The lock helper lets go once the check's own group is gone; only the quarantine still protects the tree.
    await lockFreed(cache)
    const second = await runInMergedTree({ dir: f.root } as Session, f.head, new Map([['app.txt', 'SECOND\n']]), `pwd; cat app.txt; echo '1 passed'`)
    expect(second.passed, second.text).toBe(true)
    expect(second.text).toContain('SECOND')
    expect(second.text).not.toContain(cache)
    expect(second.text).toMatch(/quarantined/)
    // Neither reset nor reused while the escaped process lives.
    expect(fs.readFileSync(path.join(cache, 'app.txt'), 'utf8')).toBe('FIRST\n')
    f.killPidFile(pidFile)
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    for (let n = 0; n < 100; n++) { try { process.kill(pid, 0) } catch { break } await new Promise(r => setTimeout(r, 50)) }
    const third = await runInMergedTree({ dir: f.root } as Session, f.head, new Map([['app.txt', 'THIRD\n']]), `pwd; cat app.txt; echo '1 passed'`)
    expect(third.passed, third.text).toBe(true)
    expect(third.text).toContain(cache)
    expect(third.text).toContain('THIRD')
    expect(fs.readFileSync(path.join(cache, 'app.txt'), 'utf8')).toBe('BASE\n')
  } finally { await f.dispose(pidFile) }
}, 60_000)

it('keeps a cached tree untouched while its process group is still reported alive', async () => {
  if (!posix) return
  const f = await fixture(true)
  try {
    setPreviewCleanupForTests({ graceMs: 300, groupAlive: async (_pid, file) => file !== 'git' })
    const result = await runInMergedTree({ dir: f.root } as Session, f.head, new Map([['app.txt', 'FIRST\n']]), `echo '1 passed'`)
    expect(result.passed, result.text).toBe(false)
    expect(result.text).toContain('command completion: incomplete')
    expect(result.text).toMatch(/is quarantined/)
    // Not reset under a possibly live tree: the merged file is still in place.
    expect(fs.readFileSync(path.join(await previewCachePath(f.root), 'app.txt'), 'utf8')).toBe('FIRST\n')
  } finally { await f.dispose() }
}, 30_000)

it('stops the check when the tool call is cancelled', async () => {
  if (!posix) return
  const f = await fixture(true)
  const pidFile = path.join(f.root, 'check.pid')
  try {
    const controller = new AbortController()
    const watcher = setInterval(() => { if (fs.existsSync(pidFile)) { clearInterval(watcher); controller.abort() } }, 20)
    const started = Date.now()
    const result = await runInMergedTree({ dir: f.root } as Session, f.head, new Map([['app.txt', 'FIRST\n']]),
      `node -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)}`,
      { signal: controller.signal })
    clearInterval(watcher)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(result.passed).toBe(false)
    expect(result.text).toMatch(/cancelled/)
    expect(result.text).toContain('command completion: incomplete')
    expect(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0)).toThrow()
    // A completed cancellation still resets the cache.
    expect(fs.readFileSync(path.join(await previewCachePath(f.root), 'app.txt'), 'utf8')).toBe('BASE\n')
  } finally { await f.dispose(pidFile) }
}, 30_000)

it('does not start a check whose tool call was already cancelled', async () => {
  if (!posix) return
  const f = await fixture(false)
  try {
    const controller = new AbortController()
    controller.abort()
    const result = await runInMergedTree({ dir: f.root } as Session, f.head, new Map(), `echo '1 passed'`, { signal: controller.signal })
    expect(result.passed).toBe(false)
    expect(result.text).toMatch(/cancelled/)
  } finally { await f.dispose() }
}, 30_000)

it('a quarantine clears only when no working directory is inside the tree, and never when that is unreadable', async () => {
  const entry = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-quarantine-')))
  try {
    expect(await clearPreviewQuarantine(entry)).toBe(true) // no marker
    await quarantinePreview(entry, 'test')
    setPreviewCwdsForTests(async () => undefined)
    expect(await clearPreviewQuarantine(entry)).toBe(false)
    setPreviewCwdsForTests(async () => ['/', path.join(entry, 'sub')])
    expect(await clearPreviewQuarantine(entry)).toBe(false)
    setPreviewCwdsForTests(async () => [entry])
    expect(await clearPreviewQuarantine(entry)).toBe(false)
    expect(fs.existsSync(previewQuarantinePath(entry))).toBe(true)
    setPreviewCwdsForTests(async () => ['/', `${entry}-sibling`])
    expect(await clearPreviewQuarantine(entry)).toBe(true)
    expect(fs.existsSync(previewQuarantinePath(entry))).toBe(false)
  } finally {
    setPreviewCwdsForTests()
    fs.rmSync(entry, { recursive: true, force: true }); fs.rmSync(previewQuarantinePath(entry), { force: true })
  }
})

it('the process probes fail closed: a partial lsof listing or an unreadable own process keeps the quarantine', async () => {
  const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  expect(lsofCwds(overflow, 'n/Users/x/elsewhere\n')).toBeUndefined()
  expect(lsofCwds(null, '')).toBeUndefined()
  expect(lsofCwds(null, 'p1\nn/a\np2\nn/b (deleted)\n')).toEqual(['/a', '/b (deleted)'])
  const err = (code: string) => Object.assign(new Error(code), { code })
  const read = (map: Record<string, string | Error>) => async (pid: string) => { const v = map[pid]; if (v instanceof Error) throw v; return v }
  // exited and foreign processes are skipped; a complete listing results
  expect(await procCwds(['1', '2', '3'], 501, read({ '1': '/a', '2': err('ENOENT'), '3': err('EACCES') }), async pid => pid === '3' ? 0 : 501)).toEqual(['/a'])
  // our own unreadable process makes the listing incomplete
  expect(await procCwds(['1', '2'], 501, read({ '1': '/a', '2': err('EACCES') }), async () => 501)).toBeUndefined()
  // any other error is incomplete
  expect(await procCwds(['1'], 501, read({ '1': err('EIO') }), async () => 501)).toBeUndefined()
  // an owner that vanished between listing and stat is an exited process
  expect(await procCwds(['1'], 501, read({ '1': err('EPERM') }), async () => undefined)).toEqual([])
  // a deleted cwd keeps its path for prefix matching
  expect(await procCwds(['1'], 501, read({ '1': '/t/x (deleted)' }), async () => 501)).toEqual(['/t/x'])
})
