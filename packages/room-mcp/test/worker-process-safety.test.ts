import { expect, it, vi } from 'vitest'
import { terminateWorktreeProcesses } from '../src/worker-process.js'

it.each(['', '.', '.room/workers/a', process.cwd(), '/'])('refuses unsafe process cleanup root %j before inspection', async dir => {
  const list = vi.fn(() => [{ pid: 123, cwd: process.cwd(), command: 'session child' }])
  const signal = vi.fn()
  await expect(terminateWorktreeProcesses(dir, { list, signal, probe: () => ({}), sleep: async () => {} })).rejects.toThrow()
  expect(list).not.toHaveBeenCalled()
  expect(signal).not.toHaveBeenCalled()
})
