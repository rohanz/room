import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import http from 'node:http'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { localProofHeader, localViewKey, probeRelay, relayProof, startRelay, viewTicketProof } from '../src/index.js'
import { authorizedWebSocket } from '../../roomd/src/ws-auth.js'

const room = 'local/credentials', key = 'test-key'
describe('local relay credentials', () => {
  it('uses port-bound one-use proofs and refuses obsolete credentials', async () => {
    const relay = await startRelay(0, { key })
    const base = `http://127.0.0.1:${relay.port}`
    const path = `/${encodeURIComponent(room)}?schema=2`
    const connect = (query: string, headers: Record<string, string> = {}) => new Promise<number>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}${path}${query}`, { headers })
      ws.once('open', () => { ws.close(); resolve(101) })
      ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate() })
      ws.once('error', () => resolve(0))
    })
    try {
      const nonce = 'a'.repeat(32)
      const health = await fetch(base + '/health', { headers: { 'x-room-nonce': nonce } })
      expect((await health.json() as { proof: string }).proof).toBe(relayProof(key, nonce, relay.port))
      const proof = localProofHeader(key, 'GET', path, relay.port)
      expect(await connect('', { authorization: proof })).toBe(101)
      expect(await connect('', { authorization: proof })).toBe(403)
      expect(await connect('', { authorization: 'Bearer test-key' })).toBe(400)
      expect(await connect('&key=test-key')).toBe(400)
      expect(await connect('', { authorization: localProofHeader(key, 'GET', path, relay.port + 1) })).toBe(403)
      for (const body of ['null', '1', '[]', '"x"']) expect((await fetch(base + '/ws-ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(400)
      expect((await fetch(base + '/ws-ticket', { method: 'POST', headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' }, body: JSON.stringify({ room, schema: 2 }) })).status).toBe(400)
      const nodeTicket = await fetch(base + '/ws-ticket', { method: 'POST', headers: { authorization: localProofHeader(key, 'POST', '/ws-ticket', relay.port), 'content-type': 'application/json' }, body: JSON.stringify({ room, schema: 2 }) })
      expect(nodeTicket.status).toBe(200)
      const ts = Date.now(), viewNonce = crypto.randomBytes(16).toString('hex'), view = localViewKey(key, room)
      const body = JSON.stringify({ room, schema: 2, ts, nonce: viewNonce, proof: viewTicketProof(view, room, ts, viewNonce) })
      const minted = await fetch(base + '/ws-ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(minted.status).toBe(200)
      expect(minted.headers.get('access-control-allow-origin')).toBe('*')
      expect((await fetch(base + '/ws-ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(403)
      const { ticket } = await minted.json() as { ticket: string }
      expect(await connect(`&ticket=${ticket}`)).toBe(101)
      expect(await connect(`&ticket=${ticket}`)).toBe(403)
      expect(view).not.toBe(key)
      const nextTs = Date.now(), nextNonce = crypto.randomBytes(16).toString('hex')
      const nextBody = JSON.stringify({ room, schema: 2, ts: nextTs, nonce: nextNonce, proof: viewTicketProof(view, room, nextTs, nextNonce) })
      const viewTicket = (await (await fetch(base + '/ws-ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: nextBody })).json() as { ticket: string }).ticket
      const viewerDoc = new Y.Doc(), writerDoc = new Y.Doc()
      const viewer = new WebsocketProvider(`ws://127.0.0.1:${relay.port}`, encodeURIComponent(room), viewerDoc, { WebSocketPolyfill: WebSocket as never, params: { schema: '2', ticket: viewTicket }, disableBc: true })
      const writer = new WebsocketProvider(`ws://127.0.0.1:${relay.port}`, encodeURIComponent(room), writerDoc, { WebSocketPolyfill: authorizedWebSocket({ key }) as never, params: { schema: '2' }, disableBc: true })
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('providers did not sync')), 3000)
          const check = () => { if (viewer.synced && writer.synced) { clearTimeout(timer); resolve() } }
          viewer.on('sync', check); writer.on('sync', check); check()
        })
        viewerDoc.getText('private').insert(0, 'blocked')
        await new Promise(resolve => setTimeout(resolve, 100))
        expect(writerDoc.getText('private').toString()).toBe('')
      } finally { viewer.destroy(); writer.destroy(); viewerDoc.destroy(); writerDoc.destroy() }
      const preflight = await fetch(base + '/ws-ticket', { method: 'OPTIONS' })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type')
    } finally { await relay.close() }
  })

  it('never sends the discovery key to a listener that takes the recorded port', async () => {
    const captured: string[] = []
    const fake = http.createServer((req, res) => {
      captured.push(`${req.method} ${req.url}\n${JSON.stringify(req.headers)}`)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ local: true, schema: 2, hub: 1, clone: 'fake' }))
    })
    await new Promise<void>(resolve => fake.listen(0, '127.0.0.1', resolve))
    const port = (fake.address() as { port: number }).port
    try {
      expect(await probeRelay(port, '/tmp/fake-clone', key)).not.toBe('ours')
      const Polyfill = authorizedWebSocket({ key })
      await new Promise<void>(resolve => {
        const ws = new Polyfill(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?schema=2`)
        ws.once('error', () => resolve())
      })
      expect(captured.join('\n')).not.toContain(key)
      expect(captured.every(request => request.startsWith('GET /health'))).toBe(true)
    } finally { await new Promise<void>(resolve => fake.close(() => resolve())) }
  })

  it('closes state-request floods and a consumer sent more than its output budget', async () => {
    const relay = await startRelay(0, { key, socketQueueBytes: 256 * 1024 })
    const path = `/${encodeURIComponent(room)}?schema=2`
    const open = () => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}${path}`, { headers: { authorization: localProofHeader(key, 'GET', path, relay.port) } })
      ws.once('open', () => resolve(ws)); ws.once('error', reject)
    })
    try {
      const flood = await open()
      const flooded = new Promise<number>(resolve => flood.once('close', code => resolve(code)))
      for (let n = 0; n < 11; n++) flood.send(Uint8Array.of(0, 0))
      expect(await flooded).toBe(1013)
      // A consumer that has stopped reading falls behind; once its queue passes the budget it is cut off,
      // while a single large message into an empty queue (how a big document arrives) is still delivered.
      const sender = await open()
      const reader = await open()
      const slow = await open()
      const received = new Promise<number>(resolve => reader.on('message', data => { if ((data as Buffer).byteLength > 1024 * 1024) resolve((data as Buffer).byteLength) }))
      const closed = new Promise<number>(resolve => slow.once('close', code => resolve(code)))
      const update = (text: string) => {
        const doc = new Y.Doc()
        doc.getText(`t${Math.random()}`).insert(0, text)
        const frame = encoding.createEncoder()
        encoding.writeVarUint(frame, 0)
        syncProtocol.writeUpdate(frame, Y.encodeStateAsUpdate(doc))
        return encoding.toUint8Array(frame)
      }
      sender.send(update('x'.repeat(2 * 1024 * 1024)))
      expect(await received).toBeGreaterThan(2 * 1024 * 1024)
      ;(slow as unknown as { _socket: { pause(): void } })._socket.pause()
      for (let n = 0; n < 200; n++) sender.send(update('y'.repeat(64 * 1024)))
      await new Promise(resolve => setTimeout(resolve, 2500))
      ;(slow as unknown as { _socket: { resume(): void } })._socket.resume()
      expect([1013, 1006]).toContain(await closed)
      sender.terminate(); reader.terminate()
    } finally { await relay.close() }
  })
})
