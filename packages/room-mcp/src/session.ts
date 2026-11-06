import { storageRegistration } from './storage-admission.js'
import { sessionHostIdentity } from './hosts/session-host.js'
import { sessionEntries } from './session-entries.js'
import { requireDaemonRuntime } from './daemon-cutover.js'
import { trackConnection } from './connection.js'
import pluginManifest from '../../../plugins/room/.claude-plugin/plugin.json' with { type: 'json' }
import { LOCAL_CLIENT_COMPAT, compatibilityFromHealth, compatibilityFloor, type ClientCompatibility } from './client-compat.js'
import { CURRENT_COMPAT, LEGACY_COMPAT, selectContract, type ContractSelection, type BootstrapSelection } from '@room/hub-core'
/**
 * A session is one joined room's publisher and participant identity. Local sessions own
 * their replica across transports and join attempts; a standalone process owns local transport.
 * Explicit `room_leave` disposes the logical session.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { normalizeExplicitRoomName } from './room-name.js'
export { normalizeExplicitRoomName } from './room-name.js'
import { startRoomd, RoomdError, clampShare, inPhase, readRoomFile, authorizedWebSocket, type WatcherHandoff, type Roomd, type RoomFile, type ShareLevel } from '@room/roomd'
import { ensureLocalDaemon, relayHealth, LocalRelayCompatibilityError, localViewKey, type LocalRelay } from '@room/relay'
import { primePrivateState, primePrivateDirectory } from '@room/local-state/private-state'
import { localRoomName } from '@room/roomd/local'
import { gitCommonDir, realGitCommonDir, worktreeGitDirSync } from '@room/roomd'
import { git, gitBranch, gitOrigin } from '@room/roomd/git'
import { RoomDoc, STALE_REPLICA_CODE, STALE_REPLICA_REASON, assertValidParticipantName, roomConnection, canonicalRepo, roomKey, type Claim, type Identity, type Kind, type Msg, type Scope } from '@room/shared'
import { GraphIndex, type GraphSeed } from './graph-index.js'
import { checkoutLead, endCheckoutLead } from './checkout-lead.js'
import { withdrawFormerPublisher } from '@room/roomd/publisher'
import { credentialsPath as defaultCredentialsPath, getCredential, removeCredential, setCredential } from './credentials.js'
import { LOCAL, resolveConfig, resolveShare, resolveServer, resolveSessionHost, resolveSessionRuntime } from './config.js'
import { createSessionBinding } from './binding.js'
import { isFresh } from './presence.js'
import { migrateLegacyLocalChoice, worktreePath } from './choice.js'
import { probeProcess, type ProcessProbe } from './worker-process.js'
import { sameStartTime } from '@room/local-state/process'
import { writeAtomic, type ProcessIdentity } from './leases.js'
import { CeilingSource, PolicyStore } from './policy-store.js'
import { admitWorkerEnvironment, workerCarried } from './worker-registry.js'
import { HubClient, HubError, hubTransport } from './hub-client.js'
import { createPost, greet, type Post } from './post.js'
import { attachPublisher, publisherLease } from './publisher-lease.js'
import { chooseName, NameRefused, ParticipantLease, processToken, type ChosenName } from './names.js'
import { joinableRoot, sameFolder } from './repository.js'
import type { HolderIn } from '@room/hub-core'
import { currentToolTiming } from './timing.js'
import { revokeLeadProjections } from './bridge.js'

const timed = <T>(name: string, work: () => Promise<T> | T): Promise<T> => currentToolTiming()?.phase(name, work) ?? Promise.resolve().then(work)

/** A server requires an argument, ROOM_SERVER/ROOM_URL, or a remembered choice. */
export { LOCAL, resolveServer }
const CLIENT_COMPAT = { ...CURRENT_COMPAT, release: pluginManifest.version }
const DEFAULT_WEB = 'http://localhost:5173'
const VIEWER_MISSING = 'not built; run npm run build -w @room/web'

/** Installed plugins and source checkouts put the trusted local viewer beside their code. */
function findLocalViewer(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const file of [resolve(here, '..', 'web', 'viewer.html'), resolve(here, '..', '..', 'web', 'dist', 'viewer.html')]) {
    if (existsSync(file)) return file
  }
  return undefined
}

export function localBrowserLink(roomUrl: string, name: string, view: string, viewerFile: string | undefined = findLocalViewer(), web?: string): string {
  if (!viewerFile && !web) return VIEWER_MISSING
  const base = web ? `${web.replace(/\/+$/, '')}/` : pathToFileURL(resolve(viewerFile!)).href
  return `${base}#room=${encodeURIComponent(roomUrl)}&view=${encodeURIComponent(view)}&participant=${encodeURIComponent(name)}&relay=1`
}

export interface Session {
  /** Latest authenticated publisher contract, absent while disconnected or in fixture providers. */
  readonly contract?: ContractSelection & { legacy: boolean }
  readonly compatibilityRefusal?: string
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
  /** Symbol graph over base + overlays; undefined in unit tests and while another session leads this checkout (checkout-lead.ts). */
  graph?: GraphIndex
  /** Set when the server closed the repo (ws close 4001): the provider stops reconnecting. */
  closed?: { reason: string }
  /** A size-cap refusal: publication stays paused until the next successful sync. */
  rejected?: { reason: string; at: number }
  /** Set when the server refused this replica (ws close 4409): the room's document was compacted at a server
   *  restart. The provider stops reconnecting; the session is replaced as a restart replaces it (compacted.ts). */
  stale?: { reason: string }
  /** The server's ceiling on sharing levels (ROOM_SHARE_MAX); the daemon's level never exceeds it. */
  shareMax: ShareLevel
  /** Set in local mode: non-owning daemon discovery and client monitoring. */
  local?: LocalRelay
  localReplica?: LocalReplica
  /** Retry a paused local transport without replacing the session or its replica. */
  recoverLocal?: () => Promise<void>
  /** Invalid input narrowed to plans only; retained for sharing controls. */
  shareWarning?: string
  /** The requested level before the server ceiling. */
  shareRequested: ShareLevel
  /** The credential store this team session authenticated from; HTTP calls after the join read the same store. */
  credentialsPath?: string
  /** The shared token this session joined with (argument, ROOM_TOKEN, or `?token=` on the server URL); workers get it as ROOM_TOKEN. Never printed. */
  token?: string
  /** Receives this session's server-wait progress lines (the join's `log`). */
  serverLog?: ServerLog
  autoTagNote?: string
  /** One-time upgrade notice for the first reply: a remembered 0.16 per-branch local room moved to the repository room. */
  upgradeNote?: string
  /** Latest preview started by this MCP session; never reconstructed from shared room history. */
  lastPreview?: { clean: boolean; complete: boolean; testsPassed?: boolean; partialPassed?: boolean; testsCommand?: string }
  policyStore: PolicyStore
  /** Verified tool activity for the checkout publisher lease. */
  publicationActivity?: () => Promise<void>
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
  hostPid?: number
  transcript_path?: string
  model?: string
  effort?: string
  worker_id?: string
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

function sessionRecords(commonDir: string): SessionRecord[] {
  const root = join(commonDir, 'room', 'sessions')
  const records: SessionRecord[] = []
  for (const entry of sessionEntries(root)) {
    if (entry.kind !== 'directory') continue
    try {
      const record = JSON.parse(readFileSync(join(entry.path, 'session.json'), 'utf8')) as SessionRecord
      if (record?.session_id && sessionDirectory(commonDir, record.session_id) === entry.path) records.push(record)
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
  /** Thread identity supplied by Codex tool-call metadata under the shared daemon. */
  codexThreadId?: string
  codexLogSessionId?: string
  appServer?: boolean
  parentArgs?: string
}

function processIdentity(pid: number, probe: ProcessProbe): ProcessIdentity | undefined {
  const info = probe(pid)
  return info?.startTime && info.executable ? { pid, startTime: info.startTime, executable: info.executable } : undefined
}

function ownSession(record: SessionRecord, parent: ProcessIdentity): boolean {
  const host = sessionHostIdentity(record)
  return !!host && sameProcess(host, parent)
}

function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && sameStartTime(a.startTime, b.startTime) && a.executable === b.executable
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

// Each daemon thread owns its MCP process; every binding in that process shares this identity.
let codexThreadId: string | undefined
export function admitCodexThread(id: string): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) return
  if (!codexThreadId) codexThreadId = id
  else if (id !== codexThreadId) {
    throw new Error('Room cannot share one MCP process across Codex chats (mcp_connection_sharing + mcp_2026_07_28); disable mcp_connection_sharing for Room, or wait for a Room release that supports pooling.')
  }
}
export function admittedCodexThread(): string | undefined { return codexThreadId }

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
    const matching = records.filter(record => record.worker_id === workerId
      && (!options.cwd || typeof record.cwd === 'string' && sameFolder(record.cwd, options.cwd)))
      .sort((a, b) => b.at - a.at)[0]
    // A Codex worker without its hook record yet is bound by the thread its first tool call names.
    const id = matching?.session_id ?? (host === 'codex' ? options.codexLogSessionId ?? options.codexThreadId ?? admittedCodexThread() : undefined)
    return id ? { id, host } : undefined
  }
  if (host === 'codex') {
    const id = options.codexThreadId ?? admittedCodexThread()
    if (id) return { id, host }
    const args = codexArguments(parent, options.parentArgs ?? parentCommandLine())
    if (options.appServer || args?.match(/^\S+/)?.[0] === 'app-server') return undefined
    if (args === undefined) return undefined
  }
  const matching = parent && records.filter(record => !record.worker_id && ownSession(record, parent)).sort((a, b) => b.at - a.at)[0]
  if (matching) return { id: matching.session_id, host }
  return host === 'claude' && env.CLAUDE_CODE_SESSION_ID ? { id: env.CLAUDE_CODE_SESSION_ID, host } : undefined
}

/** Used by the name lease while a Codex app-server request has no bound thread. */
export function syntheticSessionId(identity: ProcessIdentity): string { return `mcp:${identity.pid}:${identity.startTime}` }

/** Owned by the logical local session, across transports and host identity changes. */
export interface LocalReplica { doc: Y.Doc; disposed?: boolean; common?: string; room?: string }
export function createLocalReplica(): LocalReplica { return { doc: new Y.Doc() } }
export function disposeLocalReplica(replica: LocalReplica | undefined): void {
  if (!replica || replica.disposed) return
  replica.disposed = true
  replica.doc.destroy()
}
const detachedCheckouts = new WeakMap<Session, CheckoutReuse>()
const stoppedSessions = new WeakSet<Session>()

export interface CheckoutReuse {
  replica?: LocalReplica
  watcher?: WatcherHandoff
  graph?: GraphSeed
}

/** Detach once for retirement; retain the replica, watch handoff and immutable base facts for retries. */
export function detachCheckout(s: Session): CheckoutReuse {
  let reuse = detachedCheckouts.get(s)
  if (!reuse) {
    reuse = { watcher: s.daemon?.takeWatcher?.(), graph: s.graph?.baseSeed?.(), ...(s.localReplica ? { replica: s.localReplica } : {}) }
    detachedCheckouts.set(s, reuse)
  }
  return reuse
}

export interface JoinOptions {
  reuse?: CheckoutReuse
  localReplica?: LocalReplica
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
  /** A local worker's lead clone, bound by the worker launcher. */
  leadClone?: string
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
export async function serverAuthConfig(server: string, log?: ServerLog): Promise<AuthConfig> {
  const hit = configCache.get(server)
  if (hit) return hit
  const cfg: AuthConfig = { mode: 'token', providers: [] }
  try {
    const res = await serverFetch(`${httpOf(server)}/auth/config`, { timeoutMs: 20000 }, log)
    if (res.ok) {
      const b = await res.json() as { github?: string; providers?: string[] }
      if (b.github === 'device') cfg.mode = 'device'
      cfg.providers = (b.providers ?? (cfg.mode === 'device' ? ['github'] : [])).filter((p): p is Provider => p === 'github' || p === 'oidc')
      // Only an answer is kept: a server that was down at first contact (cold start, offline) is asked again, or
      // a GitHub room would stay "no GitHub login" until restart. A server's login setup is kept for the process.
      configCache.set(server, cfg)
    }
  } catch { /* unreachable: the join will report it */ }
  return cfg
}
/** `device`: the server has GitHub device login, so github.com rooms can be joined after room_login.
 *  `token`: it has none; only non-GitHub rooms (local/, git/) are reachable, by shared token or another login. */
export async function serverAuthMode(server: string): Promise<AuthMode> { return (await serverAuthConfig(server)).mode }

export interface Creds { token?: string; session?: string; login?: string }
/** Credentials for a server: a Room session from a login and/or the shared token. A github.com room needs the
 *  session (ROOM_TOKEN does not admit it; the server never accepts a forwarded GitHub token). Non-GitHub rooms
 *  (local/, git/) send the session when this machine holds one: servers with a login provider require it. */
export async function resolveAuth(credentialsPath: string, server: string, roomName: string, token?: string, log?: ServerLog): Promise<Creds> {
  const github = roomName.startsWith('github.com/')
  const cfg = await serverAuthConfig(server, log)
  const c = cfg.providers.length ? getCredential(credentialsPath, server) : undefined
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
export async function startLogin(server: string, provider?: Provider, log?: ServerLog): Promise<LoginProgress> {
  const res = await serverFetch(`${httpOf(server)}/auth/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(provider ? { provider } : {}), timeoutMs: 15000, retry: false }, log)
  if (res.status === 404 && !provider) { // older server: only the GitHub device flow
    const old = await fetch(`${httpOf(server)}/auth/device`, { method: 'POST', signal: AbortSignal.timeout(15000) })
    if (!old.ok) throw new RoomdError(`${server} could not start GitHub login: ${(await old.text()).trim() || `HTTP ${old.status}`}`, 2)
    return { provider: 'github', ...(await old.json() as Omit<LoginProgress, 'provider'>) }
  }
  if (!res.ok) throw new RoomdError(`${server} could not start ${provider ?? ''} login: ${(await res.text()).trim() || `HTTP ${res.status}`}`.replace('  ', ' '), 2)
  const p = await res.json() as LoginProgress
  return { ...p, provider: p.provider ?? provider ?? 'github' }
}
/** Poll until the provider confirms, the attempt fails, or maxMs passes. Saves the credential on success into
 *  credentialsPath, the store captured when the login started. */
export async function pollLogin(credentialsPath: string, server: string, p: LoginProgress, opts: { maxMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ login: string } | { pending: true } | { error: string }> {
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const deadline = Date.now() + (opts.maxMs ?? 90_000)
  for (;;) {
    const res = await fetch(`${httpOf(server)}/auth/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: p.device }), signal: AbortSignal.timeout(15000) })
    if (res.status === 429) {
      const retry = Math.max(1, Number(res.headers.get('retry-after')) || p.interval)
      if (Date.now() + retry * 1000 >= deadline) return { pending: true }
      await sleep(retry * 1000)
      continue
    }
    if (!res.ok) return { error: (await res.text()).trim() || `HTTP ${res.status}` }
    const b = await res.json() as { pending?: boolean; error?: string; session?: string; login?: string }
    if (b.session && b.login) { await primePrivateDirectory(dirname(credentialsPath)); setCredential(credentialsPath, server, { session: b.session, login: b.login, at: Date.now() }); configCache.delete(server); return { login: b.login } }
    if (b.error) return { error: b.error }
    if (Date.now() >= deadline) return { pending: true }
    await sleep(Math.max(1, p.interval) * 1000)
  }
}
/** Removes the saved login locally whatever the server says; `unconfirmed` says why the server did not confirm
 *  ending the session (unreachable, or 503 when its deletion was not stored yet), so a retry can finish it. */
export async function logout(credentialsPath: string, server: string): Promise<{ login?: string; removed: boolean; unconfirmed?: string }> {
  const c = getCredential(credentialsPath, server)
  let unconfirmed: string | undefined
  if (c) {
    try {
      const res = await fetch(`${httpOf(server)}/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: c.session }), signal: AbortSignal.timeout(20000) })
      if (!res.ok) {
        const body = await res.json().catch(() => undefined) as { error?: unknown } | undefined
        unconfirmed = `${res.status}${typeof body?.error === 'string' && body.error ? ` ${body.error}` : ''}`
      }
    } catch (e) { unconfirmed = e instanceof Error ? e.message : String(e) }
  }
  if (c) await primePrivateDirectory(dirname(credentialsPath))
  return { login: c?.login, removed: removeCredential(credentialsPath, server), ...(unconfirmed ? { unconfirmed } : {}) }
}

/** Private room metadata written by the daemon. */
export type { RoomFile } from '@room/roomd'

export function findRoomFile(start: string): (RoomFile & { room: string; _from: string }) | undefined {
  let d = resolve(start)
  const own = (dir: string) => { try { return worktreeGitDirSync(dir) } catch { return undefined } }
  const gitDir = own(d)
  if (!gitDir) return undefined
  for (;;) {
    const room = readRoomFile(d)
    if (room?.room) return { ...room, room: room.room, _from: d }
    const up = dirname(d)
    if (up === d || own(up) !== gitDir) return undefined
    d = up
  }
}

/** The validated current root always supplies the folder, even when copied room metadata names another clone. */
export async function startupJoinOptions(root: string, server: string, room?: string): Promise<JoinOptions | undefined> {
  if (server === LOCAL) return { dir: root, room, server: LOCAL }
  if (room) return { dir: root, room: normalizeExplicitRoomName(room), server }
  if ((await deriveRoomName(root).catch(() => ({ roomName: undefined }))).roomName) return { dir: root, server }
  const prior = findRoomFile(root)
  if (prior) return { dir: root, name: prior.name, room: normalizeExplicitRoomName(decodeRoom(new URL(prior.room).pathname.replace(/^\/+/, ''))), server }
  return undefined
}

/** Room name from the clone's origin; the branch is a participant fact, not part of the room key. */
export async function deriveRoomName(dir: string): Promise<{ roomName?: string; branch: string; repo?: string }> {
  const [repo, branch] = await Promise.all([gitOrigin(dir), gitBranch(dir)])
  const canonical = repo ? canonicalRepo(repo) : undefined
  return { repo: canonical, branch, roomName: canonical }
}

const branchRoomHint = (room: string): string => room.startsWith('git/')
  ? '\nRoom 0.17 has one room per repository: if this name ends in a branch, remove it.' : ''

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
export async function serverShareMax(server: string, fallback: ShareLevel = 'intent', fetcher: typeof serverFetch = serverFetch): Promise<ShareLevel> {
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

/** Progress lines for one session's server waits (cold starts). */
export type ServerLog = (line: string) => void
/** Total time a tool call may spend starting new attempts against a cold server. */
const SERVER_RETRY_MS = 45_000
/** Default bound on one attempt; callers pass their own `timeoutMs`. */
const SERVER_ATTEMPT_MS = 25_000
/** Pause between attempts. */
const SERVER_RETRY_PAUSE_MS = 3000

/**
 * HTTP to the room server with patience for a cold start: the hosted machine stops when idle and
 * takes up to a minute to answer its first request (timeouts, 502/503/504 from the proxy). Those
 * are retried while fewer than SERVER_RETRY_MS have passed since the first attempt; an attempt
 * started before that deadline still runs to its own `timeoutMs` (default SERVER_ATTEMPT_MS), so a
 * call can last up to SERVER_RETRY_MS + SERVER_RETRY_PAUSE_MS + `timeoutMs`. Then the last answer
 * or error is returned. `log` receives progress lines for the caller's session.
 */
export async function serverFetch(url: string, init: RequestInit & { timeoutMs?: number; retry?: boolean } = {}, log?: ServerLog): Promise<Response> {
  const { timeoutMs = SERVER_ATTEMPT_MS, retry = true, ...rest } = init
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
    await new Promise(r => setTimeout(r, SERVER_RETRY_PAUSE_MS))
  }
}

export function encodeRoom(roomName: string): string { return encodeURIComponent(roomName) }
export function decodeRoom(encoded: string): string { try { return decodeURIComponent(encoded) } catch { return encoded } }

/** What a join resolved: the daemon under a leased name, its store, and the lease and hub that keep the name. */
export interface NamedRoomd { daemon: Roomd; me: Identity; policyStore: PolicyStore; lease: ParticipantLease; hub: HubClient; post: Post; autoTagNote?: string; publicationActivity: () => Promise<void>; refreshRuntime: () => void; onHookActivity: (listener: () => void) => void; onRebind: (listener: (sessionId: string) => void) => void; startupCapClose: () => CapClose | undefined; contract: () => (ContractSelection & { legacy: boolean }) | undefined; compatibilityRefusal: () => string | undefined }

/** Keep a live daemon in sync when a sharing grant changes or settles. */
export function applySessionPolicy(daemon: Roomd, policy: PolicyStore['policy']): void {
  revokeLeadProjections(daemon.roomDoc, daemon.name, daemon.fence, policy)
  daemon.applyInputs({ ...daemon.inputs, policy })
}

interface DiscoveredCompatibility extends ClientCompatibility { remember(): void }
const negotiatingOrigins = new Set<string>()
const contractBody = (server: string) => negotiatingOrigins.has(server) ? { compat: CLIENT_COMPAT } : {}

/** Health is a hint; the encrypted/authenticated socket selects again before any document exchange. */
async function discoverCompatibility(server: string, dir: string, localKey?: string, log?: ServerLog): Promise<DiscoveredCompatibility> {
  const url = new URL(server)
  const common = await realGitCommonDir(dir)
  const identity = localKey ? `local:${common}` : url.origin
  const floor = compatibilityFloor(common, identity, localKey ? createHash('sha256').update(localKey).digest('hex') : undefined)
  let health: unknown
  if (localKey) health = await relayHealth(Number(url.port), localKey)
  else try {
    const response = await serverFetch(`${httpOf(server)}/health`, { timeoutMs: 20000, retry: false, redirect: 'manual' }, log)
    if (!response.ok) throw new RoomdError(`Room server compatibility discovery failed (HTTP ${response.status}); check the configured origin and retry`, 2)
    // Bound discovery independently from the parser's 1 KiB compat manifest cap.
    const reader = response.body?.getReader()
    if (!reader) throw new RoomdError('Room server compatibility discovery returned no body', 2)
    const chunks: Uint8Array[] = []; let bytes = 0
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > 16 * 1024) throw new Error('Room server health response exceeds 16 KiB'); chunks.push(next.value) }
      try { health = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new RoomdError('Room server compatibility discovery returned malformed JSON; update the server', 2) }
    } finally { await reader.cancel().catch(() => {}) }
  } catch {
    // Older hubs may have no health endpoint. Their existing socket/admission path
    // remains authoritative; a learned floor below still prevents downgrading.
    health = undefined
  }
  let profile: ClientCompatibility
  try {
    profile = compatibilityFromHealth(health, floor.learned(), localKey ? LOCAL_CLIENT_COMPAT : CLIENT_COMPAT)
    if (localKey && profile.legacy) throw new Error('local room requires the standalone daemon runtime; drain old Room sessions and restart updated clients')
  } catch (error) { throw new RoomdError(error instanceof Error ? error.message : String(error), 2) }
  if (!profile.legacy) { await primePrivateState(common); negotiatingOrigins.add(server) }
  else negotiatingOrigins.delete(server)
  return { ...profile, remember: () => { if (!profile.legacy) floor.remember() } }
}

/**
 * Resolve identity before roomd can publish anything under it (registry §15): a probe connection syncs the
 * room and reaches its hub; the name is the first candidate whose O_EXCL lease in this clone and whose hub
 * lease this session gets. The hub client then moves to the daemon's connection and keeps renewing.
 */
export async function startAutoTaggedRoomd(options: Omit<Parameters<typeof startRoomd>[0], 'policy'> & { requested: ShareLevel; requestedExplicit?: boolean; ceiling?: ShareLevel; takeover?: boolean; compatibility?: DiscoveredCompatibility }, explicitTag?: string): Promise<NamedRoomd> {
  assertValidParticipantName(options.name)
  if (options.owner) assertValidParticipantName(options.owner)
  if (options.label) assertValidParticipantName(options.label)
  if (explicitTag) assertValidParticipantName(explicitTag)
  // The bare name the candidates build on; a caller passing only a tagged name gets it back for that tag.
  const owner = options.owner ?? (explicitTag && options.name.endsWith(`+${explicitTag}`) ? options.name.slice(0, -explicitTag.length - 1) : options.name)
  const binding = createSessionBinding(options.dir)
  const sessionId = options.sessionId ?? binding.id()
  const url = new URL(options.room)
  const encodedRoom = url.pathname.split('/').pop()!
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/'))
  const server = url.toString().replace(/\/$/, '')
  const compatibility = options.providerFactory ? undefined : options.compatibility ?? await discoverCompatibility(server, options.dir, options.localKey, options.log)
  let selected: (ContractSelection & { legacy: boolean }) | undefined
  let compatibilityRefusal: string | undefined
  let currentProvider: WebsocketProvider | undefined
  const negotiation = compatibility && !compatibility.legacy ? {
    offer: options.localKey ? { ...LOCAL_CLIENT_COMPAT, release: pluginManifest.version } : CLIENT_COMPAT, sessionId,
    onSelection: (_reply: BootstrapSelection) => { compatibility.remember(); compatibilityRefusal = undefined },
    onRefusal: (text: string) => { compatibilityRefusal = text; if (currentProvider) currentProvider.shouldConnect = false },
  } : undefined
  if (compatibility?.legacy) {
    const baseline = selectContract(CURRENT_COMPAT, LEGACY_COMPAT, { activeSchema: 2 })
    if (baseline.ok) selected = { ...baseline.selection, legacy: true }
  }
  const doc = options.replica ?? new Y.Doc()
  const probe = await timed('connect', () => options.providerFactory
    ? options.providerFactory(server, encodedRoom, doc)
    : new WebsocketProvider(server, encodedRoom, doc, {
        WebSocketPolyfill: authorizedWebSocket({ token: options.token ?? process.env.ROOM_TOKEN, key: options.localKey, session: options.session, negotiation }) as any,
        ...roomConnection(doc),
      }))
  currentProvider = probe
  const closeProbe = () => { probe.destroy(); probe.awareness.destroy(); if (!options.replica) doc.destroy() }
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
    if (compatibilityRefusal) throw new RoomdError(compatibilityRefusal, 2)
    if (!probe.synced) await timed('sync', () => inPhase('sync', () => new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); probe.off('sync', onSync); probe.off('connection-close', onClose) }
      const onClose = () => { if (compatibilityRefusal) { cleanup(); reject(new RoomdError(compatibilityRefusal, 2)) } }
      const onSync = (synced: boolean) => { if (synced) { cleanup(); resolve() } }
      const timer = setTimeout(() => {
        cleanup()
        reject(new RoomdError(`could not sync with ${options.room} within ${options.connectTimeoutMs ?? 15000}ms`, 1))
      }, options.connectTimeoutMs ?? 15000)
      probe.on('sync', onSync)
      probe.on('connection-close', onClose)
    })))
    // An unreachable or older hub leaves the session paused under its local lease (hub §7, §10).
    const reachable = await hub.hello().then(() => true, error => { if (error instanceof HubError && error.reason === 'version') throw new RoomdError(error.message, 2); return false })
    const epoch = Number(process.env.ROOM_NAME_EPOCH)
    const commonDir = await gitCommonDir(options.dir)
    chosen = await timed('name', () => inPhase('name', () => chooseName({
      dir: options.dir, commonDir, roomKey: key, owner, explicitTag, host: resolveSessionHost(),
      doc: new RoomDoc(doc), hub: reachable ? hub : undefined, token, holder, workerId, takeover: options.takeover,
      ...(workerId && Number.isSafeInteger(epoch) ? { supersedes: epoch } : {}), log: options.log ?? console.error,
    })))
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
      // Shutdown ends presence before stopping the daemon. Keep its last publication
      // readable offline; losing authority to another session must still withdraw it.
      const ended = lease.state === 'ended'
      publicationTransition = publicationTransition.then(async () => {
        if (stopping) return
        if (!fence) {
          if (!ended) {
            if (daemon && lease.epoch !== undefined) withdrawFormerPublisher(daemon.roomDoc, name, String(lease.epoch), 'another session')
            policyStore.setPublisher(false)
          }
          const attachment = publishing
          publishing = undefined
          await attachment?.detach()
        } else if (!publishing) publishing = await attachPublication!()
      }).catch((error: unknown) => { options.log?.(`warn: publisher handoff: ${error instanceof Error ? error.message : String(error)}`) })
    },
  })
  let daemon: Roomd | undefined
  const { requested: _requested, requestedExplicit: _requestedExplicit, ceiling: _ceiling, compatibility: _compatibility, ...daemonOptions } = options
  // The daemon's automatic posts go through this connection's hub, under the name lease (hub §2.3).
  let post: Post | undefined
  let started: Roomd
  let startupCapClose: () => CapClose | undefined = () => undefined
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
    started = daemon = await timed('daemon start', async () => startRoomd({ ...daemonOptions, negotiation: negotiation ? { ...negotiation, onSelection: reply => { negotiation.onSelection(reply); selected = { ...reply.selection, legacy: false } } } : undefined, name, label, sessionId, lease: () => lease.fence(), policy: policyStore.policy, carried: (await workerCarried(options.dir)),
      // Startup publishes on the daemon's own provider (not the probe) before watchClosed exists.
      onProvider: provider => { currentProvider = provider; startupCapClose = captureCapClose(provider) },
      post: (from, body, opts) => {
        if (post) return post(from, body, opts)
        options.log?.(`not posted before the hub connection: ${body.type}`)
        return { ok: false }
      },
      onFullScan: (policy, entries, unsettled) => policyStore.settle(policy, entries, unsettled).then(() => {}),
      host: resolveSessionHost(), ...resolveSessionRuntime(binding.dir()) }))
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
  const publicationActivity = async () => { await publishing?.activity() }
  const records = watchSessionRecords({ daemon: started, binding, sessionId, boundAtJoin, hostCurrent, lease,
    publicationActivity: () => { void publicationActivity().catch(error => options.log?.(`warn: publisher activity: ${String(error)}`)) } })
  const stop = started.stop.bind(started)
  started.stop = async (reason?: string) => { records.stop(); await stop(reason) }
  return { daemon: started, me: { name, kind: options.kind ?? 'agent', owner, ...(label ? { label } : {}) }, policyStore, lease, hub, post, autoTagNote, publicationActivity, refreshRuntime: records.refresh, onHookActivity: records.onHookActivity, onRebind: records.onRebind, startupCapClose: () => startupCapClose(), contract: () => started.provider.wsconnected ? selected : undefined, compatibilityRefusal: () => compatibilityRefusal }
}

/** What watchSessionRecords installs; `stop` ends the poll before the daemon stops. */
interface SessionRecordsWatch {
  stop: () => void
  /** Republish the bound session's runtime facts now. */
  refresh: () => void
  onHookActivity: (listener: () => void) => void
  /** The listener hears a new host binding; registering it also checks at once. */
  onRebind: (listener: (sessionId: string) => void) => void
}

/** Poll the bound host session's records into the daemon's presence; a rebinding withdraws publisher authority. */
function watchSessionRecords({ daemon, binding, sessionId, boundAtJoin, hostCurrent, lease, publicationActivity }: {
  daemon: Roomd; binding: ReturnType<typeof createSessionBinding>; sessionId: string; boundAtJoin: string | undefined
  hostCurrent: () => boolean; lease: ParticipantLease; publicationActivity: () => void
}): SessionRecordsWatch {
  // The bound session's records (ledger SF3): SessionStart's session.json, the before-edit hook's runtime.json
  // and hook-activity.json. Polled, since a new binding (Claude /clear) moves them to another directory.
  const publishRuntime = () => {
    if (!hostCurrent()) return
    const current = daemon.provider.awareness.getLocalState()
    const runtime = resolveSessionRuntime(binding.dir())
    if (current) daemon.provider.awareness.setLocalState({ ...current, host: resolveSessionHost(), ...runtime })
  }
  let published = ''
  let lastActivity = Date.now() // do not replay activity left by an earlier session
  let hookActivity: (() => void) | undefined
  let rebindListener: ((sessionId: string) => void) | undefined
  let announcedRebind: string | undefined
  const watchRecords = () => {
    const currentBound = binding.bound()?.id
    if ((boundAtJoin || currentBound) && currentBound !== sessionId) {
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
      daemon.touch()
      publicationActivity()
      hookActivity?.()
    } catch { /* absent or partially written hook state; retry on the next poll */ }
  }
  const watcher = setInterval(watchRecords, 500)
  watcher.unref?.()
  publishRuntime()
  return {
    stop: () => clearInterval(watcher),
    refresh: publishRuntime,
    onHookActivity: listener => { hookActivity = listener },
    onRebind: listener => { rebindListener = listener; watchRecords() },
  }
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
  const dir = await joinableRoot(resolve(opts.dir))
  const config = await resolveConfig({ dir, env: process.env, args: opts })
  const localWorkerLead = config.workerId && config.server === LOCAL ? process.env.ROOM_LEAD_CLONE : undefined
  if (localWorkerLead && await realGitCommonDir(dir) !== localWorkerLead) throw new RoomdError(`this worker is in ${dir}, another repository than its lead's (${localWorkerLead}); it cannot join the lead's local room. Start a lead in ${dir} instead.`, 2)
  if (process.env.ROOM_WORKER_ID) await admitWorkerEnvironment(dir, process.env, createSessionBinding(dir).bound())
  for (const value of [config.name, config.owner, config.tag]) if (value) assertValidParticipantName(value)
  const chosen = config.server
  if (chosen === LOCAL) {
    const dispatched = !!config.workerId
    const leadClone = dispatched ? process.env.ROOM_LEAD_CLONE || undefined : opts.leadClone
    const session = await joinLocal(dir, { ...opts, name: config.owner ?? config.name, tag: config.tag, kind: config.kind, share: config.share, shareExplicit: config.shareExplicit, web: config.web, leadClone })
    session.shareWarning = config.shareWarning
    if (config.legacyLocalRoom && session.roomName === config.legacyLocalRoom.to) {
      const note = await migrateLegacyLocalChoice(dir).catch(error => { opts.log?.(`could not update the remembered room choice: ${error instanceof Error ? error.message : String(error)}`); return undefined })
      if (note) { opts.log?.(note); session.upgradeNote = note }
    }
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
  } else {
    roomName = normalizeExplicitRoomName(roomName, opts.log)
  }
  const auth = await resolveAuth(config.credentialsPath, server, roomName, token, opts.log)
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
  const compatibility = await discoverCompatibility(server, dir, undefined, opts.log)
  let pre = await timed('preflight', () => preflight(config.credentialsPath, server, roomName!, creds))
  if (opts.create && pre?.missing) {
    if (opts.confirm !== true) throw new RoomdError('room_create opens this repo for everyone with push access; call with confirm=true only after the user has agreed', 2)
    const err = await timed('preflight', () => createRoom(server, roomName!, { ...creds, by: name }, opts.log))
    if (err) throw new RoomdError(`${server} would not open ${roomName}: ${err}${branchRoomHint(roomName)}`, 2)
    pre = await timed('preflight', () => preflight(config.credentialsPath, server, roomName!, creds))
  }
  // Preflight over HTTP: a refused websocket only shows up as a sync timeout, so ask the server first.
  if (pre?.missing) throw new NoRoom(roomName, pre.reason + (pre.status === 404 ? branchRoomHint(roomName) : ''), server)
  if (pre?.loginNeeded) throw new NotLoggedIn(server)
  if (pre && !pre.canonical) throw new RoomdError(`${server} refused ${roomName}: ${pre.reason}${pre.status === 400 ? branchRoomHint(roomName) : ''}`, 2)
  if (pre?.canonical && pre.canonical !== roomName) {
    opts.log?.('room names no longer carry a branch; joined ' + pre.canonical)
    roomName = pre.canonical
  }
  const roomUrl = `${server}/${encodeRoom(roomName)}`
  const shareRequested = requestedShare(config.share)
  const fetchServer: typeof serverFetch = (url, init) => serverFetch(url, init, opts.log)
  const shareMax = await timed('preflight', () => serverShareMax(server, shareRequested, fetchServer))
  const share = clampShare(shareRequested, shareMax)
  if (share !== shareRequested) opts.log?.(`sharing ${share}, not ${shareRequested}: the server caps sharing at ${shareMax} (ROOM_SHARE_MAX)`)
  const { daemon, me, policyStore, lease, hub, post, autoTagNote, publicationActivity, refreshRuntime, onHookActivity, onRebind, startupCapClose, contract, compatibilityRefusal } = await startAutoTaggedRoomd({ compatibility, room: roomUrl, dir, name, kind, owner, label, token, session: creds.session, watcher: opts.reuse?.watcher, requested: shareRequested, requestedExplicit: config.shareExplicit, ceiling: shareMax, sessionId: opts.sessionId, connectTimeoutMs: opts.connectTimeoutMs, takeover: opts.takeover, log: opts.log }, config.tag)
  const view = await timed('view token', () => viewToken(server, roomName, creds, opts.log))
  const browserUrl = `${web}/#room=${encodeURIComponent(roomUrl)}&participant=${encodeURIComponent(me.name)}${view ? `&view=${encodeURIComponent(view)}` : ''}`
  const session: Session = {
    room: daemon.roomDoc,
    provider: daemon.provider,
    awareness: daemon.provider.awareness,
    daemon,
    policyStore,
    lease,
    me, autoTagNote, publicationActivity, refreshRuntime, onHookActivity, onRebind,
    dir,
    roomUrl,
    roomName,
    browserUrl,
    shareMax,
    shareRequested: policyStore.requested,
    shareWarning: config.shareWarning,
    credentialsPath: config.credentialsPath,
    serverLog: opts.log,
    ...(token ? { token } : {}),
    hub, post,
    get contract() { return contract() },
    get compatibilityRefusal() { return compatibilityRefusal() },
  }
  indexWhileLeading(session, opts.reuse?.graph, opts.log)
  const untrackShare = ceilingFor(server, shareMax).subscribe(policyStore)
  trackConnection(session)
  const stop = session.daemon.stop.bind(session.daemon)
  session.daemon.stop = async () => { try { await stop() } finally { untrackShare() } }
  let refreshing = false
  session.provider.on('sync', (synced: boolean) => {
    if (!synced || refreshing) return
    refreshing = true
    void serverShareMax(server, session.shareMax, fetchServer)
      .catch(error => opts.log?.(`warn: could not refresh sharing ceiling: ${String(error)}`))
      .finally(() => { refreshing = false })
  })
  watchClosed(session, opts.log, startupCapClose())
  return session
}

/** Normalize an explicit local room while preserving worker/bridge destinations. */
export function normalizeLocalRoomName(room: string): string {
  if (room.startsWith('local/')) return room
  const name = room.trim().replace(/[^A-Za-z0-9_./-]/g, '')
  if (!name) throw new RoomdError('local room name must not be empty', 2)
  return `local/${name}`
}

/** Resolve this release's current identity without relying on arbitration's publication poll. */
export async function currentDaemonClient(dir: string): Promise<{ currentSessionId?: string; currentWorkerId?: string }> {
  const bound = createSessionBinding(dir).bound()
  // Re-resolve binding and verify the worker on every ensure/rediscovery. Arbitration may not
  // have published at this binding yet, and an unbound worker has no endpoint file at all.
  const currentWorkerId = process.env.ROOM_WORKER_ID
  if (currentWorkerId) await admitWorkerEnvironment(dir, process.env, bound)
  return { currentSessionId: bound?.id, currentWorkerId }
}

/** Resolve only installed code; never execute repository startup scripts or use its cwd. */
async function ensureDaemon(common: string, room: string, dir: string, log?: ServerLog): Promise<LocalRelay> {
  await storageRegistration(common)
  await requireDaemonRuntime(common, await currentDaemonClient(dir)).catch((error: unknown) => {
    throw new RoomdError(error instanceof Error ? error.message : String(error), 2)
  })
  const here = dirname(fileURLToPath(import.meta.url))
  const bundled = join(here, 'room-daemon.mjs')
  const launch = existsSync(bundled) ? { entryPath: bundled } : {
    entryPath: resolve(here, '../../relay/src/daemon-bin.ts'), execArgv: ['--import', import.meta.resolve('tsx')],
  }
  return inPhase('daemon', () => ensureLocalDaemon(common, room, { ...launch, log }).catch((error: unknown) => {
    throw error instanceof LocalRelayCompatibilityError ? new RoomdError(error.message, 2) : error
  }))
}

/**
 * Recover transport, never the logical session. y-websocket keeps its document, awareness and all
 * hub listeners when serverUrl changes. Authentication and contract negotiation run on each socket.
 * Late ensure results own only their monitoring handle; stopping them cannot stop the daemon.
 */
export function watchLocalDaemon(s: Session, ensure: () => Promise<LocalRelay>, options: { retryMs?: number; maxAttempts?: number; log?: ServerLog; web?: string } = {}): () => void {
  const provider = s.provider
  let stopped = false
  let inflight = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastError: string | undefined
  let attempts = 0
  const schedule = () => {
    if (stopped || timer || s.closed || s.rejected || s.stale || attempts >= (options.maxAttempts ?? 5)) return
    timer = setTimeout(() => { timer = undefined; void recover() }, options.retryMs ?? 2000)
    timer.unref?.()
  }
  const recover = async () => {
    if (stopped || inflight || s.closed || s.rejected || s.stale) return
    inflight = true
    attempts++
    try {
      const next = await ensure()
      if (stopped) { await next.stop(); return }
      // A changed clone key is a maintenance operation, never automatic recovery.
      if (next.key !== s.local?.key) { await next.stop(); throw new Error('local daemon key changed; retain this replica and restart only after the clone maintenance is resolved') }
      if (provider.wsconnected && provider.serverUrl === next.url) {
        await s.local?.stop()
        s.local = next
        lastError = undefined
        return
      }
      provider.disconnect()
      if (stopped) { await next.stop(); return }
      await s.local?.stop()
      s.local = next
      provider.serverUrl = next.url
      s.roomUrl = `${next.url}/${encodeRoom(s.roomName)}`
      s.browserUrl = localBrowserLink(s.roomUrl, s.me.name, localViewKey(next.key, s.roomName), findLocalViewer(), options.web)
      provider.connect()
      lastError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!stopped && message !== lastError) options.log?.(`local daemon recovery: ${message}; keeping this session's replica`)
      lastError = message
    } finally {
      inflight = false
      if (!stopped && !provider.wsconnected) {
        if (attempts >= (options.maxAttempts ?? 5)) {
          provider.disconnect()
          options.log?.('local daemon recovery paused; replica retained; next Room tool call or room_join retries')
        } else schedule()
      }
    }
  }
  const onClose = () => { if (provider.synced) attempts = 0; schedule() }
  const onSync = (synced: boolean) => { if (synced) attempts = 0 }
  provider.on('connection-close', onClose)
  provider.on('sync', onSync)
  if (!provider.wsconnected) schedule()
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); provider.off('connection-close', onClose); provider.off('sync', onSync) }
  s.recoverLocal = async () => { if (stopped) return; attempts = 0; await recover() }
  return stop
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
  if (opts.leadClone && await realGitCommonDir(dir) !== opts.leadClone) throw new RoomdError(`this worker is in ${dir}, another repository than its lead's (${opts.leadClone}); it cannot join the lead's local room. Start a lead in ${dir} instead.`, 2)
  const replica = opts.localReplica ?? opts.reuse?.replica ?? createLocalReplica()
  if (replica.disposed) throw new RoomdError('local join was cancelled by an explicit leave', 2)
  if (replica.common && (replica.common !== common || replica.room !== roomName)) {
    throw new RoomdError('the retained local replica belongs to a different clone or room; explicitly leave it before joining that destination', 2)
  }
  replica.common = common; replica.room = roomName
  const local = await ensureDaemon(common, roomName, dir, opts.log)
  const roomUrl = `${local.url}/${encodeRoom(roomName)}`
  const share = requestedShare(opts.share)
  let daemon: Roomd, me: Identity, policyStore: PolicyStore, lease: ParticipantLease, hub: HubClient, post: Post, autoTagNote: string | undefined, publicationActivity: () => Promise<void>, refreshRuntime: () => void, onHookActivity: (listener: () => void) => void, onRebind: (listener: (sessionId: string) => void) => void, startupCapClose: () => CapClose | undefined, contract: NamedRoomd['contract'], compatibilityRefusal: NamedRoomd['compatibilityRefusal']
  try {
    ;({ daemon, me, policyStore, lease, hub, post, autoTagNote, publicationActivity, refreshRuntime, onHookActivity, onRebind, startupCapClose, contract, compatibilityRefusal } = await startAutoTaggedRoomd({ room: roomUrl, dir, name, kind, owner, label, replica: replica.doc, watcher: opts.reuse?.watcher, requested: share, requestedExplicit: opts.shareExplicit, localKey: local.key, sessionId: opts.sessionId, connectTimeoutMs: opts.connectTimeoutMs, takeover: opts.takeover, log: opts.log }, opts.tag))
  } catch (e) { await local.stop(); throw e }
  if (replica.disposed) { await daemon.stop(); await local.stop(); throw new RoomdError('local join was cancelled by an explicit leave', 2) }
  // This room-scoped view capability cannot authorize a write or reveal the clone key.
  const browserUrl = localBrowserLink(roomUrl, me.name, localViewKey(local.key, roomName), findLocalViewer(), opts.web)
  const session: Session = {
    room: daemon.roomDoc,
    provider: daemon.provider,
    awareness: daemon.provider.awareness,
    daemon,
    policyStore,
    lease,
    me, autoTagNote, publicationActivity, refreshRuntime, onHookActivity, onRebind,
    dir,
    roomUrl,
    roomName,
    browserUrl,
    shareMax: 'full',
    shareRequested: policyStore.requested,
    local, localReplica: replica,
    hub, post,
    get contract() { return contract() },
    get compatibilityRefusal() { return compatibilityRefusal() },
  }
  const stopRecovery = watchLocalDaemon(session, () => ensureDaemon(common, roomName, dir, opts.log), { log: opts.log, web: opts.web })
  const stop = daemon.stop.bind(daemon)
  daemon.stop = async reason => { stopRecovery(); await stop(reason) }
  indexWhileLeading(session, opts.reuse?.graph, opts.log)
  trackConnection(session)
  // The relay closes a writer into a room over its size cap with 4413, as the server does.
  watchClosed(session, opts.log, startupCapClose())
  return session
}

/** Server close code when a repo is closed (DELETE /rooms): stop reconnecting and remember why. */
const ROOM_CLOSED_CODE = 4001
const ROOM_SIZE_CAP_CODE = 4413
const SIZE_CAP_RETRY_MS = 60_000
const SIZE_CAP_VERIFY_MS = 2_000
type CapClose = { code: number; reason?: string }
/**
 * Remembers a size-cap close from the moment the provider exists: startup connects and publishes
 * before the session (and watchClosed) does, and y-websocket never reconnects after a 44xx itself.
 * The returned function stops listening and hands over what was seen.
 */
export function captureCapClose(provider: unknown): () => CapClose | undefined {
  const p = provider as { on?: (ev: string, fn: (e: unknown) => void) => void; off?: (ev: string, fn: (e: unknown) => void) => void }
  let seen: CapClose | undefined
  const onClose = (e: unknown) => {
    const close = e && typeof e === 'object' ? e as { code?: number; reason?: string } : undefined
    if (close?.code === ROOM_SIZE_CAP_CODE || close?.code === STALE_REPLICA_CODE || close?.code === 4406) seen = { code: close.code, reason: close.reason }
  }
  p.on?.('connection-close', onClose)
  return () => { p.off?.('connection-close', onClose); const taken = seen; seen = undefined; return taken }
}
const staleListeners = new WeakMap<Session, (() => void)[]>()
/** Call `listener` once the server refuses this session's replica (4409), or now if it already has. */
export function whenStale(s: Session, listener: () => void): void {
  if (s.stale) { listener(); return }
  staleListeners.set(s, [...staleListeners.get(s) ?? [], listener])
}
export function watchClosed(s: Session, log?: (line: string) => void, startupClose?: CapClose): void {
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
  const onClose = (e: { code?: number; reason?: string } | boolean | null) => {
    const close = e && typeof e === 'object' ? e : undefined
    if (close?.code === STALE_REPLICA_CODE) {
      if (s.stale || s.closed) return
      if (retry) clearTimeout(retry)
      if (verify) clearTimeout(verify)
      if (s.local) {
        s.closed = { reason: `${close.reason || STALE_REPLICA_REASON}; local replica retained: resolve the daemon generation mismatch before explicitly leaving` }
        try { p.disconnect?.() } catch { /* already gone */ }
        log?.(`${s.roomName}: ${s.closed.reason}`)
        return
      }
      s.stale = { reason: close.reason || STALE_REPLICA_REASON }
      try { p.disconnect?.() } catch { /* already gone */ }
      log?.(`${s.roomName}: ${s.stale.reason}`)
      for (const listener of staleListeners.get(s) ?? []) listener()
      return
    }
    if (close?.code === ROOM_SIZE_CAP_CODE) {
      s.rejected = { reason: close.reason || 'room is over its size cap', at: Date.now() }
      if (verify) clearTimeout(verify)
      pauseAndRetry()
      log?.(`${s.roomName}: ${s.rejected.reason}; your last edits are not in the room; retrying in 60 seconds`)
      return
    }
    if (close?.code !== ROOM_CLOSED_CODE && close?.code !== 4401 && close?.code !== 4403 && close?.code !== 4406 && !s.compatibilityRefusal) return
    if (retry) clearTimeout(retry)
    if (verify) clearTimeout(verify)
    const server = s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))
    const reason = (s.compatibilityRefusal || close?.code === 4406) ? s.compatibilityRefusal || close?.reason || 'Room contract refused; update the affected client or server and reconnect Room (/mcp)'
      : close?.code === 4401 ? `logged out of ${server}: run room_login`
      : close?.code === 4403 ? `access to ${s.roomName} was revoked`
      : close?.reason || 'room closed'
    s.closed = { reason }
    try { p.disconnect?.() } catch { /* already gone */ }
    log?.(`${s.roomName}: ${s.closed.reason}; not reconnecting`)
  }
  p.on?.('connection-close', onClose)
  if (startupClose) onClose(startupClose)
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
async function removeStaleCredential(credentialsPath: string, server: string, reason: string): Promise<void> { if (/expired or unknown/.test(reason)) { await primePrivateDirectory(dirname(credentialsPath)); removeCredential(credentialsPath, server) } }

/** Check team admission before a move leaves its current room. A room_create may open a missing room after confirmation. */
export async function checkTeamAdmission(rawServer: string, roomName: string, opts: { dir?: string; token?: string; credentialsPath?: string; create?: boolean; confirm?: boolean; log?: ServerLog } = {}): Promise<void> {
  roomName = normalizeExplicitRoomName(roomName)
  const credentialsPath = opts.credentialsPath ?? defaultCredentialsPath()
  const parsed = parseServer(rawServer)
  const { login: _login, ...creds } = await resolveAuth(credentialsPath, parsed.server, roomName, opts.token ?? parsed.token, opts.log)
  if (opts.dir) await discoverCompatibility(parsed.server, opts.dir, undefined, opts.log)
  const pre = await preflight(credentialsPath, parsed.server, roomName, creds, opts.log)
  if (!pre || pre.canonical) return
  if (pre.missing) {
    if (!opts.create) throw new NoRoom(roomName, pre.reason + (pre.status === 404 ? branchRoomHint(roomName) : ''), parsed.server)
    if (opts.confirm !== true) throw new RoomdError('room_create opens this repo for everyone with push access; call with confirm=true only after the user has agreed', 2)
    return
  }
  if (pre.loginNeeded) throw new NotLoggedIn(parsed.server)
  throw new RoomdError(`${parsed.server} refused ${roomName}: ${pre.reason}${pre.status === 400 ? branchRoomHint(roomName) : ''}`, 2)
}

/** Why the server would refuse us, or undefined when access is fine (or the server cannot be asked).
 *  `missing`: access is fine but nobody has opened this repo yet. */
async function preflight(credentialsPath: string, server: string, roomName: string, auth: Creds, log?: ServerLog): Promise<{ reason: string; missing?: boolean; loginNeeded?: boolean; canonical?: string; status?: number } | undefined> {
  try {
    const res = await serverFetch(`${httpOf(server)}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, schema: 2, ...contractBody(server), ...auth }), timeoutMs: 20000 }, log)
    if (res.ok) {
      const body = await res.json() as { room?: string; hub?: number }
      if (body.hub !== 1) return { reason: 'this Room server has no 0.17 hub; ask its operator to deploy Room 0.17' }
      return body.room && body.room !== roomName ? { reason: '', canonical: body.room } : undefined
    }
    if (res.status === 426) {
      const body = await res.json() as { error?: { text?: string }; text?: string }
      return { reason: body.error?.text ?? body.text ?? 'Room server refused this contract; update the affected client or server', status: 426 }
    }
    if (res.status === 401) {
      const reason = (await res.text()).trim() || 'unauthorized'
      // The server points at room_login for a missing or stale session; a ROOM_TOKEN on a github.com room gets the same pointer.
      if (/room_login/.test(reason)) { await removeStaleCredential(credentialsPath, server, reason); return { reason, loginNeeded: true } }
      return { reason }
    }
    if (res.status === 403) return { reason: (await res.text()).trim() || 'forbidden' }
    if (res.status === 400) return { reason: (await res.text()).trim() || 'invalid room name (HTTP 400)', status: 400 }
    if (res.status === 404) return { reason: (await res.text()).trim() || `no room for ${roomName} yet`, missing: true, status: 404 }
    return undefined // older server or unexpected status: let the websocket try
  } catch (e) {
    return { reason: `cannot reach ${server} (${e instanceof Error ? e.message : String(e)})` }
  }
}

/** Open this repository room on the server. Idempotent. Returns the refusal, if any. */
export async function createRoom(server: string, roomName: string, auth: Creds & { by?: string }, log?: ServerLog): Promise<string | undefined> {
  try {
    const res = await serverFetch(`${httpOf(server)}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, schema: 2, ...contractBody(server), ...auth }), timeoutMs: 20000 }, log)
    if (res.ok) return undefined
    return (await res.text()).trim() || `HTTP ${res.status}`
  } catch (e) {
    return `cannot reach ${server} (${e instanceof Error ? e.message : String(e)})`
  }
}

/** Close this repository room on the server, with its overlays and connections. */
export async function closeRoom(server: string, roomName: string, auth: Creds, log?: ServerLog): Promise<string[]> {
  const res = await serverFetch(`${httpOf(server)}/rooms`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, schema: 2, ...contractBody(server), ...auth }), timeoutMs: 20000 }, log)
  if (!res.ok) throw new RoomdError(`${server} would not close ${roomName}: ${(await res.text()).trim() || `HTTP ${res.status}`}`, 2)
  const body = (await res.json().catch(() => ({}))) as { closed?: string[] }
  return body.closed ?? []
}

/** Auth the way joinSession resolves it, for HTTP calls made after the join. */
export async function authFor(s: Session): Promise<Creds & { server: string }> {
  if (s.local) throw new RoomdError('local room: no server to authenticate to', 2)
  const server = s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))
  const token = s.token
  const { login: _login, ...creds } = await resolveAuth(s.credentialsPath ?? defaultCredentialsPath(), server, s.roomName, token, s.serverLog)
  return { ...creds, server }
}

/** Ask the server for a room-scoped token (7 days) the browser can use (never the GitHub token itself). */
async function viewToken(server: string, roomName: string, auth: Creds, log?: ServerLog): Promise<string | undefined> {
  if (!auth.token && !auth.session) return undefined
  try {
    const res = await serverFetch(`${httpOf(server)}/view-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomName, schema: 2, ...contractBody(server), ...auth }), timeoutMs: 20000 }, log)
    if (!res.ok) return undefined
    return ((await res.json()) as { view?: string }).view
  } catch { return undefined }
}

/** Re-mint the browser link (view keys can expire or be lost); falls back to the stored one. */
/** The printed link line: OS file openers drop the `#` parameters, so the line names the tool that opens it properly. */
export async function browserViewLine(s: Session): Promise<string> { return `browser view: ${await refreshBrowserUrl(s)} (room_open opens it)` }

export async function refreshBrowserUrl(s: Session): Promise<string> {
  if (s.local) return s.browserUrl
  try {
    const server = s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/'))
    const u = new URL(s.browserUrl)
    const web = `${u.protocol}//${u.host}`
    const a = await authFor(s)
    const view = await timed('view token', () => viewToken(server, s.roomName, a, s.serverLog))
    if (view) s.browserUrl = `${web}/#room=${encodeURIComponent(s.roomUrl)}&view=${encodeURIComponent(view)}&participant=${encodeURIComponent(s.me.name)}`
  } catch { /* keep the stored link */ }
  return s.browserUrl
}

/** The symbol graph runs only while this session leads its checkout (checkout-lead.ts). A reused seed serves the
 *  first start only: a later start follows another session's tenure, so it rebuilds from the base. */
function indexWhileLeading(s: Session, seed: GraphSeed | undefined, log?: (line: string) => void): void {
  checkoutLead(s, { log }).attach({
    name: 'symbol graph',
    start: () => { s.graph = new GraphIndex(s.room, s.me.name, s.dir, log, seed ? { seed } : {}); seed = undefined; s.graph.start() },
    stop: () => { s.graph?.stop(); s.graph = undefined },
  })
}

/** Retiring a client never stops the standalone daemon. Only explicit user leave disposes its local replica. */
export async function leaveSession(s: Session, options: { preserveReplica?: boolean } = {}): Promise<string | undefined> {
  if (!stoppedSessions.has(s)) {
    endCheckoutLead(s)
    await s.daemon.stop()
    await s.local?.stop()
    stoppedSessions.add(s)
  }
  if (options.preserveReplica === false) {
    await detachedCheckouts.get(s)?.watcher?.dispose()
    detachedCheckouts.delete(s)
  }
  if (s.local && options.preserveReplica === false) {
    if (s.localReplica) disposeLocalReplica(s.localReplica)
    else if (!s.room.doc.isDestroyed) s.room.doc.destroy()
  }
  return undefined
}
