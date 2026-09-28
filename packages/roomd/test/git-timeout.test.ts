import { expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => [] as { args: string[]; timeout: number }[])
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (_file: string, args: string[], options: { timeout: number }, done: (error: Error | null, stdout: string, stderr: string) => void) => {
      calls.push({ args, timeout: options.timeout })
      const workMs = args[0] === 'ls-files' ? 90_000 : 310_000
      const timedOut = options.timeout < workMs
      done(timedOut ? Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }) : null, timedOut ? '' : 'ok', '')
    },
    execFileSync: (_file: string, args: string[], options: { timeout: number }) => {
      calls.push({ args, timeout: options.timeout })
      if (options.timeout < 90_000) throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' })
      return Buffer.from('ok')
    },
  }
})

import { gitWholeTree } from '../src/git.js'
import { boundedGitSync } from '../src/baseline.js'

it('allows a large whole-tree git step that exceeds the old 30-second limit', async () => {
  await expect(gitWholeTree('/repo', ['ls-files', '-z'], 5_705)).resolves.toBe('ok')
  expect(calls.at(-1)?.timeout).toBeGreaterThan(90_000)
})

it('caps whole-tree git time and identifies the timed-out step', async () => {
  await expect(gitWholeTree('/repo', ['ls-tree', '-rz', 'HEAD'], 50_000)).rejects.toThrow(/git ls-tree -rz HEAD failed: timed out after 300000ms/)
  expect(calls.at(-1)?.timeout).toBe(300_000)
})

it('allows a large synchronous read-tree while leaving per-file operations short', () => {
  expect(boundedGitSync('/repo', ['read-tree', 'HEAD'], { wholeTreePaths: 5_705 }).toString()).toBe('ok')
  expect(calls.at(-1)?.timeout).toBeGreaterThan(90_000)
  expect(() => boundedGitSync('/repo', ['cat-file', 'blob', 'one-file'])).toThrow(/timed out after 30000ms/)
})
