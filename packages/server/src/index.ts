#!/usr/bin/env tsx
/**
 * Room server: a stock y-websocket server plus access control and persistence.
 *  - Rooms named github.com/<owner>/<repo> admit callers whose GitHub account has push
 *    access to the repo (checked against the GitHub API, cached 10 min). Read access is not
 *    enough: a public repo must not be an open room.
 *  - GITHUB_CLIENT_ID: clients log in with GitHub's device flow (POST /auth/start, /auth/poll) and the
 *    server keeps the GitHub token; clients hold only an opaque session sent in Authorization. That session is the only
 *    way into a github.com room: forwarded GitHub tokens (?gh=) are refused with 401 in every mode,
 *    and without a client id github.com rooms cannot be entered at all. GITHUB_CLIENT_ID=fake is a
 *    test issuer (refused with NODE_ENV=production): /auth/poll confirms with the body's `fakeLogin`.
 *    Logged-in connections may only announce presence under their login.
 *  - OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_CLIENT_SECRET + PUBLIC_URL: OIDC login (authorization code +
 *    PKCE; GET /auth/callback is the redirect URI). OIDC_ALLOWED_DOMAINS limits who may log in.
 *    Any logged-in user is admitted to non-GitHub rooms (local/..., git/<host>/<owner>/<repo>);
 *    github.com rooms still need a GitHub login with push access.
 *  - ROOM_TOKEN: if set, X-Room-Token admits non-GitHub rooms (local/..., git/...) only; it never
 *    admits a github.com room.
 *  - With no login provider and no ROOM_TOKEN configured, non-GitHub rooms are open.
 *  - YPERSISTENCE: if set to a directory, rooms are stored in LevelDB there and survive restarts;
 *    the repo registry, sessions and the audit log (audit.log, JSON lines) live there too unless
 *    DATABASE_URL points at Postgres (see store.ts). GET /audit with Authorization: Bearer <admin session>
 *    for logins in ROOM_ADMINS.
 *  - A repo is opened explicitly once (POST /rooms) before anyone can connect. A websocket
 *    to a repo nobody opened is refused with 404. GET /rooms lists open repos; DELETE /rooms
 *    closes one, dropping live connections and persisted legacy archives.
 *  - Browser view keys are exchanged for one-use websocket tickets; those sockets are read-only.
 * All coordination state lives inside the Y.Doc; room name = URL path.
 * Each loaded room also runs its hub (hub.ts, @room/hub-core) on message type 7 of the same websocket:
 * name leases, message order, trim and expiry.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { setupWSConnection, getYDoc, docs, getPersistence, setPersistence } from '@y/websocket-server/utils'
import { makeReadOnly, bindIdentity, bindDocumentIdentity, capDocSize, sizeCapReason, DocSizeMeter, DocumentIdentityGuard } from './readonly.js'
import { docNameOf, roomNameOf, githubRepoOf, parseRoomName, archiveOwnerOf } from './names.js'
import * as Y from 'yjs'
import { Auth, FAKE_CLIENT_ID } from './auth.js'
import type { Provider } from './auth.js'
import { githubPushChecker, makeAdmitted, type Creds } from './admit.js'
import { CredentialSockets, PermissionRevalidator, type Credential } from './sockets.js'
import { storeFromEnv, writeAtomicFile, type AuditEntry, type OpenRepo } from './store.js'
import { ServerHubs, bindHub, incarnationFile, type PersistenceProvider } from './hub.js'
import { RepoLocks } from './repo-lock.js'
import { migrateRepo, migrationSources, closeDocumentNames, safeRoomRegistry } from './migrate.js'
import { HUB_ORIGIN } from '@room/hub-core'
import { bodyReader, HttpFailure, isAdminIdentity, RateLimit, safeUrl, staticFile } from './http.js'

const PORT = Number(process.env.PORT ?? 1234)
const HOST = process.env.HOST ?? '0.0.0.0'
const TOKEN = process.env.ROOM_TOKEN?.trim() || undefined
/** Ceiling on what clients may share: intent | declared | full (ROOM_SHARE_MAX). */
const SHARE_MAX = (['intent', 'declared', 'full'] as const).find(l => l === process.env.ROOM_SHARE_MAX?.trim()) ?? 'full'
/**
 * Member document checks are observe-only by default so a rejected Yjs packet cannot break that
 * client's causal stream. ROOM_IDENTITY_GUARD=enforce is experimental: it drops objected packets
 * and can desynchronise the client. No shipped configuration enables it.
 */
const IDENTITY_GUARD_MODE = process.env.ROOM_IDENTITY_GUARD?.trim() === 'enforce' ? 'enforce' : 'observe'
/** Directory with the built browser view (packages/web/dist). Served at / when present. */
const STATIC = process.env.ROOM_STATIC ?? path.resolve(process.cwd(), 'public')
/** Logins allowed to read the audit log (ROOM_ADMINS, comma list). */
const ADMINS = new Set((process.env.ROOM_ADMINS ?? '').split(',').map(s => s.trim()).filter(Boolean))
/** GitHub admins use their login; OIDC admins use the issuer/subject identity only. */
const isAdmin = (st: { login: string; id?: string; provider?: Provider }) => isAdminIdentity(st, ADMINS)
const list = (v: string | undefined) => v?.split(',').map(s => s.trim()).filter(Boolean) ?? []
const oidcIssuer = process.env.OIDC_ISSUER?.trim()
if (oidcIssuer && !(process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET && process.env.PUBLIC_URL)) { console.error('OIDC_ISSUER is set but OIDC_CLIENT_ID, OIDC_CLIENT_SECRET or PUBLIC_URL is missing'); process.exit(1) }
const store = storeFromEnv()
const clientId = process.env.GITHUB_CLIENT_ID?.trim() || undefined
if (clientId === FAKE_CLIENT_ID && process.env.NODE_ENV === 'production') { console.error(`GITHUB_CLIENT_ID=${FAKE_CLIENT_ID} is the test issuer; it cannot run with NODE_ENV=production`); process.exit(1) }
const ticketTtlSetting = Number(process.env.ROOM_WS_TICKET_TTL_MS ?? 60_000)
const credentialSockets = new CredentialSockets(Date.now, 10000, Number.isFinite(ticketTtlSetting) ? Math.max(1, Math.min(60_000, ticketTtlSetting)) : 60_000)
const auth = new Auth({
  clientId,
  oidc: oidcIssuer ? { issuer: oidcIssuer, clientId: process.env.OIDC_CLIENT_ID!.trim(), clientSecret: process.env.OIDC_CLIENT_SECRET!.trim(), allowedDomains: list(process.env.OIDC_ALLOWED_DOMAINS), publicUrl: process.env.PUBLIC_URL!.trim() } : undefined,
  store,
  log: l => console.log(l),
  onSessionRemoved: (session, reason) => { credentialSockets.close({ kind: 'session', value: session }, 4401, reason); revalidator.forget(session) },
})
setInterval(() => { auth.sweepSessions(); void auth.reconcileSessions().catch(e => console.log(`session store check failed: ${e instanceof Error ? e.message : e}`)) }, 60_000).unref()
/** Append-only audit trail: who logged in, which rooms were opened/closed, every websocket accepted or refused. */
function audit(e: Omit<AuditEntry, 'at'>): void {
  store.audit({ at: Date.now(), ...e }).catch(err => console.log(`audit: could not write: ${err instanceof Error ? err.message : err}`))
}
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' }

// ---- github proxy (pull requests): the routes are in the "github" section of the request handler ----
import { GitHubProxy } from './github.js'
const github = new GitHubProxy({ log: l => console.log(l) })

/** Room-scoped tokens for the browser view (minted for verified clients). Persisted next to the
 *  room data so a redeploy does not invalidate links people already opened. */
const viewTokens = new Map<string, { room: string; exp: number }>()
const VIEW_TTL = 7 * 24 * 60 * 60 * 1000
const VIEW_FILE = process.env.YPERSISTENCE ? path.join(process.env.YPERSISTENCE, 'view-tokens.json') : undefined
try { if (VIEW_FILE && fs.existsSync(VIEW_FILE)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(VIEW_FILE, 'utf8')) as Record<string, { room: string; exp: number }>)) if (v.exp > Date.now()) viewTokens.set(k, v) } catch { /* start empty */ }
let viewSaveRetry: ReturnType<typeof setTimeout> | undefined
function saveViewTokens() {
  if (!VIEW_FILE) return
  try {
    fs.mkdirSync(path.dirname(VIEW_FILE), { recursive: true })
    writeAtomicFile(VIEW_FILE, JSON.stringify(Object.fromEntries(viewTokens)))
    if (viewSaveRetry) clearTimeout(viewSaveRetry)
    viewSaveRetry = undefined
  } catch (error) {
    console.log(`could not save view tokens: ${error instanceof Error ? error.message : error}`)
    if (!viewSaveRetry) { viewSaveRetry = setTimeout(() => { viewSaveRetry = undefined; saveViewTokens() }, 1000); viewSaveRetry.unref?.() }
  }
}

/** Repos someone has opened, keyed by their canonical origin-derived names. */
const rooms = new Map<string, OpenRepo>()
/** Process budgets: 100 rooms x 40 agents is enough for a large team on one server. Every session, worker and
 *  browser view is its own connection, and one login's lead plus its workers share that login's budget. */
const MAX_ROOMS = Number(process.env.ROOM_MAX_ROOMS ?? 100)
const MAX_CONNECTIONS = Number(process.env.ROOM_MAX_CONNECTIONS ?? 4000)
const MAX_CONNECTIONS_PER_ROOM = Number(process.env.ROOM_MAX_CONNECTIONS_PER_ROOM ?? 200)
const MAX_CONNECTIONS_PER_PRINCIPAL = Number(process.env.ROOM_MAX_CONNECTIONS_PER_PRINCIPAL ?? 100)
const connectionCounts = { total: 0, room: new Map<string, number>(), principal: new Map<string, number>() }
const locks = new RepoLocks()
const canonical = (name: string, schema2 = false) => {
  const parsed = parseRoomName(name, schema2)
  if (!parsed) return roomNameOf(name)
  if (parsed.github || schema2 || rooms.has(parsed.name)) return parsed.repo
  return [...rooms].find(([, entry]) => entry.branches.includes(parsed.name) || entry.legacy?.includes(parsed.name))?.[0] ?? parsed.name
}
const oldBranchRepo = (name: string) => name.split('/').slice(0, name.split('/')[0]?.toLowerCase() === 'github.com' ? 3 : name.startsWith('git/') ? 4 : 2).join('/')
async function loadRoomsWithRetry(): Promise<Record<string, OpenRepo>> {
  let delay = 1000
  for (;;) {
    try { return await store.loadRooms() }
    catch (error) {
      console.log(`could not load the room registry; retrying: ${error instanceof Error ? error.message : error}`)
      await new Promise(resolve => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 10_000)
    }
  }
}
const roomsLoaded = auth.ready.then(loadRoomsWithRetry).then(all => {
  for (const [key, value] of Object.entries(safeRoomRegistry(all))) {
    const name = parseRoomName(key, true)!.repo
    const previous = rooms.get(name)
    if (!previous) {
      rooms.set(name, { ...value, branches: [...new Set(value.branches ?? [])],
        legacy: [...new Set([...(value.legacy ?? []), ...(key === name ? [] : [key])])] })
      continue
    }
    const earliest = previous.at <= value.at ? previous : value
    const progress = previous.plan || previous.migratedAt ? previous : value.plan || value.migratedAt ? value : earliest
    rooms.set(name, { ...progress, by: earliest.by, at: Math.min(previous.at, value.at),
      lastSeen: Math.max(previous.lastSeen ?? 0, value.lastSeen ?? 0) || undefined,
      branches: [...new Set([...previous.branches, ...value.branches])],
      legacy: [...new Set([...(previous.legacy ?? []), ...(value.legacy ?? []), ...(key === name ? [] : [key])])] })
  }
  if (Object.keys(all).some(key => !rooms.has(key))) return saveRooms()
}).catch(e => console.log(`could not load the room registry: ${e instanceof Error ? e.message : e}`))
let roomSaveQueue: Promise<void> = Promise.resolve()
let roomSaveRetry: ReturnType<typeof setTimeout> | undefined
function saveRooms(): Promise<void> {
  const snapshot = Object.fromEntries(rooms)
  const saving = roomSaveQueue.then(() => store.saveRooms(snapshot))
  roomSaveQueue = saving.catch(error => {
    console.log(`could not save room registry: ${error instanceof Error ? error.message : error}`)
    if (!roomSaveRetry) { roomSaveRetry = setTimeout(() => { roomSaveRetry = undefined; void saveRooms().catch(() => {}) }, 1000); roomSaveRetry.unref?.() }
  })
  return saving
}
const NOT_OPEN = (room: string) => `no room for ${canonical(room)} yet: open one with room_create (or POST /rooms)`
const upgradeText = (repo: string) => `update Room to 0.17 or later: this repository now has one room for all branches (${repo})`
const oldLinkText = 'this link was for a branch room that no longer exists; ask a teammate for a new link'

/** Is this caller allowed into `room`? Same rule for opening, listing, closing, viewing and connecting;
 *  the verdict carries the verified login when the caller is logged in. See admit.ts. */
const pushChecker = githubPushChecker()
const admitted = makeAdmitted({ auth, token: TOKEN, canPush: pushChecker })
const memoryDocs = new Map<string, Uint8Array>()
const memoryProvider: PersistenceProvider & { getAllDocNames(): Promise<string[]> } = {
  getAllDocNames: async () => [...memoryDocs.keys()],
  getYDoc: async name => {
    const doc = new Y.Doc()
    const update = memoryDocs.get(name)
    if (update) Y.applyUpdate(doc, update)
    return doc
  },
  storeUpdate: async (name, update) => {
    const before = memoryDocs.get(name)
    memoryDocs.set(name, before ? Y.mergeUpdates([before, update]) : update)
  },
  clearDocument: async name => { memoryDocs.delete(name) },
}
const provider = () => (getPersistence() as { provider?: PersistenceProvider & { getAllDocNames?(): Promise<string[]> } } | null)?.provider
const listDocs = async () => [...new Set([...(await provider()?.getAllDocNames?.() ?? []), ...docs.keys()])]
const loadDoc = async (name: string): Promise<Y.Doc> => {
  const live = docs.get(name)
  if (live) return live
  return provider()!.getYDoc(name)
}
const writeDoc = async (name: string, update: Uint8Array): Promise<void> => {
  await provider()!.storeUpdate(name, update)
}
const clearDoc = async (name: string): Promise<void> => {
  await provider()?.clearDocument?.(name)
}
function stopDoc(name: string, reason = 'room closed') {
  const doc = docs.get(name)
  if (doc) for (const conn of [...doc.conns.keys()] as { close(code?: number, reason?: string): void; terminate(): void }[]) {
    try { conn.close(4001, reason) } catch { conn.terminate() }
  }
  hubs.stop(name)
  documentGuards.delete(name); awarenessOwners.delete(name)
  docMeters.delete(name); capLogged.delete(name)
}
async function freezeDocs(names: string[], reason: string): Promise<void> {
  const live = new Map(names.flatMap(name => docs.get(name) ? [[name, docs.get(name)!] as const] : []))
  for (const [name, doc] of live) { await hubs.flush(doc); await hubs.flushName(name) }
  for (const name of names) await hubs.flushName(name)
  const closed = [...live.values()].flatMap(doc => [...doc.conns.keys()]).map(conn => new Promise<void>(resolve => {
    const socket = conn as { once(event: 'close', fn: () => void): void; terminate(): void }
    const timer = setTimeout(() => { socket.terminate(); resolve() }, 1000)
    socket.once('close', () => { clearTimeout(timer); resolve() })
  }))
  for (const name of names) stopDoc(name, reason)
  await Promise.all(closed)
  for (const [name, doc] of live) {
    await hubs.flush(doc)
    docs.delete(name)
  }
  for (const name of names) await hubs.flushName(name)
}
async function migrateOpenRepo(repo: string): Promise<void> {
  await locks.run(repo, async () => {
    const r = rooms.get(repo)
    if (!r || r.migratedAt) return
    await migrateRepo(repo, r, {
      list: listDocs, load: loadDoc, write: writeDoc, clear: clearDoc, save: saveRooms,
      freeze: names => freezeDocs(names, upgradeText(repo)),
      revoke: async names => {
        const set = new Set(names)
        for (const [token, value] of viewTokens) if (set.has(value.room) || parseRoomName(value.room)?.repo === repo) { viewTokens.delete(token); credentialSockets.close({ kind: 'view', value: token }, 4403, 'view access revoked') }
        saveViewTokens()
      },
    }, new Set(rooms.keys()))
  })
}
/** Repos nobody has connected to for ROOM_IDLE_DAYS (default 30) are closed automatically: their
 *  shared uncommitted work is deleted. 0 disables. Checked hourly and at startup. */
const IDLE_MS = Number(process.env.ROOM_IDLE_DAYS ?? 30) * 24 * 60 * 60 * 1000
async function expireIdle() {
  const cutoff = Date.now() - IDLE_MS
  for (const [repo, r] of Array.from(rooms)) {
    if (r.migratedAt && r.legacy?.length && Date.now() - r.migratedAt > Number(process.env.ROOM_LEGACY_DAYS ?? 30) * 86400000) {
      await locks.run(repo, async () => {
        const current = rooms.get(repo)
        if (!current?.legacy?.length || !current.migratedAt) return
        for (const name of migrationSources(repo, current, current.legacy, new Set(rooms.keys()))) await clearDoc(name)
        const doc = await loadDoc(repo)
        doc.transact(() => doc.getMap('unresolved').clear(), HUB_ORIGIN)
        await writeDoc(repo, Y.encodeStateAsUpdate(doc))
        current.legacy = []; current.unresolved = 0
        await saveRooms()
      })
    }
    const live = Array.from(docs.keys()).some(n => canonical(n) === repo && (docs.get(n)?.conns.size ?? 0) > 0)
    if (IDLE_MS && !live && (r.lastSeen ?? r.at) < cutoff) { console.log(`room expired: ${repo} (idle since ${new Date(r.lastSeen ?? r.at).toISOString()})`); await closeRepo(repo) }
  }
}
setInterval(() => { void expireIdle().catch(error => console.log(`room expiry failed: ${error instanceof Error ? error.message : error}`)) }, 60 * 60 * 1000).unref()
void roomsLoaded.then(expireIdle).catch(error => console.log(`room expiry failed: ${error instanceof Error ? error.message : error}`))
/** Close all live and archived documents, including while the caller is unjoined. */
async function closeRepo(repo: string, oldClient = false): Promise<string[] | undefined> {
  return locks.run(repo, async () => {
    const r = rooms.get(repo)
    if (!r) return []
    if (oldClient && r.mode === 'repo') return undefined
    const names = new Set(closeDocumentNames(repo, r, await listDocs(), new Set(rooms.keys())))
    for (const name of names) await hubs.flushName(name)
    rooms.delete(repo); await saveRooms()
    for (const [key, value] of viewTokens) if (names.has(value.room)) { viewTokens.delete(key); credentialSockets.close({ kind: 'view', value: key }, 4403, 'view access revoked') }
    saveViewTokens()
    await freezeDocs([...names], 'room closed')
    for (const name of names) await clearDoc(name)
    console.log(`room closed: ${repo} (${names.size} document(s))`)
    return [...names]
  })
}
const str = (v: unknown): string | undefined => typeof v === 'string' && v ? v : undefined
const readBody = bodyReader({ maxBytes: Number(process.env.ROOM_MAX_BODY_KB ?? 64) * 1024,
  maxConcurrent: Number(process.env.ROOM_MAX_BODY_READS ?? 32), timeoutMs: Number(process.env.ROOM_BODY_TIMEOUT_MS ?? 10000) })
/** A PR note carries a room's ledger, so its body may be larger (ROOM_MAX_PR_NOTE_MB, default 4), but only for a
 *  request whose Authorization header is a live session: nobody unauthenticated is read past the small limit. */
const PR_NOTE_MAX_BYTES = Number(process.env.ROOM_MAX_PR_NOTE_MB ?? 4) * 1048576
const authStartLimit = new RateLimit(10, 60_000)
const authPollLimit = new RateLimit(120, 60_000)
const authCallbackLimit = new RateLimit(30, 60_000)
// A team behind one office address reconnects all its sessions at once after a deploy.
const upgradeLimit = new RateLimit(600, 60_000)
const failedAdmissionLimit = new RateLimit(30, 60_000)
const ticketLimit = new RateLimit(60, 60_000)
setInterval(() => {
  credentialSockets.sweep()
  for (const [key, value] of viewTokens) if (value.exp <= Date.now()) { viewTokens.delete(key); credentialSockets.close({ kind: 'view', value: key }, 4403, 'view key expired') }
}, 60_000).unref()
const revalidateSetting = Number(process.env.ROOM_REVALIDATE_MINUTES ?? 10)
const revalidateMinutes = Number.isFinite(revalidateSetting) && revalidateSetting >= 0 ? revalidateSetting : 10
const revalidator = new PermissionRevalidator(
  async (session, repo) => {
    const st = auth.peek(session)
    if (!st) return true // peek already closed an expired session with 4401
    if (!st.ghToken) return false
    const ownerRepo = githubRepoOf(repo)
    return !ownerRepo || st.ghToken.startsWith('fake:') ? true : pushChecker(st.ghToken, ownerRepo, true)
  },
  (session, repo) => {
    const st = auth.peek(session)
    credentialSockets.closeRoom({ kind: 'session', value: session }, repo, 4403, 'access revoked')
    audit({ event: 'refused', room: repo, login: st?.login, reason: 'access revoked' })
  },
  (_session, repo) => console.log(`permission revalidation unavailable for ${repo}; retaining connections`),
)
if (revalidateMinutes > 0) setInterval(() => { void revalidator.run() }, revalidateMinutes * 60_000).unref()
/** Behind a reverse proxy every socket has the proxy's address: ROOM_TRUST_PROXY=true keys the limits on the
 *  address the proxy reports (Fly-Client-IP, else the LAST X-Forwarded-For entry, the one the proxy appended;
 *  earlier entries are the client's to forge). Never set it on a server clients reach directly. */
const clientIp = (req: http.IncomingMessage) => {
  const direct = req.socket.remoteAddress ?? '?'
  if (process.env.ROOM_TRUST_PROXY !== 'true') return direct
  const fly = req.headers['fly-client-ip']
  if (typeof fly === 'string' && fly.trim()) return fly.trim()
  return String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1)!.trim() || direct
}

const server = http.createServer((req, res) => {
  try {
  res.setHeader('Referrer-Policy', 'no-referrer')
  let url: URL
  try { url = safeUrl(req.url) } catch { res.writeHead(400); res.end('Bad Request'); return }
  const limited = (limiter: RateLimit) => { const retry = limiter.check(clientIp(req)); if (!retry) return false; res.writeHead(429, { 'retry-after': String(retry) }); res.end('rate limited'); return true }
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, schema: 2, hub: 1, ...(hubs.anyStorageFailure() ? { storage: 'failing' } : {}) })); return }
  const headerCreds = (): Creds => ({ session: /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1], token: str(req.headers['x-room-token']) })
  const creds = (o: Record<string, unknown>): Creds => ({ gh: str(o.gh), token: str(o.token) ?? headerCreds().token, session: str(o.session) ?? headerCreds().session })
  if (['session', 'token', 'gh'].some(key => url.searchParams.has(key)) && req.method === 'GET') { res.writeHead(400); res.end('send credentials in Authorization or X-Room-Token headers'); return }
  const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const text = (status: number, body: string) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(body) }
  const html = (status: number, body: string) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(`<!doctype html><title>Room</title><body style="font-family:system-ui;margin:3em">${body}</body>`) }
  const withBody = (fn: (o: Record<string, unknown>) => Promise<void>, maxBytes?: number) => { void readBody(req, { maxBytes }).then(async body => {
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(body || '{}') as Record<string, unknown> } catch { text(400, 'bad request'); return }
    try { await fn({ ...headerCreds(), ...parsed }) }
    catch (e) { console.log(`request ${url.pathname}: ${e instanceof Error ? e.stack : e}`); if (!res.writableEnded) text(e instanceof Error && e.message.includes('storage is failing') ? 503 : 500, 'room server operation failed; retry') }
  }).catch(e => { if (!res.writableEnded && !res.destroyed) text(e instanceof HttpFailure ? e.status : 500, e instanceof HttpFailure ? e.message : 'request body failed') }); return }

  // A retired browser URL must explain the terminal state before the static app reconnects.
  if (req.method === 'GET' && url.pathname === '/' && (url.searchParams.has('view') || url.searchParams.has('key')) && url.searchParams.has('room')) {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const linked = new URL(url.searchParams.get('room')!)
      const name = roomNameOf(linked.pathname)
      if (!parseRoomName(name, linked.searchParams.get('schema') === '2')) return text(400, 'invalid room name: use github.com/owner/repo, git/host/path, or local/name')
      const repo = canonical(name)
      const entry = rooms.get(repo)
      const token = url.searchParams.get('view')!
      if (entry?.mode === 'repo' && (name !== repo ||
        (entry.plan?.moved && name === repo && viewTokens.get(token)?.room !== repo)))
        return html(410, `<h1>Room link expired</h1><p>${oldLinkText}</p>`)
    } catch { return text(400, 'invalid room name: use github.com/owner/repo, git/host/path, or local/name') }
  }

  // ---- auth ----
  if (url.pathname === '/auth/config' && req.method === 'GET') return json(200, { github: auth.mode, clientIdSet: auth.mode === 'device', providers: auth.providers, shareMax: SHARE_MAX, ...(auth.fake ? { fake: true } : {}) })
  const startLogin = (provider: Provider | undefined) => {
    if (!auth.providers.length) return text(404, 'this server has no login provider (set GITHUB_CLIENT_ID or OIDC_ISSUER)')
    void auth.start(provider).then(d => json(200, d)).catch(e => text(502, `could not start ${provider ?? auth.providers[0]} login: ${e instanceof Error ? e.message : e}`))
  }
  if (url.pathname === '/auth/device' && req.method === 'POST') { if (limited(authStartLimit)) return; return startLogin('github') } // older clients
  if (url.pathname === '/auth/start' && req.method === 'POST') return withBody(async o => {
    if (limited(authStartLimit)) return
    const p = str(o.provider)
    if (p && p !== 'github' && p !== 'oidc') return text(400, `unknown provider ${p}`)
    startLogin(p as Provider | undefined)
  })
  if (url.pathname === '/auth/callback' && req.method === 'GET') {
    if (limited(authCallbackLimit)) return
    void auth.callbackOidc(url.searchParams.get('code') ?? undefined, url.searchParams.get('state') ?? undefined, url.searchParams.get('error') ?? undefined).then(r => {
      if ('login' in r) { audit({ event: 'login', login: r.login, id: r.id, provider: 'oidc' }); return html(200, `<h1>Logged in as ${escapeHtml(r.login)}</h1><p>You can close this tab and go back to your agent.</p>`) }
      return html(400, `<h1>Login failed</h1><p>${escapeHtml(r.error)}</p>`)
    }).catch(e => { console.log(`auth callback: ${e instanceof Error ? e.message : e}`); if (!res.writableEnded) text(502, 'login callback failed') })
    return
  }
  if (url.pathname === '/auth/poll' && req.method === 'POST') return withBody(async o => {
    if (limited(authPollLimit)) return
    const device = str(o.device)
    if (!device) return text(400, 'device required')
    const r = await auth.poll(device, { fakeLogin: str(o.fakeLogin) })
    if ('session' in r && r.provider === 'github') audit({ event: 'login', login: r.login, provider: 'github' })
    json(200, r)
  })
  if (url.pathname === '/auth/logout' && req.method === 'POST') return withBody(async o => {
    const was = auth.logout(str(o.session))
    if (was) audit({ event: 'logout', login: was.login, id: was.id, provider: was.provider })
    json(200, { ok: !!was })
  })
  if (url.pathname === '/auth/me' && req.method === 'GET') {
    const st = auth.resolve(headerCreds().session)
    return st ? json(200, { login: st.login, provider: st.provider }) : text(401, 'not logged in')
  }
  if (url.pathname === '/audit' && req.method === 'GET') {
    const st = auth.resolve(headerCreds().session)
    if (!st) return text(401, 'not logged in: send Authorization: Bearer <session>')
    if (!isAdmin(st)) return text(403, `${st.login} is not in ROOM_ADMINS`)
    const since = Number(url.searchParams.get('since') ?? 0) || 0
    const limit = Math.min(10_000, Number(url.searchParams.get('limit') ?? 1000) || 1000)
    void store.readAudit({ since, limit }).then(entries => json(200, entries)).catch(e => text(500, `audit unavailable: ${e instanceof Error ? e.message : e}`))
    return
  }

  // ---- rooms ----
  if (url.pathname === '/rooms' && req.method === 'GET') {
    if (url.searchParams.has('room') && !parseRoomName(url.searchParams.get('room') ?? '', url.searchParams.get('schema') === '2')) return text(400, 'invalid room name: use github.com/owner/repo, git/host/path, or local/name')
    const c = headerCreds()
    void (async () => {
      const out: ({ repo: string } & OpenRepo)[] = []
      for (const [repo, r] of rooms) if ((await admitted(repo, c)).ok) out.push({ repo, ...r })
      json(200, out)
    })().catch(e => { console.log(`rooms list: ${e instanceof Error ? e.message : e}`); if (!res.writableEnded) text(500, 'could not list rooms') })
    return
  }
  if (url.pathname === '/rooms' && req.method === 'DELETE') return withBody(async o => {
    const room = str(o.room)
    if (!room) return text(400, 'room required')
    if (!parseRoomName(room, o.schema === 2)) return text(400, 'invalid room name: use github.com/owner/repo, git/host/path, or local/name')
    if (o.schema !== 2 && rooms.get(canonical(room))?.mode === 'repo') return text(403, upgradeText(canonical(room)))
    const v = await admitted(room, creds(o))
    if (!v.ok) { console.log(`close refused: ${v.why}`); return text(v.status, v.why) }
    const repo = canonical(room)
    if (!rooms.has(repo)) return text(404, NOT_OPEN(room))
    if (o.schema !== 2 && rooms.get(repo)?.mode === 'repo') return text(403, upgradeText(repo))
    const closed = await closeRepo(repo, o.schema !== 2)
    if (!closed) return text(403, upgradeText(repo))
    audit({ event: 'room_closed', room: repo, login: v.login, id: v.id })
    json(200, { repo, closed, ...(v.login ? { login: v.login } : {}) })
  })
  if (url.pathname === '/rooms' && req.method === 'POST') return withBody(async o => {
    const room = str(o.room)
    if (!room) return text(400, 'room required')
    if (!parseRoomName(room, o.schema === 2) || o.schema !== 2 && !parseRoomName(oldBranchRepo(roomNameOf(room)), true)) return text(400, 'invalid room name: use github.com/owner/repo, git/host/path, or local/name')
    if (o.schema !== 2 && rooms.get(canonical(room))?.mode === 'repo') return text(403, upgradeText(canonical(room)))
    const v = await admitted(room, creds(o))
    if (!v.ok) { console.log(`open refused: ${v.why}`); return text(v.status, v.why) }
    const by = v.login ?? str(o.by)
    const requested = roomNameOf(room)
    const name = o.schema === 2 ? canonical(requested, true) : canonical(oldBranchRepo(requested))
    let created = false
    await locks.run(name, async () => {
      const existing = rooms.get(name)
      if (o.schema !== 2 && existing?.mode === 'repo') return text(403, upgradeText(name))
      if (!existing) {
        if (rooms.size >= MAX_ROOMS) return text(503, 'server room limit reached')
        created = true
        const priorDocs = await listDocs()
        const oldDocs = o.schema === 2 && priorDocs.some(doc => doc === name || parseRoomName(doc)?.github && parseRoomName(doc)?.repo === name)
        const fresh = !priorDocs.includes(name) && !oldDocs
        rooms.set(name, { by, at: Date.now(), branches: [], mode: o.schema === 2 && !oldDocs ? 'repo' : 'branch',
          ...(o.schema === 2 && !oldDocs ? { migratedAt: Date.now() } : {}) })
        if (o.schema === 2 && !oldDocs) {
          const empty = new Y.Doc(); empty.getMap('meta').set('schemaVersion', 2)
          await writeDoc(name, Y.encodeStateAsUpdate(empty))
        }
        await saveRooms()
        if (fresh) hubs.markFresh(name)
        console.log(`room opened: ${name}${by ? ` by ${by}` : ''}`)
        audit({ event: 'room_opened', room: name, login: by, id: v.id })
      }
      const opened = rooms.get(name)
      if (o.schema !== 2 && requested !== name && opened && !opened.branches.includes(requested)) { opened.branches.push(requested); await saveRooms() }
    })
    if (res.writableEnded) return
    if (o.schema === 2) await migrateOpenRepo(name)
    json(created ? 201 : 200, { repo: name, created, ...rooms.get(name),
      ...(o.schema === 2 ? { room: name, hub: 1 } : {}), ...(v.login ? { login: v.login } : {}) })
  })
  if (url.pathname === '/ws-ticket' && req.method === 'POST') return withBody(async o => {
    if (limited(ticketLimit)) return
    const room = str(o.room)
    if (!room || o.schema !== 2 || !parseRoomName(room, true)) return text(400, 'schema 2 room required')
    const repo = canonical(room, true)
    if (!rooms.has(repo)) return text(404, NOT_OPEN(room))
    const view = str(o.view)
    if (view) {
      const key = viewTokens.get(view)
      if (!key || key.exp <= Date.now() || key.room !== repo) return text(403, 'view key invalid or expired')
      return json(200, credentialSockets.mint(repo, { kind: 'view', value: view }, true))
    }
    const c = { ...headerCreds(), ...creds(o) }
    const v = await admitted(repo, c)
    if (!v.ok) return text(v.status, v.why)
    const credential: Credential | undefined = c.session ? { kind: 'session', value: c.session } : c.token ? { kind: 'token', value: c.token } : undefined
    if (!credential) return text(401, 'credential required')
    return json(200, credentialSockets.mint(repo, credential, false))
  })
  if (url.pathname === '/view-token' && req.method === 'POST') return withBody(async o => {
    const room = str(o.room)
    if (!room) return text(400, 'room required')
    if (!parseRoomName(room, o.schema === 2)) return text(400, 'invalid room name: use github.com/owner/repo, git/host/path, or local/name')
    if (o.schema !== 2 && rooms.get(canonical(room))?.mode === 'repo') return text(403, upgradeText(canonical(room)))
    const v = await admitted(room, creds(o))
    if (!v.ok) { console.log(`view-token refused: ${v.why}`); return text(v.status, v.why) }
    const repo = canonical(room)
    const entry = rooms.get(repo)
    if (!entry) return text(404, NOT_OPEN(repo))
    if (o.schema !== 2 && entry.mode === 'repo') return text(403, upgradeText(repo))
    if (o.schema === 2) await migrateOpenRepo(repo)
    const name = o.schema === 2 ? repo : roomNameOf(room)
    const view = await locks.run(repo, async () => {
      if (!rooms.has(repo)) return undefined
      if (o.schema !== 2 && rooms.get(repo)?.mode === 'repo') return undefined
      const key = crypto.randomBytes(16).toString('hex')
      viewTokens.set(key, { room: name, exp: Date.now() + VIEW_TTL })
      for (const [k, vv] of viewTokens) if (vv.exp < Date.now()) viewTokens.delete(k)
      saveViewTokens()
      return key
    })
    if (!view) return rooms.get(repo)?.mode === 'repo' && o.schema !== 2
      ? text(403, upgradeText(repo)) : text(404, NOT_OPEN(repo))
    json(200, { ...(o.schema === 2 ? { room: name, hub: 1 } : {}), view, expiresIn: VIEW_TTL, ...(v.login ? { login: v.login } : {}) })
  })

  // Legacy documents are retained for 30 days but never connected to a writable socket.
  if (url.pathname === '/archive' && req.method === 'GET') {
    if (!parseRoomName(url.searchParams.get('repo') ?? '', true)) return text(400, 'invalid room name: use github.com/owner/repo, git/host/path, or local/name')
    void (async () => {
      const repo = canonical(url.searchParams.get('repo') ?? '')
      const entry = rooms.get(repo)
      if (!entry) return text(404, NOT_OPEN(repo))
      const v = await admitted(repo, headerCreds())
      if (!v.ok) return text(v.status, v.why)
      const unresolved = (await loadDoc(repo)).getMap('unresolved')
      json(200, { repo, legacy: entry.legacy ?? [], unresolved: [...unresolved.keys()] })
    })().catch(e => text(500, `archive unavailable: ${e instanceof Error ? e.message : e}`))
    return
  }
  if (url.pathname === '/archive/export' && req.method === 'POST') return withBody(async o => {
    if (o.schema !== 2) return text(403, 'update Room to 0.17 or later to export an archive')
    const name = str(o.room)
    if (!name) return text(400, 'room required')
    if (!archiveOwnerOf(name) && !parseRoomName(name)) return text(400, 'invalid archive name')
    if (o.view) return text(403, 'view tokens cannot export an archive')
    const parsed = parseRoomName(name)
    const owner = archiveOwnerOf(name) ?? (parsed?.github ? parsed.repo : undefined)
    const repo = [...rooms].find(([key, r]) => (!owner || key === owner) && r.legacy?.includes(name) && migrationSources(key, r, [name], new Set(rooms.keys())).includes(name))?.[0]
    if (!repo) return text(404, 'archive not found')
    const v = await admitted(repo, creds(o))
    if (!v.ok) return text(v.status, v.why)
    const update = Y.encodeStateAsUpdate(await loadDoc(name))
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': update.byteLength })
    res.end(Buffer.from(update))
  })

  // ---- github (pull requests) ----
  // Same admission rule as /rooms; the GitHub call uses the token behind the session (device
  // login). Sessions without a GitHub token (OIDC) get 403: the proxy cannot act on GitHub for
  // them. A fake-issuer session holds no real token, so the proxy refuses it the same way.
  const githubTokenFor = (c: Creds): string | undefined => { const t = c.session ? auth.resolve(c.session)?.ghToken : undefined; return t && !t.startsWith('fake:') ? t : undefined }
  const githubFail = (what: string, e: unknown) => { const st = (e as { status?: number }).status; console.log(`${what}: ${e instanceof Error ? e.message : e}`); text(st === 401 || st === 403 || st === 404 ? st : 502, `${what}: ${e instanceof Error ? e.message : String(e)}`) }
  if (url.pathname === '/github/prs' && req.method === 'GET') {
    const room = str(url.searchParams.get('room') ?? undefined)
    if (!room) return text(400, 'room required')
    if (!parseRoomName(room, url.searchParams.get('schema') === '2')) return text(400, 'invalid room name: use github.com/owner/repo')
    const c = headerCreds()
    void (async () => {
      const name = roomNameOf(room)
      const repo = githubRepoOf(name)
      if (!repo) return text(400, `${name} is not a github.com room`)
      const v = await admitted(name, c)
      if (!v.ok) { console.log(`github/prs refused: ${v.why}`); return text(v.status, v.why) }
      if (!rooms.has(canonical(name))) return text(404, NOT_OPEN(name))
      const token = githubTokenFor(c)
      if (!token) return text(403, 'this session has no GitHub token; log in with GitHub to see pull requests')
      try { json(200, await github.openPrs(token, repo, url.searchParams.get('branch') ?? name.slice(`github.com/${repo}/`.length), { head: url.searchParams.get('head') === '1' })) }
      catch (e) { githubFail('github/prs', e) }
    })().catch(e => { console.log(`github/prs: ${e instanceof Error ? e.message : e}`); if (!res.writableEnded) text(500, 'could not list pull requests') })
    return
  }
  if (url.pathname === '/github/pr-note' && req.method === 'POST') return withBody(async o => {
    const room = str(o.room)
    const number = Number(o.number)
    const body = str(o.body)
    if (!room) return text(400, 'room required')
    if (!parseRoomName(room, o.schema === 2)) return text(400, 'invalid room name: use github.com/owner/repo')
    if (!Number.isInteger(number) || number <= 0) return text(400, 'number required (positive PR number)')
    if (!body) return text(400, 'body required')
    const c = creds(o)
    const name = roomNameOf(room)
    const repo = githubRepoOf(name)
    if (!repo) return text(400, `${name} is not a github.com room`)
    const v = await admitted(name, c)
    if (!v.ok) { console.log(`github/pr-note refused: ${v.why}`); return text(v.status, v.why) }
    if (!rooms.has(canonical(name))) return text(404, NOT_OPEN(name))
    const token = githubTokenFor(c)
    if (!token) return text(403, 'this session has no GitHub token; log in with GitHub to comment on pull requests')
    try { json(200, { repo, number, ...(await github.upsertNote(token, repo, number, body)), ...(v.login ? { login: v.login } : {}) }) }
    catch (e) { githubFail('github/pr-note', e) }
  }, auth.resolve(headerCreds().session) ? PR_NOTE_MAX_BYTES : undefined)
  if (fs.existsSync(STATIC)) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const file = staticFile(STATIC, url.pathname)
    if (file) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': rel === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable' })
      fs.createReadStream(file).pipe(res)
      return
    }
  }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('room server: connect a y-websocket client to ws://host:port/<room> with authorization headers\n')
  } catch (e) {
    console.log(`http request failed: ${e instanceof Error ? e.message : e}`)
    if (!res.writableEnded && !res.destroyed) { res.writeHead(e instanceof HttpFailure ? e.status : 500); res.end(e instanceof HttpFailure ? e.message : 'Internal Server Error') }
  }
})
/** A room's document may not grow past this (ROOM_DOC_MAX_MB, default 64): a client that floods the doc
 *  would otherwise make the room impossible to load. Measured per room at most every 30 s, and again
 *  after 200 write messages or 8 MB received, whichever comes first: a time-only cache would let an
 *  unbounded amount through between two measurements. The default 64 pairs with ROOM_DOC_MAX_BYTES in
 *  shared/src/memory.ts (the local relay's snapshot ceiling); the server image ships without @room/shared. */
const DOC_MAX_BYTES = Number(process.env.ROOM_DOC_MAX_MB ?? 64) * 1048576
const docMeters = new Map<string, DocSizeMeter>()
const capLogged = new Map<string, number>()
function docMeter(roomName: string): DocSizeMeter {
  let m = docMeters.get(roomName)
  if (!m) {
    m = new DocSizeMeter(() => { const doc = docs.get(roomName); return doc ? Y.encodeStateAsUpdate(doc).byteLength : 0 })
    docMeters.set(roomName, m)
  }
  return m
}
/** Largest websocket message accepted (ROOM_MAX_MESSAGE_MB, default 16). A client holding a bloated copy of
 *  a room, such as a browser tab left open, would otherwise push the whole thing back in one frame. */
const MAX_MESSAGE_BYTES = Number(process.env.ROOM_MAX_MESSAGE_MB ?? 16) * 1048576
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
wss.on('headers', headers => headers.push('Referrer-Policy: no-referrer'))
/** One log line per room per minute at most: a misbehaving viewer must not flood the log. */
const dropLog = new Map<string, number>()
const droppedWrite = (room: string) => () => {
  const now = Date.now()
  if ((dropLog.get(room) ?? 0) > now - 60_000) return
  dropLog.set(room, now)
  console.log(`dropped write from a view-key connection (room ${room})`)
}
/** One hub per loaded room: one process per YPERSISTENCE volume, so one authority per room (hub spec §6). */
const hubs = new ServerHubs({ store: incarnationFile(process.env.YPERSISTENCE, PORT), log: l => console.log(l), full: room => docMeter(room).size() > DOC_MAX_BYTES,
  hubBytes: (room, bytes) => { docMeter(room).size(bytes) } })
const stockPersistence = getPersistence() as { provider: PersistenceProvider } | null
setPersistence(hubs.persistence(stockPersistence?.provider ?? memoryProvider))
setInterval(() => hubs.tick(), 1000).unref()
// The docs map (and persistence) is keyed by the DECODED room name, the same key admission, closing,
// expiry and the size cap use; y-websocket's default would key by the raw, possibly double-encoded path.
wss.on('connection', (conn, req) => {
  try {
  const url = safeUrl(req.url)
  const raw = docNameOf(req.url ?? '/')
  if (!parseRoomName(raw, url.searchParams.get('schema') === '2' && !url.searchParams.has('view'))) { conn.close(1008, 'invalid room name'); return }
  const repo = canonical(raw)
  const docName = url.searchParams.get('schema') === '2' || rooms.get(repo)?.mode === 'repo' ? repo : raw
  setupWSConnection(conn, req, { gc: true, docName })
  hubs.ensure(docName, docs.get(docName)!)
  } catch (e) { console.log(`websocket connection failed: ${e instanceof Error ? e.message : e}`); conn.close(1008, 'Bad Request') }
})
/** Refused connections are audited at most once per 10 s per remote address: a client retrying in a
 *  loop (or a scanner) must not fill the audit log. The refusal itself is still logged and sent. */
const refusedAudit = new Map<string, number>()
const REFUSED_AUDIT_EVERY_MS = 10_000
function auditRefused(remote: string | undefined, room: string | undefined, reason: string): void {
  const key = remote ?? '?'
  const now = Date.now()
  if ((refusedAudit.get(key) ?? 0) > now - REFUSED_AUDIT_EVERY_MS) return
  refusedAudit.set(key, now)
  if (refusedAudit.size > 10_000) for (const [k, at] of refusedAudit) if (at <= now - REFUSED_AUDIT_EVERY_MS) refusedAudit.delete(k)
  audit({ event: 'refused', room, reason })
}
const refuse = (socket: import('node:stream').Duplex, code: number, why: string, room?: string) => {
  console.log(`refused ${code} ${why}${room ? ` (room ${room})` : ''}`)
  auditRefused((socket as import('node:net').Socket).remoteAddress, room, `${code} ${why}`)
  socket.write(`HTTP/1.1 ${code} ${why}\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}
const identityLog = new Map<string, number>()
const documentGuards = new Map<string, DocumentIdentityGuard>()
const awarenessOwners = new Map<string, Map<number, string>>()
function documentGuard(roomName: string): DocumentIdentityGuard {
  let guard = documentGuards.get(roomName)
  if (!guard) { guard = new DocumentIdentityGuard(() => docs.get(roomName)); documentGuards.set(roomName, guard) }
  return guard
}
function awarenessOwnerMap(roomName: string): Map<number, string> {
  let owners = awarenessOwners.get(roomName)
  if (!owners) { owners = new Map(); awarenessOwners.set(roomName, owners) }
  return owners
}
server.on('upgrade', (req, socket, head) => {
  // First, before anything can refuse: a refusal writes to a socket the client may already have reset (EPIPE).
  socket.on('error', () => {})
  try {
  const url = safeUrl(req.url)
  const retry = upgradeLimit.check(clientIp(req))
  if (retry) return refuse(socket, 429, `Too Many Requests; retry after ${retry} seconds`)
  const roomName = roomNameOf(url.pathname)
  // A retired branch link (view key) keeps its branch suffix so it can be told 410 instead of 400.
  if (!parseRoomName(roomName, url.searchParams.get('schema') === '2' && !url.searchParams.has('view'))) return refuse(socket, 400, 'invalid room name: use github.com/owner/repo, git/host/path, or local/name', roomName)
  const repo = canonical(roomName)
  const schema2 = url.searchParams.get('schema') === '2'
  const docKey = schema2 || rooms.get(repo)?.mode === 'repo' ? repo : roomName
  if (schema2 && ['session', 'token', 'gh', 'view', 'key'].some(key => url.searchParams.has(key))) return refuse(socket, 400, 'send credentials in headers or exchange a browser link at POST /ws-ticket', roomName)
  if (!schema2 && (url.searchParams.has('token') || url.searchParams.has('gh'))) return refuse(socket, 400, 'send credentials in headers', roomName)
  if (!schema2 && rooms.get(repo)?.mode === 'repo') return refuse(socket, 403, upgradeText(repo), roomName)
  const accept = (opts: { readOnly?: boolean; login?: string; id?: string; provider?: Provider; credential?: Credential } = {}) => {
    void locks.run(repo, async () => {
      const current = rooms.get(repo)
      if (!current) return refuse(socket, 404, `Not Found: ${NOT_OPEN(roomName)}`)
      if (!schema2 && current.mode === 'repo') return refuse(socket, 403, upgradeText(repo), roomName)
      if (schema2 && !current.migratedAt) return refuse(socket, 503, 'room migration is not complete; retry', roomName)
      if (hubs.storageFailure(docKey)) return refuse(socket, 503, hubs.storageFailure(docKey)!, roomName)
      if (opts.readOnly) {
        const token = viewTokens.get(opts.credential?.value ?? '')
        if (!token || token.exp <= Date.now() || token.room !== docKey)
          return refuse(socket, current.mode === 'repo' && (roomName !== repo || current.plan?.moved) ? 410 : 403,
            current.mode === 'repo' && (roomName !== repo || current.plan?.moved) ? oldLinkText : 'Forbidden: view token invalid for this room', roomName)
      }
      const principal = opts.login ? `login:${opts.login}` : `ip:${clientIp(req)}`
      if (connectionCounts.total >= MAX_CONNECTIONS || (connectionCounts.room.get(repo) ?? 0) >= MAX_CONNECTIONS_PER_ROOM)
        return refuse(socket, 503, 'connection limit reached', roomName)
      if ((connectionCounts.principal.get(principal) ?? 0) >= MAX_CONNECTIONS_PER_PRINCIPAL)
        return refuse(socket, 429, 'connection limit reached for principal', roomName)
      // Finish loading before the HTTP upgrade: after handleUpgrade the client may send immediately.
      // Holding the repo lock also makes the socket visible to migration's freeze step.
      await hubs.flush(getYDoc(docKey, true))
      if (hubs.storageFailure(docKey)) return refuse(socket, 503, hubs.storageFailure(docKey)!, roomName)
      wss.handleUpgrade(req, socket, head, ws => {
        if (opts.credential) credentialSockets.track(opts.credential, ws, docKey)
        if (opts.credential?.kind === 'session' && githubRepoOf(repo)) ws.once('close', revalidator.track(opts.credential.value, repo))
        connectionCounts.total++
        connectionCounts.room.set(repo, (connectionCounts.room.get(repo) ?? 0) + 1)
        connectionCounts.principal.set(principal, (connectionCounts.principal.get(principal) ?? 0) + 1)
        ws.once('close', () => {
          connectionCounts.total--
          const roomCount = (connectionCounts.room.get(repo) ?? 1) - 1
          if (roomCount) connectionCounts.room.set(repo, roomCount); else connectionCounts.room.delete(repo)
          const principalCount = (connectionCounts.principal.get(principal) ?? 1) - 1
          if (principalCount) connectionCounts.principal.set(principal, principalCount); else connectionCounts.principal.delete(principal)
        })
        const entry = rooms.get(repo)!
        entry.lastSeen = Date.now(); void saveRooms().catch(() => {})
        // Innermost wrapper (installed first): the outer ones pass type 7 through to it.
        bindHub(ws, () => hubs.current(docKey), opts.readOnly ? { readOnly: true } : { login: opts.login, readOnly: false }, () => hubs.storageFailure(docKey) ?? hubs.startFailure(docKey))
        audit({ event: 'join', room: docKey, login: opts.login, id: opts.id, provider: opts.provider, ...(opts.readOnly ? { readOnly: true } : {}) })
        if (opts.readOnly) makeReadOnly(ws, droppedWrite(docKey))
        if (opts.login) {
          bindIdentity(ws, opts.login, (login, name) => {
            const now = Date.now()
            if ((identityLog.get(login) ?? 0) > now - 60_000) return
            identityLog.set(login, now)
            console.log(`dropped presence under ${JSON.stringify(name)} from ${login} (room ${roomName})`)
          }, awarenessOwnerMap(docKey))
          bindDocumentIdentity(ws, opts.login, documentGuard(docKey), (login, reason) => {
            const key = `document:${login}`
            const now = Date.now()
            if ((identityLog.get(key) ?? 0) > now - 60_000) return
            identityLog.set(key, now)
            if (IDENTITY_GUARD_MODE === 'enforce') {
              console.log(`rejected identity-bearing update from ${login} (room ${repo}): ${reason}`)
              audit({ event: 'refused', room: repo, login, id: opts.id, provider: opts.provider, reason: `identity-bearing update rejected: ${reason}` })
            } else {
              console.log(`observed identity-bearing update from ${login} (room ${repo}); update applied: ${reason}`)
              audit({ event: 'identity_violation', room: repo, login, id: opts.id, provider: opts.provider, reason: `identity-bearing update observed; update applied: ${reason}` })
            }
          }, IDENTITY_GUARD_MODE)
        }
        // The cap is the outermost wrapper: a packet it refuses never advances the identity shadow.
        const meter = docMeter(docKey)
        capDocSize(ws, bytes => hubs.storageFailure(docKey) ? DOC_MAX_BYTES + 1 : meter.size(bytes), DOC_MAX_BYTES, size => {
          const failure = hubs.storageFailure(docKey)
          if (failure) { ws.close(4507, failure); return }
          const now = Date.now()
          if ((capLogged.get(repo) ?? 0) < now - 60_000) { capLogged.set(repo, now); console.log(`refusing writes: room ${repo} is ${(size / 1048576).toFixed(1)} MB (cap ${(DOC_MAX_BYTES / 1048576).toFixed(0)} MB); close and reopen the repo, or raise ROOM_DOC_MAX_MB`) }
          ws.close(4413, sizeCapReason(DOC_MAX_BYTES))
        })
        wss.emit('connection', ws, req)
      })
    }).catch(e => { console.log(`could not load room ${docKey}: ${e instanceof Error ? e.message : e}`); refuse(socket, 503, 'room could not load; retry', roomName) })
  }
  const ticket = url.searchParams.get('ticket')
  if (ticket) {
    const issued = credentialSockets.take(ticket, docKey)
    if (!issued) return refuse(socket, 403, 'websocket ticket invalid or expired', roomName)
    const c = issued.credential
    if (issued.readOnly) {
      const view = viewTokens.get(c.value)
      if (!view || view.exp <= Date.now() || view.room !== docKey) return refuse(socket, 403, 'view key invalid or expired', roomName)
      return accept({ readOnly: true, credential: c })
    }
    const creds: Creds = c.kind === 'session' ? { session: c.value } : { token: c.value }
    return admitted(roomName, creds).then(v => v.ok ? accept({ login: v.login, id: v.id, provider: v.provider, credential: c }) : refuse(socket, v.status, v.why, roomName))
      .catch(() => refuse(socket, 503, 'room unavailable; retry', roomName))
  }
  const view = url.searchParams.get('view')
  if (view) {
    const v = viewTokens.get(view)
    const entry = rooms.get(repo)
    if (url.searchParams.get('schema') === '2' && !entry?.migratedAt) return refuse(socket, 410, oldLinkText, roomName)
    if (v && v.exp > Date.now() && v.room === docKey) return accept({ readOnly: true, credential: { kind: 'view', value: view } })
    if (entry?.mode === 'repo' && (roomName !== repo || entry.plan?.moved))
      return refuse(socket, 410, oldLinkText, roomName)
    return refuse(socket, 403, 'Forbidden: view token invalid for this room')
  }
  const c: Creds = { token: str(req.headers['x-room-token']), session: /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1],
    ...(!schema2 ? { gh: url.searchParams.get('gh') ?? undefined, token: str(req.headers['x-room-token']) ?? url.searchParams.get('token') ?? undefined,
      session: /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? url.searchParams.get('session') ?? undefined } : {}) }
  admitted(roomName, c)
    .then(async v => {
      if (!v.ok) {
        const retry = failedAdmissionLimit.check(clientIp(req))
        return retry ? refuse(socket, 429, `Too Many Requests; retry after ${retry} seconds`, roomName) : refuse(socket, v.status, v.why, roomName)
      }
      const entry = rooms.get(repo)
      if (!entry) return refuse(socket, 404, `Not Found: ${NOT_OPEN(roomName)}`)
      if (url.searchParams.get('schema') !== '2') {
        if (entry.mode === 'repo') return refuse(socket, 403, upgradeText(repo), roomName)
        return accept({ login: v.login, id: v.id, provider: v.provider, credential: c.session ? { kind: 'session', value: c.session } : c.token ? { kind: 'token', value: c.token } : undefined })
      }
      await migrateOpenRepo(repo)
      if (!rooms.has(repo)) return refuse(socket, 404, `Not Found: ${NOT_OPEN(roomName)}`)
      return accept({ login: v.login, id: v.id, provider: v.provider, credential: c.session ? { kind: 'session', value: c.session } : c.token ? { kind: 'token', value: c.token } : undefined })
    })
    .catch(e => { console.log(`upgrade admission: ${e instanceof Error ? e.message : e}`); refuse(socket, 503, 'room unavailable; retry', roomName) })
  } catch (e) { console.log(`upgrade failed: ${e instanceof Error ? e.message : e}`); refuse(socket, e instanceof HttpFailure ? e.status : 500, e instanceof HttpFailure ? e.message : 'Internal Server Error') }
})
process.on('unhandledRejection', e => console.log(`unhandled rejection: ${e instanceof Error ? e.stack : e}`))
function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!) }
void roomsLoaded.then(() => server.listen(PORT, HOST, () => console.log(
  `room server listening on ws://${HOST}:${PORT}/<room>` +
  (auth.fake ? ' (FAKE GitHub login: test issuer, any fakeLogin is accepted)' : auth.mode === 'device' ? ' (GitHub login via device flow)' : ' (no GitHub login: github.com rooms refused; set GITHUB_CLIENT_ID)') +
  (auth.providers.includes('oidc') ? ` (OIDC login via ${oidcIssuer})` : '') +
  (TOKEN ? ' (shared token accepted for non-GitHub rooms)' : '') +
  (process.env.DATABASE_URL ? ' registry/sessions/audit in Postgres' : '') +
  (process.env.YPERSISTENCE ? ` persisting to ${process.env.YPERSISTENCE}` : ' (in-memory: rooms reset on restart)'),
)))
