import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as sync from 'y-protocols/sync'
import { relayConnectionHandler, SecureSession, AuthorityLock, loadMemory, memoryFile, localViewKey } from '../src/index.js'
import { holderDeadCheck, incarnationFile } from '../src/hub.js'
import { decodeFrame, encodeFrame } from '@room/hub-core'

const key = 'synthetic-admission-key'
type Docs = Parameters<typeof relayConnectionHandler>[0]
type Options = Parameters<typeof relayConnectionHandler>[1]
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

/** Real authenticated frames at the handler seam: loopback listen is EPERM in this sandbox. */
class Socket extends EventEmitter {
  readonly OPEN = 1
  readonly CLOSED = 3
  readyState = this.OPEN
  bufferedAmount = 0
  binaryType = 'nodebuffer'
  frames: Buffer[] = []
  closure?: { code: number; reason: string }
  send(frame: Uint8Array, cb?: (error?: Error) => void) { this.frames.push(Buffer.from(frame)); cb?.() }
  close(code = 1000, reason = '') { this.closure ??= { code, reason }; this.readyState = this.CLOSED; this.emit('close') }
  terminate() { this.close() }
}
function fixture(options: Partial<Options> = {}) {
  const docs: Docs = new Map()
  const handler = relayConnectionHandler(docs, { key, ...options })
  const sockets: Socket[] = []
  cleanups.push(() => {
    for (const socket of sockets) socket.close()
    for (const d of docs.values()) { d.closed = true; d.hub?.stop(); d.memory?.close(); d.awareness.destroy(); d.doc.destroy() }
  })
  const connect = (room = 'local/synthetic', ready = true, target = encodeURIComponent(room), view = false) => {
    const socket = new Socket(); sockets.push(socket)
    handler(socket as unknown as WebSocket, { url: `/${target}?schema=2`, ticketView: view } as unknown as http.IncomingMessage)
    const client = new SecureSession(view ? localViewKey(key, room) : key, room, 'client')
    const send = (frame: Uint8Array) => { if (!socket.closure) socket.emit('message', client.encrypt(frame), true) }
    if (ready && !socket.closure) {
      socket.emit('message', client.clientHello(), true)
      client.acceptRelayHello(socket.frames.shift()!)
      const doc = new Y.Doc(), enc = encoding.createEncoder()
      encoding.writeVarUint(enc, 0); sync.writeSyncStep1(enc, doc); doc.destroy()
      send(encoding.toUint8Array(enc))
    }
    return { socket, client, send }
  }
  return { docs, connect }
}
function presence(entries: [number, number, unknown][]) {
  const inner = encoding.createEncoder(), outer = encoding.createEncoder()
  encoding.writeVarUint(inner, entries.length)
  for (const [id, clock, state] of entries) {
    encoding.writeVarUint(inner, id); encoding.writeVarUint(inner, clock); encoding.writeVarString(inner, JSON.stringify(state))
  }
  encoding.writeVarUint(outer, 1); encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner))
  return encoding.toUint8Array(outer)
}

describe('relay aggregate admission (A5)', () => {
  it.each([0, -1, NaN, Infinity])('rejects invalid admission/presence capacities (%s) before allocating sockets', value => {
    expect(() => fixture({ admission: { maxRooms: value } })).toThrow('positive safe integers')
    expect(() => fixture({ awareness: { maxIdsPerRoom: value } })).toThrow('positive safe integers')
  })
  it('bounds 20 distinct room attempts at the default eight, including disconnected docs', () => {
    const f = fixture()
    for (let i = 0; i < 20; i++) {
      const c = f.connect(`local/probe-${i}`)
      if (i >= 8) expect(c.socket.closure).toEqual({ code: 1013, reason: 'relay room limit reached' })
      c.socket.close()
    }
    expect(f.docs.size).toBe(8)
    expect([...f.docs.values()].every(d => d.conns.size === 0)).toBe(true)
  })
  it('reserves pending handshake rooms, releases failed handshakes, and keeps admitted rooms usable', () => {
    const f = fixture({ admission: { maxRooms: 2 } })
    const a = f.connect('local/a'), pending = f.connect('local/b', false)
    expect(f.connect('local/c').socket.closure?.reason).toBe('relay room limit reached')
    expect(f.docs.size).toBe(1)
    pending.socket.emit('error', new Error('synthetic failure'))
    const c = f.connect('local/c')
    expect(c.socket.closure).toBeUndefined()
    expect(f.connect('local/a').socket.closure).toBeUndefined()
    expect(a.socket.closure).toBeUndefined()
    expect(f.docs.size).toBe(2)
  })
  it('caps total sockets including handshakes and returns slots once on close/error', () => {
    const f = fixture({ admission: { maxConnections: 2 } })
    const a = f.connect('local/a', false), b = f.connect('local/b')
    expect(f.connect('local/a').socket.closure).toEqual({ code: 1013, reason: 'relay connection limit reached' })
    a.socket.emit('error', new Error('synthetic failure')); a.socket.close()
    expect(f.connect('local/c').socket.closure).toBeUndefined()
    expect(f.connect('local/d').socket.closure?.reason).toBe('relay connection limit reached')
    expect(b.socket.closure).toBeUndefined()
  })
  it('caps sockets per room and preserves encoded and legacy room-name routing', () => {
    const f = fixture({ admission: { maxConnectionsPerRoom: 2 } })
    const a = f.connect('local/legacy', true, 'local/legacy')
    f.connect('local/legacy')
    expect(f.connect('local/legacy', false, 'local/legacy').socket.closure).toEqual({ code: 1013, reason: 'relay room connection limit reached' })
    expect(f.connect('legacy-name').socket.closure).toBeUndefined()
    expect(f.docs.size).toBe(2)
    a.socket.close()
    expect(f.connect('local/legacy').socket.closure).toBeUndefined()
  })
})

describe('relay awareness budgets (A5)', () => {
  it('closes a connection at the default 16 lifetime unique IDs', () => {
    const f = fixture(), c = f.connect()
    for (let id = 1; id <= 40; id++) c.send(presence([[id, 1, { name: `synthetic-${id}` }]]))
    const d = [...f.docs.values()][0]
    expect(c.socket.closure).toEqual({ code: 4429, reason: 'invalid or excessive presence' })
    expect(d.awareness.getStates().size).toBe(0)
    expect(d.awareness.meta.size).toBe(17) // 16 accepted IDs and the relay's local ID
  })
  it.each([
    ['message bytes', { maxMessageBytes: 64 }, [[1, 1, { text: 'x'.repeat(100) }]], 'presence budget exceeded'],
    ['state bytes', { maxStateBytes: 64 }, [[1, 1, { text: 'é'.repeat(40) }]], 'invalid or excessive presence'],
  ] as const)('refuses excessive %s before applying presence', (_label, awareness, entries, reason) => {
    const f = fixture({ awareness }), c = f.connect()
    c.send(presence(entries as unknown as [number, number, unknown][]))
    expect(c.socket.closure).toEqual({ code: 4429, reason })
    expect([...f.docs.values()][0].awareness.getStates().size).toBe(0)
  })
  it('enforces the production message and state byte defaults', () => {
    for (const size of [17 * 1024, 65 * 1024]) {
      const f = fixture(), c = f.connect()
      c.send(presence([[1, 1, { text: 'x'.repeat(size) }]]))
      expect(c.socket.closure?.code).toBe(4429)
      expect([...f.docs.values()][0].awareness.getStates().size).toBe(0)
    }
  })
  it('counts unknown removals and unique IDs across removal/re-add cycles', () => {
    const f = fixture({ awareness: { maxIdsPerConnection: 2 } }), c = f.connect()
    c.send(presence([[1, 1, {}], [1, 2, {}]])) // duplicate batch IDs consume one slot
    c.send(presence([[1, 3, null], [2, 1, null]]))
    c.send(presence([[1, 4, {}]]))
    expect(c.socket.closure).toBeUndefined()
    c.send(presence([[3, 1, null]]))
    expect(c.socket.closure?.code).toBe(4429)
  })
  it('caps room metadata across connections, keeps removals safe, and prunes stale tombstones', () => {
    let now = Date.now()
    const f = fixture({ awareness: { maxIdsPerRoom: 3, now: () => now } })
    const a = f.connect(), b = f.connect(), d = [...f.docs.values()][0]
    a.send(presence([[1, 1, {}], [2, 1, {}]]))
    b.send(presence([[3, 1, {}]]))
    expect(b.socket.closure).toBeUndefined() // full rooms silently drop new presence, as the hosted server does
    expect(d.awareness.meta.size).toBe(3)
    expect(d.awareness.getStates().has(3)).toBe(false)
    a.send(presence([[1, 2, null]]))
    b.send(presence([[1, 1, {}]])) // late echo cannot resurrect a removed ID
    expect(d.awareness.getStates().has(1)).toBe(false)
    b.send(presence([[3, 2, {}]]))
    expect(d.awareness.getStates().has(3)).toBe(false)
    // Yjs stamps records with its own clock; expire relative to those stamps, not fixture setup.
    now = Math.max(...[...d.awareness.meta.values()].map(record => record.lastUpdated)) + 60_001
    b.send(presence([[3, 3, {}]]))
    expect(d.awareness.meta.has(1)).toBe(false)
    expect(d.awareness.meta.size).toBeLessThanOrEqual(3)
    expect(d.awareness.getStates().has(3)).toBe(true)
    expect(d.awareness.getStates().has(2)).toBe(true)
  })
  it('allows echoes from other clients without consuming their ID budgets', () => {
    const f = fixture({ awareness: { maxIdsPerConnection: 1 } }), a = f.connect(), b = f.connect()
    a.send(presence([[1, 1, { name: 'synthetic-a' }]]))
    b.send(presence([[1, 1, { name: 'synthetic-a' }]]))
    b.send(presence([[2, 1, { name: 'synthetic-b' }]]))
    expect(b.socket.closure).toBeUndefined()
    expect([...f.docs.values()][0].awareness.getStates().size).toBe(2)
  })
  it('counts a previously owned but pruned ID against room capacity when re-added', () => {
    let now = Date.now()
    const f = fixture({ awareness: { maxIdsPerRoom: 3, maxIdsPerConnection: 3, now: () => now } }), a = f.connect(), b = f.connect()
    a.send(presence([[1, 1, {}], [1, 2, null]]))
    const d = [...f.docs.values()][0]
    // Yjs stamps records with its own clock; expire relative to those stamps, not fixture setup.
    now = Math.max(...[...d.awareness.meta.values()].map(record => record.lastUpdated)) + 60_001
    b.send(presence([[2, 1, {}], [3, 1, {}], [4, 1, {}]]))
    expect(d.awareness.meta.size).toBe(3)
    a.send(presence([[1, 3, {}]]))
    expect(d.awareness.meta.size).toBe(3)
    expect(d.awareness.getStates().has(1)).toBe(false)
    expect(a.socket.closure).toBeUndefined()
  })
  it('cleans removed IDs after the echo grace period even without another presence update', () => {
    let now = Date.now()
    const f = fixture({ awareness: { now: () => now } }), a = f.connect(), d = [...f.docs.values()][0]
    a.send(presence([[1, 1, {}]])); a.socket.close()
    expect(d.awareness.meta.has(1)).toBe(true)
    // Yjs stamps records with its own clock; expire relative to those stamps, not fixture setup.
    now = Math.max(...[...d.awareness.meta.values()].map(record => record.lastUpdated)) + 60_001
    d.presence.prune() // the relay maintenance ticker uses the same operation
    expect(d.awareness.meta.has(1)).toBe(false)
  })
  it('bounds message frequency and refreshes its minute window', () => {
    let now = Date.now()
    const f = fixture({ awareness: { maxMessagesPerMinute: 2, now: () => now } }), c = f.connect()
    c.send(presence([[1, 1, {}]])); c.send(presence([[1, 1, {}]]))
    now += 60_000
    c.send(presence([[1, 2, {}]])); c.send(presence([[1, 2, {}]]))
    expect(c.socket.closure).toBeUndefined()
    c.send(presence([[1, 2, {}]]))
    expect(c.socket.closure?.reason).toBe('presence budget exceeded')
  })
  it('rejects malformed presence without affecting another connection', () => {
    const f = fixture(), a = f.connect(), b = f.connect()
    a.send(Uint8Array.of(1, 2, 255))
    expect(a.socket.closure?.code).toBe(4429)
    b.send(presence([[1, 1, {}]]))
    expect(b.socket.closure).toBeUndefined()
  })
  it('preserves read-only viewer awareness behavior while counting its admission slot', () => {
    const f = fixture({ admission: { maxConnections: 1 } }), view = f.connect('local/synthetic', true, 'local%2Fsynthetic', true)
    view.send(presence([[1, 1, { text: 'x'.repeat(65 * 1024) }]]))
    expect(view.socket.closure).toBeUndefined()
    expect([...f.docs.values()][0].awareness.getStates().size).toBe(0)
    expect(f.connect().socket.closure?.reason).toBe('relay connection limit reached')
  })
})

it('preserves live sync, reconnecting awareness, memory flush, and hub requests in one admitted room', async () => {
  const commonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-relay-admission-'))
  cleanups.push(() => fs.rmSync(commonDir, { recursive: true, force: true }))
  const lock = AuthorityLock.take(commonDir)!
  cleanups.push(() => lock.release())
  const f = fixture({ commonDir, admission: { maxRooms: 1, maxConnectionsPerRoom: 1 }, hub: {
    lock, store: incarnationFile(commonDir), mono: () => performance.now(), wall: Date.now, holderDead: holderDeadCheck(),
  } })
  const a = f.connect(), d = [...f.docs.values()][0], update = new Y.Doc()
  update.getText('live').insert(0, 'survives reconnect')
  update.getArray('bus').push([{ id: 'synthetic-memory' }])
  const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); sync.writeUpdate(enc, Y.encodeStateAsUpdate(update)); update.destroy()
  a.send(encoding.toUint8Array(enc)); a.send(presence([[1, 1, { name: 'synthetic' }]]))
  a.socket.close()
  expect(fs.existsSync(memoryFile(commonDir, 'local/synthetic'))).toBe(true)
  const saved = loadMemory(commonDir, 'local/synthetic')
  expect(saved.getArray('bus').toArray()).toEqual([{ id: 'synthetic-memory' }]); saved.destroy()
  const b = f.connect()
  expect([...f.docs.values()][0]).toBe(d)
  b.send(presence([[1, 2, { name: 'synthetic' }]]))
  expect(d.awareness.getStates().get(1)).toEqual({ name: 'synthetic' })
  const replica = new Y.Doc()
  for (const frame of b.socket.frames.splice(0)) {
    const dec = decoding.createDecoder(b.client.decrypt(frame)), reply = encoding.createEncoder()
    if (decoding.readVarUint(dec) === 0) sync.readSyncMessage(dec, reply, replica, null)
  }
  expect(replica.getText('live').toString()).toBe('survives reconnect'); replica.destroy()
  for (let i = 0; i < 100 && !d.hub; i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(d.hub).toBeDefined()
  b.send(encodeFrame({ v: 1, id: 'hello', op: 'hello', proto: 1, schema: 2, client: 'synthetic', sessionId: 'synthetic' } as never))
  expect(b.socket.frames.map(frame => b.client.decrypt(frame)).filter(frame => frame[0] === 7).map(decodeFrame)).toContainEqual(expect.objectContaining({ re: 'hello', ok: true }))
})
