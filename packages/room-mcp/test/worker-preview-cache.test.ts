import { disposePreviewFixture } from './fixtures/preview-disposal.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { cleanupWorker, pruneMissingWorkerWorktree } from '../src/worker-git.js'
import { previewCachePath, runInMergedTree, waitForPreviewSweepForTests } from '../src/tools/files.js'
import { tryPreviewLock } from '../src/preview-cache.js'
import type { LocalWorker } from '../src/worker-status.js'
import type { Session } from '../src/session.js'

// The cache needs lockf/flock; elsewhere previews use temporary trees and leave nothing to reclaim.
const cacheHost = process.platform === 'darwin' || process.platform === 'linux'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await disposePreviewFixture(root, { registries: [root] })
})

async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-worker-preview-')))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(root, 'app.txt'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const workerDir = path.join(root, '.room', 'workers', 'w1')
  git('worktree', 'add', '-qb', 'room/w1', workerDir)
  const head = git('rev-parse', 'HEAD')
  const preview = await runInMergedTree({ dir: workerDir } as Session, head,
    new Map([['app.txt', 'combined\n']]), 'test "$(cat app.txt)" = combined && echo "1 passed"')
  expect(preview.passed, preview.text).toBe(true)
  await waitForPreviewSweepForTests()
  const cache = await previewCachePath(workerDir)
  const worker = { id: 'w_w1', tag: 'w1', name: 'lead+w1', lead: 'lead', host: 'codex', task: 'task',
    dir: workerDir, branch: 'room/w1', pid: 0, startedAt: 1, status: 'done', exitCode: 0,
    budget: { threads: 1, memGb: 1, nice: 10 }, share: 'full' } as LocalWorker
  const listed = () => git('worktree', 'list', '--porcelain')
  return { root, git, head, workerDir, cache, worker, listed }
}

it.runIf(cacheHost).each([false, true])('removes the worker clone\'s idle preview cache on cleanup (discarded: %s)', async discarded => {
  const { root, cache, worker, listed } = await fixture()
  expect(fs.existsSync(cache)).toBe(true)
  expect(listed()).toMatch(new RegExp(`${cache.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[^]*?locked`))
  expect(await cleanupWorker(root, worker, true, discarded, [], { list: () => [] })).toBe(true)
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(cache)).toBe(false)
  expect(listed()).not.toContain(cache)
  expect(fs.existsSync(path.dirname(cache))).toBe(false)
}, 30_000)

it.runIf(cacheHost)('removes the cache when the worker checkout has already vanished', async () => {
  const { root, workerDir, cache, worker, listed } = await fixture()
  await fs.promises.rm(workerDir, { recursive: true, force: true })
  await pruneMissingWorkerWorktree(root, worker)
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(cache)).toBe(false)
  expect(listed()).not.toContain(cache)
}, 30_000)

it.runIf(cacheHost)('reclaims a locked cache left by a clone that is gone on the next preview', async () => {
  // The 2026-10-22 leak: an earlier build kept the worker's entry, locked against git worktree prune,
  // after the worker worktree was removed; nothing recorded or reclaimed it.
  const { root, git, head, cache, workerDir, listed } = await fixture()
  git('worktree', 'remove', '--force', workerDir)
  git('worktree', 'prune')
  expect(listed()).toContain(cache)
  const lead = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  expect(lead.passed, lead.text).toBe(true)
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(cache)).toBe(false)
  expect(listed()).not.toContain(cache)
  expect(fs.existsSync(path.dirname(cache))).toBe(false)
  // The lead's own entry stays warm.
  expect(fs.existsSync(await previewCachePath(root))).toBe(true)
}, 30_000)

it.runIf(cacheHost)('leaves an entry whose preview still holds the lock, and reclaims it once the holder exits', async () => {
  const { root, head, cache, worker, listed } = await fixture()
  const holder = await tryPreviewLock(cache)
  expect(holder).toBeDefined()
  try {
    expect(await cleanupWorker(root, worker, true, true, [], { list: () => [] })).toBe(true)
    await waitForPreviewSweepForTests()
    expect(fs.existsSync(path.join(cache, '.git'))).toBe(true)
    expect(listed()).toContain(cache)
  } finally { await holder!() }
  const lead = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  expect(lead.passed, lead.text).toBe(true)
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(cache)).toBe(false)
  expect(listed()).not.toContain(cache)
}, 30_000)

it.runIf(cacheHost)('removes a partial first checkout left by a killed preview of a gone clone', async () => {
  const { root, git, head, cache, workerDir, listed } = await fixture()
  git('worktree', 'remove', '--force', workerDir)
  // Simulate a kill during `git worktree add`: an unregistered directory with no .git.
  git('worktree', 'unlock', cache)
  git('worktree', 'remove', '--force', cache)
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(path.join(cache, 'app.txt'), 'partial\n')
  const lead = await runInMergedTree({ dir: root } as Session, head, new Map(), 'echo "1 passed"')
  expect(lead.passed, lead.text).toBe(true)
  await waitForPreviewSweepForTests()
  expect(fs.existsSync(cache)).toBe(false)
  expect(listed()).not.toContain(cache)
}, 30_000)
