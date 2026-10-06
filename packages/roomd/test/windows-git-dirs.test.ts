import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { realGitCommonDir } from '../src/git-dirs.js'
import { isOwnedWorkerWorktree } from '@room/room-mcp/worker-state'

it.skipIf(process.platform !== 'win32')('recognizes Windows Git directory aliases without accepting another repository', async () => {
  // Windows CI's TEMP contains RUNNER~1; Git emits runneradmin for linked worktrees.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-windows-common-'))
  const run = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  try {
    run(root, 'init', '-q')
    run(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'base')
    const worker = path.join(root, '.room', 'workers', 'test')
    run(root, 'worktree', 'add', '-qb', 'room/test', worker)
    const common = fs.realpathSync.native(path.join(root, '.git'))
    for (const dir of [root, fs.realpathSync.native(root), worker, fs.realpathSync.native(worker), root[0].toLowerCase() + root.slice(1)]) {
      expect(await realGitCommonDir(dir)).toBe(common)
    }
    const record = { name: 'lead+test', lead: 'lead', tag: 'test', dir: worker, branch: 'room/test' }
    expect(await isOwnedWorkerWorktree(root, record, 'lead')).toBe(true)
    const other = path.join(root, 'other')
    fs.mkdirSync(other)
    run(other, 'init', '-q')
    expect(await realGitCommonDir(other)).not.toBe(common)
    expect(await isOwnedWorkerWorktree(other, record, 'lead')).toBe(false)
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)
