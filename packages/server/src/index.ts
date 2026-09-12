#!/usr/bin/env tsx
/**
 * Room server: a stock y-websocket server plus access control and persistence.
 *  - Rooms named github.com/<owner>/<repo>/<branch> admit a websocket carrying ?gh=<GitHub token>
 *    when that token can read the repo (checked against the GitHub API, cached 10 min).
 *  - ROOM_TOKEN: if set, ?token=<same> admits any room (fallback for non-GitHub repos, and override).
 *  - With neither a GitHub-verifiable room nor ROOM_TOKEN configured, the server is open.
 *  - YPERSISTENCE: if set to a directory, rooms are stored in LevelDB there and survive restarts.
 * All coordination state lives inside the Y.Doc; room name = URL path.
 */
import http from 'node:http'
import crypto from 'node:crypto'
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

/** GitHub token -> (owner/repo -> admitted until). */
const ghCache = new Map<string, Map<string, number>>()
async function githubCanRead(token: string, ownerRepo: string): Promise<boolean> {
  const now = Date.now()
  const hit = ghCache.get(token)?.get(ownerRepo)
  if (hit && hit > now) return true
  try {
    const res = await fetch(`https://api.github.com/repos/${ownerRepo}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'room-server' } })
    if (!res.ok) return false
    let m = ghCache.get(token); if (!m) { m = new Map(); ghCache.set(token, m) }
    m.set(ownerRepo, now + 10 * 60 * 1000)
    return true
  } catch { return false }
}
/** Clients encode the room name once or twice; decode until it stops changing. */
function roomNameOf(roomPath: string): string {
  let name = roomPath.replace(/^\/+/, '')
  for (let i = 0; i < 3; i++) {
    let next: string
    try { next = decodeURIComponent(name) } catch { break }
    if (next === name) break
    name = next
  }
  return name
}
/** "github.com%2Fowner%2Frepo%2Fbranch" (or decoded) -> "owner/repo" */
function githubRepoOf(roomPath: string): string | undefined {
  const name = roomNameOf(roomPath)
  const m = name.match(/^github\.com\/([^/]+)\/([^/]+)\//)
  return m ? `${m[1]}/${m[2]}` : undefined
}

/** Room-scoped tokens for the browser view (minted for verified clients). Persisted next to the
 *  room data so a redeploy does not invalidate links people already opened. */
const viewTokens = new Map<string, { room: string; exp: number }>()
const VIEW_TTL = 7 * 24 * 60 * 60 * 1000
const VIEW_FILE = process.env.YPERSISTENCE ? path.join(process.env.YPERSISTENCE, 'view-tokens.json') : undefined
try { if (VIEW_FILE && fs.existsSync(VIEW_FILE)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(VIEW_FILE, 'utf8')) as Record<string, { room: string; exp: number }>)) if (v.exp > Date.now()) viewTokens.set(k, v) } catch { /* start empty */ }
function saveViewTokens() {
  if (!VIEW_FILE) return
  try { fs.writeFileSync(VIEW_FILE, JSON.stringify(Object.fromEntries(viewTokens))) } catch { /* best effort */ }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
  if (url.pathname === '/view-token' && req.method === 'POST') {
    let body = ''
    req.on('data', c => { body += c }); req.on('end', async () => {
      try {
        const { room, gh, token } = JSON.parse(body || '{}') as { room?: string; gh?: string; token?: string }
        if (!room) { res.writeHead(400); res.end('room required'); return }
        const repo = githubRepoOf(room)
        const ok = (TOKEN && token === TOKEN) || (gh && repo && await githubCanRead(gh, repo)) || (!TOKEN && !repo)
        if (!ok) {
          const why = repo && !gh && !token ? `no GitHub token: run \`gh auth login\` (room ${repo})`
            : repo && gh ? `your GitHub account cannot read ${repo}: accept the repo invite, or check \`gh auth status\` is the right account`
            : 'token required or wrong: set ROOM_SERVER=ws://host/?token=<shared token>'
          console.log(`view-token refused: ${why}`)
          res.writeHead(403, { 'content-type': 'text/plain' }); res.end(why); return
        }
        const view = crypto.randomBytes(16).toString('hex')
        viewTokens.set(view, { room: roomNameOf(room), exp: Date.now() + VIEW_TTL })
        for (const [k, v] of viewTokens) if (v.exp < Date.now()) viewTokens.delete(k)
        saveViewTokens()
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ view, expiresIn: VIEW_TTL }))
      } catch { res.writeHead(400); res.end('bad request') }
    })
    return
  }
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
const refuse = (socket: import('node:stream').Duplex, code: number, why: string, room?: string) => {
  console.log(`refused ${code} ${why}${room ? ` (room ${room})` : ''}`)
  socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const accept = () => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  if (TOKEN && url.searchParams.get('token') === TOKEN) return accept()
  const view = url.searchParams.get('view')
  if (view) {
    const v = viewTokens.get(view)
    const roomName = roomNameOf(url.pathname)
    if (v && v.exp > Date.now() && v.room === roomName) return accept()
    return refuse(socket, 403, 'Forbidden: view token invalid for this room')
  }
  const gh = url.searchParams.get('gh')
  const repo = githubRepoOf(url.pathname)
  if (gh && repo) {
    githubCanRead(gh, repo).then(ok => ok ? accept() : refuse(socket, 403, 'Forbidden: GitHub token cannot read ' + repo, repo)).catch(() => refuse(socket, 403, 'Forbidden', repo))
    return
  }
  if (!TOKEN && !repo) return accept() // open server, non-GitHub room
  refuse(socket, 401, repo ? `Unauthorized: no GitHub token for ${repo}` : 'Unauthorized: token required', repo ?? url.pathname)
})
server.listen(PORT, HOST, () => console.log(
  `room server listening on ws://${HOST}:${PORT}/<room>` +
  (TOKEN ? ' (token required)' : ' (no token: anyone with the URL can join)') +
  (process.env.YPERSISTENCE ? ` persisting to ${process.env.YPERSISTENCE}` : ' (in-memory: rooms reset on restart)'),
))
