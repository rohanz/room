#!/usr/bin/env tsx
/**
 * Room server: a stock y-websocket server plus access control and persistence.
 *  - Rooms named github.com/<owner>/<repo>/<branch> admit a websocket carrying ?gh=<GitHub token>
 *    when that token has push access to the repo (checked against the GitHub API, cached 10 min).
 *    Read access is not enough: a public repo must not be an open room.
 *  - ROOM_TOKEN: if set, ?token=<same> admits any room (fallback for non-GitHub repos, and override).
 *  - With neither a GitHub-verifiable room nor ROOM_TOKEN configured, the server is open.
 *  - YPERSISTENCE: if set to a directory, rooms are stored in LevelDB there and survive restarts.
 *  - A repo is opened explicitly once (POST /rooms) before anyone can connect to any of its branch
 *    rooms; a websocket to a repo nobody opened is refused with 404. Joining a branch of an
 *    opened repo needs no further step. GET /rooms lists the caller's open repos; DELETE /rooms
 *    closes one: live connections are dropped and persisted branch docs deleted.
 *  - Browser view keys (?view=) are read-only: inbound document writes are discarded.
 * All coordination state lives inside the Y.Doc; room name = URL path.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { setupWSConnection, docs, getPersistence } from '@y/websocket-server/utils'
import { makeReadOnly } from './readonly.js'

const PORT = Number(process.env.PORT ?? 1234)
const HOST = process.env.HOST ?? '0.0.0.0'
const TOKEN = process.env.ROOM_TOKEN?.trim() || undefined
/** Directory with the built browser view (packages/web/dist). Served at / when present. */
const STATIC = process.env.ROOM_STATIC ?? path.resolve(process.cwd(), 'public')
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' }

/** GitHub token -> (owner/repo -> admitted until). */
const ghCache = new Map<string, Map<string, number>>()
/** Can this token push to the repo? Read access alone would make every public repo an open room. */
async function githubCanPush(token: string, ownerRepo: string): Promise<boolean> {
  const now = Date.now()
  const hit = ghCache.get(token)?.get(ownerRepo)
  if (hit && hit > now) return true
  try {
    const res = await fetch(`https://api.github.com/repos/${ownerRepo}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'room-server' } })
    if (!res.ok) return false
    const body = await res.json() as { permissions?: { push?: boolean } }
    if (!body.permissions?.push) return false
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

/** "github.com/owner/repo/feature/x" -> "github.com/owner/repo"; "local/dir/main" -> "local/dir". */
function repoOf(roomName: string): string {
  const parts = roomName.split('/')
  return parts.slice(0, roomName.startsWith('github.com/') ? 3 : 2).join('/')
}
/** Repos someone has opened: repo -> who/when + the branch rooms seen since. Persisted next to the room data. */
interface OpenRepo { by?: string; at: number; branches: string[] }
const rooms = new Map<string, OpenRepo>()
const ROOMS_FILE = process.env.YPERSISTENCE ? path.join(process.env.YPERSISTENCE, 'rooms.json') : undefined
try { if (ROOMS_FILE && fs.existsSync(ROOMS_FILE)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')) as Record<string, Partial<OpenRepo>>)) rooms.set(k, { by: v.by, at: v.at ?? Date.now(), branches: v.branches ?? [] }) } catch { /* start empty */ }
function saveRooms() {
  if (!ROOMS_FILE) return
  try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(Object.fromEntries(rooms))) } catch { /* best effort */ }
}
const NOT_OPEN = (room: string) => `no room for ${repoOf(room)} yet: open one with room_create (or POST /rooms)`

/** Is this caller allowed into `room`? Same rule for opening, listing, closing, viewing and connecting. */
async function admitted(room: string, auth: { gh?: string; token?: string }): Promise<string | undefined> {
  const repo = githubRepoOf(room)
  const ok = (TOKEN && auth.token === TOKEN) || (auth.gh && repo && await githubCanPush(auth.gh, repo)) || (!TOKEN && !repo)
  if (ok) return undefined
  return repo && !auth.gh && !auth.token ? `no GitHub token: run \`gh auth login\` (room ${repo})`
    : repo && auth.gh ? `your GitHub account cannot push to ${repo}: ask for write access, or check \`gh auth status\` is the right account`
    : 'token required or wrong: set ROOM_SERVER=ws://host/?token=<shared token>'
}
/** Remember which branch rooms of an open repo have been connected to, so closing can find their docs. */
function noteBranch(roomName: string) {
  const r = rooms.get(repoOf(roomName))
  if (r && !r.branches.includes(roomName)) { r.branches.push(roomName); saveRooms() }
}
/** Close a repo: forget it, drop every live connection to its branch rooms, delete their persisted docs. */
async function closeRepo(repo: string): Promise<string[]> {
  const r = rooms.get(repo)
  if (!r) return []
  const names = new Set(r.branches)
  for (const name of docs.keys()) if (repoOf(name) === repo) names.add(name)
  rooms.delete(repo); saveRooms()
  for (const name of names) {
    const doc = docs.get(name)
    if (doc) for (const conn of Array.from(doc.conns.keys()) as { close(code?: number, reason?: string): void }[]) conn.close(4001, 'room closed')
    docs.delete(name)
    try { await ((getPersistence() as { provider?: { clearDocument?(n: string): Promise<void> } } | null)?.provider)?.clearDocument?.(name) } catch (e) { console.log(`close ${name}: could not clear persisted doc: ${e instanceof Error ? e.message : e}`) }
  }
  console.log(`room closed: ${repo} (${names.size} branch room(s))`)
  return Array.from(names)
}
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => { let body = ''; req.on('data', c => { body += c }); req.on('end', () => resolve(body)) })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
  if (url.pathname === '/rooms' && req.method === 'GET') {
    const auth = { gh: url.searchParams.get('gh') ?? undefined, token: url.searchParams.get('token') ?? undefined }
    void (async () => {
      const out: ({ repo: string } & OpenRepo)[] = []
      for (const [repo, r] of rooms) if (!(await admitted(`${repo}/x`, auth))) out.push({ repo, ...r })
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out))
    })()
    return
  }
  if (url.pathname === '/rooms' && req.method === 'DELETE') {
    void readBody(req).then(async body => {
      try {
        const { room, gh, token } = JSON.parse(body || '{}') as { room?: string; gh?: string; token?: string }
        if (!room) { res.writeHead(400); res.end('room required'); return }
        const why = await admitted(room, { gh, token })
        if (why) { console.log(`close refused: ${why}`); res.writeHead(403, { 'content-type': 'text/plain' }); res.end(why); return }
        const repo = repoOf(roomNameOf(room))
        if (!rooms.has(repo)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end(NOT_OPEN(room)); return }
        const closed = await closeRepo(repo)
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ repo, closed }))
      } catch { res.writeHead(400); res.end('bad request') }
    })
    return
  }
  if (url.pathname === '/rooms' && req.method === 'POST') {
    void readBody(req).then(async body => {
      try {
        const { room, gh, token, by } = JSON.parse(body || '{}') as { room?: string; gh?: string; token?: string; by?: string }
        if (!room) { res.writeHead(400); res.end('room required'); return }
        const why = await admitted(room, { gh, token })
        if (why) { console.log(`open refused: ${why}`); res.writeHead(403, { 'content-type': 'text/plain' }); res.end(why); return }
        const name = repoOf(roomNameOf(room))
        const existing = rooms.get(name)
        if (!existing) { rooms.set(name, { by, at: Date.now(), branches: [] }); saveRooms(); console.log(`room opened: ${name}${by ? ` by ${by}` : ''}`) }
        res.writeHead(existing ? 200 : 201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ repo: name, created: !existing, ...(existing ?? {}) }))
      } catch { res.writeHead(400); res.end('bad request') }
    })
    return
  }
  if (url.pathname === '/view-token' && req.method === 'POST') {
    void readBody(req).then(async body => {
      try {
        const { room, gh, token } = JSON.parse(body || '{}') as { room?: string; gh?: string; token?: string }
        if (!room) { res.writeHead(400); res.end('room required'); return }
        const why = await admitted(room, { gh, token })
        if (why) { console.log(`view-token refused: ${why}`); res.writeHead(403, { 'content-type': 'text/plain' }); res.end(why); return }
        const name = roomNameOf(room)
        if (!rooms.has(repoOf(name))) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end(NOT_OPEN(name)); return }
        const view = crypto.randomBytes(16).toString('hex')
        viewTokens.set(view, { room: name, exp: Date.now() + VIEW_TTL })
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
/** One log line per room per minute at most: a misbehaving viewer must not flood the log. */
const dropLog = new Map<string, number>()
const droppedWrite = (room: string) => () => {
  const now = Date.now()
  if ((dropLog.get(room) ?? 0) > now - 60_000) return
  dropLog.set(room, now)
  console.log(`dropped write from a view-key connection (room ${room})`)
}
wss.on('connection', (conn, req) => setupWSConnection(conn, req, { gc: true }))
const refuse = (socket: import('node:stream').Duplex, code: number, why: string, room?: string) => {
  console.log(`refused ${code} ${why}${room ? ` (room ${room})` : ''}`)
  socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const roomName = roomNameOf(url.pathname)
  const accept = (readOnly = false) => rooms.has(repoOf(roomName))
    ? wss.handleUpgrade(req, socket, head, ws => {
      noteBranch(roomName)
      if (readOnly) makeReadOnly(ws, droppedWrite(roomName))
      wss.emit('connection', ws, req)
    })
    : refuse(socket, 404, `Not Found: ${NOT_OPEN(roomName)}`)
  const view = url.searchParams.get('view')
  if (view) {
    const v = viewTokens.get(view)
    if (v && v.exp > Date.now() && v.room === roomName) return accept(true)
    return refuse(socket, 403, 'Forbidden: view token invalid for this room')
  }
  const gh = url.searchParams.get('gh') ?? undefined, token = url.searchParams.get('token') ?? undefined
  admitted(roomName, { gh, token })
    .then(why => why ? refuse(socket, why.startsWith('no GitHub token') || why.startsWith('token required') ? 401 : 403, why, roomName) : accept())
    .catch(() => refuse(socket, 403, 'Forbidden', roomName))
})
server.listen(PORT, HOST, () => console.log(
  `room server listening on ws://${HOST}:${PORT}/<room>` +
  (TOKEN ? ' (token required)' : ' (no token: anyone with the URL can join)') +
  (process.env.YPERSISTENCE ? ` persisting to ${process.env.YPERSISTENCE}` : ' (in-memory: rooms reset on restart)'),
))
