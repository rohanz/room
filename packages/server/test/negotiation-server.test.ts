/** Real hosted transport regressions; independent process keeps the production login budget intact. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import WebSocket from 'ws'
import { CURRENT_COMPAT, decodeFrame, encodeFrame, type BootstrapSelection } from '@room/hub-core'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { RoomDoc } from '@room/shared'
import { WebsocketProvider } from 'y-websocket'
import { negotiatedWebSocket, VIEWER_COMPAT } from '../../web/src/negotiated-websocket.js'
import { devServers } from './dev-server.js'

// No frame can signal success while the protocol intentionally withholds it.
const NO_DOCUMENT_FRAME_WINDOW_MS = 25
const servers = devServers(), persistenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-negotiation-'))
let port: number, base: string
const post = (route: string, body: unknown) => fetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
async function login(fakeLogin: string): Promise<string> {
  const start = await post('/auth/device', {})
  expect(start.status).toBe(200)
  const { device } = await start.json() as { device: string }
  const done = await post('/auth/poll', { device, fakeLogin })
  expect(done.status).toBe(200)
  return ((await done.json()) as { session: string }).session
}
beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const value = (server.address() as { port: number }).port
      server.close(() => resolve(value))
    })
  })
  base = `http://127.0.0.1:${port}`
  const logs: string[] = []
  const child = servers.start({ env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test',
    ROOM_SERVER: '', GITHUB_CLIENT_ID: 'fake', ROOM_TOKEN: '', YPERSISTENCE: persistenceDir }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', data => logs.push(String(data)))
  child.stderr!.on('data', data => logs.push(String(data)))
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${logs.join('')}`)
    try { if ((await fetch(base + '/health')).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`server did not start: ${logs.join('')}`)
}, 15000)
afterAll(async () => { try { await servers.stopAll() } finally { fs.rmSync(persistenceDir, { recursive: true, force: true }) } })

describe('hosted bootstrap and the frozen legacy wire profile', () => {
  it('negotiates before any document frame and attaches only after its selection ACK', async () => {
    const session = await login('negotiated')
    const room = 'github.com/negotiated/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    // The admitted canonical identity, not a schema query, chooses the new route.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?negotiate=1&gen=fresh`, { headers: { authorization: `Bearer ${session}` } })
    const packets: Uint8Array[] = []
    ws.on('message', data => packets.push(new Uint8Array(data as Buffer)))
    try {
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      await new Promise(resolve => setTimeout(resolve, NO_DOCUMENT_FRAME_WINDOW_MS))
      expect(packets).toHaveLength(0)
      ws.send(encodeFrame({ v: 1, id: 'hello', op: 'compat-hello', sessionId: 'negotiated-session', offer: CURRENT_COMPAT }))
      await expect.poll(() => packets.length).toBe(1)
      const reply = decodeFrame(packets[0]) as BootstrapSelection
      expect(reply).toMatchObject({ ok: true, compat: CURRENT_COMPAT, selection: { bootstrap: 1, hub: 1, schema: 2 } })
      await new Promise(resolve => setTimeout(resolve, NO_DOCUMENT_FRAME_WINDOW_MS))
      expect(packets).toHaveLength(1)
      ws.send(encodeFrame({ v: 1, id: 'ack', op: 'compat-ack', selectionId: reply.selectionId }))
      await expect.poll(() => packets.some(p => p[0] === 0)).toBe(true)
    } finally { ws.close() }
  })

  it('refuses an unknown bootstrap before upgrade with the side that must change', async () => {
    const result = await new Promise<{ status: number; body: string }>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/local%2Fbad-bootstrap?schema=2&negotiate=2`)
      ws.on('unexpected-response', (_req, res) => {
        let body = ''; res.on('data', part => { body += part }); res.on('end', () => { resolve({ status: res.statusCode!, body }); ws.terminate() })
      })
      ws.on('error', () => {})
    })
    expect(result.status).toBe(426)
    expect(JSON.parse(result.body)).toMatchObject({ code: expect.any(String), side: 'client', supported: { server: CURRENT_COMPAT } })
  })

  it('names the server side on a newer-only client refusal without sending Yjs', async () => {
    const session = await login('newer-client'), room = 'github.com/newer-client/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?negotiate=1&gen=fresh`, { headers: { authorization: `Bearer ${session}` } })
    const packets: Uint8Array[] = []
    ws.on('message', data => packets.push(new Uint8Array(data as Buffer)))
    const closed = new Promise<number>(resolve => ws.once('close', resolve))
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(encodeFrame({ v: 1, id: 'h', op: 'compat-hello', sessionId: 's', offer: { ...CURRENT_COMPAT, hub: { min: 2, max: 2 } } }))
    expect(await closed).toBe(4406)
    expect(packets).toHaveLength(1)
    expect(decodeFrame(packets[0])).toMatchObject({ ok: false, error: { side: 'server' } })
  })

  it('revokes a pending selection on logout without exchanging document data', async () => {
    const session = await login('pending-logout'), room = 'github.com/pending-logout/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?negotiate=1&gen=fresh`, { headers: { authorization: `Bearer ${session}` } })
    const packets: Uint8Array[] = []
    ws.on('message', data => packets.push(new Uint8Array(data as Buffer)))
    const closed = new Promise<number>(resolve => ws.once('close', resolve))
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(encodeFrame({ v: 1, id: 'h', op: 'compat-hello', sessionId: 's', offer: CURRENT_COMPAT }))
    await expect.poll(() => packets.length).toBe(1)
    expect((await post('/auth/logout', { session })).status).toBe(200)
    expect(await closed).toBe(4401)
    expect(packets.every(p => p[0] === 7)).toBe(true)
  })

  it('binds a negotiating viewer ticket to its offer and preserves read-only hub authority', async () => {
    const session = await login('viewer-compat'), room = 'github.com/viewer-compat/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    const { view } = await (await post('/view-token', { room, session, schema: 2 })).json() as { view: string }
    const offer = VIEWER_COMPAT
    const { ticket } = await (await post('/ws-ticket', { room, view, schema: 2, compat: offer })).json() as { ticket: string }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?negotiate=1&gen=fresh&ticket=${ticket}`)
    const packets: Uint8Array[] = []
    ws.on('message', data => packets.push(new Uint8Array(data as Buffer)))
    try {
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      ws.send(encodeFrame({ v: 1, id: 'h', op: 'compat-hello', sessionId: 'viewer', offer }))
      await expect.poll(() => packets.length).toBe(1)
      const reply = decodeFrame(packets[0]) as BootstrapSelection
      expect(reply.ok).toBe(true)
      ws.send(encodeFrame({ v: 1, id: 'ack', op: 'compat-ack', selectionId: reply.selectionId }))
      await expect.poll(() => packets.some(p => p[0] === 0)).toBe(true)
      ws.send(encodeFrame({ v: 1, id: 'write', op: 'renew', name: 'viewer-compat', epoch: 1 }))
      await expect.poll(() => packets.filter(p => p[0] === 7).map(decodeFrame).some(p => (p as { re?: string }).re === 'write')).toBe(true)
      expect(packets.filter(p => p[0] === 7).map(decodeFrame).at(-1)).toMatchObject({ re: 'write', ok: false, reason: 'read-only' })
    } finally { ws.close() }
  })

  it('admits the browser transport through negotiation and drops its document writes', async () => {
    const session = await login('browser-viewer'), room = 'github.com/browser-viewer/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    const { view } = await (await post('/view-token', { room, session, schema: 2 })).json() as { view: string }
    const { ticket } = await (await post('/ws-ticket', { room, view, schema: 2, compat: VIEWER_COMPAT })).json() as { ticket: string }
    const doc = new RoomDoc(), errors: string[] = []
    const provider = new WebsocketProvider(base.replace('http:', 'ws:'), encodeURIComponent(room), doc.doc, {
      WebSocketPolyfill: negotiatedWebSocket(globalThis.WebSocket, text => errors.push(text)), params: { ticket, schema: '2', gen: 'fresh' }, disableBc: true,
    })
    try {
      await expect.poll(() => provider.synced).toBe(true)
      expect(errors).toEqual([])
      doc.doc.getText('forbidden').insert(0, 'viewer write')
      const other = new RoomDoc()
      const { ticket: next } = await (await post('/ws-ticket', { room, view, schema: 2, compat: VIEWER_COMPAT })).json() as { ticket: string }
      const reader = new WebsocketProvider(base.replace('http:', 'ws:'), encodeURIComponent(room), other.doc, {
        WebSocketPolyfill: negotiatedWebSocket(globalThis.WebSocket, text => errors.push(text)), params: { ticket: next, schema: '2', gen: 'fresh' }, disableBc: true,
      })
      try { await expect.poll(() => reader.synced).toBe(true); expect(other.doc.getText('forbidden').toString()).toBe('') }
      finally { reader.destroy(); other.doc.destroy() }
    } finally { provider.destroy(); doc.doc.destroy() }
  })

  it('refuses a non-negotiating websocket before any document exchange', async () => {
    const session = await login('no-bootstrap'), room = 'github.com/no-bootstrap/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?schema=2`, { headers: { authorization: `Bearer ${session}` } })
    const response = await new Promise<{ code: number; body: string }>((resolve, reject) => {
      ws.once('open', () => reject(new Error('unexpected websocket admission')))
      ws.once('error', reject)
      ws.once('unexpected-response', (_request, reply) => {
        let body = ''; reply.on('data', chunk => { body += chunk }); reply.on('end', () => resolve({ code: reply.statusCode!, body }))
      })
    })
    expect(response.code).toBe(426)
    expect(JSON.parse(response.body).text).toBe('Room requires negotiated admission; reconnect with negotiate=1')
  })

})
