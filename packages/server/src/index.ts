#!/usr/bin/env tsx
/**
 * Room server: a stock y-websocket server plus two switches.
 *  - ROOM_TOKEN: if set, every websocket must carry ?token=<same> or it is refused (401).
 *  - YPERSISTENCE: if set to a directory, rooms are stored in LevelDB there and survive restarts.
 * All coordination state lives inside the Y.Doc; room name = URL path.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { setupWSConnection } from '@y/websocket-server/utils'

const PORT = Number(process.env.PORT ?? 1234)
const HOST = process.env.HOST ?? '0.0.0.0'
const TOKEN = process.env.ROOM_TOKEN?.trim() || undefined
/** Directory with the built browser view (packages/web/dist). Served at / when present. */
const STATIC = process.env.ROOM_STATIC ?? path.resolve(process.cwd(), 'public')
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' }

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
  if (fs.existsSync(STATIC)) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const file = path.resolve(STATIC, rel)
    if (file.startsWith(STATIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': rel === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable' })
      fs.createReadStream(file).pipe(res)
      return
    }
  }
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
