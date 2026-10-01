import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFrame, encodeFrame, LEASE_TTL_MS, REQUEST_TIMEOUT_TEAM_MS, SETTLE_MS, type Frame, type Req, type Reply } from '@room/hub-core'
import { fakeClock, holder, memoryEnv, type ContractClient } from '../../hub-core/test/contract.js'
import { HubClient, type HubTransport } from '../src/hub-client.js'

class Transport implements HubTransport {
  up = true
  sent: Req[] = []
  dropRenew = false
  holdRenew = false
  held: Reply[] = []
  private frames = new Set<(bytes: Uint8Array) => void>()
  private reconnects = new Set<() => void>()
  private closes = new Set<() => void>()
  constructor(public connection: ContractClient) {}
  connected() { return this.up }
  send(bytes: Uint8Array) {
    const req = decodeFrame(bytes) as Req
    this.sent.push(req)
    if (req.op === 'renew' && this.dropRenew) return
    void this.connection.send(req).then(reply => {
      if (req.op === 'renew' && this.holdRenew) this.held.push(reply)
      else this.emit(reply)
    })
  }
  emit(frame: Frame) { for (const fn of this.frames) fn(encodeFrame(frame)) }
  onFrame(fn: (bytes: Uint8Array) => void) { this.frames.add(fn); return () => this.frames.delete(fn) }
  onReconnect(fn: () => void) { this.reconnects.add(fn); return () => this.reconnects.delete(fn) }
  onClose(fn: () => void) { this.closes.add(fn); return () => this.closes.delete(fn) }
  disconnect() { this.up = false; for (const fn of this.closes) fn() }
  reconnect() { this.up = true; for (const fn of this.reconnects) fn() }
  renews() { return this.sent.filter(r => r.op === 'renew') }
}

describe('HubClient renewal recovery against the hub harness', () => {
  const cleanups: Array<() => Promise<void>> = []
  beforeEach(() => vi.useFakeTimers())
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
    vi.useRealTimers()
  })

  async function fixture() {
    const clock = fakeClock()
    const env = await memoryEnv()(clock)
    clock.advance(SETTLE_MS)
    const transport = new Transport(await env.connect())
    let wallOffset = 0
    const client = new HubClient({ transport, client: 'codex', sessionId: 's1', local: false, mono: clock.mono, wall: () => clock.wall() + wallOffset })
    cleanups.push(async () => { client.close(); await transport.connection.close(); await env.close() })
    await client.hello()
    const epoch = await client.acquire('alice', holder('s1'))
    const advance = async (ms: number) => {
      // Keep the injected clocks and fake timers together, including intermediate retry deadlines.
      while (ms > 0) {
        const step = Math.min(ms, 1_000)
        clock.advance(step)
        await vi.advanceTimersByTimeAsync(step)
        await env.tick()
        for (const push of transport.connection.pushes.splice(0)) transport.emit(push)
        ms -= step
      }
    }
    const reconnect = async () => {
      await transport.connection.close()
      transport.connection = await env.connect()
      transport.reconnect()
      await vi.advanceTimersByTimeAsync(0)
    }
    return { client, transport, env, epoch, advance, reconnect, jumpWall: (ms: number) => { wallOffset += ms } }
  }

  it('renews immediately after a 16 s socket drop without changing incarnation or epoch', async () => {
    const { client, transport, env, epoch, advance, reconnect } = await fixture()
    const incarnation = env.incarnation()
    await advance(27_000)
    transport.disconnect()
    await advance(16_000)
    await reconnect()
    expect(transport.sent.slice(-2).map(r => r.op)).toEqual(['hello', 'renew'])
    expect(transport.renews().at(-1)).toMatchObject({ name: 'alice', epoch })
    await advance(18_000)
    expect(env.incarnation()).toBe(incarnation)
    expect(client.lease('alice')).toBe(epoch)
    expect(client.paused()).toBeUndefined()
    expect(env.doc().participants.get('alice\u0000holder')).toMatchObject({ epoch })
    expect(env.doc().participants.get('alice\u0000holder')).not.toHaveProperty('ended')
  })

  it('retries a timed-out renew after 1 s, before the next tick', async () => {
    const { client, transport, epoch, advance } = await fixture()
    transport.dropRenew = true
    await advance(15_000 + REQUEST_TIMEOUT_TEAM_MS)
    expect(transport.renews()).toHaveLength(1)
    transport.dropRenew = false
    await advance(999)
    expect(transport.renews()).toHaveLength(1)
    await advance(1)
    expect(transport.renews()).toHaveLength(2)
    expect(client.lease('alice')).toBe(epoch)
    expect(client.paused()).toBeUndefined()
    // Prove validity was extended by the retry, independently of periodic renewals.
    transport.disconnect()
    await advance(LEASE_TTL_MS - 1)
    expect(client.lease('alice')).toBe(epoch)
    await advance(1)
    expect(client.lease('alice')).toBeUndefined()
  })

  it('coalesces manual renews, the tick, and successful hellos while a renew is in flight', async () => {
    const { client, transport, advance } = await fixture()
    await advance(14_000)
    transport.holdRenew = true
    const a = client.renew('alice'), b = client.renew('alice')
    void a.catch(() => {}); void b.catch(() => {})
    await client.hello()
    await advance(1_000)
    expect(transport.renews()).toHaveLength(1)
    transport.holdRenew = false
    for (const reply of transport.held.splice(0)) transport.emit(reply)
    await Promise.all([a, b])
  })

  it('wakes a pending retry immediately on reconnect and resolves the interrupted renew', async () => {
    const { client, transport, epoch, advance, reconnect } = await fixture()
    await advance(14_000)
    transport.dropRenew = true
    const pending = client.renew('alice')
    void pending.catch(() => {})
    await advance(2_000)
    transport.disconnect()
    await advance(16_000)
    const attempts = transport.renews().length
    transport.dropRenew = false
    await reconnect()
    await pending
    expect(transport.renews()).toHaveLength(attempts + 1)
    expect(transport.sent.slice(-2).map(r => r.op)).toEqual(['hello', 'renew'])
    expect(client.lease('alice')).toBe(epoch)
    expect(client.paused()).toBeUndefined()
  })

  it('backs off 1 s, 2 s, then 4 s, without the tick bypassing a pending retry', async () => {
    const { transport, advance } = await fixture()
    // A failed send is unambiguous, allowing several backoffs to cross the 15 s tick.
    const send = transport.send.bind(transport)
    transport.send = bytes => {
      if ((decodeFrame(bytes) as Req).op === 'renew') {
        transport.sent.push(decodeFrame(bytes) as Req)
        throw new Error('temporary send failure')
      }
      send(bytes)
    }
    await advance(15_000)
    for (const ms of [1_000, 2_000, 4_000, 4_000, 4_000]) await advance(ms)
    expect(transport.renews()).toHaveLength(6)
    await advance(1_000) // The 30 s tick has passed; next retry is due at 34 s.
    expect(transport.renews()).toHaveLength(6)
    await advance(3_000)
    expect(transport.renews()).toHaveLength(7)
  })

  it('wakes a hub-requested retry delay after a successful hello', async () => {
    const { client, transport, advance } = await fixture()
    const send = transport.send.bind(transport)
    transport.send = bytes => {
      const req = decodeFrame(bytes) as Req
      if (req.op === 'renew' && transport.renews().length === 0) {
        transport.sent.push(req)
        transport.emit({ v: 1, re: req.id, ok: false, reason: 'unavailable', text: 'busy', retryMs: 4_000 })
      } else send(bytes)
    }
    await advance(15_000)
    expect(transport.renews()).toHaveLength(1)
    await client.hello()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.renews()).toHaveLength(2)
    expect(client.paused()).toBeUndefined()
  })

  it.each(['timeout', 'starting', 'wall sleep'] as const)('stops renewing and pauses at validity expiry: %s', async failure => {
    const { client, transport, jumpWall, epoch, advance } = await fixture()
    if (failure === 'starting') {
      transport.send = bytes => {
        const req = decodeFrame(bytes) as Req
        transport.sent.push(req)
        transport.emit({ v: 1, re: req.id, ok: false, reason: 'starting', text: 'starting', retryMs: 60_000 })
      }
    } else if (failure === 'timeout') transport.holdRenew = true
    else transport.dropRenew = true
    await advance(15_000)
    if (failure === 'wall sleep') jumpWall(LEASE_TTL_MS)
    else await advance(LEASE_TTL_MS - 15_000)
    expect(client.paused()).toContain('coordination paused')
    expect(client.lease('alice')).toBeUndefined()
    const sends = transport.renews().length
    // A successful but late reply cannot revive the expired client-side fence.
    for (const reply of transport.held.splice(0)) transport.emit(reply)
    transport.dropRenew = false
    await advance(60_000)
    expect(transport.renews()).toHaveLength(sends)
    expect(transport.renews().every(r => r.epoch === epoch)).toBe(true)
  })
})
