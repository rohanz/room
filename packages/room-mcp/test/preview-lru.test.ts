import { disposePreviewFixture } from './fixtures/preview-disposal.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { evictPreviewLru, previewCapBytes, previewMetaPath, setPreviewLockUnavailableForTests, touchPreview, tryPreviewLock } from '../src/preview-cache.js'
import { previewCachePath, runInMergedTree, waitForPreviewSweepForTests } from '../src/tools/files.js'
import * as roomGit from '@room/roomd/git'
import type { Session } from '../src/session.js'

const gitPasses = vi.hoisted(() => ({ active: false, commands: [] as string[][] }))
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const commandArgs = Array.isArray(args[1]) ? args[1] : []
    if (gitPasses.active && args[0] === 'git' && commandArgs[0] === 'worktree') gitPasses.commands.push(commandArgs)
    return actual.spawn(...args)
  } }
})

const roots: string[] = []
const maintenanceRoots = new Set<string>()
const originalCap = process.env.ROOM_PREVIEW_CACHE_GB
const originalPath = process.env.PATH
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (maintenanceRoots.has(root)) await disposePreviewFixture(root)
    else await fs.promises.rm(root, { recursive: true, force: true })
  }
  maintenanceRoots.clear()
  gitPasses.active = false
  gitPasses.commands.length = 0
  vi.restoreAllMocks()
  setPreviewLockUnavailableForTests()
  process.env.PATH = originalPath
  if (originalCap === undefined) delete process.env.ROOM_PREVIEW_CACHE_GB
  else process.env.ROOM_PREVIEW_CACHE_GB = originalCap
})

it('uses du allocation before the bounded walk and falls back when du fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-du-'))
  roots.push(root)
  const entry = path.join(root, 'entry')
  fs.mkdirSync(entry)
  fs.writeFileSync(path.join(entry, 'data'), 'content')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const du = path.join(bin, 'du')
  fs.writeFileSync(du, '#!/bin/sh\nprintf "2048\\t%s\\n" "$2"\n', { mode: 0o755 })
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`
  await touchPreview(entry, 4 * 1024 ** 3)
  expect(JSON.parse(fs.readFileSync(previewMetaPath(entry), 'utf8')).bytes).toBe(2048 * 1024)
  fs.writeFileSync(du, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await touchPreview(entry, 4 * 1024 ** 3)
  expect(JSON.parse(fs.readFileSync(previewMetaPath(entry), 'utf8')).bytes).toBeGreaterThan(0)
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-lru-'))
  roots.push(root)
  maintenanceRoots.add(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
  fs.writeFileSync(path.join(root, 'app.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  return { root, git, head: git('rev-parse', 'HEAD') }
}

it('allows only one holder and releases a dead holder through the OS', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-lock-'))
  roots.push(root)
  const entry = path.join(root, 'shared')
  const release = await tryPreviewLock(entry)
  expect(release).toBeTypeOf('function')
  expect(await tryPreviewLock(entry)).toBeUndefined()
  await release!()
  const recovered = await tryPreviewLock(entry)
  expect(recovered).toBeTypeOf('function')
  await recovered!()
})

it('recovers the lock after a holder process is killed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-dead-lock-'))
  roots.push(root)
  const entry = path.join(root, 'shared')
  const script = `import { tryPreviewLock } from './src/preview-cache.ts'; await tryPreviewLock(${JSON.stringify(entry)}); process.stdout.write('READY')`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: path.join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', data => String(data).includes('READY') && resolve())
      child.once('exit', code => reject(new Error(`holder exited ${code}`)))
    })
    expect(await tryPreviewLock(entry)).toBeUndefined()
  } finally { child.kill('SIGKILL') }
  await new Promise<void>(resolve => child.once('close', () => resolve()))
  let recovered: Awaited<ReturnType<typeof tryPreviewLock>>
  for (let n = 0; n < 50 && !recovered; n++) {
    recovered = await tryPreviewLock(entry)
    if (!recovered) await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(recovered).toBeTypeOf('function')
  await recovered!()
})

it('evicts oldest entries, skips a held entry, and counts a large tree above cap', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-lru-'))
  roots.push(root)
  const key = path.join(root, 'a'.repeat(20))
  fs.mkdirSync(key)
  const entries = [1, 2, 3].map(n => path.join(key, `shared-${String(n).repeat(16)}`))
  for (const [i, entry] of entries.entries()) {
    fs.mkdirSync(entry)
    fs.writeFileSync(previewMetaPath(entry), JSON.stringify({ bytes: 10, used: i + 1 }))
  }
  const held = await tryPreviewLock(entries[0]); expect(held).toBeTypeOf('function')
  const removed: string[] = []
  await evictPreviewLru(root, 10, async entry => {
    const unlock = await tryPreviewLock(entry)
    if (!unlock) return false
    removed.push(entry)
    await unlock()
    return true
  })
  expect(removed).toEqual(entries.slice(1))
  await held!()
  fs.writeFileSync(path.join(entries[0], 'large'), 'large')
  await touchPreview(entries[0], 1, 9)
  expect(JSON.parse(fs.readFileSync(previewMetaPath(entries[0]), 'utf8')).bytes).toBeGreaterThan(1)
})

it('passes observed recency so eviction can reject an entry touched after its scan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-recency-'))
  roots.push(root)
  const key = path.join(root, 'b'.repeat(20))
  fs.mkdirSync(key)
  const entry = path.join(key, 'shared-' + '1'.repeat(16))
  fs.mkdirSync(entry)
  fs.writeFileSync(previewMetaPath(entry), JSON.stringify({ bytes: 20, used: 1 }))
  await evictPreviewLru(root, 10, async (candidate, used) => {
    expect(candidate).toBe(entry)
    fs.writeFileSync(previewMetaPath(entry), JSON.stringify({ bytes: 20, used: 2 }))
    const current = JSON.parse(fs.readFileSync(previewMetaPath(entry), 'utf8')) as { used: number }
    return current.used === used
  })
  expect(fs.existsSync(entry)).toBe(true)
})

it('uses a fresh tree when cap is zero and reuses the shared entry otherwise', async () => {
  const { root, git, head } = fixture()
  const run = () => runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  process.env.ROOM_PREVIEW_CACHE_GB = '0'
  expect(previewCapBytes()).toBe(0)
  expect((await run()).text).toContain('fresh base')
  expect(fs.existsSync(await previewCachePath(root))).toBe(false)
  process.env.ROOM_PREVIEW_CACHE_GB = '4'
  expect((await run()).text).toContain('fresh base')
  expect((await run()).text).toContain('cached base')
  expect(git('worktree', 'list', '--porcelain')).toContain(await previewCachePath(root))
})

it('purges a previously warm entry when the cap changes to zero', async () => {
  const { root, head } = fixture()
  const entry = await previewCachePath(root)
  expect((await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')).passed).toBe(true)
  expect(fs.existsSync(entry)).toBe(true)
  process.env.ROOM_PREVIEW_CACHE_GB = '0'
  const result = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(result.text).toContain('fresh base')
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(entry)).toBe(false)
})

it('uses temporary trees without a host lock command and leaves no cache entry', async () => {
  const { root, head } = fixture()
  const cache = await previewCachePath(root)
  setPreviewLockUnavailableForTests(true)
  for (let n = 0; n < 2; n++) {
    const result = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
    expect(result.passed, result.text).toBe(true)
    expect(result.text).toContain('fresh base')
  }
  expect(fs.existsSync(cache)).toBe(false)
  expect(fs.existsSync(`${cache}.lock`)).toBe(false)
})

it('falls back immediately when another preview holds the shared entry', async () => {
  const { root, head } = fixture()
  const cache = await previewCachePath(root)
  const release = await tryPreviewLock(cache)
  expect(release).toBeTypeOf('function')
  try {
    const result = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
    expect(result.passed, result.text).toBe(true)
    expect(result.text).toContain('fresh base')
  } finally { await release!() }
})

it('removes a dead pre-release slot through Git before creating the shared entry', async () => {
  const { root, git } = fixture()
  fs.writeFileSync(path.join(root, '.gitignore'), 'target/\n')
  git('add', '.gitignore'); git('commit', '-qm', 'ignore build')
  const currentHead = git('rev-parse', 'HEAD')
  const cache = await previewCachePath(root)
  const old = path.join(path.dirname(cache), '999999999-dead-start-0')
  fs.mkdirSync(path.dirname(old), { recursive: true })
  git('worktree', 'add', '--detach', '-q', old, currentHead)
  fs.mkdirSync(path.join(old, 'target'))
  fs.writeFileSync(path.join(old, 'target', 'warm'), 'yes')
  const result = await runInMergedTree({ dir: root } as Session, currentHead, new Map(), 'test ! -e target/warm && echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  expect(result.text).toContain('fresh base')
  expect(fs.existsSync(old)).toBe(false)
  expect(git('worktree', 'list', '--porcelain')).not.toContain(old)
})

it('removes an oversized worktree through Git after a preview', async () => {
  const { root, git, head } = fixture()
  process.env.ROOM_PREVIEW_CACHE_GB = '0.0000001'
  const cache = await previewCachePath(root)
  const result = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  expect(result.passed, result.text).toBe(true)
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(cache)).toBe(false)
  expect(git('worktree', 'list', '--porcelain')).not.toContain(cache)
})


it('evicts only cache entries without global Git worktree list or prune commands', async () => {
  const { root, git, head } = fixture()
  const missing = path.join(root, 'temporarily-offline')
  git('worktree', 'add', '--detach', '-q', missing, head)
  fs.rmSync(missing, { recursive: true, force: true })
  // An eligible stale user registration makes a global prune observably destructive.
  git('config', 'gc.worktreePruneExpire', 'now')
  const entry = await previewCachePath(root)
  expect((await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')).passed).toBe(true)
  await waitForPreviewSweepForTests()
  const actual = roomGit.git, globalPasses = gitPasses.commands
  gitPasses.active = true
  vi.spyOn(roomGit, 'git').mockImplementation((...args) => {
    if (args[1][0] === 'worktree') globalPasses.push(args[1])
    return actual(...args)
  })
  process.env.ROOM_PREVIEW_CACHE_GB = '0'
  expect((await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')).passed).toBe(true)
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(entry)).toBe(false)
  expect(globalPasses.some(args => args[1] === 'remove')).toBe(true)
  expect(globalPasses.filter(args => ['list', 'prune'].includes(args[1]))).toEqual([])
  expect(git('worktree', 'list', '--porcelain')).toContain(missing)
})
