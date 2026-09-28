import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { decodeFrame, encodeFrame, LEASE_RENEW_MS, LEASE_TTL_MS, MSG_HUB, REQUEST_TIMEOUT_LOCAL_MS, REQUEST_TIMEOUT_TEAM_MS, SETTLE_MS, type Req, type Reply } from '@room/hub-core'
import type { WebsocketProvider } from 'y-websocket'
import { HubClient, hubTransport, type HubTransport } from '../src/hub-client.js'

const holder = { sessionId: 's1', pid: 12, startTime: 'now', executable: 'codex' }
const PAUSED = '[room] hub unreachable; coordination paused. Your files are unaffected; messages and claims resume when it is back.'

class FakeTransport implements HubTransport {
  up = true
  sent: Req[] = []
  answer?: (request: Req) => Omit<Reply, 'v' | 're'> | undefined
  private frames = new Set<(bytes: Uint8Array) => void>()
  private reconnects = new Set<() => void>()
  connected() { return this.up }
  send(bytes: Uint8Array) {
    const req = decodeFrame(bytes) as Req
    this.sent.push(req)
    const response = this.answer?.(req)
    if (response) queueMicrotask(() => this.emit({ v: 1, re: req.id, ...response } as Reply))
  }
  onFrame(fn: (bytes: Uint8Array) => void) { this.frames.add(fn); return () => this.frames.delete(fn) }
  onReconnect(fn: () => void) { this.reconnects.add(fn); return () => this.reconnects.delete(fn) }
  emit(frame: Reply | { v: 1; push: 'lease-lost'; name: string; epoch: number; reason: 'expired' }) {
    for (const fn of this.frames) fn(encodeFrame(frame))
  }
  reconnect() { this.up = true; for (const fn of this.reconnects) fn() }
}

function fixture(local = true) {
  const transport = new FakeTransport()
  let mono = 0; let wall = 0
  let incarnation = 1
  transport.answer = req => {
    switch (req.op) {
      case 'hello': return { ok: true, proto: 1, incarnation, ttlMs: LEASE_TTL_MS, renewMs: LEASE_RENEW_MS, authority: true }
      case 'acquire': return { ok: true, epoch: 42, ttlMs: LEASE_TTL_MS }
      case 'renew': return { ok: true, ttlMs: LEASE_TTL_MS }
      case 'release': return { ok: true }
      case 'post': return { ok: true, seq: 5, at: 1 }
    }
  }
  const client = new HubClient({ transport, client: 'codex', sessionId: 's1', local, mono: () => mono, wall: () => wall })
  return { transport, client, advance: (ms: number) => { mono += ms; wall += ms }, jumpWall: (ms: number) => { wall += ms }, setIncarnation: (v: number) => { incarnation = v } }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('HubClient', () => {
  it('allows lease-less posts after hello, before any name is acquired', async () => {
    const { client, transport } = fixture()
    await client.hello()
    expect(client.paused()).toBeUndefined()
    await client.post({ id: 'm1', type: 'note', from: 'alice' })
    expect(transport.sent.at(-1)).toMatchObject({ op: 'post', msg: { id: 'm1' } })
    client.close()
  })

  it('pauses on a lost lease until re-acquire, and release clears lease state', async () => {
    const { client, transport, jumpWall } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    jumpWall(60_000)
    expect(client.paused()).toBe(PAUSED)
    await expect(client.post({ id: 'm1', type: 'note', from: 'alice' })).rejects.toThrow('not sent: hub unreachable')
    await client.acquire('alice', holder)
    expect(client.paused()).toBeUndefined()
    await client.release('alice')
    expect(client.paused()).toBeUndefined()
    await client.post({ id: 'm2', type: 'note', from: 'alice' })
    expect(transport.sent.at(-1)?.op).toBe('post')
    client.close()
  })

  it('requires an explicitly supplied post lease to match a valid local lease', async () => {
    const { client, transport } = fixture()
    await client.hello()
    await expect(client.post({ id: 'm1', type: 'note', from: 'alice' }, { lease: { name: 'alice', epoch: 42 } })).rejects.toThrow('not sent: hub unreachable')
    expect(transport.sent.filter(r => r.op === 'post')).toHaveLength(0)
    await client.acquire('alice', holder)
    await client.post({ id: 'm2', type: 'note', from: 'alice' }, { lease: { name: 'alice', epoch: 42 } })
    expect(transport.sent.at(-1)?.op).toBe('post')
    client.close()
  })

  it('times out requests at the selected local or team limit', async () => {
    for (const local of [true, false]) {
      const { client, transport } = fixture(local)
      transport.answer = () => undefined
      const result = expect(client.hello()).rejects.toThrow('the hub did not answer')
      await vi.advanceTimersByTimeAsync((local ? REQUEST_TIMEOUT_LOCAL_MS : REQUEST_TIMEOUT_TEAM_MS) - 1)
      expect(client.paused()).toBe(PAUSED)
      await vi.advanceTimersByTimeAsync(1)
      await result
      expect(client.paused()).toContain('the hub did not answer')
      client.close()
    }
  })

  it('measures TTL from send time, even if the acknowledgement arrives late', async () => {
    const { client, transport, advance } = fixture()
    await client.hello()
    transport.answer = req => req.op === 'acquire' ? undefined : { ok: true }
    const pending = client.acquire('alice', holder)
    const req = transport.sent.at(-1)!
    advance(4_000)
    transport.emit({ v: 1, re: req.id, ok: true, epoch: 42, ttlMs: LEASE_TTL_MS })
    await pending
    advance(LEASE_TTL_MS - 4_000)
    expect(client.paused()).toBe(PAUSED)
    client.close()
  })

  it('pauses after a wall clock sleep even when monotonic time does not advance', async () => {
    const { client, jumpWall } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    jumpWall(60_000)
    expect(client.paused()).toBe(PAUSED)
    await expect(client.post({ id: 'm1', type: 'note', from: 'alice' })).rejects.toThrow('not sent: hub unreachable')
    client.close()
  })

  it('drops a lease on stale and on lease-lost push', async () => {
    const { client, transport } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    transport.answer = req => req.op === 'renew' ? { ok: false, reason: 'stale', text: 'stale' } : { ok: true }
    await expect(client.renew('alice')).rejects.toThrow('stale')
    expect(client.paused()).toBe(PAUSED)
    transport.answer = req => req.op === 'acquire' ? { ok: true, epoch: 43, ttlMs: LEASE_TTL_MS } : { ok: true }
    await client.acquire('alice', holder)
    transport.emit({ v: 1, push: 'lease-lost', name: 'alice', epoch: 43, reason: 'expired' })
    expect(client.paused()).toBe(PAUSED)
    client.close()
  })

  it('renews held leases every 15 seconds', async () => {
    const { client, transport, advance } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    advance(LEASE_RENEW_MS)
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS)
    expect(transport.sent.filter(r => r.op === 'renew')).toHaveLength(1)
    expect(client.paused()).toBeUndefined()
    client.close()
  })

  it('retries starting renews after retryMs without pausing a still-valid lease', async () => {
    const { client, transport, advance } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    let renews = 0
    transport.answer = req => req.op === 'renew' && ++renews === 1
      ? { ok: false, reason: 'starting', text: 'starting', retryMs: 1_000 }
      : { ok: true, ttlMs: LEASE_TTL_MS }
    const pending = client.renew('alice')
    await Promise.resolve()
    expect(client.paused()).toBeUndefined()
    advance(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await pending
    expect(renews).toBe(2)
    client.close()
  })

  it('bounds repeated starting replies by request timeout plus settle time', async () => {
    const { client, transport } = fixture()
    transport.answer = req => req.op === 'hello'
      ? { ok: false, reason: 'starting', text: 'starting', retryMs: 1_000 }
      : undefined
    const result = expect(client.hello()).rejects.toMatchObject({ reason: 'starting' })
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_LOCAL_MS + SETTLE_MS)
    await result
    expect(transport.sent.filter(r => r.op === 'hello').length).toBeLessThanOrEqual(11)
    expect(client.paused()).toBe(PAUSED)
    client.close()
  })

  it('re-hellos after reconnect and renews the existing epoch on a new incarnation', async () => {
    const { client, transport, setIncarnation } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    setIncarnation(2)
    transport.reconnect()
    await vi.waitFor(() => expect(transport.sent.filter(r => r.op === 'renew')).toHaveLength(1))
    expect(transport.sent.at(-2)?.op).toBe('hello')
    expect(transport.sent.at(-1)).toMatchObject({ op: 'renew', name: 'alice', epoch: 42 })
    client.close()
  })
})

it('hubTransport forwards type-7 frames after y-websocket consumes the type byte', () => {
  const handlers: Array<(...args: any[]) => void> = []
  const provider = {
    messageHandlers: handlers,
    wsconnected: true,
    ws: { send: vi.fn() },
    on: vi.fn(), off: vi.fn(),
  } as unknown as WebsocketProvider
  const transport = hubTransport(provider)
  const received: unknown[] = []
  const unsubscribe = transport.onFrame(bytes => received.push(decodeFrame(bytes)))
  const frame = { v: 1, re: 'r1', ok: true, incarnation: 4 } as const
  const decoder = decoding.createDecoder(encodeFrame(frame))
  expect(decoding.readVarUint(decoder)).toBe(MSG_HUB)
  const encoder = encoding.createEncoder()
  handlers[MSG_HUB](encoder, decoder, provider, true, MSG_HUB)
  expect(received).toEqual([frame])
  expect(encoding.length(encoder)).toBe(0)
  unsubscribe()
})
