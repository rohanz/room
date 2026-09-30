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
  it('sends no post without a valid lease of the poster (wave 4)', async () => {
    const { client, transport } = fixture()
    await client.hello()
    expect(client.paused()).toBeUndefined()
    await expect(client.post({ id: 'm1', type: 'note', from: 'alice' }, { lease: { name: 'alice', epoch: 42 } })).rejects.toThrow('not sent: name lease is no longer held')
    expect(transport.sent.filter(r => r.op === 'post')).toHaveLength(0)
    client.close()
  })

  it('pauses on a lost lease until re-acquire, and release clears lease state', async () => {
    const { client, transport, jumpWall } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    jumpWall(60_000)
    expect(client.paused()).toBe(PAUSED)
    await expect(client.post({ id: 'm1', type: 'note', from: 'alice' }, { lease: { name: 'alice', epoch: 42 } })).rejects.toThrow('not sent: name lease is no longer held')
    await client.acquire('alice', holder)
    expect(client.paused()).toBeUndefined()
    await client.post({ id: 'm2', type: 'note', from: 'alice' }, { lease: { name: 'alice', epoch: 42 } })
    expect(transport.sent.at(-1)).toMatchObject({ op: 'post', lease: { name: 'alice', epoch: 42 } })
    await client.release('alice')
    expect(client.paused()).toBeUndefined()
    client.close()
  })

  it('requires an explicitly supplied post lease to match a valid local lease', async () => {
    const { client, transport } = fixture()
    await client.hello()
    await expect(client.post({ id: 'm1', type: 'note', from: 'alice' }, { lease: { name: 'alice', epoch: 42 } })).rejects.toThrow('not sent: name lease is no longer held')
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
    await expect(client.post({ id: 'm1', type: 'note', from: 'alice' }, { lease: { name: 'alice', epoch: 42 } })).rejects.toThrow('not sent: name lease is no longer held')
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

  it('reacquires its name after an unsynced restart refuses epoch-only renewal', async () => {
    const { client, transport } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    transport.answer = req => req.op === 'renew'
      ? { ok: false, reason: 'not-yours', text: 'holder record has not synced' }
      : req.op === 'acquire' ? { ok: true, epoch: 43, ttlMs: LEASE_TTL_MS } : { ok: true }
    await expect(client.renew('alice')).rejects.toMatchObject({ reason: 'not-yours' })
    expect(client.lease('alice')).toBeUndefined()
    expect(await client.acquire('alice', holder)).toBe(43)
    expect(client.lease('alice')).toBe(43)
    client.close()
  })

  it('retries rate-limited and unavailable replies, preserving the server text on exhaustion', async () => {
    const { client, transport, advance } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    let attempts = 0
    transport.answer = req => req.op === 'post' && ++attempts === 1
      ? { ok: false, reason: 'rate-limited', text: 'slow down', retryMs: 1000 }
      : { ok: true, seq: 6, at: 1 }
    const pending = client.post({ id: 'm1', type: 'note', from: 'alice' }, { lease: { name: 'alice', epoch: 42 } })
    await Promise.resolve()
    advance(1000); await vi.advanceTimersByTimeAsync(1000)
    expect((await pending).seq).toBe(6)
    expect(attempts).toBe(2)
    transport.answer = req => req.op === 'release' ? { ok: false, reason: 'unavailable', text: 'disk offline', retryMs: 1000 } : { ok: true }
    const rejected = expect(client.release('alice')).rejects.toMatchObject({ reason: 'unavailable', message: 'disk offline' })
    for (let i = 0; i < (REQUEST_TIMEOUT_LOCAL_MS + SETTLE_MS) / 1000; i++) { advance(1000); await vi.advanceTimersByTimeAsync(1000) }
    await rejected
    expect(client.lease('alice')).toBe(42)
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

  it('does not retry a post after its lease expires during a starting delay', async () => {
    const { client, transport, advance } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    advance(LEASE_TTL_MS - 1)
    let posts = 0
    transport.answer = req => req.op === 'post'
      ? (++posts === 1 ? { ok: false, reason: 'starting', text: 'starting', retryMs: 1_000 } : { ok: true, seq: 5, at: 1 })
      : { ok: true }
    const result = expect(client.post({ id: 'm1', type: 'note', from: 'alice' }, { lease: { name: 'alice', epoch: 42 } }))
      .rejects.toThrow('not sent: name lease is no longer held')
    await Promise.resolve()
    expect(transport.sent.filter(r => r.op === 'post')).toHaveLength(1)
    advance(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await result
    expect(transport.sent.filter(r => r.op === 'post')).toHaveLength(1)
    expect(client.paused()).toBe(PAUSED)
    client.close()
  })

  it('does not retry a post after a lease-lost push during a starting delay', async () => {
    const { client, transport } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    let posts = 0
    transport.answer = req => req.op === 'post'
      ? (++posts === 1 ? { ok: false, reason: 'starting', text: 'starting', retryMs: 1_000 } : { ok: true, seq: 5, at: 1 })
      : { ok: true }
    const result = expect(client.post({ id: 'm1', type: 'note', from: 'alice' }, { lease: { name: 'alice', epoch: 42 } }))
      .rejects.toThrow('not sent: name lease is no longer held')
    await Promise.resolve()
    transport.emit({ v: 1, push: 'lease-lost', name: 'alice', epoch: 42, reason: 'expired' })
    await vi.advanceTimersByTimeAsync(1_000)
    await result
    expect(transport.sent.filter(r => r.op === 'post')).toHaveLength(1)
    expect(client.paused()).toBe(PAUSED)
    client.close()
  })

  it('rechecks the post lease after a hello-first retry', async () => {
    const { client, transport } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    transport.answer = req => req.op === 'post'
      ? { ok: false, reason: 'hello-first', text: 'hello first' }
      : undefined
    const result = expect(client.post({ id: 'm1', type: 'note', from: 'alice' }, { lease: { name: 'alice', epoch: 42 } }))
      .rejects.toThrow('not sent: name lease is no longer held')
    await vi.waitFor(() => expect(transport.sent.filter(r => r.op === 'hello')).toHaveLength(2))
    const hello = transport.sent.at(-1)!
    transport.emit({ v: 1, push: 'lease-lost', name: 'alice', epoch: 42, reason: 'expired' })
    transport.emit({ v: 1, re: hello.id, ok: true, proto: 1, incarnation: 1, ttlMs: LEASE_TTL_MS, renewMs: LEASE_RENEW_MS, authority: true })
    await result
    expect(transport.sent.filter(r => r.op === 'post')).toHaveLength(1)
    expect(client.paused()).toBe(PAUSED)
    client.close()
  })

  it('closes during a starting delay without sending another request', async () => {
    const { client, transport } = fixture()
    let sends = 0
    transport.answer = () => ++sends === 1
      ? { ok: false, reason: 'starting', text: 'starting', retryMs: 1_000 }
      : { ok: true, incarnation: 1 }
    const result = expect(client.hello()).rejects.toThrow('hub client closed')
    await Promise.resolve()
    expect(transport.sent).toHaveLength(1)
    client.close()
    client.close()
    await vi.advanceTimersByTimeAsync(1_000)
    await result
    expect(transport.sent).toHaveLength(1)
  })

  it('rejects pending requests and all APIs after close', async () => {
    const { client, transport } = fixture()
    transport.answer = () => undefined
    const pending = expect(client.hello()).rejects.toThrow('hub client closed')
    client.close()
    client.close()
    await pending
    await expect(client.hello()).rejects.toThrow('hub client closed')
    await expect(client.acquire('alice', holder)).rejects.toThrow('hub client closed')
    await expect(client.renew('alice')).rejects.toThrow('hub client closed')
    await expect(client.release('alice')).rejects.toThrow('hub client closed')
    await expect(client.post({ id: 'm1', type: 'note', from: 'alice' }, { lease: { name: 'alice', epoch: 42 } })).rejects.toThrow('hub client closed')
    expect(transport.sent).toHaveLength(1)
  })

  it('bounds repeated starting replies by request timeout plus settle time', async () => {
    const { client, transport, advance } = fixture()
    transport.answer = req => req.op === 'hello'
      ? { ok: false, reason: 'starting', text: 'starting', retryMs: 1_000 }
      : undefined
    const result = expect(client.hello()).rejects.toMatchObject({ reason: 'starting' })
    // The budget reads the injected clocks; the timers only wake the retries.
    for (let t = 0; t < REQUEST_TIMEOUT_LOCAL_MS + SETTLE_MS; t += 1_000) {
      advance(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    await result
    expect(transport.sent.filter(r => r.op === 'hello')).toHaveLength((REQUEST_TIMEOUT_LOCAL_MS + SETTLE_MS) / 1_000)
    expect(client.paused()).toBe(PAUSED)
    client.close()
  })

  it('a wall clock jump alone exhausts the starting retry budget', async () => {
    const { client, transport, jumpWall } = fixture()
    let hellos = 0
    transport.answer = req => req.op === 'hello' && ++hellos === 1
      ? { ok: false, reason: 'starting', text: 'starting', retryMs: 1_000 }
      : { ok: true, proto: 1, incarnation: 1, ttlMs: LEASE_TTL_MS, renewMs: LEASE_RENEW_MS, authority: true }
    const result = expect(client.hello()).rejects.toMatchObject({ reason: 'starting' })
    jumpWall(60_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await result
    expect(hellos).toBe(1)
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

describe('HubClient handover and lease queries (wave 4)', () => {
  it('reports a lease epoch only while it is valid by the send-time clock', async () => {
    const { client, advance } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    expect(client.lease('alice')).toBe(42)
    expect(client.lease('bob')).toBeUndefined()
    advance(LEASE_TTL_MS)
    expect(client.lease('alice')).toBeUndefined()
    client.close()
  })

  it('moves to a new connection, keeps the lease and renews it there', async () => {
    const { client, transport } = fixture()
    await client.hello(); await client.acquire('alice', holder)
    const next = new FakeTransport()
    next.answer = transport.answer
    client.attach(next)
    await vi.waitFor(() => expect(next.sent.map(r => r.op)).toEqual(['hello', 'renew']))
    expect(next.sent[1]).toMatchObject({ name: 'alice', epoch: 42 })
    expect(client.lease('alice')).toBe(42)
    // The old connection no longer delivers frames to this client.
    transport.emit({ v: 1, push: 'lease-lost', name: 'alice', epoch: 42, reason: 'expired' })
    expect(client.lease('alice')).toBe(42)
    next.emit({ v: 1, push: 'lease-lost', name: 'alice', epoch: 42, reason: 'expired' })
    expect(client.lease('alice')).toBeUndefined()
    client.close()
  })
})
