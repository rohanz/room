import { afterEach, expect, it, vi } from 'vitest'
import { timeoutMs, wholeTreeTimeoutMs } from '../src/git.js'
afterEach(() => vi.unstubAllEnvs())
it('uses the fixed Git defaults even when the retired variable is set', () => {
  vi.stubEnv('ROOM_GIT_TIMEOUT_MS', '1')
  expect(timeoutMs()).toBe(30_000)
  expect(wholeTreeTimeoutMs(10)).toBe(30_150)
  expect(wholeTreeTimeoutMs()).toBe(180_000)
  expect(wholeTreeTimeoutMs(100_000)).toBe(300_000)
  expect(timeoutMs(123)).toBe(123)
  expect(wholeTreeTimeoutMs(10, 123)).toBe(123)
})
