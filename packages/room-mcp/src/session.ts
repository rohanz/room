import { trackConnection } from './connection.js'
/**
 * A session is one joined room: the embedded daemon (which owns the Y.Doc and the
 * websocket provider) plus the identity the tools act as. `room_join` creates it,
 * `room_leave` tears it down.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { startRoomd, RoomdError, clampShare, inPhase, readRoomFile, type Roomd, type RoomFile, type ShareLevel } from '@room/roomd'
import { ensureLocalRelay, type LocalRelay } from '@room/relay'
import { localRoomName } from '@room/roomd/local'
import { gitCommonDir } from '@room/roomd'
import { git, gitBranch, gitOrigin } from '@room/roomd/git'
import { RoomDoc, assertValidParticipantName, canonicalRepo, roomKey, type Claim, type Identity, type Kind, type Msg, type Scope } from '@room/shared'
import { GraphIndex } from './graph-index.js'
import { withdrawFormerPublisher } from '../../roomd/src/publisher.js'
import { configureCredentials, getCredential, removeCredential, setCredential } from './credentials.js'
import { DEFAULT_SERVER, LOCAL, resolveConfig, resolveShare, resolveServer, resolveSessionHost, resolveSessionRuntime } from './config.js'
import { createSessionBinding } from './binding.js'
import { isFresh } from './presence.js'
import { worktreePath } from './choice.js'
import { probeProcess, type ProcessProbe } from './worker-process.js'
import { writeAtomic, type ProcessIdentity } from './leases.js'
import { CeilingSource, PolicyStore } from './policy-store.js'
import { admitWorkerEnvironment, workerCarried } from './worker-registry.js'
import { HubClient, hubTransport } from './hub-client.js'
import { createPost, greet, type Post } from './post.js'
import { attachPublisher, publisherLease } from './publisher-lease.js'
import { chooseName, NameRefused, ParticipantLease, processToken, type ChosenName } from './names.js'
import type { HolderIn } from '@room/hub-core'

/** A server requires an argument, ROOM_SERVER/ROOM_URL, or a remembered choice. */
export { DEFAULT_SERVER, LOCAL, resolveServer }
const DEFAULT_WEB = 'http://localhost:5173'

export interface Session {
  room: RoomDoc
  provider: WebsocketProvider
  awareness: Awareness
  daemon: Roomd
  me: Identity
  dir: string
  /** ws://server/<encoded room name> */
  roomUrl: string
  /** Human-readable repository room name, e.g. github.com/rohanz/room */
  roomName: string
  browserUrl: string
  /** Symbol graph over base + overlays; undefined in unit tests. */
  graph?: GraphIndex
  /** Set when the server closed the repo (ws close 4001): the provider stops reconnecting. */
  closed?: { reason: string }
  /** A size-cap refusal: publication stays paused until the next successful sync. */
  rejected?: { reason: string; at: number }
  /** The server's ceiling on sharing levels (ROOM_SHARE_MAX); the daemon's level never exceeds it. */
  shareMax: ShareLevel
  /** Set in local mode (no server): the relay this session found or runs. */
  local?: LocalRelay
  /** Invalid input narrowed to plans only; retained for sharing controls. */
  shareWarning?: string
  /** The requested level before the server ceiling. */
  shareRequested: ShareLevel
  /** The shared token this session joined with (argument, ROOM_TOKEN, or `?token=` on the server URL); workers get it as ROOM_TOKEN. Never printed. */
  token?: string
  autoTagNote?: string
  /** Latest preview started by this MCP session; never reconstructed from shared room history. */
  lastPreview?: { clean: boolean; complete: boolean; testsPassed?: boolean; partialPassed?: boolean; testsCommand?: string }
  policyStore: PolicyStore
  /** Refresh hook/session runtime metadata before a Room tool is dispatched. */
  refreshRuntime?: () => void
  /** Route a verified bound hook contact to the host's monotonic presence clock. */
  onHookActivity?: (listener: () => void) => void
  /** Same MCP process observed a new bound host session after /clear. */
  onRebind?: (listener: (sessionId: string) => void) => void
  /** The room's hub over this connection (hub §9): posts, and whether coordination is paused. */
  hub: HubClient
  /** The only way to post: through the hub, the sole appender of `bus` (post.ts). */
  post: Post
  /** The name lease (registry §15): the fence while coordination may write, the paused line otherwise (hub §7). */
  lease?: ParticipantLease
}

/** SessionStart owns session.json; the same session's hooks own runtime.json. */
export interface SessionRecord {
  session_id: string
  host: 'claude' | 'codex'
  cwd: string
  at: number
  source?: string
  chain: ProcessIdentity[]
  hostPid: number
  transcript_path?: string
  model?: string
  effort?: string
  worker_id?: string
}

export interface SessionRuntime {
  model?: string
  effort?: string
  transcript?: { path: string; mtimeMs: number; size: number }
  at: number
}

/** The short component keeps host thread IDs out of local path names. */
export function sessionDirectory(commonDir: string, sessionId: string): string {
  if (!sessionId) throw new Error('session ID is required')
  const sid = createHash('sha256').update(sessionId).digest('hex').slice(0, 16)
  return join(commonDir, 'room', 'sessions', sid)
}

function readSessionFile<T>(commonDir: string, sessionId: string, name: string): T | undefined {
  try { return JSON.parse(readFileSync(join(sessionDirectory(commonDir, sessionId), name), 'utf8')) as T }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}

export function writeSessionRecord(commonDir: string, record: SessionRecord): void {
  writeAtomic(join(sessionDirectory(commonDir, record.session_id), 'session.json'), record)
}

export function readSessionRecord(commonDir: string, sessionId: string): SessionRecord | undefined {
  const record = readSessionFile<SessionRecord>(commonDir, sessionId, 'session.json')
  return record?.session_id === sessionId ? record : undefined
}

export function writeSessionRuntime(commonDir: string, sessionId: string, runtime: SessionRuntime): void {
  writeAtomic(join(sessionDirectory(commonDir, sessionId), 'runtime.json'), runtime)
}

export function readSessionRuntime(commonDir: string, sessionId: string): SessionRuntime | undefined {
  return readSessionFile<SessionRuntime>(commonDir, sessionId, 'runtime.json')
}

function sessionRecords(commonDir: string): SessionRecord[] {
  const root = join(commonDir, 'room', 'sessions')
  let entries: string[]
  try { entries = readdirSync(root) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  const records: SessionRecord[] = []
  for (const entry of entries) {
    try {
      const record = JSON.parse(readFileSync(join(root, entry, 'session.json'), 'utf8')) as SessionRecord
      if (record?.session_id && sessionDirectory(commonDir, record.session_id) === join(root, entry)) records.push(record)
    } catch (e) {
      if (e instanceof SyntaxError || ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) continue
      throw e
    }
  }
  return records
}

export interface SessionBindingOptions {
  commonDir?: string
  cwd?: string
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  host?: 'claude' | 'codex'
  parent?: ProcessIdentity
  probe?: ProcessProbe
  workerId?: string
  /** Registry's pre-generated Claude session, or an admitted Codex log thread ID. */
  workerSessionId?: string
  codexLogSessionId?: string
  appServer?: boolean
  parentArgs?: string
}

function processIdentity(pid: number, probe: ProcessProbe): ProcessIdentity | undefined {
  const info = probe(pid)
  return info?.startTime && info.executable ? { pid, startTime: info.startTime, executable: info.executable } : undefined
}

function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.startTime === b.startTime && a.executable === b.executable
}

function defaultCommonDir(cwd: string): string | undefined {
  try { return resolve(cwd, execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()) }
  catch { return undefined }
}

function parentCommandLine(): string {
  try { return execFileSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch { return '' }
}

/** Strip the known Codex executable, including an unquoted path containing spaces. */
function codexArguments(parent: ProcessIdentity | undefined, commandLine: string): string | undefined {
  if (!parent) return undefined
  const known = parent.executable
  const name = known.split(/[/\\]/).at(-1)
  if (name !== 'codex' && name !== 'codex.exe') return undefined
  const raw = commandLine.trim()
  const after = (prefix: string): string | undefined => raw.startsWith(prefix) && (raw.length === prefix.length || /\s/.test(raw[prefix.length]))
    ? raw.slice(prefix.length).trimStart() : undefined
  for (const prefix of [known, `"${known}"`, `'${known}'`]) {
    const args = after(prefix)
    if (args !== undefined) return args
  }
  if (raw[0] === '"' || raw[0] === "'") {
    const end = raw.indexOf(raw[0], 1)
    if (end > 0 && raw.slice(1, end).split(/[/\\]/).at(-1) === name) return after(raw.slice(0, end + 1))
    return undefined
  }
  const direct = after(name)
  if (direct !== undefined) return direct
  for (const separator of ['/', '\\']) {
    let index = raw.indexOf(`${separator}${name}`)
    while (index >= 0) {
      const args = after(raw.slice(0, index + 1 + name.length))
      if (args !== undefined) return args
      index = raw.indexOf(`${separator}${name}`, index + 1)
    }
  }
  return undefined
}

/** Re-evaluate on every call: a new SessionStart after Claude /clear supersedes the prior ID. */
export function boundSession(options: SessionBindingOptions = {}): { id: string; host: 'claude' | 'codex' } | undefined {
  const env = options.env ?? process.env
  const parent = options.parent ?? processIdentity(process.ppid, options.probe ?? probeProcess)
  const host = options.host ?? (env.ROOM_WORKER_HOST === 'claude' || env.ROOM_HOST === 'claude' ? 'claude'
    : env.ROOM_WORKER_HOST === 'codex' || env.ROOM_HOST === 'codex' ? 'codex'
      : parent && /claude/i.test(basename(parent.executable)) ? 'claude'
        : parent && /codex/i.test(basename(parent.executable)) ? 'codex' : undefined)
  if (!host) return undefined
  const workerId = options.workerId ?? env.ROOM_WORKER_ID
  if (workerId && host === 'claude' && options.workerSessionId) return { id: options.workerSessionId, host }
  const commonDir = options.commonDir ?? defaultCommonDir(options.cwd ?? process.cwd())
  if (!commonDir) return undefined
  const records = sessionRecords(commonDir).filter(record => record.host === host)
  if (workerId) {
    const matching = records.filter(record => record.worker_id === workerId).sort((a, b) => b.at - a.at)[0]
    const id = matching?.session_id ?? (host === 'codex' ? options.codexLogSessionId : undefined)
    return id ? { id, host } : undefined
  }
  if (host === 'codex') {
    const args = codexArguments(parent, options.parentArgs ?? parentCommandLine())
    if (options.appServer || args === undefined || args.match(/^\S+/)?.[0] === 'app-server') return undefined
  }
  const matching = parent && records.filter(record => !record.worker_id && record.chain?.some(member => sameProcess(member, parent))).sort((a, b) => b.at - a.at)[0]
  if (matching) return { id: matching.session_id, host }
  return host === 'claude' && env.CLAUDE_CODE_SESSION_ID ? { id: env.CLAUDE_CODE_SESSION_ID, host } : undefined
}

/** Used by the name lease while a Codex app-server request has no bound thread. */
export function syntheticSessionId(identity: ProcessIdentity): string { return `mcp:${identity.pid}:${identity.startTime}` }

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
  /** Label for a second principal under the same login: name becomes login+label. Default from ROOM_TAG. */
  tag?: string
  /** 'agent' (default), 'bot' or 'ci'. Default from ROOM_KIND. */
  kind?: string
  /** Sharing level: intent | declared | full. Default from ROOM_SHARE, then full. Clamped to the server's shareMax. */
  share?: string
  shareExplicit?: boolean
  /** The host session this join acts for (registry §17); default the bound session, else this process's synthetic one. */
  sessionId?: string
  connectTimeoutMs?: number
  /** Explicit recovery of a local holder whose process identity is unknown (registry §15). */
  takeover?: boolean
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

/** Room name from the clone's origin; the branch is a participant fact, not part of the room key. */
export async function deriveRoomName(dir: string): Promise<{ roomName?: string; branch: string; repo?: string }> {
  const [repo, branch] = await Promise.all([gitOrigin(dir), gitBranch(dir)])
  const canonical = repo ? canonicalRepo(repo) : undefined
  return { repo: canonical, branch, roomName: canonical }
}

async function defaultName(dir: string): Promise<string | undefined> {
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

const ceilings = new Map<string, CeilingSource>()
function ceilingFor(server: string, fallback: ShareLevel): CeilingSource {
  let source = ceilings.get(server)
  if (!source) { source = new CeilingSource(server, fallback); ceilings.set(server, source) }
  return source
}
/** The server's sharing ceiling. Unknown results use the local choice and are retried. */
export async function serverShareMax(server: string, fallback: ShareLevel = 'intent', fetcher: typeof serverFetch = serverFetch, _refresh = false): Promise<ShareLevel> {
  const source = ceilingFor(server, fallback)
  try {
    const res = await fetcher(`${httpOf(server)}/auth/config`, { timeoutMs: 20000 })
    if (!res.ok) return source.level
    source.set(resolveShare(((await res.json()) as { shareMax?: unknown }).shareMax).level)
  } catch { /* unreachable: the join will report it */ }
  return source.level
}

/** Missing uses full; invalid levels fail closed to plans only. */
export function requestedShare(explicit?: string): ShareLevel {
  return resolveShare(explicit).level
}

/** The server also serves the browser view: ws(s)://host -> http(s)://host. Local dev keeps the Vite port. */
function defaultWeb(server: string): string {
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
function setServerLog(log?: (line: string) => void): void { serverLog = log }
/** Total time a tool call may spend waiting for a cold server before giving up. */
const SERVER_RETRY_MS = 45_000

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

/** What a join resolved: the daemon under a leased name, its store, and the lease and hub that keep the name. */
export interface NamedRoomd { daemon: Roomd; me: Identity; policyStore: PolicyStore; lease: ParticipantLease; hub: HubClient; post: Post; autoTagNote?: string; refreshRuntime: () => void; onHookActivity: (listener: () => void) => void; onRebind: (listener: (sessionId: string) => void) => void }

/** Keep a live daemon in sync when a sharing grant changes or settles. */
export function applySessionPolicy(daemon: Roomd, policy: PolicyStore['policy']): void {
  daemon.applyInputs({ ...daemon.inputs, policy })
}

/**
 * Resolve identity before roomd can publish anything under it (registry §15): a probe connection syncs the
 * room and reaches its hub; the name is the first candidate whose O_EXCL lease in this clone and whose hub
 * lease this session gets. The hub client then moves to the daemon's connection and keeps renewing.
 */
export async function startAutoTaggedRoomd(options: Omit<Parameters<typeof startRoomd>[0], 'policy'> & { requested: ShareLevel; requestedExplicit?: boolean; ceiling?: ShareLevel; takeover?: boolean }, explicitTag?: string): Promise<NamedRoomd> {
  assertValidParticipantName(options.name)
  if (options.owner) assertValidParticipantName(options.owner)
  if (options.label) assertValidParticipantName(options.label)
  if (explicitTag) assertValidParticipantName(explicitTag)
  // The bare name the candidates build on; a caller passing only a tagged name gets it back for that tag.
  const owner = options.owner ?? (explicitTag && options.name.endsWith(`+${explicitTag}`) ? options.name.slice(0, -explicitTag.length - 1) : options.name)
  const doc = new Y.Doc()
  const url = new URL(options.room)
  const encodedRoom = url.pathname.split('/').pop()!
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/'))
  const probe = options.providerFactory
    ? options.providerFactory(url.toString().replace(/\/$/, ''), encodedRoom, doc)
    : new WebsocketProvider(url.toString().replace(/\/$/, ''), encodedRoom, doc, {
        WebSocketPolyfill: WebSocket as any,
        params: { schema: '2', ...(options.token ? { token: options.token } : {}), ...(options.session ? { session: options.session } : {}), ...(options.localKey ? { key: options.localKey } : {}) },
      })
  const closeProbe = () => { probe.destroy(); probe.awareness.destroy(); doc.destroy() }
  const binding = createSessionBinding(options.dir)
  const sessionId = options.sessionId ?? binding.id()
  const boundAtJoin = binding.bound()?.id
  const hostCurrent = () => !boundAtJoin || binding.bound()?.id === sessionId
  const token = processToken(sessionId)
  const workerId = process.env.ROOM_WORKER_ID || undefined
  const holder: HolderIn = { sessionId, pid: token.pid, startTime: token.startTime, executable: token.executable, ...(workerId ? { workerId } : {}) }
  const room = decodeURIComponent(new URL(options.room).pathname.replace(/^\/+/, ''))
  const key = roomKey(options.localKey ? 'local' : new URL(options.room).origin, room)
  const hub = new HubClient({ transport: hubTransport(probe), client: 'room-mcp', sessionId, local: !!options.localKey })
  let chosen: ChosenName
  try {
    if (!probe.synced) await inPhase('sync', () => new Promise<void>((resolve, reject) => {
      const onSync = (synced: boolean) => { if (synced) { clearTimeout(timer); probe.off('sync', onSync); resolve() } }
      const timer = setTimeout(() => {
        probe.off('sync', onSync)
        reject(new RoomdError(`could not sync with ${options.room} within ${options.connectTimeoutMs ?? 15000}ms`, 1))
      }, options.connectTimeoutMs ?? 15000)
      probe.on('sync', onSync)
    }))
    // An unreachable or older hub leaves the session paused under its local lease (hub §7, §10).
    const reachable = await hub.hello().then(() => true, () => false)
    const epoch = Number(process.env.ROOM_NAME_EPOCH)
    const commonDir = await gitCommonDir(options.dir)
    chosen = await inPhase('name', () => chooseName({
      dir: options.dir, commonDir, roomKey: key, owner, explicitTag, host: resolveSessionHost(),
      doc: new RoomDoc(doc), hub: reachable ? hub : undefined, token, holder, workerId, takeover: options.takeover,
      ...(workerId && Number.isSafeInteger(epoch) ? { supersedes: epoch } : {}), log: options.log ?? console.error,
    }))
  } catch (e) {
    hub.close(); closeProbe()
    throw e instanceof NameRefused ? new RoomdError(e.message, 2) : e
  }
  const name = chosen.name, label = chosen.label, autoTagNote = chosen.note
  let publishing: Awaited<ReturnType<typeof attachPublisher>> | undefined
  let attachPublication: (() => Promise<Awaited<ReturnType<typeof attachPublisher>>>) | undefined
  let publicationTransition: Promise<void> = Promise.resolve()
  let stopping = false
  const lease = new ParticipantLease({ name, file: chosen.file, token, holder, hub, epoch: chosen.epoch, hostCurrent, log: options.log,
    onChange: fence => {
      if (!attachPublication || stopping) return
      publicationTransition = publicationTransition.then(async () => {
        if (stopping) return
        if (!fence) {
          if (daemon && lease.epoch !== undefined) withdrawFormerPublisher(daemon.roomDoc, name, String(lease.epoch), 'another session')
          policyStore.setPublisher(false)
          const attachment = publishing
          publishing = undefined
          await attachment?.detach()
        } else if (!publishing) publishing = await attachPublication!()
      }).catch(error => { options.log?.(`warn: publisher handoff: ${error instanceof Error ? error.message : String(error)}`) })
    },
  })
  let daemon: Roomd | undefined
  const { requested: _requested, requestedExplicit: _requestedExplicit, ceiling: _ceiling, ...daemonOptions } = options
  // The daemon's automatic posts go through this connection's hub, under the name lease (hub §2.3).
  let post: Post | undefined
  let started: Roomd
  let policyStore: PolicyStore
  try {
    policyStore = await PolicyStore.open({ dir: options.dir, room, participant: name, server: new URL(options.room).origin, requested: options.requested, ceiling: options.ceiling,
      onChange: policy => { if (daemon) applySessionPolicy(daemon, policy) } })
    if (options.requestedExplicit) await policyStore.setRequested(options.requested)
    // One publisher per worktree (registry §16): its lease decides `publisher` before the daemon's first write.
    attachPublication = async () => attachPublisher({
      lease: publisherLease(await gitCommonDir(options.dir), await worktreePath(options.dir), token),
      roomKey: key, participant: name,
      setPublisher: (publisher, publisherName) => { policyStore.setPublisher(publisher, publisherName) },
      named: () => !!daemon && namesAsPublisher(daemon.roomDoc, daemon.provider.awareness, name), log: options.log,
    })
    if (lease.fence()) publishing = await attachPublication()
    else policyStore.setPublisher(false)
    started = daemon = await startRoomd({ ...daemonOptions, name, label, sessionId, lease: () => lease.fence(), policy: policyStore.policy, carried: workerCarried(options.dir),
      post: (from, body, opts) => {
        if (post) return post(from, body, opts)
        options.log?.(`not posted before the hub connection: ${body.type}`)
        return { ok: false }
      },
      onFullScan: (policy, entries, unsettled) => policyStore.settle(policy, entries, unsettled).then(() => {}),
      host: resolveSessionHost(), ...resolveSessionRuntime(binding.dir()) })
    if (lease.fence()) claimLegacyIdentity(started.roomDoc, options.dir, name)
  } catch (e) { await publishing?.detach(); await lease.end(); hub.close(); closeProbe(); throw e }
  // The daemon's connection carries the hub from here (one client per session): the lease's clock and epoch move with it.
  hub.attach(hubTransport(started.provider))
  greet(hub)
  closeProbe()
  post = createPost(started.roomDoc, hub, () => lease.held(), () => lease.paused())
  try { if (lease.fence()) await started.validateMigratedClaims() }
  catch (error) { await publishing?.detach(); await lease.end(); await started.stop(); hub.close(); throw error }
  const stopLegacyWatch = watchLegacyIdentity(started.roomDoc, readRoomFile(options.dir)?.legacy, name,
    () => lease.fence(), () => started.validateMigratedClaims())
  {
    const stop = started.stop.bind(started)
    // Ending presence: withdraw and detach the publisher lease, release the hub lease while the connection is up, then stop.
    started.stop = async (reason?: string) => { stopLegacyWatch(); stopping = true; await publicationTransition; await publishing?.detach(); await lease.end(); await stop(reason); hub.close() }
  }
  daemon = started
  // The bound session's records (ledger SF3): SessionStart's session.json, the before-edit hook's runtime.json
  // and hook-activity.json. Polled, since a new binding (Claude /clear) moves them to another directory.
  const publishRuntime = () => {
    if (!hostCurrent()) return
    const current = started.provider.awareness.getLocalState()
    const runtime = resolveSessionRuntime(binding.dir())
    if (current) started.provider.awareness.setLocalState({ ...current, host: resolveSessionHost(), ...runtime })
  }
  let published = ''
  let lastActivity = Date.now() // do not replay activity left by an earlier session
  let hookActivity: (() => void) | undefined
  let rebindListener: ((sessionId: string) => void) | undefined
  let announcedRebind: string | undefined
  const watchRecords = () => {
    const currentBound = binding.bound()?.id
    if (boundAtJoin && currentBound !== sessionId) {
      lease.check() // withdraw publisher authority before asking the host to rejoin.
      if (currentBound && currentBound !== announcedRebind && rebindListener) {
        announcedRebind = currentBound
        rebindListener(currentBound)
      }
      return
    }
    const dir = binding.dir()
    if (!dir) return
    const stamp = ['session.json', 'runtime.json'].map(f => { try { return `${statSync(join(dir, f)).mtimeMs}` } catch { return '-' } }).join(`\0${dir}\0`)
    if (stamp !== published) { published = stamp; publishRuntime() }
    try {
      const activity = JSON.parse(readFileSync(join(dir, 'hook-activity.json'), 'utf8'))
      if (activity.session_id !== binding.bound()?.id || activity.event !== 'PreToolUse') return
      if (typeof activity.at !== 'number' || !Number.isFinite(activity.at) || activity.at <= lastActivity || activity.at > Date.now()) return
      lastActivity = activity.at
      started.touch()
      hookActivity?.()
    } catch { /* absent or partially written hook state; retry on the next poll */ }
  }
  const watcher = setInterval(watchRecords, 500)
  watcher.unref?.()
  publishRuntime()
  const stop = started.stop.bind(started)
  started.stop = async (reason?: string) => { clearInterval(watcher); await stop(reason) }
  return { daemon: started, me: { name, kind: options.kind ?? 'agent', owner, ...(label ? { label } : {}) }, policyStore, lease, hub, post, autoTagNote, refreshRuntime: publishRuntime, onHookActivity: listener => { hookActivity = listener }, onRebind: listener => { rebindListener = listener; watchRecords() } }
}

/** Resolve an ambiguous 0.16 branch-room identity using this worktree's old room.json. */
function claimLegacyIdentity(room: RoomDoc, dir: string, name: string): boolean {
  return reclaimLegacyIdentity(room, readRoomFile(dir)?.legacy, name)
}

function reclaimLegacyIdentity(room: RoomDoc, legacy: { room: string; name: string } | undefined, name: string): boolean {
  if (!legacy) return false
  let oldRoom: string
  try { oldRoom = decodeRoom(new URL(legacy.room).pathname.replace(/^\/+/, '')) } catch { return false }
  const unresolved = room.doc.getMap<{ placeholder: string; claims: Claim[]; scope?: Scope }>('unresolved')
  const key = `${oldRoom}\0${legacy.name}`
  const entry = unresolved.get(key)
  if (!entry) return false
  room.doc.transact(() => {
    for (const claim of entry.claims) if (!room.claims.has(claim.id)) room.claims.set(claim.id, { ...claim, by: name })
    if (entry.scope && !room.scopes.has(name)) room.scopes.set(name, { ...entry.scope, by: name })
    for (const [id, message] of room.mail) {
      if (message.from !== entry.placeholder && message.to !== entry.placeholder) continue
      room.mail.set(id, { ...message, from: message.from === entry.placeholder ? name : message.from,
        ...(message.to === entry.placeholder ? { to: name } : {}) } as Msg)
    }
    room.doc.getMap<string>('aliases').set(entry.placeholder, name)
    unresolved.delete(key)
  })
  return true
}

/** Local catch-up can add unresolved facts after a session has joined. Reclaim them
 * only while this session still holds its current name fence. */
export function watchLegacyIdentity(room: RoomDoc, legacy: { room: string; name: string } | undefined,
  name: string, fence: () => string | undefined, validate: () => Promise<void>): () => void {
  const unresolved = room.doc.getMap('unresolved')
  const check = () => {
    if (!fence() || !reclaimLegacyIdentity(room, legacy, name)) return
    void validate().catch(() => {})
  }
  unresolved.observe(check)
  check()
  return () => unresolved.unobserve(check)
}

/** Another fresh session in the room shows `name` as the publisher of its checkout (manifest §5.7). */
function namesAsPublisher(room: RoomDoc, awareness: Awareness, name: string): boolean {
  const now = Date.now()
  const present = new Set([...awareness.getStates()].filter(([id]) => id !== awareness.clientID && isFresh(awareness, id, now)).map(([, state]) => state.user?.name))
  return [...room.manifestHead.entries()].some(([other, head]) => other !== name && present.has(other) && head.publisher === name && head.coverage.kind === 'none' && head.coverage.reason === 'not-publisher')
}

export async function joinSession(opts: JoinOptions): Promise<Session> {
  const dir = resolve(opts.dir)
  const config = await resolveConfig({ dir, env: process.env, args: opts })
  await admitWorkerEnvironment(dir)
  for (const value of [config.name, config.owner, config.tag]) if (value) assertValidParticipantName(value)
  configureCredentials(config.credentialsPath)
  if (opts.log) setServerLog(opts.log)
  const chosen = config.server
  if (chosen === LOCAL) {
    const session = await joinLocal(dir, { ...opts, name: config.owner ?? config.name, tag: config.tag, kind: config.kind, share: config.share, shareExplicit: config.shareExplicit, web: config.web })
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
    if (!d.roomName) throw new RoomdError(`${dir} has no origin remote; pass room explicitly (e.g. room="myteam/shop")`, 2)
    roomName = d.roomName
  }
  const auth = await resolveAuth(server, roomName, token)
  // Logged in with GitHub: the owner is the verified login, whatever git config says. A label (ROOM_TAG)
  // makes this a second principal under the same owner: name = login+label (e.g. rohanz+codex).
  const label = config.tag?.replace(/[^A-Za-z0-9_-]/g, '') || undefined
  const kindEnv = config.kind
  const kind: Kind = kindEnv === 'bot' || kindEnv === 'ci' ? kindEnv : 'agent'
  const owner = auth.login ?? config.owner ?? config.name ?? await defaultName(dir)
  if (!owner) throw new RoomdError('could not determine your name: pass name or set git config user.name', 2)
  assertValidParticipantName(owner)
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
  if (pre && !pre.canonical) throw new RoomdError(`${server} refused ${roomName}: ${pre.reason}`, 2)
  if (pre?.canonical && pre.canonical !== roomName) {
    opts.log?.('room names no longer carry a branch; joined ' + pre.canonical)
    roomName = pre.canonical
  }
  const roomUrl = `${server}/${encodeRoom(roomName)}`
  const shareRequested = requestedShare(config.share)
  const shareMax = await serverShareMax(server, shareRequested)
  const share = clampShare(shareRequested, shareMax)
  if (share !== shareRequested) opts.log?.(`sharing ${share}, not ${shareRequested}: the server caps sharing at ${shareMax} (ROOM_SHARE_MAX)`)
  const { daemon, me, policyStore, lease, hub, post, autoTagNote, refreshRuntime, onHookActivity, onRebind } = await startAutoTaggedRoomd({ room: roomUrl, dir, name, kind, owner, label, token, session: creds.session, requested: shareRequested, requestedExplicit: config.shareExplicit, ceiling: shareMax, sessionId: opts.sessionId, connectTimeoutMs: opts.connectTimeoutMs, takeover: opts.takeover, log: opts.log }, config.tag)
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
    policyStore,
    lease,
    me, autoTagNote, refreshRuntime, onHookActivity, onRebind,
    dir,
    roomUrl,
    roomName,
    browserUrl,
    shareMax,
    shareRequested: policyStore.requested,
    shareWarning: config.shareWarning,
    ...(token ? { token } : {}),
    hub, post,
  }
  const untrackShare = ceilingFor(server, shareMax).subscribe(policyStore)
  trackConnection(session)
  const stop = session.daemon.stop.bind(session.daemon)
  session.daemon.stop = async () => { try { await stop() } finally { untrackShare() } }
  let refreshing = false
  session.provider.on('sync', (synced: boolean) => {
    if (!synced || refreshing) return
    refreshing = true
    void serverShareMax(server, session.shareMax, serverFetch, true)
      .catch(error => opts.log?.(`warn: could not refresh sharing ceiling: ${String(error)}`))
      .finally(() => { refreshing = false })
  })
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
  const roomName = opts.room !== undefined ? normalizeLocalRoomName(opts.room) : await localRoomName(dir)
  // A dispatched worker is named after its lead's verified owner (ROOM_OWNER), not this clone's git config.
  const owner = opts.name ?? await defaultName(dir)
  if (!owner) throw new RoomdError('could not determine your name: pass name or set git config user.name', 2)
  assertValidParticipantName(owner)
  const label = opts.tag?.trim().replace(/[^A-Za-z0-9_-]/g, '') || undefined
  const kindEnv = opts.kind?.trim()
  const kind: Kind = kindEnv === 'bot' || kindEnv === 'ci' ? kindEnv : 'agent'
  const name = label ? `${owner}+${label}` : owner
  const common = await gitCommonDir(dir)
  // A takeover starts the successor relay from this session's replica (hub.md §5); roomd supplies it once started.
  let replica: Y.Doc | undefined
  const local = await inPhase('relay', () => ensureLocalRelay(common, roomName, { log: opts.log, seed: () => Y.encodeStateAsUpdate(replica ?? new Y.Doc()) }))
  const roomUrl = `${local.url}/${encodeRoom(roomName)}`
  const share = requestedShare(opts.share)
  let daemon: Roomd, me: Identity, policyStore: PolicyStore, lease: ParticipantLease, hub: HubClient, post: Post, autoTagNote: string | undefined, refreshRuntime: () => void, onHookActivity: (listener: () => void) => void, onRebind: (listener: (sessionId: string) => void) => void
  try {
    ;({ daemon, me, policyStore, lease, hub, post, autoTagNote, refreshRuntime, onHookActivity, onRebind } = await startAutoTaggedRoomd({ room: roomUrl, dir, name, kind, owner, label, requested: share, requestedExplicit: opts.shareExplicit, localKey: local.key, sessionId: opts.sessionId, connectTimeoutMs: opts.connectTimeoutMs, takeover: opts.takeover, log: opts.log }, opts.tag))
  } catch (e) { await local.stop(); throw e }
  replica = daemon.roomDoc.doc
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
    policyStore,
    lease,
    me, autoTagNote, refreshRuntime, onHookActivity, onRebind,
    dir,
    roomUrl,
    roomName,
    browserUrl,
    shareMax: 'full',
    shareRequested: policyStore.requested,
    local,
    hub, post,
  }
  trackConnection(session)
  return session
}

/** Server close code when a repo is closed (DELETE /rooms): stop reconnecting and remember why. */
const ROOM_CLOSED_CODE = 4001
const ROOM_SIZE_CAP_CODE = 4413
const SIZE_CAP_RETRY_MS = 60_000
const SIZE_CAP_VERIFY_MS = 2_000
export function watchClosed(s: Session, log?: (line: string) => void): void {
  const p = s.provider as unknown as { on?: (ev: string, fn: (e: { code?: number; reason?: string } | boolean | null) => void) => void; disconnect?: () => void; connect?: () => void; wsconnected?: boolean; synced?: boolean }
  let retry: ReturnType<typeof setTimeout> | undefined
  let verify: ReturnType<typeof setTimeout> | undefined
  const pauseAndRetry = () => {
    s.daemon.setPublicationRejected(true)
    try { p.disconnect?.() } catch { /* already gone */ }
    if (retry) clearTimeout(retry)
    retry = setTimeout(() => { retry = undefined; if (!s.closed && s.rejected) p.connect?.() }, SIZE_CAP_RETRY_MS)
    retry.unref?.()
  }
  p.on?.('connection-close', e => {
    const close = e && typeof e === 'object' ? e : undefined
    if (close?.code === ROOM_SIZE_CAP_CODE) {
      s.rejected = { reason: close.reason || 'room is over its size cap', at: Date.now() }
      if (verify) clearTimeout(verify)
      pauseAndRetry()
      log?.(`${s.roomName}: ${s.rejected.reason}; your last edits are not in the room; retrying in 60 seconds`)
      return
    }
    if (close?.code !== ROOM_CLOSED_CODE) return
    if (retry) clearTimeout(retry)
    if (verify) clearTimeout(verify)
    s.closed = { reason: close.reason || 'room closed' }
    try { p.disconnect?.() } catch { /* already gone */ }
    log?.(`${s.roomName}: ${s.closed.reason}; not reconnecting`)
  })
  p.on?.('sync', e => {
    if (!e || !s.rejected) return
    const rejected = s.rejected
    if (retry) clearTimeout(retry)
    retry = undefined
    // Re-send the local publication under its current fence. A successful sync alone
    // does not prove the server accepted the writes that triggered 4413.
    s.daemon.setPublicationRejected(false)
    void s.daemon.reconcileGitChanges().then(() => {
      if (s.rejected !== rejected) return
      verify = setTimeout(() => {
        verify = undefined
        if (s.rejected !== rejected) return
        if (p.wsconnected && p.synced && s.daemon.fence) s.rejected = undefined
        else pauseAndRetry()
      }, SIZE_CAP_VERIFY_MS)
      verify.unref?.()
    }).catch(() => { if (s.rejected === rejected) pauseAndRetry() })
  })
}

const httpOf = (server: string) => server.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
/** A session the server no longer knows is useless locally too. */
function removeStaleCredential(server: string, reason: string): void { if (/expired or unknown/.test(reason)) removeCredential(server) }

/** Why the server would refuse us, or undefined when access is fine (or the server cannot be asked).
 *  `missing`: access is fine but nobody has opened this repo yet. */
async function preflight(server: string, roomName: string, auth: Creds): Promise<{ reason: string; missing?: boolean; loginNeeded?: boolean; canonical?: string } | undefined> {
  try {
    const res = await serverFetch(`${httpOf(server)}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, schema: 2, ...auth }), timeoutMs: 20000 })
    if (res.ok) {
      const body = await res.json() as { room?: string; hub?: number }
      if (body.hub !== 1) return { reason: "this room's hub speaks protocol 1; update Room to 0.17 or later" }
      return body.room && body.room !== roomName ? { reason: '', canonical: body.room } : undefined
    }
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

/** Open this repository room on the server. Idempotent. Returns the refusal, if any. */
export async function createRoom(server: string, roomName: string, auth: Creds & { by?: string }): Promise<string | undefined> {
  try {
    const res = await serverFetch(`${httpOf(server)}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, schema: 2, ...auth }), timeoutMs: 20000 })
    if (res.ok) return undefined
    return (await res.text()).trim() || `HTTP ${res.status}`
  } catch (e) {
    return `cannot reach ${server} (${e instanceof Error ? e.message : String(e)})`
  }
}

/** Close this repository room on the server, with its overlays and connections. */
export async function closeRoom(server: string, roomName: string, auth: Creds): Promise<string[]> {
  const res = await serverFetch(`${httpOf(server)}/rooms`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, schema: 2, ...auth }), timeoutMs: 20000 })
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
async function viewToken(server: string, roomName: string, auth: Creds): Promise<string | undefined> {
  if (!auth.token && !auth.session) return undefined
  try {
    const res = await serverFetch(`${httpOf(server)}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, schema: 2, ...auth }), timeoutMs: 20000 })
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
