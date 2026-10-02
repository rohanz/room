// rc12 review rounds 3-4: the shared probe may hold a predecessor's identity for a reused pid for up to 2 s. A live
// successor that already holds a guard or lease must not read as dead from that cache, so a mismatch on a live pid
// is confirmed afresh; a pid that is gone is dead at once, with no fresh `ps` (R4: status reads of exited workers).
import { beforeEach, expect, it, vi } from 'vitest'

const fresh = { startTime: 'darwin:1:200', executable: 'node' }
const calls = vi.hoisted(() => ({ now: 0 }))
vi.mock('../src/process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/process.js')>()
  return { ...actual,
    probeProcess: (pid: number) => actual.pidAlive(pid) ? { startTime: 'darwin:1:100', executable: 'node' } : undefined,
    probeProcessConfirm: () => { calls.now++; return fresh } }
})
import { liveness } from '../src/leases.js'
import { probeProcess } from '../src/process.js'

beforeEach(() => { calls.now = 0 })

it('confirms a dead verdict on a live pid from the cached probe with a fresh read', () => {
  expect(liveness({ pid: process.pid, ...fresh })).toBe('alive')
  // Guard recovery passes the shared probe explicitly (withGuard, recover): the same confirmation applies.
  expect(liveness({ pid: process.pid, ...fresh }, probeProcess)).toBe('alive')
  expect(calls.now).toBe(2)
})

it('answers a vanished pid dead without a fresh read', () => {
  for (let i = 0; i < 50; i++) expect(liveness({ pid: 2 ** 30, ...fresh })).toBe('dead')
  expect(calls.now).toBe(0)
})

it('keeps an injected probe\'s verdict as it is', () => {
  expect(liveness({ pid: process.pid, ...fresh }, () => ({ startTime: 'darwin:1:100', executable: 'node' }))).toBe('dead')
  expect(calls.now).toBe(0)
})
