import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { WebSocket } from 'ws'
import { decodeFrame, encodeFrame } from '@room/hub-core'
import { relayConnectionHandler, SecureSession } from '../src/index.js'

const offer = { bootstrap: 1, hub: { min: 1, max: 1 }, schemas: { read: [2], write: [2] }, capabilities: {}, legacy: { schema: 2, hub: 1 } }
class Socket extends EventEmitter {
  OPEN = 1; CLOSED = 3; readyState = 1; bufferedAmount = 0; binaryType = 'nodebuffer'
  _receiver = { _maxPayload: 100 * 1024 * 1024 }
  frames: Buffer[] = []; code?: number; reason?: string
  send(frame: Uint8Array, callback?: (error?: Error) => void) { this.frames.push(Buffer.from(frame)); callback?.() }
  close(code?: number, reason?: string) { this.code = code; this.reason = reason; this.readyState = 3; this.emit('close') }
  terminate() { this.close() }
}
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers() })
function connect(query = '&negotiate=1') {
  const docs = new Map() as Parameters<typeof relayConnectionHandler>[0]
  const conn = new Socket()
  relayConnectionHandler(docs, { key: 'key' })(conn as unknown as WebSocket, { url: '/local%2Ftest?schema=2' + query } as http.IncomingMessage)
  const secure = new SecureSession('key', 'local/test', 'client')
  conn.emit('message', secure.clientHello(), true)
  secure.acceptRelayHello(conn.frames.shift()!)
  const send = (frame: Uint8Array) => conn.emit('message', secure.encrypt(frame), true)
  const next = () => secure.decrypt(conn.frames.shift()!)
  const hello = () => send(encodeFrame({ v: 1, id: 'h', op: 'compat-hello', sessionId: 'session', offer } as never))
  cleanups.push(() => { conn.close(); for (const doc of docs.values()) { doc.awareness.destroy(); doc.doc.destroy() } })
  return { conn, docs, send, next, hello }
}

describe('encrypted relay bootstrap gate', () => {
  it('does not allocate a document or send sync on early Yjs input', () => {
    const c = connect()
    c.send(Uint8Array.of(0, 0, 0))
    expect(c.conn.code).toBe(4406)
    expect(c.docs.size).toBe(0)
    expect(c.conn.frames).toHaveLength(0)
  })

  it('selects before sync and attaches only after the matching ACK', async () => {
    const c = connect()
    expect(c.conn._receiver._maxPayload).toBe(8192 + 16)
    c.hello()
    await vi.waitFor(() => expect(c.conn.frames).toHaveLength(1))
    const selection = decodeFrame(c.next()) as unknown as { selectionId: string; selection: { schema: number; hub: number }; ok: boolean }
    expect(selection).toMatchObject({ ok: true, selection: { schema: 2, hub: 1 } })
    expect(c.conn.frames).toHaveLength(0)
    c.send(encodeFrame({ v: 1, id: 'a', op: 'compat-ack', selectionId: selection.selectionId } as never))
    await vi.waitFor(() => expect(c.conn.frames.length).toBeGreaterThan(0))
    expect(decodeFrame(c.next())).toEqual({ v: 1, re: 'a', ok: true })
    expect(c.next()[0]).toBe(0)
    expect(c.conn._receiver._maxPayload).toBe(100 * 1024 * 1024)
  })

  it('rejects duplicate hello and incorrect selection ACK without sync', async () => {
    const c = connect()
    c.hello()
    await vi.waitFor(() => expect(c.conn.frames).toHaveLength(1))
    c.next()
    c.send(encodeFrame({ v: 1, id: 'a', op: 'compat-ack', selectionId: 'other-selection' } as never))
    expect(c.conn.code).toBe(4406)
    expect(c.conn.frames.filter(frame => frame.length)).toHaveLength(0)
  })

  it('rejects a second hello after selection without attaching', async () => {
    const c = connect()
    c.hello()
    await vi.waitFor(() => expect(c.conn.frames).toHaveLength(1))
    c.next()
    c.hello()
    expect(c.conn.code).toBe(4406)
    expect(c.docs.values().next().value!.conns.size).toBe(0)
  })

  it('rechecks document generation at ACK and never syncs a stale selection', async () => {
    const c = connect('&negotiate=1&gen=fresh')
    c.hello()
    await vi.waitFor(() => expect(c.conn.frames).toHaveLength(1))
    const selected = decodeFrame(c.next()) as { selectionId: string }
    c.docs.values().next().value!.doc.getMap('meta').set('generation', 'new-generation')
    c.send(encodeFrame({ v: 1, id: 'a', op: 'compat-ack', selectionId: selected.selectionId } as never))
    expect(c.conn.code).toBe(4406)
    expect(c.conn.frames).toHaveLength(0)
  })

  it('bounds bootstrap input before decoding or allocating a document', () => {
    const c = connect()
    c.send(Buffer.alloc(8193, 7))
    expect(c.conn.code).toBe(4406)
    expect(c.docs.size).toBe(0)
  })

  it('keeps shared state unchanged when no required contract overlaps', () => {
    const c = connect()
    c.send(encodeFrame({ v: 1, id: 'h', op: 'compat-hello', sessionId: 'session', offer: { ...offer, legacy: undefined, schemas: { read: [3], write: [3] } } } as never))
    expect(c.conn.code).toBe(4406)
    expect(c.docs.size).toBe(0)
    expect(decodeFrame(c.next())).toMatchObject({ v: 1, re: 'h', ok: false })
  })

  it('rejects trailing data after the bootstrap JSON envelope', () => {
    const c = connect()
    const hello = encodeFrame({ v: 1, id: 'h', op: 'compat-hello', sessionId: 'session', offer } as never)
    c.send(Buffer.concat([hello, Buffer.from([0])]))
    expect(c.conn.code).toBe(4406)
    expect(c.docs.size).toBe(0)
  })

  it('checks the absolute ACK deadline even when the timer callback has not run', async () => {
    vi.useFakeTimers()
    const c = connect()
    c.hello()
    await Promise.resolve(); await Promise.resolve()
    const selection = decodeFrame(c.next()) as { selectionId: string }
    vi.setSystemTime(Date.now() + 5001)
    c.send(encodeFrame({ v: 1, id: 'a', op: 'compat-ack', selectionId: selection.selectionId } as never))
    expect(c.conn.code).toBe(4406)
    expect(c.conn.frames).toHaveLength(0)
  })

  it('retains exact legacy sync-before-hub-hello ordering without a new ACK', () => {
    const c = connect('')
    c.send(Uint8Array.of(0, 0, 0))
    expect(c.docs.size).toBe(1)
    expect(c.next()[0]).toBe(0)
    expect(c.conn.code).toBeUndefined()
  })

  it('rejects unknown negotiate values instead of selecting legacy sync', () => {
    const conn = new Socket(), docs = new Map()
    relayConnectionHandler(docs, { key: 'key' })(conn as unknown as WebSocket, { url: '/local%2Ftest?schema=2&negotiate=9' } as http.IncomingMessage)
    expect(conn.code).toBe(4406)
    expect(docs.size).toBe(0)
  })

  it('applies a five-second absolute ACK deadline without syncing', async () => {
    vi.useFakeTimers()
    const c = connect()
    c.hello()
    await Promise.resolve(); await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5001)
    expect(c.conn.code).toBe(4406)
  })
})
