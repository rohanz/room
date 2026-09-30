/** Socket regression for the lead: requires loopback listen, unavailable in worker sandboxes. */
import { afterAll, beforeAll, expect, it } from 'vitest'
import net from 'node:net'
import WebSocket from 'ws'
import { devServers } from './dev-server.js'

const servers = devServers()
let base: string, port: number, session: string
const rooms = ['github.com/pending-tests/first', 'github.com/pending-tests/second']
const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const value = (server.address() as { port: number }).port; server.close(() => resolve(value)) })
  })
  base = `http://127.0.0.1:${port}`
  const { YPERSISTENCE: _volume, ...inherited } = process.env
  servers.start({ env: { ...inherited, PORT: String(port), HOST: '127.0.0.1', ROOM_SERVER: '', NODE_ENV: 'test',
    GITHUB_CLIENT_ID: 'fake', ROOM_TEST_UPGRADE_DELAY_MS: '1000', ROOM_MAX_PENDING_ADMISSIONS: '1', ROOM_MAX_PENDING_PER_ADDRESS: '1' }, stdio: 'ignore' })
  let started = false
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) { started = true; break } } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!started) throw Error('server did not start')
  const { device } = await (await post('/auth/device', {})).json() as { device: string }
  session = (await (await post('/auth/poll', { device, fakeLogin: 'pending-tests' })).json() as { session: string }).session
  for (const room of rooms) expect((await post('/rooms', { room, schema: 2, session })).status).toBe(201)
})
afterAll(() => servers.stopAll())

const join = (room: string) => new Promise<number>((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?schema=2`, { headers: { authorization: `Bearer ${session}` } })
  ws.once('open', () => { ws.close(); resolve(101) })
  ws.once('unexpected-response', (_request, response) => { resolve(response.statusCode ?? 0); ws.terminate() })
  ws.once('error', reject)
})
it('disconnect during suspended admission work retains capacity across distinct repositories until settlement', async () => {
  // Raw upgrade lets us disconnect before handleUpgrade; HTTP requests expose the refusal status.
  const raw = net.connect(port, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { raw.once('connect', resolve); raw.once('error', reject) })
  raw.write(`GET /${encodeURIComponent(rooms[0])}?schema=2 HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer ${session}\r\n\r\n`)
  // Wait for the admission slot to be occupied, then abandon it while loading is suspended.
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(await join(rooms[1])).toBe(429)
  const closed = new Promise<void>(resolve => raw.once('close', () => resolve()))
  raw.destroy(); await closed
  for (let i = 0; i < 3; i++) expect(await join(rooms[1])).toBe(429)
  await new Promise(resolve => setTimeout(resolve, 1100))
  expect(await join(rooms[1])).toBe(101)
})
