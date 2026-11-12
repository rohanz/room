import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomMemory } from '../src/memory.js'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { WebSocket } from 'ws'
import { CURRENT_COMPAT, noticeEvidence, workerNoticeId, serializedStore, SETTLE_MS, decodeFrame, encodeFrame } from '@room/hub-core'
import { relayConnectionHandler, SecureSession } from '../src/index.js'

const offer = { bootstrap: 1, hub: { min: 1, max: 1 }, schemas: { read: [2], write: [2] }, capabilities: {} }
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
function connect(query = '&negotiate=1', options: Partial<Parameters<typeof relayConnectionHandler>[1]> = {}) {
  const docs = new Map() as Parameters<typeof relayConnectionHandler>[0]
  const conn = new Socket()
  relayConnectionHandler(docs, { key: 'key', ...options })(conn as unknown as WebSocket, { url: '/local%2Ftest?schema=2' + query } as http.IncomingMessage)
  const secure = new SecureSession('key', 'local/test', 'client')
  conn.emit('message', secure.clientHello(), true)
  secure.acceptRelayHello(conn.frames.shift()!)
  const send = (frame: Uint8Array) => conn.emit('message', secure.encrypt(frame), true)
  const next = () => secure.decrypt(conn.frames.shift()!)
  const hello = (advertisement = offer) => send(encodeFrame({ v: 1, id: 'h', op: 'compat-hello', sessionId: 'session', offer: advertisement } as never))
  cleanups.push(() => { conn.close(); for (const doc of docs.values()) { doc.hub?.stop(); doc.memory?.detach(); doc.awareness.destroy(); doc.doc.destroy() } })
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

  it.each([true, false])('encrypted ACK binds optional notice authority only when selected=%s', async capable => {
    const commonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-notice-gate-'))
    let mono = 0, max: number | undefined
    const c = connect('&negotiate=1', { commonDir, hub: {
      lock: { held: () => true } as never, store: serializedStore({ read: async () => max, write: async n => { max = n } }),
      mono: () => mono, wall: Date.now, holderDead: () => false,
    } })
    cleanups.push(() => fs.rmSync(commonDir, { recursive: true, force: true }))
    c.hello(capable ? CURRENT_COMPAT : { ...CURRENT_COMPAT, capabilities: { 'room.generation': [1], 'room.manifest': [1], 'room.ledger': [1] } })
    await vi.waitFor(() => expect(c.conn.frames).toHaveLength(1))
    const selected = decodeFrame(c.next()) as any
    expect(selected.selection.capabilities['room.notice-lifecycle']).toBe(capable ? 1 : undefined)
    c.send(encodeFrame({ v: 1, id: 'ack', op: 'compat-ack', selectionId: selected.selectionId }))
    await vi.waitFor(() => expect(c.conn.frames.length).toBeGreaterThan(0))
    while (c.conn.frames.length) c.next()
    mono += SETTLE_MS
    let serial = 0
    const request = (body: object) => {
      const id = `notice-${++serial}`
      c.send(encodeFrame({ v: 1, id, ...body } as never))
      const replies = []
      while (c.conn.frames.length) { const bytes = c.next(); if (bytes[0] === 7) replies.push(decodeFrame(bytes) as any) }
      return replies.find(reply => reply.re === id)
    }
    const grant = request({ op: 'acquire', name: 'A', holder: { sessionId: 'session', pid: 1, startTime: '', executable: '', workerId: 'retirement-worker' } })
    expect(grant).toMatchObject({ ok: true })
    const doc = c.docs.values().next().value!, room = doc.room!, lease = { name: 'A', epoch: grant.epoch }
    const intent = (id: string, expected: number) => ({
      op: 'notice-lifecycle', generation: doc.hub!.incarnation, lease, action: 'register', producer: 'producer', operation: 'register-original',
      expected, evidence: noticeEvidence(room, ['A', 'B']), episode: 'registration',
      msg: { id, type: 'contract', from: 'room', fromKind: 'agent', to: 'A', path: 'x', symbol: 'api', text: 'unchanged body', priority: 'notify' },
    })
    const originalId = capable ? workerNoticeId('cf:original', ['retirement-worker'])! : 'cf:original'
    const original = intent(originalId, 0)
    if (capable) {
      expect(request(original)).toMatchObject({ ok: true, managed: true })
      expect(request({ ...original, operation: 'forbidden-complete', expected: 1, transition: 'complete' })).toMatchObject({ ok: false, reason: 'invalid' })
      expect(room.outcomes.has(originalId)).toBe(false)
      expect(request({ op: 'notice-lifecycle', generation: doc.hub!.incarnation, lease, action: 'retire', producer: 'retirement', expected: 0,
        operation: 'retire-worker', workerId: 'retirement-worker', targets: [{ producer: 'producer', expected: 1, ids: [originalId], episodes: { [originalId]: 'registration' } }] })).toMatchObject({ ok: true, managed: true })
      expect(room.outcomes.has(originalId)).toBe(true)
    } else {
      expect(request(original)).toMatchObject({ ok: false, reason: 'version' })
      expect(request({ op: 'post', lease, auto: true, msg: original.msg })).toMatchObject({ ok: true })
      expect(room.outcomes.has(originalId)).toBe(false)
      expect(room.doc.getMap('noticeInventory').size).toBe(0)
    }
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
    c.send(encodeFrame({ v: 1, id: 'h', op: 'compat-hello', sessionId: 'session', offer: { ...offer, schemas: { read: [3], write: [3] } } } as never))
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

  it('refuses a non-negotiating client before secure hello or document allocation', () => {
    const conn = new Socket(), docs = new Map()
    relayConnectionHandler(docs, { key: 'key' })(conn as unknown as WebSocket, { url: '/local%2Ftest?schema=2' } as http.IncomingMessage)
    expect(conn.code).toBe(4406)
    expect(conn.reason).toBe('Room requires negotiated admission; reconnect with negotiate=1')
    expect(conn.frames).toHaveLength(0)
    expect(docs.size).toBe(0)
  })

  it('rejects unknown negotiate values before allocating a document', () => {
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

it('fences a secure handshake that was already upgraded when draining begins', () => {
  let accepting = true
  const c = connect('&negotiate=1', { accepting: () => accepting })
  accepting = false
  c.send(Uint8Array.of(0, 0, 0))
  expect(c.conn.code).toBe(1013)
  expect(c.docs.size).toBe(0)
})
it('fences negotiation after an awaited admission and before attaching a writer', async () => {
  let accepting = true
  const c = connect('&negotiate=1', { accepting: () => accepting })
  c.hello()
  accepting = false // receivePlain is awaiting hubReady, like the idle timer/lease-flush race
  await Promise.resolve()
  expect(c.conn.code).toBe(1013)
  expect(c.docs.values().next().value!.conns.size).toBe(0)
  expect(c.conn.frames).toHaveLength(0)
})
it('fences the selected pending ACK and counts no writer during draining', async () => {
  let accepting = true
  const c = connect('&negotiate=1', { accepting: () => accepting })
  c.hello()
  await vi.waitFor(() => expect(c.conn.frames).toHaveLength(1))
  const selected = decodeFrame(c.next()) as { selectionId: string }
  accepting = false
  c.send(encodeFrame({ v: 1, id: 'a', op: 'compat-ack', selectionId: selected.selectionId } as never))
  expect(c.conn.code).toBe(1013)
  expect(c.docs.values().next().value!.conns.size).toBe(0)
})

it.each(['fresh', 'current', 'stale', 'absent'])('gates a loaded value copy before sync (%s)', async kind => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-generation-'))
  const memory = new RoomMemory(dir, 'local/test')
  const previous = memory.doc.getMap('meta').get('generation')
  expect(memory.save('current')).toBeUndefined(); memory.detach(); memory.doc.destroy()
  const c = connect('&negotiate=1' + (kind === 'absent' ? '' : `&gen=${kind === 'current' ? 'current' : kind}`), {
    commonDir: dir,
    loaded: (_room, doc) => {
      expect(doc.getMap('meta').get('generation')).toBeTypeOf('string')
      expect(doc.getMap('meta').get('generation')).not.toBe(previous)
      expect(doc.getMap('meta').get('generation')).toBe('current')
    },
  })
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  // Generation is checked during selection, before any document frame or attachment.
  c.hello()
  await vi.waitFor(() => expect(c.conn.frames.length > 0 || c.conn.code !== undefined).toBe(true))
  if (kind === 'fresh' || kind === 'current') {
    const selected = decodeFrame(c.next()) as { selectionId: string }
    c.send(encodeFrame({ v: 1, id: 'ack', op: 'compat-ack', selectionId: selected.selectionId }))
  }
  if (kind === 'fresh' || kind === 'current') {
    expect(c.conn.code).toBeUndefined()
    expect(c.docs.values().next().value!.conns.size).toBe(1)
  } else {
    expect(c.conn.code).toBe(kind === 'absent' ? 4403 : 4409)
    expect(c.docs.values().next().value!.conns.size).toBe(0)
    expect(c.conn.frames).toHaveLength(0)
  }
})
