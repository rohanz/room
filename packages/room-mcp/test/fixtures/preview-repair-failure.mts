import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

// Install the fault before loading files.ts, whose named execFile import is fixed at load time.
const original = cp.execFile
let own = ''
let failed = false
;(cp as unknown as { execFile: typeof cp.execFile }).execFile = ((file: string, args: string[], options: object, callback: (error: Error, stdout: string, stderr: string) => void) => {
  if (file === 'git' && args[0] === 'worktree' && args[1] === 'repair' && args[2] === own && !failed) {
    failed = true
    queueMicrotask(() => callback(new Error('injected repair failure'), '', 'injected repair failure'))
    return undefined
  }
  return original(file, args, options, callback)
}) as typeof cp.execFile
syncBuiltinESMExports()

const { previewCachePath, runInMergedTree, waitForPreviewSweepForTests } = await import('../../src/tools/files.ts')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-repair-')))
const git = (...args: string[]) => cp.execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
try {
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.test')
  fs.writeFileSync(path.join(root, 'app.txt'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const ancestor = git('rev-parse', 'HEAD')
  own = await previewCachePath(root)
  const dead = path.join(path.dirname(own), '999999999-dead')
  fs.mkdirSync(path.dirname(dead), { recursive: true })
  git('worktree', 'add', '--detach', '-q', dead, ancestor)
  const first = await runInMergedTree({ dir: root } as never, ancestor, new Map(), 'echo "1 passed"')
  assert.equal(failed, true)
  assert.equal(first.passed, true, first.text)
  assert.match(first.text, /fresh base/)
  assert.equal(fs.existsSync(`${dead}.claim`), true)
  const next = await previewCachePath(root)
  assert.notEqual(next, own)
  const second = await runInMergedTree({ dir: root } as never, ancestor, new Map(), 'echo "1 passed"')
  assert.equal(second.passed, true, second.text)
  assert.equal(fs.existsSync(next), true)
  await waitForPreviewSweepForTests()
} finally {
  ;(cp as unknown as { execFile: typeof cp.execFile }).execFile = original
  syncBuiltinESMExports()
  fs.rmSync(root, { recursive: true, force: true })
}
