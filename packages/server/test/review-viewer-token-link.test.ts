import { expect, it } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { CURRENT_COMPAT, encodeFrame, decodeFrame } from '@room/hub-core'
import { roomConnection } from '@room/shared'
import { authorizedWebSocket } from '../../roomd/src/ws-auth.js'
import { negotiatedWebSocket, VIEWER_COMPAT } from '../../web/src/negotiated-websocket.js'
import { devServers } from './dev-server.js'
import { mintTicket, parseRoomUrl } from '../../web/src/conn.js'

it('opens token and session browser links with member offers, and keeps view keys read-only', async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer(); s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
  })
  const servers = devServers(), base = `http://127.0.0.1:${port}`, wsBase = base.replace('http:', 'ws:')
  const persistence = fs.mkdtempSync(path.join(os.tmpdir(), 'room-review-viewer-')), logs: string[] = []
  const child = servers.start({ env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
    ROOM_SERVER: '', GITHUB_CLIENT_ID: 'fake', ROOM_TOKEN: 'review-token', YPERSISTENCE: persistence }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', chunk => logs.push(String(chunk))); child.stderr!.on('data', chunk => logs.push(String(chunk)))
  const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let writer: WebsocketProvider | undefined
  const writerDoc = new Y.Doc()
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(`test server exited: ${logs.join('')}`)
      return fetch(base + '/health').then(r => r.ok, () => false)
    }, { timeout: 10000 }).toBe(true)
    const { device } = await (await post('/auth/device', {})).json() as { device: string }
    const { session } = await (await post('/auth/poll', { device, fakeLogin: 'viewer-review' })).json() as { session: string }
    const room = 'local/token-view', loc = parseRoomUrl(wsBase + '/' + encodeURIComponent(room))
    expect((await post('/rooms', { room, schema: 2, session })).status).toBe(201)
    const { view } = await (await post('/view-token', { room, schema: 2, session })).json() as { view: string }
    writer = new WebsocketProvider(wsBase, encodeURIComponent(room), writerDoc, {
      WebSocketPolyfill: authorizedWebSocket({ session }) as never, ...roomConnection(writerDoc),
    })
    await expect.poll(() => writer!.synced).toBe(true)
    writerDoc.getText('content').insert(0, 'room contents')
    await new Promise<void>(resolve => { writer!.ws!.once('pong', resolve); writer!.ws!.ping() })
    for (const [auth, offer] of [
      [{ view: '', key: '', token: 'review-token' }, CURRENT_COMPAT],
      [{ view: '', key: '', token: '', session }, CURRENT_COMPAT],
      [{ view, key: '', token: '' }, VIEWER_COMPAT],
    ] as const) {
      const ticket = await mintTicket(loc, auth), doc = new Y.Doc(), errors: string[] = []
      const viewer = new WebsocketProvider(wsBase, encodeURIComponent(room), doc, {
        WebSocketPolyfill: negotiatedWebSocket(globalThis.WebSocket, why => errors.push(why), offer),
        ...roomConnection(doc), params: { ...roomConnection(doc).params, ticket },
      })
      try {
        await expect.poll(() => viewer.synced, { message: JSON.stringify(errors) }).toBe(true)
        expect(doc.getText('content').toString()).toBe('room contents')
        expect(errors).toEqual([])
      } finally { viewer.destroy(); doc.destroy() }
    }
    // A write-capable advertisement cannot promote a view-key credential.
    const response = await post('/ws-ticket', { room, schema: 2, compat: CURRENT_COMPAT, view })
    expect(response.status).toBe(200)
    const { ticket } = await response.json() as { ticket: string }
    const socket = new (authorizedWebSocket({}))(`${wsBase}/${encodeURIComponent(room)}?schema=2&gen=fresh&ticket=${ticket}`)
    const replies: unknown[] = []
    socket.on('message', raw => { const bytes = new Uint8Array(raw as ArrayBuffer); if (bytes[0] === 7) replies.push(decodeFrame(bytes)) })
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      socket.send(encodeFrame({ v: 1, id: 'forbidden', op: 'renew', name: 'reader', epoch: 1 }))
      await expect.poll(() => replies.find(reply => (reply as { re?: string }).re === 'forbidden')).toMatchObject({ ok: false, reason: 'read-only' })
    } finally { socket.close() }
    // A member credential offering only reads is refused; offers never change its admission role.
    for (const credential of [{ token: 'review-token' }, { session }]) {
      expect((await post('/ws-ticket', { room, schema: 2, compat: VIEWER_COMPAT, ...credential })).status).toBe(426)
    }
  } finally { writer?.destroy(); writerDoc.destroy(); await servers.stopAll(); fs.rmSync(persistence, { recursive: true, force: true }) }
}, 15000)
