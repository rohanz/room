import { describe, expect, it, vi } from 'vitest'
import { idleLabel, RoomDoc } from '@room/shared'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { IDLE_CLAIMS_MS, IDLE_LEASE_MS, joinedPresenceWorkers, PresenceEnd, attachingParentReader, hostRecordAlive, hostSessionAlive, idleLeaseTickMs, releaseIdleHeld, type HostKind, type PresenceEndOptions } from '../src/presence-end.js'
import type { ProcessInfo } from '@room/relay/process'
import { writeSessionRecord, type Session } from '../src/session.js'

import { closeRegistryForDir, WorkerRegistry } from '../src/worker-registry.js'
import { seedRegistryWorker } from './registry-fixture.js'

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

it('keeps presence when worker evidence becomes blocked during projectable acquisition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'presence-blocked-worker-'))
  let spy: ReturnType<typeof vi.spyOn> | undefined
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const { registry, record } = await seedRegistryWorker(dir, 'blocked-presence')
    const snapshot = WorkerRegistry.prototype.snapshot
    spy = vi.spyOn(WorkerRegistry.prototype, 'snapshot').mockImplementationOnce(async function (this: WorkerRegistry, query) {
      const facts = await snapshot.call(this, query)
      writeFileSync(join(registry.root, 'workers', `${record.id}.json`), '{malformed')
      return facts
    })
    const s = { dir, roomName: record.room, me: { name: record.lead.participant } } as Session
    expect(await joinedPresenceWorkers([s])).toBe(true)
  } finally { spy?.mockRestore(); await closeRegistryForDir(dir); rmSync(dir, { recursive: true, force: true }) }
})

describe('presence end and the idle lease (registry §18)', () => {
  it('keeps a bound session with a chain but no hostPid even when its processes are gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'presence-no-host-pid-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      vi.stubEnv('ROOM_HOST', 'claude')
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'no-host-pid')
      writeSessionRecord(join(dir, '.git'), { session_id: 'no-host-pid', host: 'claude', cwd: dir, at: 1,
        chain: [{ pid: 2147483647, startTime: 'gone', executable: 'sh' }] })
      expect(await hostSessionAlive(dir, undefined)).toEqual({ alive: undefined })
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) }
  })

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

  it('bounds the tick for explicitly injected short test leases', () => {
    expect(IDLE_LEASE_MS).toBe(30 * 60_000)
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

  it('logs a stale host verdict once and keeps presence; ends when the verdict turns false', async () => {
    const log: string[] = []
    const { events, state, at } = fixture('interactive', { log: line => log.push(line) })
    const stale = { alive: undefined, stale: 'recorded host pid 9 is gone but this session\'s host (pid 7, codex) still runs; ending on stdin close instead' }
    ;(state as { hostAlive: unknown }).hostAlive = stale
    await at(31_000)
    await at(61_000)
    expect(events).toEqual([])
    expect(log).toEqual(['host liveness: ' + stale.stale])
    ;(state as { hostAlive: unknown }).hostAlive = { alive: false }
    await at(91_000)
    expect(events).toEqual(['ended: host session ended'])
  })

  it('reads the attaching parent identity until it is readable, then keeps it', () => {
    const reads: number[] = []
    let readable = false
    const read = attachingParentReader(pid => { reads.push(pid); return readable ? { startTime: 'linux:boot:1', executable: 'codex' } : {} }, 7)
    expect(read()).toBeUndefined()
    readable = true
    expect(read()).toEqual({ pid: 7, startTime: 'linux:boot:1', executable: 'codex' })
    readable = false
    expect(read()).toEqual({ pid: 7, startTime: 'linux:boot:1', executable: 'codex' })
    expect(reads).toEqual([7, 7])
  })

  it('latches an async parent without blocking ticks or depending on the cache TTL', async () => {
    let finish!: (info: ProcessInfo) => void
    const asyncProbe = vi.fn(() => new Promise<ProcessInfo>(resolve => { finish = resolve }))
    const read = attachingParentReader(() => ({}), 7, asyncProbe)
    expect(read()).toBeUndefined()
    expect(read()).toBeUndefined()
    await Promise.resolve()
    expect(asyncProbe).toHaveBeenCalledExactlyOnceWith(7)
    finish({ startTime: 'windows:birth', executable: 'codex' })
    await vi.waitFor(() => expect(read()).toEqual({ pid: 7, startTime: 'windows:birth', executable: 'codex' }))
    expect(asyncProbe).toHaveBeenCalledTimes(1)
  })

  it('retries an unreadable async parent on a later tick', async () => {
    const asyncProbe = vi.fn().mockRejectedValueOnce(new Error('CIM unavailable'))
      .mockResolvedValueOnce({ startTime: 'windows:birth', executable: 'codex' })
    const read = attachingParentReader(() => ({}), 7, asyncProbe)
    expect(read()).toBeUndefined()
    // Let the failed read and its finally handler settle before the next tick.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(read()).toBeUndefined()
    await vi.waitFor(() => expect(read()).toEqual({ pid: 7, startTime: 'windows:birth', executable: 'codex' }))
    expect(asyncProbe).toHaveBeenCalledTimes(2)
  })

  describe('a recorded host pid that is gone', () => {
    // pid 7 is the MCP's parent, alive throughout; pid 9 is the pid the session record named as the host.
    const parent = { pid: 7, startTime: 'linux:boot:100', executable: 'codex' }
    const probeWith = (table: Record<number, ProcessInfo | undefined>) => (pid: number) => table[pid]

    it('is reported alive while its recorded identity still runs', () => {
      const probe = probeWith({ 7: parent, 9: { startTime: 'linux:boot:50', executable: 'codex' } })
      const record = { hostPid: 9, chain: [{ pid: 9, startTime: 'linux:boot:50', executable: 'codex' }] }
      expect(hostRecordAlive(record, parent, probe)).toEqual({ alive: true })
    })

    it('does not end the session while the process that attached the MCP still runs (Windows launcher or stale record)', () => {
      const probe = probeWith({ 7: parent, 9: undefined })
      const record = { hostPid: 9, chain: [{ pid: 9, startTime: 'linux:boot:50', executable: 'codex' }] }
      const verdict = hostRecordAlive(record, parent, probe)
      expect(verdict.alive).toBeUndefined()
      expect(verdict.stale).toContain('recorded host pid 9 is gone')
      expect(verdict.stale).toContain('pid 7, codex')
      // A chain holding only a hook interpreter names no host: unknown, whatever the operating system's pids are.
      expect(hostRecordAlive({ hostPid: 9, chain: [{ pid: 9, startTime: 'linux:boot:50', executable: 'cmd' }] }, parent, probe).alive).toBeUndefined()
    })

    it('treats a reused host pid like a gone one', () => {
      const probe = probeWith({ 7: parent, 9: { startTime: 'linux:boot:900', executable: 'ContainerMetadataExtractor' } })
      const record = { hostPid: 9, chain: [{ pid: 9, startTime: 'linux:boot:50', executable: 'codex' }] }
      expect(hostRecordAlive(record, parent, probe).alive).toBeUndefined()
    })

    it('ends the session once the attaching parent is gone too', () => {
      const probe = probeWith({ 7: undefined, 9: undefined })
      const record = { hostPid: 9, chain: [{ pid: 9, startTime: 'linux:boot:50', executable: 'codex' }] }
      expect(hostRecordAlive(record, parent, probe)).toEqual({ alive: false })
    })

    it('with an unreadable parent identity, keeps the session while the parent pid exists (slow Windows CIM reads)', () => {
      const probe = probeWith({ 9: undefined })
      const record = { hostPid: 9, chain: [{ pid: 9, startTime: 'linux:boot:50', executable: 'codex' }] }
      const verdict = hostRecordAlive(record, undefined, probe, 7, pid => pid === 7)
      expect(verdict.alive).toBeUndefined()
      expect(verdict.stale).toContain('pid 7, identity unread')
    })

    it('with an unreadable parent identity, ends the session once the parent pid is gone', () => {
      const probe = probeWith({ 9: undefined })
      const record = { hostPid: 9, chain: [{ pid: 9, startTime: 'linux:boot:50', executable: 'codex' }] }
      expect(hostRecordAlive(record, undefined, probe, 7, () => false)).toEqual({ alive: false })
    })
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


it.each(['activity', 'stop'] as const)('does not expire presence when %s arrives during an awaited worker decision', async action => {
  let resolve!: (value: boolean) => void
  let entered!: () => void
  const waiting = new Promise<void>(done => { entered = done })
  const decision = new Promise<boolean>(done => { resolve = done })
  const f = fixture('shared-app-server', { leadsWorkers: () => { entered(); return decision } })
  try {
    f.advanceTo(IDLE_LEASE_MS + 1)
    const tick = f.presence.tick()
    await waiting
    if (action === 'activity') f.presence.activity()
    else f.presence.stop()
    resolve(false)
    await tick
    expect(f.presence.hasLeft).toBe(false)
    expect(f.events).toEqual([])
  } finally { f.presence.stop() }
})

it('ignores a live shared supervisor when the nearest background Claude host died', () => {
  const chain = [
    { pid: 49716, startTime: 'bg', executable: 'claude bg-spare' },
    { pid: 49656, startTime: 'pty', executable: 'claude bg-pty-host' },
    { pid: 41119, startTime: 'supervisor', executable: 'claude' },
  ]
  expect(hostRecordAlive({ host: 'claude', hostPid: 41119, chain }, undefined,
    pid => chain.find(p => p.pid === pid && pid === 41119), 1, () => false)).toEqual({ alive: false })
})

it('reports unknown, not dead, when a record carries no host evidence', () => {
  const chain = [{ pid: 3, startTime: 'shell', executable: 'zsh' }]
  expect(hostRecordAlive({ host: 'claude', chain } as unknown as Parameters<typeof hostRecordAlive>[0], undefined,
    () => undefined, 1, () => false)).toEqual({ alive: undefined })
})
