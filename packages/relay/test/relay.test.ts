import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { authorizedWebSocket } from '../../roomd/src/ws-auth.js'
const keyedSocket = (key: string) => authorizedWebSocket({ key })
import { WebsocketProvider } from 'y-websocket'
import { canonicalRelayWarning, localProofHeader, startRelay } from '../src/index.js'
import http from 'node:http'

/** A stand-in for a clone's git common dir: the relay only needs a directory for its discovery file. */
const makeCommonDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'room-relay-'))
// Withheld frames have no completion signal before sync/undrain.
const NO_BROADCAST_WINDOW_MS = 150
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const until = async (f: () => boolean | Promise<boolean>, ms = 5000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(50) } }

it('classifies old, mismatched-key, foreign-clone, and non-Room canonical listeners without sockets', () => {
  const common = '/tmp/room-collision-test'
  const port = 46115
  const info = { schema: 2 as const, port, pid: 321, room: 'local/test', startedAt: Date.UTC(2026, 8, 28), key: 'stale' }
  const old = canonicalRelayWarning(port, common, { health: { ok: true, local: true }, proven: false }, info)
  expect(old.warning).toBe("an older Room session (pid 321, started 2026-09-28T00:00:00.000Z) still holds this room's relay on 127.0.0.1:46115; quit it or reconnect Room there")
  const mismatch = canonicalRelayWarning(port, common, { health: { ok: true, local: true, schema: 2, hub: 1 }, proven: false }, info)
  expect(mismatch.warning).toBe(old.warning)
  expect(canonicalRelayWarning(port, common, { health: { ok: true, local: true, clone: 'another-clone' }, proven: false }, info)).toEqual({ roomRelay: true })
  expect(canonicalRelayWarning(port, common, { health: { ok: true }, proven: false }, info)).toEqual({ roomRelay: false })
})

describe('local relay browser view', () => {
  const get = (url: string) => new Promise<{ status: number; body: string; type: string }>((resolve, reject) => {
    http.get(url, res => { let body = ''; res.on('data', c => { body += c }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body, type: String(res.headers['content-type']) })) }).on('error', reject)
  })
  it('serves no viewer assets, but keeps /health and authenticated websockets', async () => {
    const dist = await fsp.mkdtemp(path.join(os.tmpdir(), 'room-dist-'))
    await fsp.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Room</title>')
    await fsp.writeFile(path.join(dist, 'app.js'), 'console.log(1)')
    const relay = await startRelay(0, { staticDir: dist, key: 'test-key' })
    try {
      const root = await get(`http://127.0.0.1:${relay.port}/`)
      expect(root.status).toBe(200); expect(root.type).toContain('text/plain'); expect(root.body).toContain('file link printed by your agent')
      const js = await get(`http://127.0.0.1:${relay.port}/app.js`)
      expect(js.status).toBe(404); expect(js.body).not.toContain('console.log')
      const html = await get(`http://127.0.0.1:${relay.port}/index.html`)
      expect(html.status).toBe(404)
      const health = await get(`http://127.0.0.1:${relay.port}/health`)
      expect(JSON.parse(health.body)).toMatchObject({ ok: true, local: true, schema: 2, hub: 1, discovery: 1, runtime: 'session-relay', compat: { bootstrap: 1 } })
      const old = await new Promise<{ code: number; text: string }>(resolve => {
        const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/local%2Fx`)
        ws.on('unexpected-response', (_request, response) => { resolve({ code: response.statusCode ?? 0, text: response.statusMessage ?? '' }); ws.terminate() })
        ws.on('error', () => {})
      })
      expect(old.code).toBe(426)
      expect(old.text).toBe('Room requires negotiated admission; reconnect with negotiate=1')
      const outside = await get(`http://127.0.0.1:${relay.port}/../../etc/passwd`)
      expect(outside.body).not.toContain('root:')
      const doc = new Y.Doc()
      const provider = new WebsocketProvider(`ws://127.0.0.1:${relay.port}`, encodeURIComponent('local/x'), doc, { WebSocketPolyfill: keyedSocket('test-key') as never, params: { schema: '2' } })
      await until(() => provider.synced)
      provider.destroy()
      // a sibling directory that merely shares the prefix is not served
      const sibling = `${dist}-private`
      await fsp.mkdir(sibling); await fsp.writeFile(path.join(sibling, 'secret.txt'), 'shh')
      const leak = await get(`http://127.0.0.1:${relay.port}/../${path.basename(sibling)}/secret.txt`)
      expect(leak.body).not.toContain('shh')
    } finally { await relay.close() }
  })
})

it('restores memory in a new relay, excludes live state, and forgets through an authenticated request', async () => {
  const commonDir = await makeCommonDir(), room = 'local/restart'
  const { memoryFile, loadMemory } = await import('../src/memory.js')
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined
  let provider: WebsocketProvider | undefined
  const docs: Y.Doc[] = []
  const connect = async () => {
    const doc = new Y.Doc(); docs.push(doc)
    provider = new WebsocketProvider(`ws://127.0.0.1:${relay!.port}`, encodeURIComponent(room), doc, {
      WebSocketPolyfill: keyedSocket('test-key') as never, params: { schema: '2' }, disableBc: true,
    })
    await until(() => provider!.synced)
    return doc
  }
  try {
    relay = await startRelay(0, { commonDir, key: 'test-key' })
    const first = await connect()
    for (const type of ['bus', 'retiredWorkers']) first.getArray(type).push([{ id: type }])
    for (const type of ['workers', 'scopes', 'colors', 'meta', 'ledger']) first.getMap(type).set('key', { value: type })
    for (const type of ['overlays', 'deleted', 'basetext', 'graphs', 'claims']) first.getMap(type).set('stale', 'text')
    await until(() => {
      if (!fs.existsSync(memoryFile(commonDir, room))) return false
      const snapshot = loadMemory(commonDir, room)
      try { return snapshot.getArray('bus').length === 1 } finally { snapshot.destroy() }
    })
    // Last client leaving and the relay shutting down must both preserve the snapshot.
    provider!.destroy(); provider = undefined
    await relay.close()
    relay = await startRelay(0, { commonDir, key: 'test-key' })
    const second = await connect()
    expect(second.getArray('bus').toArray()).toEqual([{ id: 'bus' }])
    expect(second.getArray('retiredWorkers').toArray()).toEqual([{ id: 'retiredWorkers' }])
    expect(second.getMap('workers').get('key')).toEqual({ value: 'workers' })
    expect(second.getMap('scopes').get('key')).toEqual({ value: 'scopes' })
    for (const type of ['overlays', 'deleted', 'basetext', 'graphs']) {
      // Live file text and graphs are rebuilt, even if schema 2 initializes empty roots.
      expect(second.getMap(type).has('stale')).toBe(false)
    }
    // Registry §18 keeps offline claims in the doc when a session ends.
    expect(second.getMap('claims').get('stale')).toBe('text')
    const url = `http://127.0.0.1:${relay.port}/memory?room=${encodeURIComponent(room)}`
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(403)
    expect(fs.existsSync(memoryFile(commonDir, room))).toBe(true)
    expect((await fetch(url, { method: 'DELETE', headers: { authorization: localProofHeader('test-key', 'DELETE', new URL(url).pathname + new URL(url).search, relay.port) } })).status).toBe(204)
    provider!.destroy(); provider = undefined
    await relay.close(); relay = undefined
    expect(fs.existsSync(memoryFile(commonDir, room))).toBe(false)
  } finally {
    provider?.destroy(); await relay?.close()
    for (const doc of docs) doc.destroy()
    fs.rmSync(commonDir, { recursive: true, force: true })
  }
})

it.each([false, true])('withholds broadcasts until the first sync reply (held while draining: %s)', async draining => {
  const encoding = await import('lib0/encoding')
  const decoding = await import('lib0/decoding')
  const sync = await import('y-protocols/sync')
  const awarenessProtocol = await import('y-protocols/awareness')
  const relay = await startRelay(0, { key: 'sync-order' })
  const doc = new Y.Doc(), replica = new Y.Doc()
  const writer = new WebsocketProvider(`ws://127.0.0.1:${relay.port}`, 'local%2Fsync-order', doc, {
    WebSocketPolyfill: keyedSocket('sync-order') as never, params: { schema: '2' }, disableBc: true,
  })
  writer.awareness.setLocalState(null)
  let socket: WebSocket | undefined
  try {
    await until(() => writer.synced)
    const Socket = keyedSocket('sync-order')
    socket = new Socket(`ws://127.0.0.1:${relay.port}/local%2Fsync-order?schema=2`) as unknown as WebSocket
    const frames: Uint8Array[] = []
    socket.on('message', raw => frames.push(new Uint8Array(raw as Buffer)))
    await new Promise<void>(resolve => socket!.once('open', () => resolve()))
    // The relay attaches a socket on its first frame: an awareness frame here, so the socket is attached but has
    // not asked for state. It must receive the relay's sync step 1 and nothing else until it asks.
    const hello = encoding.createEncoder()
    encoding.writeVarUint(hello, 1)
    encoding.writeVarUint8Array(hello, awarenessProtocol.encodeAwarenessUpdate(new awarenessProtocol.Awareness(replica), []))
    socket.send(encoding.toUint8Array(hello))
    await until(() => frames.length === 1)
    expect(decoding.peekVarUint(decoding.createDecoder(frames[0]))).toBe(0)
    doc.getMap('meta').set('missed', 'covered by reply')
    await wait(NO_BROADCAST_WINDOW_MS)
    expect(frames).toHaveLength(1)
    if (draining) relay.setDraining(true)
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 0); sync.writeSyncStep1(enc, replica)
    socket.send(encoding.toUint8Array(enc))
    if (draining) {
      await wait(NO_BROADCAST_WINDOW_MS)
      expect(frames).toHaveLength(1)
      relay.setDraining(false)
    }
    await until(() => frames.length >= 2)
    const reply = decoding.createDecoder(frames[1])
    expect(decoding.readVarUint(reply)).toBe(0)
    expect(decoding.peekVarUint(reply)).toBe(sync.messageYjsSyncStep2)
    sync.readSyncMessage(reply, encoding.createEncoder(), replica, 'relay')
    expect(replica.getMap('meta').get('missed')).toBe('covered by reply')
    doc.getMap('meta').set('later', 'broadcast')
    await until(() => frames.some((f, i) => i >= 2 && decoding.peekVarUint(decoding.createDecoder(f)) === 0))
    for (const f of frames.slice(2)) {
      const d = decoding.createDecoder(f)
      if (decoding.readVarUint(d) !== 0) continue
      sync.readSyncMessage(d, encoding.createEncoder(), replica, 'relay')
    }
    expect(replica.getMap('meta').get('later')).toBe('broadcast')
  } finally {
    socket?.close(); writer.destroy(); await relay.close(); doc.destroy(); replica.destroy()
  }
})
