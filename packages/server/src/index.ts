#!/usr/bin/env tsx
/**
 * Room server: a stock y-websocket server plus two switches.
 *  - ROOM_TOKEN: if set, every websocket must carry ?token=<same> or it is refused (401).
 *  - YPERSISTENCE: if set to a directory, rooms are stored in LevelDB there and survive restarts.
 * All coordination state lives inside the Y.Doc; room name = URL path.
 */
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { setupWSConnection } from '@y/websocket-server/utils'

const PORT = Number(process.env.PORT ?? 1234)
const HOST = process.env.HOST ?? '0.0.0.0'
const TOKEN = process.env.ROOM_TOKEN?.trim() || undefined

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end(`room server: connect a y-websocket client to ws://host:port/<room>${TOKEN ? '?token=...' : ''}\n`)
})
const wss = new WebSocketServer({ noServer: true })
wss.on('connection', (conn, req) => setupWSConnection(conn, req, { gc: true }))
server.on('upgrade', (req, socket, head) => {
  if (TOKEN) {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.searchParams.get('token') !== TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})
server.listen(PORT, HOST, () => console.log(
  `room server listening on ws://${HOST}:${PORT}/<room>` +
  (TOKEN ? ' (token required)' : ' (no token: anyone with the URL can join)') +
  (process.env.YPERSISTENCE ? ` persisting to ${process.env.YPERSISTENCE}` : ' (in-memory: rooms reset on restart)'),
))
