#!/usr/bin/env tsx
/**
 * Room server: a stock y-websocket server plus access control and persistence.
 *  - Rooms named github.com/<owner>/<repo> admit callers whose GitHub account has push
 *    access to the repo (checked against the GitHub API, cached 10 min). Read access is not
 *    enough: a public repo must not be an open room.
 *  - GITHUB_CLIENT_ID: clients log in with GitHub's device flow (POST /auth/start, /auth/poll) and the
 *    server keeps the GitHub token; clients hold only an opaque ?session=. That session is the only
 *    way into a github.com room: forwarded GitHub tokens (?gh=) are refused with 401 in every mode,
 *    and without a client id github.com rooms cannot be entered at all. GITHUB_CLIENT_ID=fake is a
 *    test issuer (refused with NODE_ENV=production): /auth/poll confirms with the body's `fakeLogin`.
 *    Logged-in connections may only announce presence under their login.
 *  - OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_CLIENT_SECRET + PUBLIC_URL: OIDC login (authorization code +
 *    PKCE; GET /auth/callback is the redirect URI). OIDC_ALLOWED_DOMAINS limits who may log in.
 *    Any logged-in user is admitted to non-GitHub rooms (local/..., git/<host>/<owner>/<repo>);
 *    github.com rooms still need a GitHub login with push access.
 *  - ROOM_TOKEN: if set, ?token=<same> admits non-GitHub rooms (local/..., git/...) only; it never
 *    admits a github.com room.
 *  - With no login provider and no ROOM_TOKEN configured, non-GitHub rooms are open.
 *  - YPERSISTENCE: if set to a directory, rooms are stored in LevelDB there and survive restarts;
 *    the repo registry, sessions and the audit log (audit.log, JSON lines) live there too unless
 *    DATABASE_URL points at Postgres (see store.ts). GET /audit?session=<admin session>&since=<ms>
 *    for logins in ROOM_ADMINS.
 *  - A repo is opened explicitly once (POST /rooms) before anyone can connect. A websocket
 *    to a repo nobody opened is refused with 404. GET /rooms lists open repos; DELETE /rooms
 *    closes one, dropping live connections and persisted legacy archives.
 *  - Browser view keys (?view=) are read-only: inbound document and awareness writes are discarded.
 * All coordination state lives inside the Y.Doc; room name = URL path.
 * Each loaded room also runs its hub (hub.ts, @room/hub-core) on message type 7 of the same websocket:
 * name leases, message order, trim and expiry.
 */
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { setupWSConnection, docs, getPersistence, setPersistence } from '@y/websocket-server/utils'
import { makeReadOnly, bindIdentity, bindDocumentIdentity, capDocSize, sizeCapReason, DocSizeMeter, DocumentIdentityGuard } from './readonly.js'
import { docNameOf, roomNameOf, githubRepoOf, repoRoomOf } from './names.js'
import * as Y from 'yjs'
import { Auth, FAKE_CLIENT_ID } from './auth.js'
import type { Provider } from './auth.js'
import { makeAdmitted, type Creds } from './admit.js'
import { storeFromEnv, writeAtomicFile, type AuditEntry, type OpenRepo } from './store.js'
import { ServerHubs, bindHub, incarnationFile, type PersistenceProvider } from './hub.js'
import { RepoLocks } from './repo-lock.js'
import { migrateRepo } from './migrate.js'
import { HUB_ORIGIN } from '@room/hub-core'

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
/** An entry in ROOM_ADMINS may be the display login (GitHub login, verified email) or, for OIDC users,
 *  the namespaced identity `oidc:<issuer-host>:<sub>`, which cannot be spoofed by a look-alike email. */
const isAdmin = (st: { login: string; id?: string }) => ADMINS.has(st.login) || (!!st.id && ADMINS.has(st.id))
const list = (v: string | undefined) => v?.split(',').map(s => s.trim()).filter(Boolean) ?? []
const oidcIssuer = process.env.OIDC_ISSUER?.trim()
if (oidcIssuer && !(process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET && process.env.PUBLIC_URL)) { console.error('OIDC_ISSUER is set but OIDC_CLIENT_ID, OIDC_CLIENT_SECRET or PUBLIC_URL is missing'); process.exit(1) }
const store = storeFromEnv()
const clientId = process.env.GITHUB_CLIENT_ID?.trim() || undefined
if (clientId === FAKE_CLIENT_ID && process.env.NODE_ENV === 'production') { console.error(`GITHUB_CLIENT_ID=${FAKE_CLIENT_ID} is the test issuer; it cannot run with NODE_ENV=production`); process.exit(1) }
const auth = new Auth({
  clientId,
  oidc: oidcIssuer ? { issuer: oidcIssuer, clientId: process.env.OIDC_CLIENT_ID!.trim(), clientSecret: process.env.OIDC_CLIENT_SECRET!.trim(), allowedDomains: list(process.env.OIDC_ALLOWED_DOMAINS), publicUrl: process.env.PUBLIC_URL!.trim() } : undefined,
  store,
  log: l => console.log(l),
})
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
function saveViewTokens() {
  if (!VIEW_FILE) return
  fs.mkdirSync(path.dirname(VIEW_FILE), { recursive: true })
  writeAtomicFile(VIEW_FILE, JSON.stringify(Object.fromEntries(viewTokens)))
}

/** Repos someone has opened, keyed by their canonical origin-derived names. */
const rooms = new Map<string, OpenRepo>()
const locks = new RepoLocks()
const canonical = (name: string) => repoRoomOf(name, key => rooms.has(key))
const oldBranchRepo = (name: string) => name.split('/').slice(0, name.startsWith('github.com/') ? 3 : name.startsWith('git/') ? 4 : 2).join('/')
const roomsLoaded = auth.ready.then(() => store.loadRooms()).then(all => {
  for (const [key, value] of Object.entries(all)) {
    const name = repoRoomOf(key, () => false)
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
function saveRooms(): Promise<void> { return store.saveRooms(Object.fromEntries(rooms)) }
const NOT_OPEN = (room: string) => `no room for ${canonical(room)} yet: open one with room_create (or POST /rooms)`
const upgradeText = (repo: string) => `update Room to 0.17 or later: this repository now has one room for all branches (${repo})`

/** Is this caller allowed into `room`? Same rule for opening, listing, closing, viewing and connecting;
 *  the verdict carries the verified login when the caller is logged in. See admit.ts. */
const admitted = makeAdmitted({ auth, token: TOKEN })
const memoryDocs = new Map<string, Uint8Array>()
const provider = () => (getPersistence() as { provider?: PersistenceProvider & { getAllDocNames?(): Promise<string[]> } } | null)?.provider
const listDocs = async () => [...new Set([...(await provider()?.getAllDocNames?.() ?? []), ...memoryDocs.keys(), ...docs.keys()])]
const loadDoc = async (name: string): Promise<Y.Doc> => {
  const live = docs.get(name)
  if (live) return live
  if (provider()) return provider()!.getYDoc(name)
  const doc = new Y.Doc()
  const update = memoryDocs.get(name)
  if (update) Y.applyUpdate(doc, update)
  return doc
}
const writeDoc = async (name: string, update: Uint8Array): Promise<void> => {
  if (provider()) { await provider()!.storeUpdate(name, update); return }
  const before = memoryDocs.get(name)
  memoryDocs.set(name, before ? Y.mergeUpdates([before, update]) : update)
}
const clearDoc = async (name: string): Promise<void> => {
  memoryDocs.delete(name)
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
  if (!provider()) for (const [name, doc] of live) await writeDoc(name, Y.encodeStateAsUpdate(doc))
  const closed = [...live.values()].flatMap(doc => [...doc.conns.keys()]).map(conn => new Promise<void>(resolve => {
    const socket = conn as { once(event: 'close', fn: () => void): void; terminate(): void }
    const timer = setTimeout(() => { socket.terminate(); resolve() }, 1000)
    socket.once('close', () => { clearTimeout(timer); resolve() })
  }))
  for (const name of names) stopDoc(name, reason)
  await Promise.all(closed)
  for (const [name, doc] of live) {
    await hubs.flush(doc)
    if (!provider()) await writeDoc(name, Y.encodeStateAsUpdate(doc))
    docs.delete(name)
  }
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
        for (const [token, value] of viewTokens) if (set.has(value.room)) viewTokens.delete(token)
        saveViewTokens()
      },
    })
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
        for (const name of current.legacy) await clearDoc(name)
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
setInterval(() => { void expireIdle() }, 60 * 60 * 1000).unref()
void roomsLoaded.then(expireIdle)
/** Close all live and archived documents, including while the caller is unjoined. */
async function closeRepo(repo: string, oldClient = false): Promise<string[] | undefined> {
  return locks.run(repo, async () => {
    const r = rooms.get(repo)
    if (!r) return []
    if (oldClient && r.mode === 'repo') return undefined
    const names = new Set([repo, ...r.branches, ...(r.legacy ?? []), ...(r.plan?.sources ?? [])])
    for (const name of await listDocs()) if (canonical(name) === repo) names.add(name)
    rooms.delete(repo); await saveRooms()
    for (const [key, value] of viewTokens) if (names.has(value.room)) viewTokens.delete(key)
    saveViewTokens()
    await freezeDocs([...names], 'room closed')
    for (const name of names) await clearDoc(name)
    console.log(`room closed: ${repo} (${names.size} document(s))`)
    return [...names]
  })
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
  const html = (status: number, body: string) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><title>Room</title><body style="font-family:system-ui;margin:3em">${body}</body>`) }
  const withBody = (fn: (o: Record<string, unknown>) => Promise<void>) => { void readBody(req).then(async body => {
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(body || '{}') as Record<string, unknown> } catch { text(400, 'bad request'); return }
    try { await fn(parsed) }
    catch (e) { console.log(`request ${url.pathname}: ${e instanceof Error ? e.stack : e}`); if (!res.writableEnded) text(500, 'room server operation failed; retry') }
  }); return }

  // ---- auth ----
  if (url.pathname === '/auth/config' && req.method === 'GET') return json(200, { github: auth.mode, clientIdSet: auth.mode === 'device', providers: auth.providers, shareMax: SHARE_MAX, ...(auth.fake ? { fake: true } : {}) })
  const startLogin = (provider: Provider | undefined) => {
    if (!auth.providers.length) return text(404, 'this server has no login provider (set GITHUB_CLIENT_ID or OIDC_ISSUER)')
    void auth.start(provider).then(d => json(200, d)).catch(e => text(502, `could not start ${provider ?? auth.providers[0]} login: ${e instanceof Error ? e.message : e}`))
  }
  if (url.pathname === '/auth/device' && req.method === 'POST') return startLogin('github') // older clients
  if (url.pathname === '/auth/start' && req.method === 'POST') return withBody(async o => {
    const p = str(o.provider)
    if (p && p !== 'github' && p !== 'oidc') return text(400, `unknown provider ${p}`)
    startLogin(p as Provider | undefined)
  })
  if (url.pathname === '/auth/callback' && req.method === 'GET') {
    void auth.callbackOidc(url.searchParams.get('code') ?? undefined, url.searchParams.get('state') ?? undefined, url.searchParams.get('error') ?? undefined).then(r => {
      if ('login' in r) { audit({ event: 'login', login: r.login, id: r.id, provider: 'oidc' }); return html(200, `<h1>Logged in as ${escapeHtml(r.login)}</h1><p>You can close this tab and go back to your agent.</p>`) }
      return html(400, `<h1>Login failed</h1><p>${escapeHtml(r.error)}</p>`)
    })
    return
  }
  if (url.pathname === '/auth/poll' && req.method === 'POST') return withBody(async o => {
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
    const st = auth.resolve(url.searchParams.get('session') ?? undefined)
    return st ? json(200, { login: st.login, provider: st.provider }) : text(401, 'not logged in')
  }
  if (url.pathname === '/audit' && req.method === 'GET') {
    const st = auth.resolve(url.searchParams.get('session') ?? undefined)
    if (!st) return text(401, 'not logged in: pass ?session=')
    if (!isAdmin(st)) return text(403, `${st.login} is not in ROOM_ADMINS`)
    const since = Number(url.searchParams.get('since') ?? 0) || 0
    const limit = Math.min(10_000, Number(url.searchParams.get('limit') ?? 1000) || 1000)
    void store.readAudit({ since, limit }).then(entries => json(200, entries)).catch(e => text(500, `audit unavailable: ${e instanceof Error ? e.message : e}`))
    return
  }

  // ---- rooms ----
  if (url.pathname === '/rooms' && req.method === 'GET') {
    const c = queryCreds()
    void (async () => {
      const out: ({ repo: string } & OpenRepo)[] = []
      for (const [repo, r] of rooms) if ((await admitted(repo, c)).ok) out.push({ repo, ...r })
      json(200, out)
    })()
    return
  }
  if (url.pathname === '/rooms' && req.method === 'DELETE') return withBody(async o => {
    const room = str(o.room)
    if (!room) return text(400, 'room required')
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
    if (o.schema !== 2 && rooms.get(canonical(room))?.mode === 'repo') return text(403, upgradeText(canonical(room)))
    const v = await admitted(room, creds(o))
    if (!v.ok) { console.log(`open refused: ${v.why}`); return text(v.status, v.why) }
    const by = v.login ?? str(o.by)
    const requested = roomNameOf(room)
    const name = o.schema === 2 ? canonical(requested) : canonical(oldBranchRepo(requested))
    if (o.schema === 2 && name !== repoRoomOf(requested, () => false)) return json(409, { room: name })
    let created = false
    await locks.run(name, async () => {
      const existing = rooms.get(name)
      if (o.schema !== 2 && existing?.mode === 'repo') return text(403, upgradeText(name))
      if (!existing) {
        created = true
        const oldDocs = o.schema === 2 && (await listDocs()).some(doc => doc === name || repoRoomOf(doc, key => key === name) === name)
        rooms.set(name, { by, at: Date.now(), branches: [], mode: o.schema === 2 && !oldDocs ? 'repo' : 'branch',
          ...(o.schema === 2 && !oldDocs ? { migratedAt: Date.now() } : {}) })
        if (o.schema === 2 && !oldDocs) {
          const empty = new Y.Doc(); empty.getMap('meta').set('schemaVersion', 2)
          await writeDoc(name, Y.encodeStateAsUpdate(empty))
        }
        await saveRooms()
        console.log(`room opened: ${name}${by ? ` by ${by}` : ''}`)
        audit({ event: 'room_opened', room: name, login: by, id: v.id })
      }
    })
    if (res.writableEnded) return
    if (o.schema === 2) await migrateOpenRepo(name)
    json(created ? 201 : 200, { repo: name, created, ...rooms.get(name),
      ...(o.schema === 2 ? { room: name, hub: 1 } : {}), ...(v.login ? { login: v.login } : {}) })
  })
  if (url.pathname === '/view-token' && req.method === 'POST') return withBody(async o => {
    const room = str(o.room)
    if (!room) return text(400, 'room required')
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
    void (async () => {
      const repo = canonical(url.searchParams.get('repo') ?? '')
      const entry = rooms.get(repo)
      if (!entry) return text(404, NOT_OPEN(repo))
      const v = await admitted(repo, queryCreds())
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
    if (o.view) return text(403, 'view tokens cannot export an archive')
    const repo = [...rooms].find(([, r]) => r.legacy?.includes(name))?.[0]
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
    const c = queryCreds()
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
    if (!rooms.has(canonical(name))) return text(404, NOT_OPEN(name))
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
/** One log line per room per minute at most: a misbehaving viewer must not flood the log. */
const dropLog = new Map<string, number>()
const droppedWrite = (room: string) => () => {
  const now = Date.now()
  if ((dropLog.get(room) ?? 0) > now - 60_000) return
  dropLog.set(room, now)
  console.log(`dropped write from a view-key connection (room ${room})`)
}
/** One hub per loaded room: one process per YPERSISTENCE volume, so one authority per room (hub spec §6). */
const hubs = new ServerHubs({ store: incarnationFile(process.env.YPERSISTENCE, PORT), log: l => console.log(l), full: room => docMeter(room).size() > DOC_MAX_BYTES })
const stockPersistence = getPersistence() as { provider: PersistenceProvider } | null
if (stockPersistence) setPersistence(hubs.persistence(stockPersistence.provider))
setInterval(() => hubs.tick(), 1000).unref()
// The docs map (and persistence) is keyed by the DECODED room name, the same key admission, closing,
// expiry and the size cap use; y-websocket's default would key by the raw, possibly double-encoded path.
wss.on('connection', (conn, req) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const raw = docNameOf(req.url ?? '/')
  const repo = canonical(raw)
  const docName = url.searchParams.get('schema') === '2' || rooms.get(repo)?.mode === 'repo' ? repo : raw
  setupWSConnection(conn, req, { gc: true, docName })
  hubs.ensure(docName, docs.get(docName)!)
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
  socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`)
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
  const url = new URL(req.url ?? '/', 'http://x')
  const roomName = roomNameOf(url.pathname)
  const repo = canonical(roomName)
  const docKey = url.searchParams.get('schema') === '2' || rooms.get(repo)?.mode === 'repo' ? repo : roomName
  if (url.searchParams.get('schema') !== '2' && rooms.get(repo)?.mode === 'repo') return refuse(socket, 403, upgradeText(repo), roomName)
  const accept = (opts: { readOnly?: boolean; login?: string; id?: string; provider?: Provider } = {}) => rooms.has(repo)
    ? wss.handleUpgrade(req, socket, head, ws => {
      const entry = rooms.get(repo)!
      entry.lastSeen = Date.now(); void saveRooms()
      // Innermost wrapper (installed first): the outer ones pass type 7 through to it.
      bindHub(ws, () => hubs.current(docKey), opts.readOnly ? { readOnly: true } : { login: opts.login, readOnly: false })
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
      capDocSize(ws, bytes => meter.size(bytes), DOC_MAX_BYTES, size => {
        const now = Date.now()
        if ((capLogged.get(repo) ?? 0) < now - 60_000) { capLogged.set(repo, now); console.log(`refusing writes: room ${repo} is ${(size / 1048576).toFixed(1)} MB (cap ${(DOC_MAX_BYTES / 1048576).toFixed(0)} MB); close and reopen the repo, or raise ROOM_DOC_MAX_MB`) }
        ws.close(4413, sizeCapReason(DOC_MAX_BYTES))
      })
      wss.emit('connection', ws, req)
    })
    : refuse(socket, 404, `Not Found: ${NOT_OPEN(roomName)}`)
  const view = url.searchParams.get('view')
  if (view) {
    const v = viewTokens.get(view)
    if (v && v.exp > Date.now() && v.room === docKey) return accept({ readOnly: true })
    return refuse(socket, 403, 'Forbidden: view token invalid for this room')
  }
  const c: Creds = { gh: url.searchParams.get('gh') ?? undefined, token: url.searchParams.get('token') ?? undefined, session: url.searchParams.get('session') ?? undefined }
  admitted(roomName, c)
    .then(async v => {
      if (!v.ok) return refuse(socket, v.status, v.why, roomName)
      const entry = rooms.get(repo)
      if (!entry) return refuse(socket, 404, `Not Found: ${NOT_OPEN(roomName)}`)
      if (url.searchParams.get('schema') !== '2') {
        if (entry.mode === 'repo') return refuse(socket, 403, upgradeText(repo), roomName)
        return accept({ login: v.login, id: v.id, provider: v.provider })
      }
      await migrateOpenRepo(repo)
      if (!rooms.has(repo)) return refuse(socket, 404, `Not Found: ${NOT_OPEN(roomName)}`)
      return accept({ login: v.login, id: v.id, provider: v.provider })
    })
    .catch(() => refuse(socket, 403, 'Forbidden', roomName))
})
function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!) }
void roomsLoaded.then(() => server.listen(PORT, HOST, () => console.log(
  `room server listening on ws://${HOST}:${PORT}/<room>` +
  (auth.fake ? ' (FAKE GitHub login: test issuer, any fakeLogin is accepted)' : auth.mode === 'device' ? ' (GitHub login via device flow)' : ' (no GitHub login: github.com rooms refused; set GITHUB_CLIENT_ID)') +
  (auth.providers.includes('oidc') ? ` (OIDC login via ${oidcIssuer})` : '') +
  (TOKEN ? ' (shared token accepted for non-GitHub rooms)' : '') +
  (process.env.DATABASE_URL ? ' registry/sessions/audit in Postgres' : '') +
  (process.env.YPERSISTENCE ? ` persisting to ${process.env.YPERSISTENCE}` : ' (in-memory: rooms reset on restart)'),
)))
