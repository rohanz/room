import { describe, expect, it, vi } from 'vitest'
import { idleLabel, RoomDoc } from '@room/shared'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { IDLE_CLAIMS_MS, IDLE_LEASE_MS, PresenceEnd, idleLeaseTickMs, releaseIdleHeld, resolveIdleLeaseMs, type HostKind, type PresenceEndOptions } from '../src/presence-end.js'
import type { Session } from '../src/session.js'

const MIN = 60_000
function fixture(host: HostKind, overrides: Partial<PresenceEndOptions> = {}) {
  let now = 0
  const events: string[] = []
  const published: number[] = []
  const state = { holds: false, leads: false, waiting: false, hostAlive: undefined as boolean | undefined }
  const presence = new PresenceEnd({
    hostKind: host, tickMs: 0, mono: () => now, episodeId: 'test',
    hostAlive: () => state.hostAlive, holds: () => state.holds, leadsWorkers: () => state.leads, waiting: () => state.waiting,
    hostEnded: reason => events.push(`ended: ${reason}`),
    leave: async idle => { events.push(`leave after ${idle / MIN} min`) },
    releaseHeld: async (idle, epoch) => { events.push(`release at ${idle / MIN} min (${epoch})`); state.holds = false },
    publishIdle: minutes => published.push(minutes),
    ...overrides,
  })
  const at = async (ms: number) => { now = ms; await presence.tick() }
  return { presence, events, published, state, at, advanceTo: (ms: number) => { now = ms } }
}

describe('presence end and the idle lease (registry §18)', () => {
  it('leaves after an overridden short lease on the timer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const leaseMs = 2_000
    const { presence, events } = fixture('shared-app-server', {
      idleLeaseMs: leaseMs, tickMs: idleLeaseTickMs(leaseMs), mono: () => Date.now(),
    })
    try {
      await vi.advanceTimersByTimeAsync(leaseMs - 1)
      expect(events).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(events).toEqual([`leave after ${leaseMs / MIN} min`])
      expect(presence.hasLeft).toBe(true)
    } finally {
      presence.stop()
      vi.useRealTimers()
    }
  })

  it('accepts only positive integer lease milliseconds from the environment', () => {
    expect(resolveIdleLeaseMs('2000')).toBe(2_000)
    for (const raw of [undefined, '', '0', '-1', '1.5', '1e3', 'garbage', '9007199254740992']) {
      expect(resolveIdleLeaseMs(raw), String(raw)).toBe(IDLE_LEASE_MS)
    }
    expect(idleLeaseTickMs(500)).toBe(500)
    expect(idleLeaseTickMs(2_000)).toBe(1_000)
  })

  it('H1 refuses a lapsed or old epoch of the same host session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'idle-epoch-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      const room = new RoomDoc()
      room.participants.set('ben\0holder', { sessionId: 'same-session', epoch: 22 })
      room.claims.set('c1', { id: 'c1', path: 'x', from: 1, to: 1, by: 'ben', byKind: 'agent', intent: 'work', at: 1 })
      const lease = { sessionId: 'same-session', fence: vi.fn<() => string | undefined>(() => undefined) }
      const session = { dir, room, roomName: 'local/example', me: { name: 'ben', kind: 'agent' }, lease,
        post: vi.fn().mockResolvedValue({ ok: true }) } as unknown as Session
      expect(await releaseIdleHeld(session, 'idle-1', IDLE_CLAIMS_MS, () => IDLE_CLAIMS_MS)).toBe(false)
      expect(room.claims.has('c1')).toBe(true)
      lease.fence.mockReturnValue('21')
      expect(await releaseIdleHeld(session, 'idle-1', IDLE_CLAIMS_MS, () => IDLE_CLAIMS_MS)).toBe(false)
      expect(room.claims.has('c1')).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('an unbound app-server session with nothing held shows idle from 10 min and leaves at 30 (row 25)', async () => {
    const { presence, events, published, at } = fixture('shared-app-server')
    await at(9 * MIN)
    expect(published.at(-1)).toBe(9)
    expect(idleLabel(published.at(-1))).toBeUndefined()
    await at(10 * MIN)
    expect(idleLabel(published.at(-1))).toBe('idle 10 min')
    await at(IDLE_LEASE_MS - 1)
    expect(events).toEqual([])
    await at(IDLE_LEASE_MS)
    expect(events).toEqual(['leave after 30 min'])
    expect(presence.hasLeft).toBe(true)
    await at(IDLE_LEASE_MS + 5 * MIN)
    expect(events).toHaveLength(1)
    // Its next Room call rejoins and learns how long it was away.
    expect(presence.activity()).toBe(IDLE_LEASE_MS + 5 * MIN)
    expect(presence.hasLeft).toBe(false)
    expect(published.at(-1)).toBe(0)
  })

  it('stays present past 30 min while it holds a claim, leads a worker, waits, or is interactive (row 26)', async () => {
    for (const hold of ['holds', 'leads', 'waiting'] as const) {
      const { events, state, at } = fixture('shared-app-server')
      state[hold] = true
      await at(2 * IDLE_LEASE_MS)
      expect(events, hold).toEqual([])
    }
    const interactive = fixture('interactive')
    await interactive.at(9 * 60 * MIN)
    expect(interactive.events).toEqual([])
    expect(idleLabel(9 * 60, 2)).toBe('idle 9 h; holds 2 claims')
  })

  it('a dead bound host process ends presence on the next tick (row 27)', async () => {
    const { events, state, at } = fixture('interactive')
    state.hostAlive = true
    await at(1_000)
    expect(events).toEqual([])
    state.hostAlive = false
    await at(31_000)
    expect(events).toEqual(['ended: host session ended'])
  })

  it('H1: an app-server session holding claims releases them at 8 h, once, then leaves on the idle lease (row 28)', async () => {
    const { events, state, at, presence, advanceTo } = fixture('shared-app-server')
    state.holds = true
    await at(IDLE_CLAIMS_MS - MIN)
    expect(events).toEqual([])
    await at(IDLE_CLAIMS_MS)
    expect(events).toEqual([`release at 480 min (idle-test-1)`, 'leave after 480 min'])
    // Activity starts a new idle epoch, and the eight hours start again (row 28a).
    advanceTo(IDLE_CLAIMS_MS + MIN)
    presence.activity()
    state.holds = true
    await at(IDLE_CLAIMS_MS + 7 * 60 * MIN)
    expect(events).toHaveLength(2)
    await at(2 * IDLE_CLAIMS_MS + MIN)
    expect(events.at(-2)).toBe('release at 480 min (idle-test-2)')
  })

  it('never releases an interactive CLI session\'s claims for quiet time (row 28a)', async () => {
    const { events, state, at } = fixture('interactive')
    state.holds = true
    await at(9 * 60 * MIN)
    expect(events).toEqual([])
  })
})
