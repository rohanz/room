import { afterAll, beforeAll, expect, it } from 'vitest'
import net from 'node:net'
import WebSocket from 'ws'
import { devServers } from './dev-server.js'

const servers = devServers()
let base: string, port: number
const room = 'local/view-expiry-race'
beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const value = (server.address() as { port: number }).port; server.close(() => resolve(value)) })
  })
  base = `http://127.0.0.1:${port}`
  const { YPERSISTENCE: _volume, ...inherited } = process.env
  servers.start({ env: { ...inherited, PORT: String(port), HOST: '127.0.0.1', ROOM_SERVER: '', NODE_ENV: 'test',
    ROOM_TEST_UPGRADE_DELAY_MS: '250', ROOM_VIEW_TTL_MS: '100' }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw Error('server did not start')
})
afterAll(() => servers.stopAll())

it('refuses a view key that expires during the awaited document load', async () => {
  const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect((await post('/rooms', { room, schema: 2 })).status).toBe(201)
  const { view } = await (await post('/view-token', { room, schema: 2 })).json() as { view: string }
  const { ticket } = await (await post('/ws-ticket', { room, schema: 2, view })).json() as { ticket: string }
  const status = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?schema=2&ticket=${ticket}`)
    ws.once('open', () => { ws.close(); reject(Error('expired view was upgraded')) })
    ws.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
    ws.once('error', reject)
  })
  expect(status).toBe(403)
})
