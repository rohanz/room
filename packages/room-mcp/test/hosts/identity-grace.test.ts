import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSessionAutoJoin } from '../../src/auto-join.js'
import { boundSession, writeSessionRecord } from '../../src/session.js'
import type { Session } from '../../src/session.js'
const dirs: string[] = []
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
it.each([4000, 6000])('delayed exec hook at %dms respects the five-second join grace', async delay => {
  vi.useFakeTimers()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-grace-')); dirs.push(dir)
  const bound = () => boundSession({ commonDir: dir, cwd: dir, host: 'codex', workerId: 'w', env: {} })
  const identities: (string | undefined)[] = [], logs: string[] = []
  const auto = createSessionAutoJoin({ local: true, joined: () => false,
    attempt: async () => { identities.push(bound()?.id); return {} as Session },
    adopt: async () => {}, discard: async () => {}, report: () => {}, log: line => logs.push(line),
  }, { bound }, { ROOM_WORKER_ID: 'w', ROOM_WORKER_HOST: 'codex' })
  setTimeout(() => writeSessionRecord(dir, { host: 'codex', session_id: 'exec-thread', worker_id: 'w', cwd: dir, at: Date.now(), chain: [] }), delay)
  const run = auto.ensure()
  await vi.advanceTimersByTimeAsync(3999)
  expect(identities).toEqual([])
  await vi.advanceTimersByTimeAsync(1001)
  await run
  expect(identities).toEqual([delay < 5000 ? 'exec-thread' : undefined])
  expect(logs.filter(line => line.includes('not bound'))).toEqual(delay < 5000 ? [] : ["host session not bound after 5000ms; joining under this process's id"])
  await vi.advanceTimersByTimeAsync(1000)
  expect(bound()).toEqual({ id: 'exec-thread', host: 'codex' })
})

it.each([
  [{ ROOM_WORKER_ID: 'w', ROOM_WORKER_HOST: 'codex', ROOM_HOST: 'claude' }, 5000],
  [{ ROOM_WORKER_ID: 'w', ROOM_WORKER_HOST: 'codex' }, 5000],
  [{ ROOM_WORKER_ID: 'w', ROOM_HOST: 'codex' }, 0],
  [{ ROOM_WORKER_HOST: 'codex' }, 0],
  [{ ROOM_WORKER_ID: 'w', ROOM_WORKER_HOST: 'claude' }, 0],
  [{ ROOM_WORKER_ID: 'w', ROOM_WORKER_HOST: 'unknown' }, 0],
  [{}, 0],
])('preserves initial join eligibility for %j', async (env, wait) => {
  vi.useFakeTimers()
  const attempt = vi.fn(async () => undefined)
  const auto = createSessionAutoJoin({ local: true, joined: () => false, attempt,
    adopt: async () => {}, discard: async () => {}, report: () => {}, log: () => {},
  }, { bound: () => undefined }, env)
  const run = auto.ensure()
  await vi.advanceTimersByTimeAsync(0)
  expect(attempt).toHaveBeenCalledTimes(wait ? 0 : 1)
  if (wait) {
    await vi.advanceTimersByTimeAsync(4999)
    expect(attempt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
  }
  await run
  expect(attempt).toHaveBeenCalledTimes(1)
})

it('skips the grace when the session is already bound', async () => {
  const attempt = vi.fn(async () => undefined)
  const auto = createSessionAutoJoin({ local: true, joined: () => false, attempt,
    adopt: async () => {}, discard: async () => {}, report: () => {}, log: () => {},
  }, { bound: () => ({ id: 'ready' }) }, { ROOM_WORKER_ID: 'w', ROOM_WORKER_HOST: 'codex' })
  await auto.ensure()
  expect(attempt).toHaveBeenCalledTimes(1)
})
