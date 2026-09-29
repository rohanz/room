import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { previewCachePath, runInMergedTree } from '../src/tools/files.js'
import type { Session } from '../src/session.js'

let repo: string
let ancestor: string
const merged = new Map<string, string | null>([['src/00/f00000.txt', 'merged zero\n'], ['src/00/f00001.txt', 'merged one\n']])
const command = 'test "$(cat src/00/f00000.txt)" = "merged zero" && test "$(cat src/00/f00001.txt)" = "merged one" && test "$(cat src/49/f04999.txt)" = "base 4999" && echo "1 passed"'
const session = () => ({ dir: repo }) as Session

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-cache-test-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  for (let i = 0; i < 5_000; i++) {
    const dir = path.join(repo, 'src', String(Math.floor(i / 100)).padStart(2, '0'))
    if (i % 100 === 0) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `f${String(i).padStart(5, '0')}.txt`), `base ${i}\n`)
  }
  fs.writeFileSync(path.join(repo, '.gitignore'), 'target/\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  ancestor = git('rev-parse', 'HEAD')
}, 120_000)

afterAll(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }) }, 120_000)

it('reuses the 5,000-file base and writes only two merged paths on a warm preview', async () => {
  const counts = { firstBase: 0, secondBase: 0, secondWrites: [] as string[] }
  const first = await runInMergedTree(session(), ancestor, merged, command, new Map(), { baseMaterialized: () => counts.firstBase++ })
  const second = await runInMergedTree(session(), ancestor, merged, command, new Map(), {
    baseMaterialized: () => counts.secondBase++, mergedWrite: rel => counts.secondWrites.push(rel),
  })
  expect(first.passed, first.text).toBe(true)
  expect(second.passed, second.text).toBe(true)
  expect(counts).toEqual({ firstBase: 1, secondBase: 0, secondWrites: ['src/00/f00000.txt', 'src/00/f00001.txt'] })
  expect(second.text).toMatch(/setup .*cached base.*check /)
}, 120_000)

it('keeps the event loop responsive throughout a preview with a check', async () => {
  let maxDelay = 0
  let previous = performance.now()
  const timer = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - previous - 10); previous = now }, 10)
  // A slow filesystem made the old synchronous deletion of 5,000 scratch files stall the MCP.
  const originalRemove = fs.rmSync.bind(fs)
  const remove = vi.spyOn(fs, 'rmSync').mockImplementation(((file: fs.PathLike, options?: fs.RmOptions) => {
    if (String(file).includes('room-merge-')) {
      const until = performance.now() + 250
      while (performance.now() < until) { /* emulate slow scratch deletion */ }
    }
    return originalRemove(file, options)
  }) as typeof fs.rmSync)
  try {
    const result = await runInMergedTree(session(), ancestor, merged, command)
    expect(result.passed, result.text).toBe(true)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  } finally { clearInterval(timer); remove.mockRestore() }
  expect(maxDelay).toBeLessThan(200)
}, 120_000)

it('repairs a dirty cache before the check and retains ignored build outputs', async () => {
  const cache = await previewCachePath(repo)
  fs.writeFileSync(path.join(cache, 'src/00/f00000.txt'), 'dirty tracked\n')
  fs.writeFileSync(path.join(cache, 'scratch-leak'), 'dirty untracked\n')
  fs.mkdirSync(path.join(cache, 'target'), { recursive: true })
  fs.writeFileSync(path.join(cache, 'target', 'warm-cache'), 'keep me\n')
  const result = await runInMergedTree(session(), ancestor, merged,
    `${command} && test ! -e scratch-leak && test -f target/warm-cache && echo "1 passed"`)
  expect(result.passed, result.text).toBe(true)
  expect(result.text).toContain('(cached base)')
  expect(fs.readFileSync(path.join(cache, 'src/00/f00000.txt'), 'utf8')).toBe('base 0\n')
  expect(fs.existsSync(path.join(cache, 'scratch-leak'))).toBe(false)
  expect(fs.readFileSync(path.join(cache, 'target', 'warm-cache'), 'utf8')).toBe('keep me\n')
}, 120_000)

it('applies merged deletions and modes without losing ancestor files', async () => {
  const changes = new Map<string, string | null>([
    ['src/00/f00002.txt', null], ['bin/check.sh', '#!/bin/sh\necho ready\n'],
  ])
  const result = await runInMergedTree(session(), ancestor, changes,
    'test ! -e src/00/f00002.txt && test -x bin/check.sh && test -f src/49/f04999.txt && echo "1 passed"',
    new Map([['bin/check.sh', 0o755]]))
  expect(result.passed, result.text).toBe(true)
  const cache = await previewCachePath(repo)
  expect(fs.readFileSync(path.join(cache, 'src/00/f00002.txt'), 'utf8')).toBe('base 2\n')
  expect(fs.existsSync(path.join(cache, 'bin/check.sh'))).toBe(false)
}, 120_000)

it('moves the cached ancestor without rebuilding the full tree', async () => {
  const rel = 'src/00/f00003.txt'
  fs.writeFileSync(path.join(repo, rel), 'new ancestor\n')
  execFileSync('git', ['-C', repo, 'add', rel])
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'move ancestor'])
  const next = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  let baseCopies = 0
  const result = await runInMergedTree(session(), next, merged,
    `${command} && test "$(cat ${rel})" = "new ancestor" && echo "1 passed"`, new Map(),
    { baseMaterialized: () => baseCopies++ })
  expect(result.passed, result.text).toBe(true)
  expect(baseCopies).toBe(0)
  expect(result.text).toContain('(cached base)')
}, 120_000)

it('uses an isolated fresh tree when two checks overlap in one clone', async () => {
  let started!: () => void
  const prepared = new Promise<void>(resolve => { started = resolve })
  const first = runInMergedTree(session(), ancestor, merged, `sleep 1; ${command}`, new Map(), {
    mergedWrite: rel => { if (rel === 'src/00/f00001.txt') started() },
  })
  await prepared
  const materializations: string[] = []
  let maxDelay = 0
  let previous = performance.now()
  const timer = setInterval(() => { const now = performance.now(); maxDelay = Math.max(maxDelay, now - previous - 10); previous = now }, 10)
  const originalRemove = fs.rmSync.bind(fs)
  const remove = vi.spyOn(fs, 'rmSync').mockImplementation(((file: fs.PathLike, options?: fs.RmOptions) => {
    if (String(file).includes('room-merge-')) {
      const until = performance.now() + 250
      while (performance.now() < until) { /* emulate slow fallback deletion */ }
    }
    return originalRemove(file, options)
  }) as typeof fs.rmSync)
  let second!: Awaited<ReturnType<typeof runInMergedTree>>
  try {
    second = await runInMergedTree(session(), ancestor, merged, command, new Map(), {
      baseMaterialized: () => materializations.push('fresh'),
    })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  } finally { clearInterval(timer); remove.mockRestore() }
  expect((await first).passed).toBe(true)
  expect(second.passed, second.text).toBe(true)
  expect(materializations).toEqual(['fresh'])
  expect(second.text).toContain('(fresh base)')
  expect(maxDelay).toBeLessThan(200)
}, 120_000)

it('recreates a preview cache after its worktree registration is broken', async () => {
  const cache = await previewCachePath(repo)
  fs.unlinkSync(path.join(cache, '.git'))
  execFileSync('git', ['-C', repo, 'worktree', 'prune'])
  let baseCopies = 0
  const result = await runInMergedTree(session(), ancestor, merged, command, new Map(), {
    baseMaterialized: () => baseCopies++,
  })
  expect(result.passed, result.text).toBe(true)
  expect(baseCopies).toBe(1)
  expect(fs.existsSync(path.join(cache, '.git'))).toBe(true)
}, 120_000)
