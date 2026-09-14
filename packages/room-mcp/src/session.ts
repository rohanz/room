/**
 * A session is one joined room: the embedded daemon (which owns the Y.Doc and the
 * websocket provider) plus the identity the tools act as. `room_join` creates it,
 * `room_leave` tears it down.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import { startRoomd, RoomdError, type Roomd } from '@room/roomd'
import { git, gitBranch, gitOrigin } from '@room/roomd/git'
import type { Identity, RoomDoc } from '@room/shared'
import { GraphIndex } from './graph-index.js'
import { getCredential, removeCredential, setCredential } from './credentials.js'

/** The hosted room server. Override with ROOM_SERVER (e.g. ws://localhost:1234 for local dev). */
export const DEFAULT_SERVER = 'wss://room-rohanz.fly.dev'
export const DEFAULT_WEB = 'http://localhost:5173'

export interface Session {
  room: RoomDoc
  provider: WebsocketProvider
  awareness: Awareness
  daemon: Roomd
  me: Identity
  dir: string
  /** ws://server/<encoded room name> */
  roomUrl: string
  /** Human-readable room name, e.g. github.com/rohanz/room/main */
  roomName: string
  browserUrl: string
  /** Symbol graph over base + overlays; undefined in unit tests. */
  graph?: GraphIndex
  /** Set when the server closed the repo (ws close 4001): the provider stops reconnecting. */
  closed?: { reason: string }
}

export interface JoinOptions {
  dir: string
  name?: string
  room?: string
  server?: string
  web?: string
  token?: string
  /** Open the repo on the server first (room_create). Without it, joining an unopened repo fails with NoRoom. */
  create?: boolean
  connectTimeoutMs?: number
  log?: (line: string) => void
}

/** The repo has not been opened on the server; room_create does that. */
export class NoRoom extends RoomdError {
  constructor(public roomName: string, detail: string) { super(detail, 3) }
}
/** The server uses GitHub device login and this machine holds no session for it; room_login does that. */
export class NotLoggedIn extends RoomdError {
  constructor(public server: string) { super(`not logged in to ${server}: room_login first`, 4) }
}

export type AuthMode = 'device' | 'token'
const modeCache = new Map<string, AuthMode>()
/** How the server authenticates GitHub rooms: device login (it holds the tokens) or forwarded gh tokens. Older servers: token. */
export async function serverAuthMode(server: string): Promise<AuthMode> {
  const hit = modeCache.get(server)
  if (hit) return hit
  let mode: AuthMode = 'token'
  try {
    const res = await fetch(`${httpOf(server)}/auth/config`, { signal: AbortSignal.timeout(20000) })
    if (res.ok) { const b = await res.json() as { github?: string }; if (b.github === 'device') mode = 'device' }
  } catch { /* unreachable: the join will report it */ }
  modeCache.set(server, mode)
  return mode
}

export interface Creds { gh?: string; token?: string; session?: string; login?: string }
/** Credentials for a server: a shared token, a Room session from device login, or (token-mode servers only) the local gh token. */
export async function resolveAuth(server: string, roomName: string, token?: string): Promise<Creds> {
  const github = roomName.startsWith('github.com/')
  if (!github) return { token }
  const mode = await serverAuthMode(server)
  if (mode === 'device') {
    const c = getCredential(server)
    if (!c) { if (token) return { token }; throw new NotLoggedIn(server) }
    return { token, session: c.session, login: c.login }
  }
  return { token, gh: await githubToken() }
}

export interface LoginProgress { user_code: string; verification_uri: string; expires_in: number; interval: number; device: string }
/** Start GitHub device login against the server. Show the user the code; then pollLogin until done. */
export async function startLogin(server: string): Promise<LoginProgress> {
  const res = await fetch(`${httpOf(server)}/auth/device`, { method: 'POST', signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new RoomdError(`${server} could not start GitHub login: ${(await res.text()).trim() || `HTTP ${res.status}`}`, 2)
  return await res.json() as LoginProgress
}
/** Poll until GitHub confirms, the attempt fails, or maxMs passes. Saves the credential on success. */
export async function pollLogin(server: string, p: LoginProgress, opts: { maxMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ login: string } | { pending: true } | { error: string }> {
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const deadline = Date.now() + (opts.maxMs ?? 90_000)
  for (;;) {
    const res = await fetch(`${httpOf(server)}/auth/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: p.device }), signal: AbortSignal.timeout(15000) })
    if (!res.ok) return { error: (await res.text()).trim() || `HTTP ${res.status}` }
    const b = await res.json() as { pending?: boolean; error?: string; session?: string; login?: string }
    if (b.session && b.login) { setCredential(server, { session: b.session, login: b.login, at: Date.now() }); modeCache.delete(server); return { login: b.login } }
    if (b.error) return { error: b.error }
    if (Date.now() >= deadline) return { pending: true }
    await sleep(Math.max(1, p.interval) * 1000)
  }
}
export async function logout(server: string): Promise<{ login?: string; removed: boolean }> {
  const c = getCredential(server)
  if (c) { try { await fetch(`${httpOf(server)}/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: c.session }), signal: AbortSignal.timeout(20000) }) } catch { /* local removal still counts */ } }
  return { login: c?.login, removed: removeCredential(server) }
}

/** `.room.json` written by the daemon; lets a later process rejoin the same room. */
export interface RoomFile { room: string; name: string; dir: string }

export function findRoomFile(start: string): (RoomFile & { _from: string }) | undefined {
  let d = resolve(start)
  for (;;) {
    const f = resolve(d, '.room.json')
    if (existsSync(f)) {
      try { return { ...JSON.parse(readFileSync(f, 'utf8')), _from: dirname(f) } } catch { /* keep walking */ }
    }
    const up = dirname(d)
    if (up === d) return undefined
    d = up
  }
}

/** Room name from the clone: normalised origin + branch. Slashes are kept for humans; encode for the URL. */
export async function deriveRoomName(dir: string): Promise<{ roomName?: string; branch: string; repo?: string }> {
  const [repo, branch] = await Promise.all([gitOrigin(dir), gitBranch(dir)])
  return { repo, branch, roomName: repo ? `${repo}/${branch}` : undefined }
}

/** The user's GitHub token: GH_TOKEN/GITHUB_TOKEN, else the gh CLI, else git's credential store for github.com. Proves repo access to the server. */
export async function githubToken(): Promise<string | undefined> {
  const env = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (env?.trim()) return env.trim()
  const { execFile } = await import('node:child_process')
  const run = (cmd: string, args: string[], input?: string) => new Promise<string | undefined>(resolve => {
    const p = execFile(cmd, args, { timeout: 5000 }, (err, out) => resolve(err ? undefined : out))
    if (input !== undefined) p.stdin?.end(input)
  })
  const gh = (await run('gh', ['auth', 'token']))?.trim()
  if (gh) return gh
  // git credential fill prints password=<token> when a helper (osxkeychain, manager, store) has one.
  const cred = await run('git', ['credential', 'fill'], 'protocol=https\nhost=github.com\n\n')
  const pw = cred?.match(/^password=(.+)$/m)?.[1]?.trim()
  if (pw && /^(gh[pousr]_|github_pat_)/.test(pw)) return pw
  return undefined
}

export async function defaultName(dir: string): Promise<string | undefined> {
  try { const n = (await git(dir, ['config', 'user.name'])).trim(); if (n) return n } catch { /* fall through */ }
  return process.env.USER || process.env.USERNAME || undefined
}

/** "wss://host/?token=abc" -> { server: "wss://host", token: "abc" }; a bare URL has no token. */
export function parseServer(raw: string): { server: string; token?: string } {
  try {
    const u = new URL(raw)
    const token = u.searchParams.get('token') ?? undefined
    u.search = ''
    return { server: u.toString().replace(/\/+$/, ''), token }
  } catch {
    return { server: raw.replace(/\/+$/, '') }
  }
}

/** The server also serves the browser view: ws(s)://host -> http(s)://host. Local dev keeps the Vite port. */
export function defaultWeb(server: string): string {
  try {
    const u = new URL(server)
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return DEFAULT_WEB
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    return u.toString().replace(/\/+$/, '')
  } catch { return DEFAULT_WEB }
}

export function encodeRoom(roomName: string): string { return encodeURIComponent(roomName) }
export function decodeRoom(encoded: string): string { try { return decodeURIComponent(encoded) } catch { return encoded } }

export async function joinSession(opts: JoinOptions): Promise<Session> {
  const dir = resolve(opts.dir)
  const parsed = parseServer(opts.server ?? process.env.ROOM_SERVER ?? DEFAULT_SERVER)
  const server = parsed.server
  const token = opts.token ?? process.env.ROOM_TOKEN?.trim() ?? parsed.token
  const web = (opts.web ?? process.env.ROOM_WEB ?? defaultWeb(server)).replace(/\/+$/, '')

  let roomName = opts.room
  if (!roomName) {
    const d = await deriveRoomName(dir)
    if (!d.roomName) throw new RoomdError(`${dir} has no origin remote; pass room explicitly (e.g. room="myteam/shop/main")`, 2)
    roomName = d.roomName
  }
  const roomUrl = `${server}/${encodeRoom(roomName)}`
  const auth = await resolveAuth(server, roomName, token)
  // Logged in with GitHub: the participant name is the verified login, whatever git config says.
  const name = auth.login ?? opts.name ?? await defaultName(dir)
  if (!name) throw new RoomdError('could not determine your name: pass name or set git config user.name', 2)
  if (auth.login && opts.name && opts.name !== auth.login) opts.log?.(`name is your GitHub login on this server: ${auth.login} (ignoring "${opts.name}")`)
  const { login: _login, ...creds } = auth
  if (opts.create) {
    const err = await createRoom(server, roomName, { ...creds, by: name })
    if (err) throw new RoomdError(`${server} would not open ${roomName}: ${err}`, 2)
  }
  // Preflight over HTTP: a refused websocket only shows up as a sync timeout, so ask the server first.
  const pre = await preflight(server, roomName, creds)
  if (pre?.missing) throw new NoRoom(roomName, pre.reason)
  if (pre?.loginNeeded) throw new NotLoggedIn(server)
  if (pre) throw new RoomdError(`${server} refused ${roomName}: ${pre.reason}`, 2)
  const daemon = await startRoomd({ room: roomUrl, dir, name, kind: 'agent', token, githubToken: creds.gh, session: creds.session, connectTimeoutMs: opts.connectTimeoutMs, log: opts.log })
  const view = await viewToken(server, roomName, creds)
  const browserUrl = `${web}/?room=${encodeURIComponent(roomUrl)}&participant=${encodeURIComponent(name)}${view ? `&view=${view}` : token ? `&token=${encodeURIComponent(token)}` : ''}`
  const graph = new GraphIndex(daemon.roomDoc, name, dir, opts.log)
  graph.start()
  const session: Session = {
    graph,
    room: daemon.roomDoc,
    provider: daemon.provider,
    awareness: daemon.provider.awareness,
    daemon,
    me: { name, kind: 'agent' },
    dir,
    roomUrl,
    roomName,
    browserUrl,
  }
  watchClosed(session, opts.log)
  return session
}

/** Server close code when a repo is closed (DELETE /rooms): stop reconnecting and remember why. */
export const ROOM_CLOSED_CODE = 4001
export function watchClosed(s: Session, log?: (line: string) => void): void {
  const p = s.provider as unknown as { on?: (ev: string, fn: (e: { code?: number; reason?: string } | null) => void) => void; disconnect?: () => void }
  p.on?.('connection-close', e => {
    if (e?.code !== ROOM_CLOSED_CODE) return
    s.closed = { reason: e.reason || 'room closed' }
    try { p.disconnect?.() } catch { /* already gone */ }
    log?.(`${s.roomName}: ${s.closed.reason}; not reconnecting`)
  })
}

const httpOf = (server: string) => server.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
/** A session the server no longer knows is useless locally too. */
function removeStaleCredential(server: string, reason: string): void { if (/expired or unknown/.test(reason)) removeCredential(server) }

/** Why the server would refuse us, or undefined when access is fine (or the server cannot be asked).
 *  `missing`: access is fine but nobody has opened this repo yet. */
export async function preflight(server: string, roomName: string, auth: Creds): Promise<{ reason: string; missing?: boolean; loginNeeded?: boolean } | undefined> {
  try {
    const res = await fetch(`${httpOf(server)}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, ...auth }), signal: AbortSignal.timeout(20000) })
    if (res.ok) return undefined
    if (res.status === 401) { const reason = (await res.text()).trim() || 'unauthorized'; if (/room_login/.test(reason)) { removeStaleCredential(server, reason); return { reason, loginNeeded: true } } return { reason } }
    if (res.status === 403) return { reason: (await res.text()).trim() || 'forbidden' }
    if (res.status === 404) return { reason: (await res.text()).trim() || `no room for ${roomName} yet`, missing: true }
    return undefined // older server or unexpected status: let the websocket try
  } catch (e) {
    return { reason: `cannot reach ${server} (${e instanceof Error ? e.message : String(e)})` }
  }
}

/** Open the repo on the server so its branch rooms can be joined. Idempotent. Returns the refusal, if any. */
export async function createRoom(server: string, roomName: string, auth: Creds & { by?: string }): Promise<string | undefined> {
  try {
    const res = await fetch(`${httpOf(server)}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, ...auth }), signal: AbortSignal.timeout(20000) })
    if (res.ok) return undefined
    return (await res.text()).trim() || `HTTP ${res.status}`
  } catch (e) {
    return `cannot reach ${server} (${e instanceof Error ? e.message : String(e)})`
  }
}

/** Close the repo on the server: every branch room, every overlay, every connection. Returns the rooms closed, or throws with the refusal. */
export async function closeRoom(server: string, roomName: string, auth: Creds): Promise<string[]> {
  const res = await fetch(`${httpOf(server)}/rooms`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, ...auth }), signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new RoomdError(`${server} would not close ${roomName}: ${(await res.text()).trim() || `HTTP ${res.status}`}`, 2)
  const body = (await res.json().catch(() => ({}))) as { closed?: string[] }
  return body.closed ?? []
}

/** Auth the way joinSession resolves it, for HTTP calls made after the join. */
export async function authFor(s: Session): Promise<Creds & { server: string }> {
  const server = s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))
  const token = process.env.ROOM_TOKEN?.trim() ?? parseServer(process.env.ROOM_SERVER ?? '').token
  const { login: _login, ...creds } = await resolveAuth(server, s.roomName, token)
  return { ...creds, server }
}

/** Ask the server for a room-scoped token (7 days) the browser can use (never the GitHub token itself). */
export async function viewToken(server: string, roomName: string, auth: Creds): Promise<string | undefined> {
  if (!auth.gh && !auth.token && !auth.session) return undefined
  try {
    const res = await fetch(`${httpOf(server)}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, ...auth }), signal: AbortSignal.timeout(20000) })
    if (!res.ok) return undefined
    return ((await res.json()) as { view?: string }).view
  } catch { return undefined }
}

/** Re-mint the browser link (view keys can expire or be lost); falls back to the stored one. */
export async function refreshBrowserUrl(s: Session): Promise<string> {
  try {
    const server = s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))
    const u = new URL(s.browserUrl)
    const web = `${u.protocol}//${u.host}`
    const a = await authFor(s)
    const view = await viewToken(server, s.roomName, a)
    if (view) s.browserUrl = `${web}/?room=${encodeURIComponent(s.roomUrl)}&view=${view}`
  } catch { /* keep the stored link */ }
  return s.browserUrl
}

export async function leaveSession(s: Session): Promise<void> {
  s.graph?.stop()
  await s.daemon.stop()
}
