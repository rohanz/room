#!/usr/bin/env tsx
/**
 * Room server: a stock y-websocket server plus access control and persistence.
 *  - Rooms named github.com/<owner>/<repo>/<branch> admit callers whose GitHub account has push
 *    access to the repo (checked against the GitHub API, cached 10 min). Read access is not
 *    enough: a public repo must not be an open room.
 *  - GITHUB_CLIENT_ID: if set, clients log in with GitHub's device flow (POST /auth/device, /auth/poll)
 *    and the server keeps the GitHub token; clients hold only an opaque ?session=. Forwarded
 *    GitHub tokens (?gh=) are refused. Without it (local dev, tests) ?gh= is accepted as before.
 *    Logged-in connections may only announce presence under their GitHub login.
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
import { makeReadOnly, bindIdentity } from './readonly.js'
import { Auth } from './auth.js'

const PORT = Number(process.env.PORT ?? 1234)
const HOST = process.env.HOST ?? '0.0.0.0'
const TOKEN = process.env.ROOM_TOKEN?.trim() || undefined
/** Directory with the built browser view (packages/web/dist). Served at / when present. */
const STATIC = process.env.ROOM_STATIC ?? path.resolve(process.cwd(), 'public')
const auth = new Auth({ clientId: process.env.GITHUB_CLIENT_ID?.trim() || undefined, sessionsFile: process.env.YPERSISTENCE ? path.join(process.env.YPERSISTENCE, 'sessions.json') : undefined, log: l => console.log(l) })
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' }

// ---- github proxy (pull requests): the routes are in the "github" section of the request handler ----
import { GitHubProxy } from './github.js'
const github = new GitHubProxy({ log: l => console.log(l) })

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
interface OpenRepo { by?: string; at: number; branches: string[]; lastSeen?: number }
const rooms = new Map<string, OpenRepo>()
const ROOMS_FILE = process.env.YPERSISTENCE ? path.join(process.env.YPERSISTENCE, 'rooms.json') : undefined
try { if (ROOMS_FILE && fs.existsSync(ROOMS_FILE)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')) as Record<string, Partial<OpenRepo>>)) rooms.set(k, { by: v.by, at: v.at ?? Date.now(), branches: v.branches ?? [] }) } catch { /* start empty */ }
function saveRooms() {
  if (!ROOMS_FILE) return
  try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(Object.fromEntries(rooms))) } catch { /* best effort */ }
}
const NOT_OPEN = (room: string) => `no room for ${repoOf(room)} yet: open one with room_create (or POST /rooms)`

interface Creds { gh?: string; token?: string; session?: string }
type Verdict = { ok: true; login?: string } | { ok: false; status: 401 | 403; why: string }
/** Is this caller allowed into `room`? Same rule for opening, listing, closing, viewing and connecting.
 *  A verdict carries the verified GitHub login when the caller is logged in. */
async function admitted(room: string, c: Creds): Promise<Verdict> {
  const repo = githubRepoOf(room)
  if (TOKEN && c.token === TOKEN) return { ok: true }
  if (!TOKEN && !repo) return { ok: true }
  if (!repo) return { ok: false, status: 401, why: 'token required or wrong: set ROOM_SERVER=ws://host/?token=<shared token>' }
  if (auth.mode === 'device') {
    if (!c.session) return { ok: false, status: 401, why: c.gh ? 'this server uses GitHub login: run room_login (forwarded GitHub tokens are not accepted)' : `not logged in: run room_login (room ${repo})` }
    const st = auth.resolve(c.session)
    if (!st) return { ok: false, status: 401, why: 'session expired or unknown: run room_login' }
    if (await githubCanPush(st.ghToken, repo)) return { ok: true, login: st.login }
    return { ok: false, status: 403, why: `${st.login} cannot push to ${repo}: ask for write access` }
  }
  if (!c.gh) return { ok: false, status: 401, why: `no GitHub token: run \`gh auth login\` (room ${repo})` }
  if (await githubCanPush(c.gh, repo)) return { ok: true }
  return { ok: false, status: 403, why: `your GitHub account cannot push to ${repo}: ask for write access, or check \`gh auth status\` is the right account` }
}
/** Remember which branch rooms of an open repo have been connected to, so closing can find their docs. */
function noteBranch(roomName: string) {
  const r = rooms.get(repoOf(roomName))
  if (!r) return
  r.lastSeen = Date.now()
  if (!r.branches.includes(roomName)) r.branches.push(roomName)
  saveRooms()
}
/** Repos nobody has connected to for ROOM_IDLE_DAYS (default 30) are closed automatically: their
 *  shared uncommitted work is deleted. 0 disables. Checked hourly and at startup. */
const IDLE_MS = Number(process.env.ROOM_IDLE_DAYS ?? 30) * 24 * 60 * 60 * 1000
async function expireIdle() {
  if (!IDLE_MS) return
  const cutoff = Date.now() - IDLE_MS
  for (const [repo, r] of Array.from(rooms)) {
    const live = Array.from(docs.keys()).some(n => repoOf(n) === repo && (docs.get(n)?.conns.size ?? 0) > 0)
    if (!live && (r.lastSeen ?? r.at) < cutoff) { console.log(`room expired: ${repo} (idle since ${new Date(r.lastSeen ?? r.at).toISOString()})`); await closeRepo(repo) }
  }
}
setInterval(() => { void expireIdle() }, 60 * 60 * 1000).unref()
void expireIdle()
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
const str = (v: unknown): string | undefined => typeof v === 'string' && v ? v : undefined
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => { let body = ''; req.on('data', c => { body += c }); req.on('end', () => resolve(body)) })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
  const creds = (o: Record<string, unknown>): Creds => ({ gh: str(o.gh), token: str(o.token), session: str(o.session) })
  const queryCreds = (): Creds => creds({ gh: url.searchParams.get('gh') ?? undefined, token: url.searchParams.get('token') ?? undefined, session: url.searchParams.get('session') ?? undefined })
  const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const text = (status: number, body: string) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(body) }
  const withBody = (fn: (o: Record<string, unknown>) => Promise<void>) => { void readBody(req).then(async body => { try { await fn(JSON.parse(body || '{}') as Record<string, unknown>) } catch { text(400, 'bad request') } }); return }

  // ---- auth ----
  if (url.pathname === '/auth/config' && req.method === 'GET') return json(200, { github: auth.mode, clientIdSet: auth.mode === 'device' })
  if (url.pathname === '/auth/device' && req.method === 'POST') {
    if (auth.mode !== 'device') return text(404, 'this server does not use GitHub login (no GITHUB_CLIENT_ID)')
    void auth.startDevice().then(d => json(200, d)).catch(e => text(502, `GitHub device flow failed: ${e instanceof Error ? e.message : e}`))
    return
  }
  if (url.pathname === '/auth/poll' && req.method === 'POST') return withBody(async o => {
    const device = str(o.device)
    if (!device) return text(400, 'device required')
    json(200, await auth.poll(device))
  })
  if (url.pathname === '/auth/logout' && req.method === 'POST') return withBody(async o => json(200, { ok: auth.logout(str(o.session)) }))
  if (url.pathname === '/auth/me' && req.method === 'GET') {
    const st = auth.resolve(url.searchParams.get('session') ?? undefined)
    return st ? json(200, { login: st.login }) : text(401, 'not logged in')
  }

  // ---- rooms ----
  if (url.pathname === '/rooms' && req.method === 'GET') {
    const c = queryCreds()
    void (async () => {
      const out: ({ repo: string } & OpenRepo)[] = []
      for (const [repo, r] of rooms) if ((await admitted(`${repo}/x`, c)).ok) out.push({ repo, ...r })
      json(200, out)
    })()
    return
  }
  if (url.pathname === '/rooms' && req.method === 'DELETE') return withBody(async o => {
    const room = str(o.room)
    if (!room) return text(400, 'room required')
    const v = await admitted(room, creds(o))
    if (!v.ok) { console.log(`close refused: ${v.why}`); return text(v.status, v.why) }
    const repo = repoOf(roomNameOf(room))
    if (!rooms.has(repo)) return text(404, NOT_OPEN(room))
    const closed = await closeRepo(repo)
    json(200, { repo, closed, ...(v.login ? { login: v.login } : {}) })
  })
  if (url.pathname === '/rooms' && req.method === 'POST') return withBody(async o => {
    const room = str(o.room)
    if (!room) return text(400, 'room required')
    const v = await admitted(room, creds(o))
    if (!v.ok) { console.log(`open refused: ${v.why}`); return text(v.status, v.why) }
    const by = v.login ?? str(o.by)
    const name = repoOf(roomNameOf(room))
    const existing = rooms.get(name)
    if (!existing) { rooms.set(name, { by, at: Date.now(), branches: [] }); saveRooms(); console.log(`room opened: ${name}${by ? ` by ${by}` : ''}`) }
    json(existing ? 200 : 201, { repo: name, created: !existing, ...(existing ?? {}), ...(v.login ? { login: v.login } : {}) })
  })
  if (url.pathname === '/view-token' && req.method === 'POST') return withBody(async o => {
    const room = str(o.room)
    if (!room) return text(400, 'room required')
    const v = await admitted(room, creds(o))
    if (!v.ok) { console.log(`view-token refused: ${v.why}`); return text(v.status, v.why) }
    const name = roomNameOf(room)
    if (!rooms.has(repoOf(name))) return text(404, NOT_OPEN(name))
    const view = crypto.randomBytes(16).toString('hex')
    viewTokens.set(view, { room: name, exp: Date.now() + VIEW_TTL })
    for (const [k, vv] of viewTokens) if (vv.exp < Date.now()) viewTokens.delete(k)
    saveViewTokens()
    json(200, { view, expiresIn: VIEW_TTL, ...(v.login ? { login: v.login } : {}) })
  })

  // ---- github (pull requests) ----
  // Same admission rule as /rooms; the GitHub call uses the token behind the session (device
  // login) or, on token-mode servers, the forwarded ?gh= token. Sessions without a GitHub token
  // (OIDC) get 403: the proxy cannot act on GitHub for them.
  const githubTokenFor = (c: Creds): string | undefined => (c.session ? auth.resolve(c.session)?.ghToken : undefined) ?? c.gh
  const githubFail = (what: string, e: unknown) => { const st = (e as { status?: number }).status; console.log(`${what}: ${e instanceof Error ? e.message : e}`); text(st === 401 || st === 403 || st === 404 ? st : 502, `${what}: ${e instanceof Error ? e.message : String(e)}`) }
  if (url.pathname === '/github/prs' && req.method === 'GET') {
    const room = str(url.searchParams.get('room') ?? undefined)
    if (!room) return text(400, 'room required')
    const c = queryCreds()
    void (async () => {
      const name = roomNameOf(room)
      const repo = githubRepoOf(name)
      if (!repo) return text(400, `${name} is not a github.com room`)
      const v = await admitted(name, c)
      if (!v.ok) { console.log(`github/prs refused: ${v.why}`); return text(v.status, v.why) }
      if (!rooms.has(repoOf(name))) return text(404, NOT_OPEN(name))
      const token = githubTokenFor(c)
      if (!token) return text(403, 'this session has no GitHub token; log in with GitHub to see pull requests')
      try { json(200, await github.openPrs(token, repo, name.slice(`github.com/${repo}/`.length))) }
      catch (e) { githubFail('github/prs', e) }
    })()
    return
  }
  if (url.pathname === '/github/pr-note' && req.method === 'POST') return withBody(async o => {
    const room = str(o.room)
    const number = Number(o.number)
    const body = str(o.body)
    if (!room) return text(400, 'room required')
    if (!Number.isInteger(number) || number <= 0) return text(400, 'number required (positive PR number)')
    if (!body) return text(400, 'body required')
    const c = creds(o)
    const name = roomNameOf(room)
    const repo = githubRepoOf(name)
    if (!repo) return text(400, `${name} is not a github.com room`)
    const v = await admitted(name, c)
    if (!v.ok) { console.log(`github/pr-note refused: ${v.why}`); return text(v.status, v.why) }
    if (!rooms.has(repoOf(name))) return text(404, NOT_OPEN(name))
    const token = githubTokenFor(c)
    if (!token) return text(403, 'this session has no GitHub token; log in with GitHub to comment on pull requests')
    try { json(200, { repo, number, ...(await github.upsertNote(token, repo, number, body)), ...(v.login ? { login: v.login } : {}) }) }
    catch (e) { githubFail('github/pr-note', e) }
  })
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
const identityLog = new Map<string, number>()
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const roomName = roomNameOf(url.pathname)
  const accept = (opts: { readOnly?: boolean; login?: string } = {}) => rooms.has(repoOf(roomName))
    ? wss.handleUpgrade(req, socket, head, ws => {
      noteBranch(roomName)
      if (opts.readOnly) makeReadOnly(ws, droppedWrite(roomName))
      if (opts.login) bindIdentity(ws, opts.login, login => {
        const now = Date.now()
        if ((identityLog.get(login) ?? 0) > now - 60_000) return
        identityLog.set(login, now)
        console.log(`dropped presence under a name other than ${login} (room ${roomName})`)
      })
      wss.emit('connection', ws, req)
    })
    : refuse(socket, 404, `Not Found: ${NOT_OPEN(roomName)}`)
  const view = url.searchParams.get('view')
  if (view) {
    const v = viewTokens.get(view)
    if (v && v.exp > Date.now() && v.room === roomName) return accept({ readOnly: true })
    return refuse(socket, 403, 'Forbidden: view token invalid for this room')
  }
  const c: Creds = { gh: url.searchParams.get('gh') ?? undefined, token: url.searchParams.get('token') ?? undefined, session: url.searchParams.get('session') ?? undefined }
  admitted(roomName, c)
    .then(v => v.ok ? accept({ login: v.login }) : refuse(socket, v.status, v.why, roomName))
    .catch(() => refuse(socket, 403, 'Forbidden', roomName))
})
server.listen(PORT, HOST, () => console.log(
  `room server listening on ws://${HOST}:${PORT}/<room>` +
  (auth.mode === 'device' ? ' (GitHub login via device flow; forwarded tokens refused)' : ' (GitHub tokens forwarded by clients; set GITHUB_CLIENT_ID for device login)') +
  (TOKEN ? ' (shared token also accepted)' : '') +
  (process.env.YPERSISTENCE ? ` persisting to ${process.env.YPERSISTENCE}` : ' (in-memory: rooms reset on restart)'),
))
