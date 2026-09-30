import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { AwarenessBudget } from '../src/readonly.js'

function frame(id: number, state: unknown, clock = 1): Uint8Array {
  return frames([[id, state, clock]])
}
function frames(entries: [number, unknown, number][]): Uint8Array {
  const inner = encoding.createEncoder()
  encoding.writeVarUint(inner, entries.length)
  for (const [id, state, clock] of entries) {
    encoding.writeVarUint(inner, id)
    encoding.writeVarUint(inner, clock)
    encoding.writeVarString(inner, JSON.stringify(state))
  }
  const outer = encoding.createEncoder()
  encoding.writeVarUint(outer, 1)
  encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner))
  return encoding.toUint8Array(outer)
}

/** A stand-in for y-protocols' Awareness: an entry applies only with a newer clock, and a removed state leaves its clock record. */
function room(clock = { now: 0 }) {
  const states = new Map<number, unknown>(), meta = new Map<number, { clock: number; lastUpdated: number }>()
  const apply = (bytes: Uint8Array) => {
    const outer = decoding.createDecoder(bytes)
    decoding.readVarUint(outer)
    const inner = decoding.createDecoder(decoding.readVarUint8Array(outer))
    const count = decoding.readVarUint(inner)
    for (let i = 0; i < count; i++) {
      const id = decoding.readVarUint(inner)
      const entryClock = decoding.readVarUint(inner)
      const state = JSON.parse(decoding.readVarString(inner))
      const known = meta.get(id)
      if (known && (entryClock < known.clock || (entryClock === known.clock && (state !== null || !states.has(id))))) continue
      meta.set(id, { clock: entryClock, lastUpdated: clock.now })
      if (state === null) states.delete(id); else states.set(id, state)
    }
  }
  const guard = (options: Partial<ConstructorParameters<typeof AwarenessBudget>[1]> = {}) => new AwarenessBudget({ meta, getStates: () => states },
    { maxMessageBytes: 65536, maxStateBytes: 16384, maxMessagesPerMinute: 100000, maxIdsPerConnection: 16, maxIdsPerRoom: 32, now: () => clock.now, ...options })
  const connect = (budget: AwarenessBudget) => {
    const conn = new EventEmitter(), close = vi.fn()
    conn.on('message', apply)
    budget.bind(conn, close)
    return { conn, close }
  }
  return { states, meta, guard, connect, clock }
}

describe('awareness budget', () => {
  it('cuts off a connection that churns fresh IDs, and prunes old clock records once the room is over its cap', () => {
    const { meta, guard, connect, clock } = room()
    const budget = guard({ maxIdsPerRoom: 32 })
    const { conn, close } = connect(budget)
    for (let id = 0; id < 10000; id++) { conn.emit('message', frame(id, { user: { name: 'a' } })); conn.emit('message', frame(id, null, 2)) }
    expect(close).toHaveBeenCalledWith(4429, 'invalid or excessive presence')
    expect(meta.size).toBeLessThanOrEqual(16)
    // Many short connections: records stay bounded by the room cap once they are a minute old.
    for (let c = 0; c < 100; c++) {
      clock.now += 61_000
      const next = connect(budget)
      for (let n = 0; n < 16; n++) { const id = 100000 + c * 16 + n; next.conn.emit('message', frame(id, {})); next.conn.emit('message', frame(id, null, 2)) }
      next.conn.emit('close')
    }
    expect(meta.size).toBeLessThanOrEqual(32 + 16)
  })
  it('lets a session announce the same ID again after it reconnects (a provider keeps its client ID)', () => {
    const { states, guard, connect } = room()
    const budget = guard()
    const first = connect(budget)
    first.conn.emit('message', frame(7, { user: { name: 'a' } }, 1))
    expect(states.has(7)).toBe(true)
    // The network drops: the server removes the state (as y-websocket does) and the socket closes.
    first.conn.emit('message', frame(7, null, 2))
    first.conn.emit('close')
    const second = connect(budget)
    second.conn.emit('message', frame(7, { user: { name: 'a' } }, 3))
    expect(second.close).not.toHaveBeenCalled()
    expect(states.has(7)).toBe(true)
  })
  it('does not count the echoes a y-websocket client sends back for everyone else in the room', () => {
    const { states, guard, connect } = room()
    const budget = guard({ maxIdsPerConnection: 2, maxIdsPerRoom: 100 })
    const others = Array.from({ length: 40 }, (_, n) => connect(budget))
    others.forEach((o, n) => o.conn.emit('message', frame(1000 + n, { n })))
    const me = connect(budget)
    me.conn.emit('message', frame(1, { me: true }))
    // The provider rebroadcasts every presence change it hears, with the clock it heard.
    for (let round = 0; round < 5; round++) me.conn.emit('message', frames(others.map((_, n) => [1000 + n, { n }, 1])))
    expect(me.close).not.toHaveBeenCalled()
    expect(states.size).toBe(41)
  })
  it('an echo of a departed participant arriving late does not bring them back', () => {
    const { states, guard, connect } = room()
    const budget = guard()
    const a = connect(budget), b = connect(budget)
    a.conn.emit('message', frame(7, { user: { name: 'a' } }, 1))
    a.conn.emit('message', frame(7, null, 2)); a.conn.emit('close')
    b.conn.emit('message', frame(7, { user: { name: 'a' } }, 1))
    expect(states.has(7)).toBe(false)
  })
  it('refuses new IDs past the room cap without cutting off the newcomer, and takes them again when room frees up', () => {
    const { states, guard, connect, clock } = room()
    const budget = guard({ maxIdsPerRoom: 2 })
    const a = connect(budget), b = connect(budget), c = connect(budget)
    a.conn.emit('message', frame(1, {})); b.conn.emit('message', frame(2, {}))
    c.conn.emit('message', frame(3, {}))
    expect(states.has(3)).toBe(false)
    expect(c.close).not.toHaveBeenCalled()
    a.conn.emit('message', frame(1, null, 2))
    clock.now += 61_000
    c.conn.emit('message', frame(3, {}))
    expect(states.has(3)).toBe(true)
  })
  it('rejects oversized state and message budgets for token-only members too', () => {
    const conn = new EventEmitter(), close = vi.fn()
    const guard = new AwarenessBudget({ meta: new Map(), getStates: () => new Map() }, { maxMessageBytes: 200,
      maxStateBytes: 32, maxMessagesPerMinute: 1, maxIdsPerConnection: 2, maxIdsPerRoom: 2 })
    guard.bind(conn, close)
    conn.emit('message', frame(1, { long: 'x'.repeat(100) }))
    expect(close).toHaveBeenCalledWith(4429, 'invalid or excessive presence')
  })
})
