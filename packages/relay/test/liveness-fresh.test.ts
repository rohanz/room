// rc12 review round 3: the shared probe may hold a predecessor's identity for a reused pid for up to 2 s. A live
// successor that already holds a guard or lease must not read as dead from that cache: "dead" is confirmed afresh.
import { expect, it, vi } from 'vitest'

const fresh = { startTime: 'darwin:1:200', executable: 'node' }
vi.mock('../src/process.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/process.js')>()
  return { ...actual, probeProcess: () => ({ startTime: 'darwin:1:100', executable: 'node' }), probeProcessNow: () => fresh }
})
import { liveness } from '../src/leases.js'

it('confirms a dead verdict from the cached probe with a fresh read', async () => {
  const { probeProcess } = await import('../src/process.js')
  expect(liveness({ pid: 4242, ...fresh })).toBe('alive')
  // Guard recovery passes the shared probe explicitly (withGuard, recover): the same confirmation applies.
  expect(liveness({ pid: 4242, ...fresh }, probeProcess)).toBe('alive')
})

it('keeps an injected probe\'s verdict as it is', () => {
  expect(liveness({ pid: 4242, ...fresh }, () => ({ startTime: 'darwin:1:100', executable: 'node' }))).toBe('dead')
})
