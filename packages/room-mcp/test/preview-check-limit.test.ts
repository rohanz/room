import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { execFileLimit, runInMergedTree, setPreviewCheckLimitsForTests } from '../src/tools/files.js'
import type { Session } from '../src/session.js'

// 2026-10-16 benchmark: a check stopped at its 5-minute limit replied only "merged-tree check failed: timed out after
// 300000ms", with none of the output it had printed. The reply names the limit and keeps the same tail as a finished check.
afterEach(() => setPreviewCheckLimitsForTests())

for (const [kind, limits, cmd, limit] of [
  ['time limit', { timeoutMs: 1500, maxBuffer: 4 * 1024 * 1024 }, 'for i in $(seq 1 30); do echo "line $i"; done; sleep 30', 'the 1.5-second time limit'],
  ['output cap', { timeoutMs: 60_000, maxBuffer: 4096 }, 'for i in $(seq 1 30); do echo "line $i"; done; sleep 0.3; head -c 8192 /dev/zero | tr "\\0" x; sleep 30', 'the 4 KB output cap'],
] as const) {
  it(`reports a check stopped at its ${kind} with the limit and its output tail, never as a pass`, async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-limit-')))
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
    const oldCap = process.env.ROOM_PREVIEW_CACHE_GB
    try {
      process.env.ROOM_PREVIEW_CACHE_GB = '0'
      git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
      fs.writeFileSync(path.join(root, 'app.txt'), 'BASE\n'); git('add', '.'); git('commit', '-qm', 'base')
      setPreviewCheckLimitsForTests(limits)
      const result = await runInMergedTree({ dir: root } as Session, git('rev-parse', 'HEAD'), new Map([['app.txt', 'NEW\n']]), cmd)
      expect(result.passed).toBe(false)
      expect(result.text).toMatch(new RegExp(`^merged-tree check did not finish: ".*" was stopped at ${limit.replace('.', '\\.')} \\(check \\d+ms\\); this is NOT a pass`))
      expect(result.text).toContain('line 30')
      expect(result.text).not.toContain('line 5\n')
      expect(result.text).not.toContain('timed out after')
      expect(result.text).toContain('command completion: incomplete')
      expect(result.text).toMatch(/snapshot inputs sha256: [a-f0-9]{64}/)
      expect(result.text).toContain(`command: ${JSON.stringify(cmd)}`)
      expect(result.text).toContain('linked dependencies are not fingerprinted')
    } finally {
      if (oldCap === undefined) delete process.env.ROOM_PREVIEW_CACHE_GB
      else process.env.ROOM_PREVIEW_CACHE_GB = oldCap
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
}

it('classifies the Windows execFile limits the same way', () => {
  const limits = { timeoutMs: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 }
  expect(execFileLimit({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, limits)?.limit).toBe('the 4 MB output cap')
  expect(execFileLimit({ code: null, killed: true }, limits)?.limit).toBe('the 5-minute time limit')
  expect(execFileLimit({ code: 3, killed: false }, limits)).toBeUndefined()
  expect(execFileLimit(null, limits)).toBeUndefined()
})
