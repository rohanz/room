import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { EventEmitter } from 'node:events'
import { HUB_ORIGIN, MAX_HUB_FRAME_BYTES, MAX_HUB_REQUESTS_PER_SECOND, decodeFrame, encodeFrame } from '@room/hub-core'
import { ServerHubs, bindHub, type PersistenceProvider } from '../src/hub.js'

it('bounds raw hub frames and reply ids before decoding, including unavailable and read-only paths', () => {
  const socket = () => Object.assign(new EventEmitter(), { replies: [] as Uint8Array[], send(buf: Uint8Array) { this.replies.push(buf) } })
  const parse = vi.spyOn(JSON, 'parse')
  try {
    const unavailable = socket()
    bindHub(unavailable, () => undefined, { readOnly: false }, () => 'storage down')
    const huge = encodeFrame({ v: 1, id: 'x', op: 'hello', payload: 'x'.repeat(MAX_HUB_FRAME_BYTES) } as never)
    const before = parse.mock.calls.length
    unavailable.emit('message', huge)
    expect(parse).toHaveBeenCalledTimes(before)
    expect(decodeFrame(unavailable.replies[0])).toMatchObject({ reason: 'too-large', re: '' })
    for (const id of ['x'.repeat(129), 'ok']) unavailable.emit('message', encodeFrame({ v: 1, id, op: 'hello' } as never))
    expect(decodeFrame(unavailable.replies[1])).toMatchObject({ reason: 'unavailable', re: '' })
    expect(decodeFrame(unavailable.replies[2])).toMatchObject({ reason: 'unavailable', re: 'ok' })
    for (let i = 0; i < MAX_HUB_REQUESTS_PER_SECOND + 1; i++) unavailable.emit('message', encodeFrame({ v: 1, id: 'r', op: 'hello' } as never))
    expect(decodeFrame(unavailable.replies.at(-1)!)).toMatchObject({ reason: 'rate-limited', retryMs: expect.any(Number) })
    const readonly = socket()
    bindHub(readonly, () => undefined, { readOnly: true })
    for (let i = 0; i <= MAX_HUB_REQUESTS_PER_SECOND; i++) readonly.emit('message', encodeFrame({ v: 1, id: 'r', op: 'hello' } as never))
    expect(decodeFrame(readonly.replies.at(-1)!)).toMatchObject({ reason: 'rate-limited' })
  } finally { parse.mockRestore() }
})

it('drains a disconnected legacy document by name before migration reads its archive', async () => {
  const stored = new Map<string, Uint8Array>()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  const provider: PersistenceProvider = {
    getYDoc: async name => {
      const doc = new Y.Doc()
      const update = stored.get(name)
      if (update) Y.applyUpdate(doc, update)
      return doc
    },
    storeUpdate: async (name, update) => {
      if (++writes > 1) await gate
      const before = stored.get(name)
      stored.set(name, before ? Y.mergeUpdates([before, update]) : update)
    },
  }
  const hubs = new ServerHubs({ store: { advance: async floor => floor }, log: () => {}, full: () => false })
  const persistence = hubs.persistence(provider)
  const live = new Y.Doc()
  await persistence.bindState('legacy', live)
  await hubs.flush(live)
  live.getMap('scopes').set('ben', { summary: 'last update' })
  let drained = false
  const flush = hubs.flushName('legacy').then(() => { drained = true })
  await Promise.resolve()
  expect(drained).toBe(false)
  expect((await provider.getYDoc('legacy')).getMap('scopes').get('ben')).toBeUndefined()
  release()
  await flush
  expect((await provider.getYDoc('legacy')).getMap('scopes').get('ben')).toMatchObject({ summary: 'last update' })
})

it('recovers a failed document write with the complete state and no unhandled rejection', async () => {
  const stored = new Map<string, Uint8Array>(), attempts: Uint8Array[] = [], logs: string[] = []
  let fail = false
  const provider: PersistenceProvider = {
    getYDoc: async name => { const doc = new Y.Doc(); if (stored.has(name)) Y.applyUpdate(doc, stored.get(name)!); return doc },
    storeUpdate: async (name, update) => {
      attempts.push(update)
      if (fail) { fail = false; throw new Error('disk full') }
      const before = stored.get(name)
      stored.set(name, before ? Y.mergeUpdates([before, update]) : update)
    },
  }
  const unhandled: unknown[] = [], listener = (error: unknown) => unhandled.push(error)
  process.on('unhandledRejection', listener)
  try {
    let mono = 0
    const hubs = new ServerHubs({ store: { advance: async floor => floor }, log: line => logs.push(line), full: () => false, mono: () => mono })
    const p = hubs.persistence(provider), live = new Y.Doc()
    await p.bindState('room', live)
    await hubs.flush(live)
    hubs.ensure('room', live)
    await vi.waitFor(() => expect(hubs.current('room')).toBeDefined())
    mono = 6_000
    const conn = {}, principal = { local: true } as const
    const hello = hubs.current('room')!.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 'test' }, principal)
    expect(hello.ok).toBe(true)
    live.getMap('scopes').set('first', 1)
    await hubs.flushName('room')
    fail = true
    live.getMap('scopes').set('second', 2)
    await vi.waitFor(() => expect(hubs.storageFailure('room')).toContain('disk full'))
    live.getMap('scopes').set('third', 3)
    await expect(hubs.flushName('room')).rejects.toThrow('disk full')
    const held = hubs.current('room')!.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada',
      holder: { sessionId: 'test', pid: 1, startTime: '', executable: '' } }, principal)
    expect(held).toMatchObject({ ok: false, reason: 'unavailable' })
    await vi.waitFor(() => expect(hubs.storageFailure('room')).toBeUndefined(), { timeout: 2_000 })
    await hubs.flushName('room')
    const accepted = hubs.current('room')!.handle(conn, { v: 1, id: 'b', op: 'acquire', name: 'ada',
      holder: { sessionId: 'test', pid: 1, startTime: '', executable: '' } }, principal)
    expect(accepted.ok).toBe(true)
    const recovered = await provider.getYDoc('room')
    expect(recovered.getMap('scopes').toJSON()).toEqual(live.getMap('scopes').toJSON())
    expect(attempts.length).toBeGreaterThanOrEqual(3)
    expect(logs.some(line => line.includes('storage recovered'))).toBe(true)
    expect(unhandled).toEqual([])
  } finally { process.off('unhandledRejection', listener) }
})

it('keeps a disconnected document until recovery and loads its state before replacement', async () => {
  const stored = new Map<string, Uint8Array>()
  let fail = false
  const provider: PersistenceProvider = {
    getYDoc: async name => { const doc = new Y.Doc(); if (stored.has(name)) Y.applyUpdate(doc, stored.get(name)!); return doc },
    storeUpdate: async (name, update) => {
      if (fail) throw new Error('disk full')
      stored.set(name, stored.has(name) ? Y.mergeUpdates([stored.get(name)!, update]) : update)
    },
  }
  const hubs = new ServerHubs({ store: { advance: async floor => floor }, log: () => {}, full: () => false })
  const persistence = hubs.persistence(provider), old = new Y.Doc(), replacement = new Y.Doc()
  await persistence.bindState('room', old)
  await hubs.flush(old)
  fail = true
  old.getMap('scopes').set('late', { summary: 'must survive' })
  await vi.waitFor(() => expect(hubs.storageFailure('room')).toContain('disk full'))
  let destroyed = false
  old.once('destroy', () => { destroyed = true })
  const disconnect = persistence.writeState('room').then(() => old.destroy())
  const loading = persistence.bindState('room', replacement)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(destroyed).toBe(false)
  fail = false
  await Promise.all([disconnect, loading])
  expect(destroyed).toBe(true)
  expect(replacement.getMap('scopes').get('late')).toMatchObject({ summary: 'must survive' })
})

it('contains a throwing hub tick and handle while metering hub-origin document updates', async () => {
  const logged: string[] = [], bytes: number[] = []
  const hubs = new ServerHubs({ store: { advance: async floor => floor }, log: line => logged.push(line), full: () => false,
    hubBytes: (_name, size) => bytes.push(size) })
  const provider: PersistenceProvider = { getYDoc: async () => new Y.Doc(), storeUpdate: async () => {} }
  const doc = new Y.Doc()
  await hubs.persistence(provider).bindState('room', doc)
  doc.transact(() => doc.getMap('scopes').set('a', 1), HUB_ORIGIN)
  expect(bytes[0]).toBeGreaterThan(0)
  const entries = (hubs as unknown as { entries: Map<string, { hub?: { tick(): void } }> }).entries
  entries.set('bad', { hub: { tick: () => { throw new Error('tick broke') } } })
  const good = vi.fn()
  entries.set('good', { hub: { tick: good } })
  hubs.tick()
  expect(good).toHaveBeenCalledOnce()
  expect(logged.some(line => line.includes('tick broke'))).toBe(true)
  const ws = new EventEmitter() as EventEmitter & { send(buf: Uint8Array): void }
  const replies: unknown[] = []
  ws.send = buf => { replies.push(decodeFrame(buf)) }
  bindHub(ws, () => ({ handle: () => { throw new Error('handle broke') }, closed: () => {} }) as never, { readOnly: false }, () => undefined)
  expect(() => ws.emit('message', encodeFrame({ v: 1, id: 'x', op: 'hello' } as never))).not.toThrow()
  expect(replies).toMatchObject([{ ok: false, reason: 'invalid', text: 'handle broke' }])
  const quarantined = new EventEmitter() as EventEmitter & { send(buf: Uint8Array): void }
  const denied: unknown[] = []
  quarantined.send = buf => { denied.push(decodeFrame(buf)) }
  bindHub(quarantined, () => undefined, { readOnly: false }, () => 'quarantined room state')
  quarantined.emit('message', encodeFrame({ v: 1, id: 'q', op: 'hello' } as never))
  expect(denied).toMatchObject([{ ok: false, reason: 'unavailable', text: 'quarantined room state' }])
})

it('bounds process-wide rooms awaiting persistence before admitting another room', async () => {
  const gate = new Promise<void>(() => {})
  const provider: PersistenceProvider = { getYDoc: async () => new Y.Doc(), storeUpdate: async () => gate }
  const hubs = new ServerHubs({ store: { advance: async floor => floor }, log: () => {}, full: () => false })
  const persistence = hubs.persistence(provider)
  for (let i = 0; i < 16; i++) await persistence.bindState(`room-${i}`, new Y.Doc())
  expect(hubs.storageFailure('room-16')).toContain('backlog is full')
})
