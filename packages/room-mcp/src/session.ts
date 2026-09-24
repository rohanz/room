import { trackConnection } from './connection.js'
/**
 * A session is one joined room: the embedded daemon (which owns the Y.Doc and the
 * websocket provider) plus the identity the tools act as. `room_join` creates it,
 * `room_leave` tears it down.
 */
import { readFileSync, watchFile, unwatchFile } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { startRoomd, RoomdError, clampShare, inPhase, readRoomFile, type Roomd, type RoomFile, type ShareLevel } from '@room/roomd'
import { ensureLocalRelay, type LocalRelay } from '@room/relay'
import { gitCommonDir, localRoomName } from '@room/roomd/local'
import { git, gitBranch, gitOrigin } from '@room/roomd/git'
import { RoomDoc, type Identity, type Kind } from '@room/shared'
import { GraphIndex } from './graph-index.js'
import { configureCredentials, getCredential, removeCredential, setCredential } from './credentials.js'
import { createClaudeTranscriptModelRefresh, DEFAULT_SERVER, LOCAL, resolveConfig, resolveShare, resolveServer, resolveSessionHost, resolveSessionRuntime, sessionMetadataPath } from './config.js'
import { isFresh } from './presence.js'
import { readChoice, rememberTag, worktreePath } from './choice.js'

/** A server requires an argument, ROOM_SERVER/ROOM_URL, or a remembered choice. */
export { DEFAULT_SERVER, LOCAL, resolveServer }
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
  /** The server's ceiling on sharing levels (ROOM_SHARE_MAX); the daemon's level never exceeds it. */
  shareMax: ShareLevel
  /** Set in local mode (no server): the relay this session found or runs. */
  local?: LocalRelay
  /** The room was chosen explicitly (room argument, ROOM_ROOM, or local naming): do not follow the clone's branch. */
  pinnedRoom?: boolean
  /** Invalid input narrowed to plans only; retained for sharing controls. */
  shareWarning?: string
  /** The requested level before the server ceiling. */
  shareRequested: ShareLevel
  /** The shared token this session joined with (argument, ROOM_TOKEN, or `?token=` on the server URL); workers get it as ROOM_TOKEN. Never printed. */
  token?: string
  autoTagNote?: string
  /** Latest preview started by this MCP session; never reconstructed from shared room history. */
  lastPreview?: { clean: boolean; testsPassed?: boolean; testsCommand?: string }
  /** Refresh hook/session runtime metadata before a Room tool is dispatched. */
  refreshRuntime?: () => void
}

export interface JoinOptions {
  credentialsPath?: string
  dir: string
  name?: string
  room?: string
  server?: string
  web?: string
  token?: string
  /** Open the repo on the server first (room_create). Without it, joining an unopened repo fails with NoRoom. */
  create?: boolean
  confirm?: boolean
  /** Local mode: the branch to name the room after (default: the main worktree's branch). */
  localBranch?: string
  /** Label for a second principal under the same login: name becomes login+label. Default from ROOM_TAG. */
  tag?: string
  /** 'agent' (default), 'bot' or 'ci'. Default from ROOM_KIND. */
  kind?: string
  /** Sharing level: intent | declared | full. Default from ROOM_SHARE, then full. Clamped to the server's shareMax. */
  share?: string
  connectTimeoutMs?: number
  log?: (line: string) => void
}

/** The repo has not been opened on the server; room_create does that. */
export class NoRoom extends RoomdError {
  constructor(public roomName: string, detail: string, public server?: string) { super(detail, 3) }
}
/** The server uses GitHub device login and this machine holds no session for it; room_login does that. */
export class NotLoggedIn extends RoomdError {
  constructor(public server: string) { super(`not logged in to ${server}: room_login first`, 4) }
}

export type AuthMode = 'device' | 'token'
export type Provider = 'github' | 'oidc'
export interface AuthConfig { mode: AuthMode; providers: Provider[] }
const configCache = new Map<string, AuthConfig>()
/** The server's login setup: whether it has GitHub device login (`device`: github.com rooms possible) or
 *  not (`token`: non-GitHub rooms only, by shared token or another provider), and which login providers
 *  it offers (github, oidc). A GitHub token from this machine is never sent to any server. */
export async function serverAuthConfig(server: string): Promise<AuthConfig> {
  const hit = configCache.get(server)
  if (hit) return hit
  const cfg: AuthConfig = { mode: 'token', providers: [] }
  try {
    const res = await serverFetch(`${httpOf(server)}/auth/config`, { timeoutMs: 20000 })
    if (res.ok) {
      const b = await res.json() as { github?: string; providers?: string[] }
      if (b.github === 'device') cfg.mode = 'device'
      cfg.providers = (b.providers ?? (cfg.mode === 'device' ? ['github'] : [])).filter((p): p is Provider => p === 'github' || p === 'oidc')
    }
  } catch { /* unreachable: the join will report it */ }
  configCache.set(server, cfg)
  return cfg
}
/** `device`: the server has GitHub device login, so github.com rooms can be joined after room_login.
 *  `token`: it has none; only non-GitHub rooms (local/, git/) are reachable, by shared token or another login. */
export async function serverAuthMode(server: string): Promise<AuthMode> { return (await serverAuthConfig(server)).mode }

export interface Creds { token?: string; session?: string; login?: string }
/** Credentials for a server: a Room session from a login and/or the shared token. A github.com room needs the
 *  session (ROOM_TOKEN does not admit it; the server never accepts a forwarded GitHub token). Non-GitHub rooms
 *  (local/, git/) send the session when this machine holds one: servers with a login provider require it. */
export async function resolveAuth(server: string, roomName: string, token?: string): Promise<Creds> {
  const github = roomName.startsWith('github.com/')
  const cfg = await serverAuthConfig(server)
  const c = cfg.providers.length ? getCredential(server) : undefined
  if (c) return { token, session: c.session, login: c.login }
  if (github) {
    if (cfg.mode !== 'device') throw new RoomdError(`${server} has no GitHub login (GITHUB_CLIENT_ID), so it cannot admit ${roomName}: use a server with GitHub login, or a non-GitHub origin`, 2)
    throw new NotLoggedIn(server)
  }
  if (token || !cfg.providers.length) return { token }
  throw new NotLoggedIn(server)
}

/** What a started login needs from the user: GitHub shows a code to enter at verification_uri; OIDC gives a URL to open. */
export interface LoginProgress { provider: Provider; device: string; expires_in: number; interval: number; user_code?: string; verification_uri?: string; url?: string }
/** Start a login against the server (default provider: the server's first). Show the user the code/URL; then pollLogin until done. */
export async function startLogin(server: string, provider?: Provider): Promise<LoginProgress> {
  const res = await serverFetch(`${httpOf(server)}/auth/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(provider ? { provider } : {}), timeoutMs: 15000, retry: false })
  if (res.status === 404 && !provider) { // older server: only the GitHub device flow
    const old = await fetch(`${httpOf(server)}/auth/device`, { method: 'POST', signal: AbortSignal.timeout(15000) })
    if (!old.ok) throw new RoomdError(`${server} could not start GitHub login: ${(await old.text()).trim() || `HTTP ${old.status}`}`, 2)
    return { provider: 'github', ...(await old.json() as Omit<LoginProgress, 'provider'>) }
  }
  if (!res.ok) throw new RoomdError(`${server} could not start ${provider ?? ''} login: ${(await res.text()).trim() || `HTTP ${res.status}`}`.replace('  ', ' '), 2)
  const p = await res.json() as LoginProgress
  return { ...p, provider: p.provider ?? provider ?? 'github' }
}
/** Poll until the provider confirms, the attempt fails, or maxMs passes. Saves the credential on success. */
export async function pollLogin(server: string, p: LoginProgress, opts: { maxMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ login: string } | { pending: true } | { error: string }> {
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const deadline = Date.now() + (opts.maxMs ?? 90_000)
  for (;;) {
    const res = await fetch(`${httpOf(server)}/auth/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: p.device }), signal: AbortSignal.timeout(15000) })
    if (!res.ok) return { error: (await res.text()).trim() || `HTTP ${res.status}` }
    const b = await res.json() as { pending?: boolean; error?: string; session?: string; login?: string }
    if (b.session && b.login) { setCredential(server, { session: b.session, login: b.login, at: Date.now() }); configCache.delete(server); return { login: b.login } }
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

/** Private room metadata written by the daemon. */
export type { RoomFile } from '@room/roomd'

export function findRoomFile(start: string): (RoomFile & { room: string; _from: string }) | undefined {
  let d = resolve(start)
  for (;;) {
    const room = readRoomFile(d)
    if (room?.room) return { ...room, room: room.room, _from: d }
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

const shareMaxCache = new Map<string, ShareLevel>()
/** The server's sharing ceiling (`shareMax` in GET /auth/config, from ROOM_SHARE_MAX). Older or unreachable servers: full. */
export async function serverShareMax(server: string): Promise<ShareLevel> {
  const hit = shareMaxCache.get(server)
  if (hit) return hit
  let max: ShareLevel = 'full'
  try {
    const res = await serverFetch(`${httpOf(server)}/auth/config`, { timeoutMs: 20000 })
    if (res.ok) max = resolveShare(((await res.json()) as { shareMax?: unknown }).shareMax).level
  } catch { /* unreachable: the join will report it */ }
  shareMaxCache.set(server, max)
  return max
}

/** Missing uses full; invalid levels fail closed to plans only. */
export function requestedShare(explicit?: string): ShareLevel {
  return resolveShare(explicit).level
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

/**
 * HTTP to the room server with patience for a cold start: the hosted machine stops when idle and
 * takes up to a minute to answer its first request (timeouts, 502/503/504 from the proxy). Retry
 * those for up to ~100 s, then give up with the last error.
 */
/** Progress lines for server waits; joinSession sets it from its `log` so every call site reports cold starts. */
let serverLog: ((line: string) => void) | undefined
export function setServerLog(log?: (line: string) => void): void { serverLog = log }
/** Total time a tool call may spend waiting for a cold server before giving up. */
export const SERVER_RETRY_MS = 45_000

export async function serverFetch(url: string, init: RequestInit & { timeoutMs?: number; retry?: boolean } = {}, log: ((line: string) => void) | undefined = serverLog): Promise<Response> {
  const { timeoutMs = 25_000, retry = true, ...rest } = init
  const deadline = Date.now() + SERVER_RETRY_MS
  let attempt = 0
  for (;;) {
    attempt++
    try {
      const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) })
      if (!retry || ![502, 503, 504].includes(res.status) || Date.now() > deadline) return res
      log?.(`server answered ${res.status}; it is probably starting up (attempt ${attempt}), retrying for up to ${Math.round(SERVER_RETRY_MS / 1000)}s`)
    } catch (e) {
      const name = e instanceof Error ? e.name : ''
      const code = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code ?? ''
      const coldStart = name === 'TimeoutError' || name === 'AbortError' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_HEADERS_TIMEOUT'
      if (!retry || !coldStart || Date.now() > deadline) throw e
      log?.(`waiting for the server to wake (attempt ${attempt}: ${e instanceof Error ? e.message : String(e)})`)
    }
    await new Promise(r => setTimeout(r, 3000))
  }
}

export function encodeRoom(roomName: string): string { return encodeURIComponent(roomName) }
export function decodeRoom(encoded: string): string { try { return decodeURIComponent(encoded) } catch { return encoded } }

/** Resolve identity before roomd can publish any overlays under it. The probe never publishes a user. */
export async function startAutoTaggedRoomd(options: Parameters<typeof startRoomd>[0], explicitTag?: string): Promise<{ daemon: Roomd; me: Identity; autoTagNote?: string; refreshRuntime: () => void }> {
  let name = options.name, label = options.label
  let autoTagNote: string | undefined
  const rememberedTag = explicitTag === undefined ? (await readChoice(options.dir))?.tags?.[await worktreePath(options.dir)] : undefined
  if (explicitTag === undefined) {
    const doc = new Y.Doc()
    const url = new URL(options.room)
    const room = url.pathname.split('/').pop()!
    url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/'))
    const provider = options.providerFactory
      ? options.providerFactory(url.toString().replace(/\/$/, ''), room, doc)
      : new WebsocketProvider(url.toString().replace(/\/$/, ''), room, doc, {
          WebSocketPolyfill: WebSocket as any,
          params: { ...(options.token ? { token: options.token } : {}), ...(options.session ? { session: options.session } : {}), ...(options.localKey ? { key: options.localKey } : {}) },
        })
    try {
      if (!provider.synced) await inPhase('sync', () => new Promise<void>((resolve, reject) => {
        const onSync = (synced: boolean) => { if (synced) { clearTimeout(timer); provider.off('sync', onSync); resolve() } }
        const timer = setTimeout(() => {
          provider.off('sync', onSync)
          reject(new RoomdError(`could not sync with ${options.room} within ${options.connectTimeoutMs ?? 15000}ms`, 1))
        }, options.connectTimeoutMs ?? 15000)
        provider.on('sync', onSync)
      }))
      const now = Date.now()
      const names = new Set([...provider.awareness.getStates()]
        .filter(([id]) => id !== provider.awareness.clientID && isFresh(provider.awareness, id, now))
        .map(([, state]) => state.user?.name))
      const roomDoc = new RoomDoc(doc)
      const holdsWork = (candidate: string) => roomDoc.changedPaths(candidate).length > 0 || (roomDoc.deleted.get(candidate)?.size ?? 0) > 0
      const rememberedName = rememberedTag === undefined ? undefined : rememberedTag ? `${options.name}+${rememberedTag}` : options.name
      const rememberedPresent = rememberedName !== undefined && names.has(rememberedName)
      const barePresent = names.has(options.name)
      const host = resolveSessionHost(options.dir)
      for (let candidate = rememberedTag === undefined ? 0 : -1; ; candidate++) {
        const tag = candidate === -1 ? rememberedTag! : candidate === 0 ? '' : candidate === 1 ? host : `${host}-${candidate}`
        const candidateName = tag ? `${options.name}+${tag}` : options.name
        if (names.has(candidateName) || (tag !== rememberedTag && holdsWork(candidateName))) continue
        label = tag || undefined
        name = candidateName
        break
      }
      if (rememberedPresent || name !== options.name && name !== rememberedName) {
        autoTagNote = `joined as ${name} (${rememberedPresent ? `remembered name ${rememberedName} is in use by another session` : barePresent ? `${options.name} is in use by another session` : `${options.name} still holds uncommitted work from another clone`})`
        ;(options.log ?? console.error)(autoTagNote)
      }
      if ((label ?? '') !== rememberedTag) await rememberTag(options.dir, label ?? '')
    } finally {
      provider.destroy()
      provider.awareness.destroy()
      doc.destroy()
    }
  }
  const daemon = await startRoomd({ ...options, name, label, host: resolveSessionHost(options.dir), ...resolveSessionRuntime(options.dir) })
  const file = sessionMetadataPath(options.dir)
  const refreshTranscriptModel = createClaudeTranscriptModelRefresh()
  const publishRuntime = (transcriptModel?: string) => {
    const current = daemon.provider.awareness.getLocalState()
    const runtime = resolveSessionRuntime(options.dir)
    runtime.model = transcriptModel ?? runtime.model
    if (current) daemon.provider.awareness.setLocalState({ ...current, host: resolveSessionHost(options.dir), ...runtime })
    const worker = daemon.roomDoc.workerOf(name)
    if (worker && (!process.env.ROOM_WORKER_ID || worker.id === process.env.ROOM_WORKER_ID) && runtime.model && worker.model !== runtime.model) daemon.roomDoc.updateWorker(worker.tag, { model: runtime.model }, worker.id)
  }
  const refresh = () => publishRuntime(refreshTranscriptModel(options.dir))
  const activityFile = resolve(dirname(file), 'room-hook-activity.json')
  let lastActivity = Date.now() // do not replay activity left by an earlier session
  const refreshActivity = () => {
    try {
      const activity = JSON.parse(readFileSync(activityFile, 'utf8'))
      const session = JSON.parse(readFileSync(file, 'utf8'))
      if (activity.session_id !== session.session_id || typeof activity.at !== 'number' || !Number.isFinite(activity.at) || activity.at <= lastActivity || activity.at > Date.now()) return
      lastActivity = activity.at
      daemon.touch()
    } catch { /* absent or partially written hook state; retry on next change */ }
  }
  watchFile(file, { interval: 500, persistent: false }, refresh)
  watchFile(activityFile, { interval: 500, persistent: false }, refreshActivity)
  publishRuntime() // cover a metadata rewrite during initial connection without reading the transcript on startup
  const stop = daemon.stop.bind(daemon)
  daemon.stop = async () => { unwatchFile(file, refresh); unwatchFile(activityFile, refreshActivity); await stop() }
  return { daemon, me: { name, kind: options.kind ?? 'agent', owner: options.owner, ...(label ? { label } : {}) }, autoTagNote, refreshRuntime: refresh }
}

export async function joinSession(opts: JoinOptions): Promise<Session> {
  const dir = resolve(opts.dir)
  const config = await resolveConfig({ dir, env: process.env, args: opts })
  configureCredentials(config.credentialsPath)
  if (opts.log) setServerLog(opts.log)
  const chosen = config.server
  if (chosen === LOCAL) {
    const session = await joinLocal(dir, { ...opts, name: config.owner ?? config.name, tag: config.tag, kind: config.kind, share: config.share, web: config.web })
    session.shareWarning = config.shareWarning
    return session
  }
  const parsed = parseServer(chosen)
  const server = parsed.server
  const token = config.token ?? parsed.token
  const web = (config.web ?? defaultWeb(server)).replace(/\/+$/, '')

  let roomName = config.room
  if (!roomName) {
    const d = await deriveRoomName(dir)
    if (!d.roomName) throw new RoomdError(`${dir} has no origin remote; pass room explicitly (e.g. room="myteam/shop/main")`, 2)
    roomName = d.roomName
  }
  const roomUrl = `${server}/${encodeRoom(roomName)}`
  const auth = await resolveAuth(server, roomName, token)
  // Logged in with GitHub: the owner is the verified login, whatever git config says. A label (ROOM_TAG)
  // makes this a second principal under the same owner: name = login+label (e.g. rohanz+codex).
  const label = config.tag?.replace(/[^A-Za-z0-9_-]/g, '') || undefined
  const kindEnv = config.kind
  const kind: Kind = kindEnv === 'bot' || kindEnv === 'ci' ? kindEnv : 'agent'
  const owner = auth.login ?? config.owner ?? config.name ?? await defaultName(dir)
  if (!owner) throw new RoomdError('could not determine your name: pass name or set git config user.name', 2)
  const name = label ? `${owner}+${label}` : owner
  if (auth.login && opts.name && opts.name !== auth.login) opts.log?.(`name is your GitHub login on this server: ${auth.login} (ignoring "${opts.name}")`)
  const { login: _login, ...creds } = auth
  let pre = await preflight(server, roomName, creds)
  if (opts.create && pre?.missing) {
    if (opts.confirm !== true) throw new RoomdError('room_create opens this repo for everyone with push access; call with confirm=true only after the user has agreed', 2)
    const err = await createRoom(server, roomName, { ...creds, by: name })
    if (err) throw new RoomdError(`${server} would not open ${roomName}: ${err}`, 2)
    pre = await preflight(server, roomName, creds)
  }
  // Preflight over HTTP: a refused websocket only shows up as a sync timeout, so ask the server first.
  if (pre?.missing) throw new NoRoom(roomName, pre.reason, server)
  if (pre?.loginNeeded) throw new NotLoggedIn(server)
  if (pre) throw new RoomdError(`${server} refused ${roomName}: ${pre.reason}`, 2)
  const shareRequested = requestedShare(config.share)
  const shareMax = await serverShareMax(server)
  const share = clampShare(shareRequested, shareMax)
  if (share !== shareRequested) opts.log?.(`sharing ${share}, not ${shareRequested}: the server caps sharing at ${shareMax} (ROOM_SHARE_MAX)`)
  const { daemon, me, autoTagNote, refreshRuntime } = await startAutoTaggedRoomd({ room: roomUrl, dir, name, kind, owner, label, token, session: creds.session, share, connectTimeoutMs: opts.connectTimeoutMs, log: opts.log }, config.tag)
  const view = await viewToken(server, roomName, creds)
  const browserUrl = `${web}/?room=${encodeURIComponent(roomUrl)}&participant=${encodeURIComponent(me.name)}${view ? `&view=${view}` : token ? `&token=${encodeURIComponent(token)}` : ''}`
  const graph = new GraphIndex(daemon.roomDoc, me.name, dir, opts.log)
  graph.start()
  const session: Session = {
    graph,
    room: daemon.roomDoc,
    provider: daemon.provider,
    awareness: daemon.provider.awareness,
    daemon,
    me, autoTagNote, refreshRuntime,
    dir,
    roomUrl,
    roomName,
    browserUrl,
    shareMax,
    shareRequested,
    shareWarning: config.shareWarning,
    ...(token ? { token } : {}),
    ...(config.room ? { pinnedRoom: true } : {}),
  }
  trackConnection(session)
  watchClosed(session, opts.log)
  return session
}

/** Normalize an explicit local room while preserving worker/bridge destinations. */
export function normalizeLocalRoomName(room: string): string {
  if (room.startsWith('local/')) return room
  const name = room.trim().replace(/[^A-Za-z0-9_./-]/g, '')
  if (!name) throw new RoomdError('local room name must not be empty', 2)
  return `local/${name}`
}

/** Local mode: no server, no login. The clone's shared git dir hosts a relay; every worktree of the clone shares the room. */
async function joinLocal(dir: string, opts: JoinOptions): Promise<Session> {
  const roomName = opts.room !== undefined ? normalizeLocalRoomName(opts.room) : await localRoomName(dir, opts.localBranch)
  // A dispatched worker is named after its lead's verified owner (ROOM_OWNER), not this clone's git config.
  const owner = opts.name ?? await defaultName(dir)
  if (!owner) throw new RoomdError('could not determine your name: pass name or set git config user.name', 2)
  const label = opts.tag?.trim().replace(/[^A-Za-z0-9_-]/g, '') || undefined
  const kindEnv = opts.kind?.trim()
  const kind: Kind = kindEnv === 'bot' || kindEnv === 'ci' ? kindEnv : 'agent'
  const name = label ? `${owner}+${label}` : owner
  const common = await gitCommonDir(dir)
  const local = await inPhase('relay', () => ensureLocalRelay(common, roomName, { log: opts.log }))
  const roomUrl = `${local.url}/${encodeRoom(roomName)}`
  const share = requestedShare(opts.share)
  let daemon: Roomd, me: Identity, autoTagNote: string | undefined, refreshRuntime: () => void
  try {
    ;({ daemon, me, autoTagNote, refreshRuntime } = await startAutoTaggedRoomd({ room: roomUrl, dir, name, kind, owner, label, share, localKey: local.key, connectTimeoutMs: opts.connectTimeoutMs, log: opts.log }, opts.tag))
  } catch (e) { await local.stop(); throw e }
  // The relay serves the browser view itself (same machine only); ROOM_WEB overrides for web dev.
  const web = (opts.web ?? local.httpUrl).replace(/\/+$/, '')
  // The link carries the relay key: it is machine-local, and anyone holding it can read the room.
  const browserUrl = `${web}/?room=${encodeURIComponent(roomUrl)}&participant=${encodeURIComponent(me.name)}&key=${encodeURIComponent(local.key)}`
  const graph = new GraphIndex(daemon.roomDoc, me.name, dir, opts.log)
  graph.start()
  const session: Session = {
    graph,
    room: daemon.roomDoc,
    provider: daemon.provider,
    awareness: daemon.provider.awareness,
    daemon,
    me, autoTagNote, refreshRuntime,
    dir,
    roomUrl,
    roomName,
    browserUrl,
    shareMax: 'full',
    shareRequested: share,
    local,
    pinnedRoom: true,
  }
  trackConnection(session)
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
    const res = await serverFetch(`${httpOf(server)}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, ...auth }), timeoutMs: 20000 })
    if (res.ok) return undefined
    if (res.status === 401) {
      const reason = (await res.text()).trim() || 'unauthorized'
      // The server points at room_login for a missing or stale session; a ROOM_TOKEN on a github.com room gets the same pointer.
      if (/room_login/.test(reason)) { removeStaleCredential(server, reason); return { reason, loginNeeded: true } }
      return { reason }
    }
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
    const res = await serverFetch(`${httpOf(server)}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, ...auth }), timeoutMs: 20000 })
    if (res.ok) return undefined
    return (await res.text()).trim() || `HTTP ${res.status}`
  } catch (e) {
    return `cannot reach ${server} (${e instanceof Error ? e.message : String(e)})`
  }
}

/** Close the repo on the server: every branch room, every overlay, every connection. Returns the rooms closed, or throws with the refusal. */
export async function closeRoom(server: string, roomName: string, auth: Creds): Promise<string[]> {
  const res = await serverFetch(`${httpOf(server)}/rooms`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, ...auth }), timeoutMs: 20000 })
  if (!res.ok) throw new RoomdError(`${server} would not close ${roomName}: ${(await res.text()).trim() || `HTTP ${res.status}`}`, 2)
  const body = (await res.json().catch(() => ({}))) as { closed?: string[] }
  return body.closed ?? []
}

/** Auth the way joinSession resolves it, for HTTP calls made after the join. */
export async function authFor(s: Session): Promise<Creds & { server: string }> {
  if (s.local) throw new RoomdError('local room: no server to authenticate to', 2)
  const server = s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))
  const token = s.token
  const { login: _login, ...creds } = await resolveAuth(server, s.roomName, token)
  return { ...creds, server }
}

/** Ask the server for a room-scoped token (7 days) the browser can use (never the GitHub token itself). */
export async function viewToken(server: string, roomName: string, auth: Creds): Promise<string | undefined> {
  if (!auth.token && !auth.session) return undefined
  try {
    const res = await serverFetch(`${httpOf(server)}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, ...auth }), timeoutMs: 20000 })
    if (!res.ok) return undefined
    return ((await res.json()) as { view?: string }).view
  } catch { return undefined }
}

/** Re-mint the browser link (view keys can expire or be lost); falls back to the stored one. */
export async function refreshBrowserUrl(s: Session): Promise<string> {
  if (s.local) return s.browserUrl
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
  await s.local?.stop()
}
