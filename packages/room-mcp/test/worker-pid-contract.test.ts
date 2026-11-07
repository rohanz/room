import { expect, it, vi } from 'vitest'
import { terminateWorktreeProcesses, pidPresent, workerPidPresent, workerProcessOwnership, workerProcessLive, signalWorker } from '../src/worker-process.js'

const worker = { host: 'codex' as const, processStartTime: 'recorded' }
it.each([0, undefined, null])('interprets worker PID %s as no recorded process without probing', pid => {
  const probe = vi.fn(() => ({ pending: true as const }))
  expect(workerPidPresent(pid, probe)).toBe(false)
  expect(workerProcessOwnership(pid as number, worker, probe)).toBe('not-ours')
  expect(workerProcessLive(pid as number, worker, probe)).toBe(false)
  expect(probe).not.toHaveBeenCalled()
  // The same value in a required identity is malformed, not proof of death.
  expect(pidPresent(pid as number, probe)).toBe(true)
})
it.each([-1, 1.5, 2147483648, NaN, Infinity, '42', false, {}])('preserves malformed worker PID %s as unknown', value => {
  const pid = value as number, probe = vi.fn(() => undefined)
  expect(workerPidPresent(pid, probe)).toBe(true)
  expect(workerProcessOwnership(pid, worker, probe)).toBe('unknown')
  expect(workerProcessLive(pid, worker, probe)).toBe(false)
  expect(signalWorker(pid, 'SIGTERM', undefined, () => [])).toBe(false)
  expect(probe).not.toHaveBeenCalled()
})
it('uses a valid PID probe to distinguish gone and unreadable', () => {
  expect(workerPidPresent(42, () => undefined)).toBe(false)
  expect(workerProcessOwnership(42, worker, () => undefined)).toBe('not-ours')
  expect(workerPidPresent(42, () => ({}))).toBe(true)
  expect(workerProcessOwnership(42, worker, () => ({}))).toBe('unknown')
})

it('never signals malformed enumerated PIDs during TERM or KILL', async () => {
  const signal = vi.fn(), probe = vi.fn((_pid: number) => ({}))
  const invalid = [0, -1, 1.5, 2147483648, NaN, Infinity, '42', false, {}]
  await terminateWorktreeProcesses('/room-pid-test', {
    list: () => [...invalid, 42].map(pid => ({ pid: pid as number, cwd: '/room-pid-test', command: 'test' })),
    signal, probe, sleep: async () => {},
  })
  expect(signal.mock.calls).toEqual([[42, 'SIGTERM'], [42, 'SIGKILL']])
  expect(probe.mock.calls.every(([pid]) => pid === 42)).toBe(true)
})
