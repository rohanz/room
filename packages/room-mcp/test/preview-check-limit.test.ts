import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { defs, handlers, execFileLimit, runInMergedTree, setPreviewCheckLimitsForTests } from '../src/tools/files.js'
import type { HandlerState } from '../src/tools/context.js'
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
      const session = { dir: root } as Session
      const ancestor = git('rev-parse', 'HEAD')
      const merged = new Map([['app.txt', 'NEW\n']])
      const result = await runInMergedTree(session, ancestor, merged, cmd)
      expect(result.passed).toBe(false)
      expect(result.text).toMatch(new RegExp(`^merged-tree check did not finish: ".*" was stopped at ${limit.replace('.', '\\.')} \\(check \\d+ms\\); this is NOT a pass`))
      expect(result.text).toContain('line 30')
      expect(result.text).not.toContain('line 5\n')
      expect(result.text).not.toContain('timed out after')
      expect(result.text).toContain('command completion: incomplete')
      expect(result.text).toMatch(/snapshot inputs sha256: [a-f0-9]{64}/)
      expect(result.text).toContain(`command: ${JSON.stringify(cmd)}`)
      expect(result.text).toContain('linked dependencies are not fingerprinted')
      const repeat = await runInMergedTree(session, ancestor, merged, cmd)
      if (kind === 'time limit') {
        expect(result.text).toContain('Narrow the command to named tests or a single file')
        expect(result.text).toContain('identical command on unchanged inputs will be refused next time')
        expect(repeat.text).toContain('refusing repeated preview command')
        expect(repeat.text).toContain(result.text)
        const tool = handlers({ S: () => session } as unknown as HandlerState).room_preview_merge
        expect(await tool({ run: cmd, allowSlow: 'true' })).toContain('allowSlow must be a boolean')
        // Changed inputs are a new check: the worker may have fixed the hang.
        const changed = await runInMergedTree(session, ancestor, new Map([['app.txt', 'FIXED\n']]), cmd)
        expect(changed.text).toContain('merged-tree check did not finish')
        expect(changed.text).not.toContain('refusing')
        const overridden = await runInMergedTree(session, ancestor, merged, cmd, new Map(), undefined, true)
        expect(overridden.text).toContain('merged-tree check did not finish')
        expect(overridden.text).not.toContain('refusing')
        const different = await runInMergedTree(session, ancestor, merged, 'echo "1 passed"')
        expect(different.passed).toBe(true)
        expect(different.text).toMatch(/check \d+ms/)
        const otherSession = await runInMergedTree({ dir: root } as Session, ancestor, merged, cmd)
        expect(otherSession.text).not.toContain('refusing')
        // A run that finishes clears the refusal for those inputs: the slow command times out at 1.5 s,
        // completes at 60 s with allowSlow, and is then runnable again without the override.
        const slow = 'sleep 2.5; echo "1 passed"'
        expect((await runInMergedTree(session, ancestor, merged, slow)).text).toContain('did not finish')
        expect((await runInMergedTree(session, ancestor, merged, slow)).text).toContain('refusing')
        setPreviewCheckLimitsForTests({ timeoutMs: 60_000, maxBuffer: 4 * 1024 * 1024 })
        expect((await runInMergedTree(session, ancestor, merged, slow, new Map(), undefined, true)).passed).toBe(true)
        setPreviewCheckLimitsForTests(limits)
        expect((await runInMergedTree(session, ancestor, merged, slow)).text).toContain('did not finish')
      } else {
        expect(repeat.text).toContain('merged-tree check did not finish')
        expect(repeat.text).not.toContain('refusing')
        expect(result.text).not.toContain('identical command will be refused')
      }
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

it('advertises the explicit retry override as a boolean', () => {
  expect(defs.find(d => d.name === 'room_preview_merge')!.inputSchema.properties.allowSlow).toMatchObject({ type: 'boolean' })
})
