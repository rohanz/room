import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { cleanupWorker, pruneMissingWorkerWorktree } from '../src/worker-git.js'
import { previewCachePath, runInMergedTree } from '../src/tools/files.js'
import type { LocalWorker } from '../src/worker-status.js'
import type { Session } from '../src/session.js'

it.each([false, true])('leaves a live preview slot after worker %s cleanup', async discarded => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-worker-preview-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  try {
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    fs.writeFileSync(path.join(root, 'app.txt'), 'base\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    const workerDir = path.join(root, '.room', 'workers', 'w1')
    git('worktree', 'add', '-qb', 'room/w1', workerDir)
    const ancestor = git('rev-parse', 'HEAD')
    const preview = await runInMergedTree({ dir: workerDir } as Session, ancestor,
      new Map([['app.txt', 'combined\n']]), 'test "$(cat app.txt)" = combined && echo "1 passed"')
    expect(preview.passed, preview.text).toBe(true)
    const cache = await previewCachePath(workerDir)
    expect(fs.existsSync(cache)).toBe(true)
    expect(git('worktree', 'list', '--porcelain')).toContain(cache)
    const worker = { id: 'w_w1', tag: 'w1', name: 'lead+w1', lead: 'lead', host: 'codex', task: 'task',
      dir: workerDir, branch: 'room/w1', pid: 0, startedAt: 1, status: 'done', exitCode: 0,
      budget: { threads: 1, memGb: 1, nice: 10 }, share: 'full' } as LocalWorker
    expect(await cleanupWorker(root, worker, true, discarded, [], { list: () => [] })).toBe(true)
    expect(fs.existsSync(cache)).toBe(true)
    expect(git('worktree', 'list', '--porcelain')).toContain(cache)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}, 30_000)

it('leaves a live preview slot when the worker checkout has already vanished', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-missing-worker-preview-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  try {
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    fs.writeFileSync(path.join(root, 'app.txt'), 'base\n')
    git('add', '.')
    git('commit', '-qm', 'base')
    const workerDir = path.join(root, '.room', 'workers', 'w1')
    git('worktree', 'add', '-qb', 'room/w1', workerDir)
    const preview = await runInMergedTree({ dir: workerDir } as Session, git('rev-parse', 'HEAD'),
      new Map([['app.txt', 'combined\n']]), 'echo "1 passed"')
    expect(preview.passed, preview.text).toBe(true)
    const cache = await previewCachePath(workerDir)
    await fs.promises.rm(workerDir, { recursive: true, force: true })
    const worker = { id: 'w_w1', tag: 'w1', name: 'lead+w1', lead: 'lead', host: 'codex', task: 'task',
      dir: workerDir, branch: 'room/w1', pid: 0, startedAt: 1, status: 'done', exitCode: 0,
      budget: { threads: 1, memGb: 1, nice: 10 }, share: 'full' } as LocalWorker
    await pruneMissingWorkerWorktree(root, worker)
    expect(fs.existsSync(cache)).toBe(true)
    expect(git('worktree', 'list', '--porcelain')).toContain(cache)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}, 30_000)
