import { afterAll, beforeAll, expect, it } from 'vitest'
import net from 'node:net'
import WebSocket from 'ws'
import { devServers } from './dev-server.js'

const servers = devServers()
let base: string
beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const value = (server.address() as { port: number }).port; server.close(() => resolve(value)) })
  })
  base = `http://127.0.0.1:${port}`
  const { YPERSISTENCE: _volume, ...inherited } = process.env
  servers.start({ env: { ...inherited, PORT: String(port), HOST: '127.0.0.1', ROOM_SERVER: '', ROOM_MAX_ROOMS: '2', ROOM_MAX_CONNECTIONS: '2', NODE_ENV: 'test' }, stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw Error('server did not start')
})
afterAll(() => servers.stopAll())

it('admits exactly two of three concurrent cross-repository creations', async () => {
  const statuses = await Promise.all(['a', 'b', 'c'].map(name => fetch(base + '/rooms', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: `local/${name}`, schema: 2 }) }).then(response => response.status)))
  expect(statuses.filter(status => status === 201)).toHaveLength(2)
  expect(statuses.filter(status => status === 503)).toHaveLength(1)
})

it('reserves the global connection quota across repositories', async () => {
  const rooms = await (await fetch(base + '/rooms')).json() as { repo: string }[]
  const connect = (room: string) => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/' + encodeURIComponent(room) + '?schema=2')
    ws.once('open', () => resolve(ws))
    ws.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)))
    ws.once('error', reject)
  })
  const first = await connect(rooms[0].repo), second = await connect(rooms[1].repo)
  try { await expect(connect(rooms[0].repo)).rejects.toThrow('HTTP 503') }
  finally { first.close(); second.close() }
})
