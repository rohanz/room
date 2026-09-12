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
}

export interface JoinOptions {
  dir: string
  name?: string
  room?: string
  server?: string
  web?: string
  token?: string
  connectTimeoutMs?: number
  log?: (line: string) => void
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
  const name = opts.name ?? await defaultName(dir)
  if (!name) throw new RoomdError('could not determine your name: pass name or set git config user.name', 2)

  let roomName = opts.room
  if (!roomName) {
    const d = await deriveRoomName(dir)
    if (!d.roomName) throw new RoomdError(`${dir} has no origin remote; pass room explicitly (e.g. room="myteam/shop/main")`, 2)
    roomName = d.roomName
  }
  const roomUrl = `${server}/${encodeRoom(roomName)}`
  const gh = roomName.startsWith('github.com/') ? await githubToken() : undefined
  // Preflight over HTTP: a refused websocket only shows up as a sync timeout, so ask the server first.
  const denied = await preflight(server, roomName, { gh, token })
  if (denied) throw new RoomdError(`${server} refused ${roomName}: ${denied}`, 2)
  const daemon = await startRoomd({ room: roomUrl, dir, name, kind: 'agent', token, githubToken: gh, connectTimeoutMs: opts.connectTimeoutMs, log: opts.log })
  const view = await viewToken(server, roomName, { gh, token })
  const browserUrl = `${web}/?room=${encodeURIComponent(roomUrl)}&participant=${encodeURIComponent(name)}${view ? `&view=${view}` : token ? `&token=${encodeURIComponent(token)}` : ''}`
  const graph = new GraphIndex(daemon.roomDoc, name, dir, opts.log)
  graph.start()
  return {
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
}

/** Returns the server's refusal reason, or undefined when access is fine (or the server cannot be asked). */
export async function preflight(server: string, roomName: string, auth: { gh?: string; token?: string }): Promise<string | undefined> {
  try {
    const http = server.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    const res = await fetch(`${http}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, ...auth }), signal: AbortSignal.timeout(8000) })
    if (res.ok) return undefined
    if (res.status === 403) return (await res.text()).trim() || 'forbidden'
    return undefined // older server or unexpected status: let the websocket try
  } catch (e) {
    return `cannot reach ${server} (${e instanceof Error ? e.message : String(e)})`
  }
}

/** Ask the server for a 24h room-scoped token the browser can use (never the GitHub token itself). */
export async function viewToken(server: string, roomName: string, auth: { gh?: string; token?: string }): Promise<string | undefined> {
  if (!auth.gh && !auth.token) return undefined
  try {
    const http = server.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    const res = await fetch(`${http}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, ...auth }) })
    if (!res.ok) return undefined
    return ((await res.json()) as { view?: string }).view
  } catch { return undefined }
}

export async function leaveSession(s: Session): Promise<void> {
  s.graph?.stop()
  await s.daemon.stop()
}
