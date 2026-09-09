#!/usr/bin/env tsx
/**
 * Room server: a stock y-websocket server. All coordination state lives inside the
 * Y.Doc, so this process has no room-specific logic. Room name = URL path.
 */
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { setupWSConnection } from '@y/websocket-server/utils'

const PORT = Number(process.env.PORT ?? 1234)
const HOST = process.env.HOST ?? '0.0.0.0'

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('room server: connect a y-websocket client to ws://host:port/<room>\n')
})
const wss = new WebSocketServer({ noServer: true })
wss.on('connection', (conn, req) => setupWSConnection(conn, req, { gc: true }))
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})
server.listen(PORT, HOST, () => console.log(`room server listening on ws://${HOST}:${PORT}/<room>`))
