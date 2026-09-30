import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { previewCachePath, runInMergedTree } from '../src/tools/files.js'
import type { Session } from '../src/session.js'

it('places a preview checkout in a process-owned slot beneath the clone key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-slot-'))
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
    fs.writeFileSync(path.join(root, 'app.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    const cache = await previewCachePath(root)
    expect(path.basename(path.dirname(cache))).toMatch(/^[a-f0-9]{20}$/)
    expect(path.basename(cache)).toMatch(new RegExp(`^${process.pid}-.+-0$`))
    const result = await runInMergedTree({ dir: root } as Session, git('rev-parse', 'HEAD'), new Map(), 'echo "1 passed"')
    expect(result.passed, result.text).toBe(true)
    expect(git('worktree', 'list', '--porcelain')).toContain(cache)
    expect(git('worktree', 'list', '--porcelain')).toMatch(/locked room preview slot/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}, 30_000)
