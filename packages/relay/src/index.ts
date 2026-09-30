/**
 * @room/relay — the local room relay. No server: the first process to join a clone's local
 * room starts a tiny y-websocket relay on 127.0.0.1 (with private memory snapshots) and records it in
 * `<git common dir>/room/relay.json` (mode 0600, with a random key every websocket must
 * present). The relay binds a port derived from the common dir, so two processes starting at
 * the same moment cannot end up in two rooms: one binds, the other gets EADDRINUSE and joins.
 * Later processes find the file, check the relay answers as a room relay, and connect. Only the
 * holder of the clone's authority lock (hub.ts) runs a relay, and each relay room runs the room's
 * hub (@room/hub-core) behind message type 7. When the owner exits, any remaining client notices
 * within a couple of seconds, recovers the lock from the dead owner and starts a relay on the same
 * port, seeded from its own replica; the others reconnect to it. Every client holds the full
 * document, so a relay restart loses nothing: clients sync their state back into the new one.
 */
import { RoomMemory, memoryFile } from './memory.js'
import { catchUpLocal, forgetLegacyLocal } from './local-migrate.js'
export { legacyRelayRunning } from './local-migrate.js'
import { pidAlive } from './process.js'
import { AuthorityLock, holderDeadCheck, hubDir, incarnationFile } from './hub.js'
export { RoomMemory, memoryFile, loadMemory, saveMemory } from './memory.js'
export { AuthorityLock } from './hub.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { MSG_HUB, STARTING_RETRY_MS, decodeFrame, encodeFrame, startHub, type Hub, type IncarnationStore, type Reply } from '@room/hub-core'
import { RoomDoc } from '@room/shared'

/** Convert a takeover failure into a reported, settled operation for the interval owner. */
export async function observeTakeover(work: () => Promise<void>, report: (error: unknown) => void): Promise<void> {
  try { await work() } catch (error) { try { report(error) } catch { /* reporting must not reject the interval */ } }
}

// ---- a minimal y-websocket relay (the wire protocol of y-websocket 3.x; private memory persistence) ----
const MSG_SYNC = 0, MSG_AWARENESS = 1
interface RelayDoc { doc: Y.Doc; awareness: awarenessProtocol.Awareness; conns: Map<WebSocket, Set<number>>; memory?: RoomMemory; room?: RoomDoc; hub?: Hub; closed?: boolean }
/** A relay started under the clone's authority lock runs a hub per room; test clocks are optional. */
export interface RelayHubOptions { lock: AuthorityLock; mono?: () => number; wall?: () => number }
interface RelayHubRuntime { lock: AuthorityLock; store: IncarnationStore; mono: () => number; wall: () => number; holderDead: ReturnType<typeof holderDeadCheck> }
interface DocOptions { commonDir?: string; log?: (line: string) => void; hub?: RelayHubRuntime; seed?: { room: string; update: Uint8Array } }
function relayDocs(): Map<string, RelayDoc> { return new Map() }
function send(conn: WebSocket, buf: Uint8Array): void {
  if (conn.readyState !== conn.OPEN) return
  try { conn.send(buf) } catch { try { conn.close() } catch { /* gone */ } }
}
function getDoc(docs: Map<string, RelayDoc>, name: string, opts: DocOptions): RelayDoc {
  let d = docs.get(name)
  if (d) return d
  const memory = opts.commonDir ? new RoomMemory(opts.commonDir, decodeURIComponent(name), opts.log) : undefined
  const doc = memory?.doc ?? new Y.Doc({ gc: true })
  if (doc.getMap('meta').get('schemaVersion') !== 2) doc.getMap('meta').set('schemaVersion', 2)
  if (opts.commonDir) catchUpLocal(opts.commonDir, decodeURIComponent(name), doc, opts.log)
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalState(null)
  d = { doc, awareness, conns: new Map(), memory }
  doc.on('update', (update: Uint8Array) => {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeUpdate(enc, update)
    const buf = encoding.toUint8Array(enc)
    for (const c of d!.conns.keys()) send(c, buf)
  })
  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const changed = [...added, ...updated, ...removed]
    if (origin && d!.conns.has(origin as WebSocket)) {
      const ids = d!.conns.get(origin as WebSocket)!
      for (const id of added) ids.add(id)
      for (const id of removed) ids.delete(id)
    }
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_AWARENESS)
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
    const buf = encoding.toUint8Array(enc)
    for (const c of d!.conns.keys()) send(c, buf)
  })
  docs.set(name, d)
  // A successor starts from its own replica before anyone connects, so its hub sees every grant it saw.
  if (opts.seed && name === encodeURIComponent(opts.seed.room)) Y.applyUpdate(doc, opts.seed.update)
  if (opts.hub) startRoomHub(d, decodeURIComponent(name), opts.hub, opts.log ?? (() => {}))
  return d
}
function startRoomHub(d: RelayDoc, room: string, rt: RelayHubRuntime, log: (line: string) => void): void {
  const roomDoc = d.room = new RoomDoc(d.doc)
  startHub({ doc: roomDoc, mono: rt.mono, wall: rt.wall, log: line => log(`local room ${room}: ${line}`), store: rt.store, holderDead: rt.holderDead, authority: () => rt.lock.held() })
    .then(hub => {
      if (d.closed) { hub.stop(); return }
      hub.onPush((conn, push) => send(conn as WebSocket, encodeFrame(push)))
      d.hub = hub
    })
    .catch(e => log(`local room ${room}: the hub could not start: ${e instanceof Error ? e.message : e}`))
}
function hubReply(d: RelayDoc, conn: WebSocket, dec: decoding.Decoder, hubOn: boolean): Reply {
  let frame: unknown
  try { frame = decodeFrame(dec) } catch { frame = undefined }
  const id = (frame as { id?: unknown } | undefined)?.id
  const re = typeof id === 'string' ? id : ''
  if (!hubOn) return { v: 1, re, ok: false, reason: 'not-authority', text: 'not the authority; reconnect' }
  if (!d.hub) return { v: 1, re, ok: false, reason: 'starting', text: 'the hub is starting', retryMs: STARTING_RETRY_MS }
  return d.hub.handle(conn, frame, { local: true })
}
function attach(docs: Map<string, RelayDoc>, conn: WebSocket, req: http.IncomingMessage, opts: DocOptions): void {
  const name = encodeURIComponent(decodeURIComponent((req.url ?? '/').slice(1).split('?')[0]))
  const d = getDoc(docs, name, opts)
  d.conns.set(conn, new Set())
  conn.binaryType = 'arraybuffer'
  conn.on('message', (raw: ArrayBuffer | Buffer | Buffer[]) => {
    const buf = raw instanceof ArrayBuffer ? new Uint8Array(raw) : Array.isArray(raw) ? new Uint8Array(Buffer.concat(raw)) : new Uint8Array(raw)
    try {
      const dec = decoding.createDecoder(buf)
      const enc = encoding.createEncoder()
      switch (decoding.readVarUint(dec)) {
        case MSG_SYNC:
          encoding.writeVarUint(enc, MSG_SYNC)
          syncProtocol.readSyncMessage(dec, enc, d.doc, conn)
          if (encoding.length(enc) > 1) send(conn, encoding.toUint8Array(enc))
          break
        case MSG_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(d.awareness, decoding.readVarUint8Array(dec), conn)
          break
        case MSG_HUB:
          send(conn, encodeFrame(hubReply(d, conn, dec, !!opts.hub)))
          break
      }
    } catch { /* malformed message: ignore */ }
  })
  const bye = () => {
    if (!d.conns.has(conn)) return
    const ids = d.conns.get(conn)
    d.conns.delete(conn)
    d.hub?.closed(conn)
    if (ids?.size) awarenessProtocol.removeAwarenessStates(d.awareness, Array.from(ids), null)
    if (!d.conns.size && !d.closed) d.memory?.flush() // a closed relay already saved its last state
  }
  conn.on('close', bye); conn.on('error', bye)
  // Sync step 1 and the current awareness states, as y-websocket's server does.
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_SYNC)
  syncProtocol.writeSyncStep1(enc, d.doc)
  send(conn, encoding.toUint8Array(enc))
  const states = d.awareness.getStates()
  if (states.size) {
    const aenc = encoding.createEncoder()
    encoding.writeVarUint(aenc, MSG_AWARENESS)
    encoding.writeVarUint8Array(aenc, awarenessProtocol.encodeAwarenessUpdate(d.awareness, Array.from(states.keys())))
    send(conn, encoding.toUint8Array(aenc))
  }
}

export interface LocalRelayInfo { schema: 2; port: number; pid: number; room: string; startedAt: number; key: string }

export interface LocalRelay {
  /** ws://127.0.0.1:<port> */
  url: string
  /** http://127.0.0.1:<port>: the browser view (same machine only). */
  httpUrl: string
  port: number
  /** Secret every websocket to this relay must carry as ?key=; lives in room/relay.json (0600). */
  key: string
  /** True when this process runs the relay. */
  owned: boolean
  /** Set when this clone's relay port is now served by another relay: the session must join afresh. */
  readonly lost?: string
  /** Forget this room's saved memory until the relay next restarts. */
  forget?(): Promise<void>
  stop(): Promise<void>
}

export const LOCAL_FILE = path.join('room', 'relay.json')

export function relayFile(commonDir: string): string { return path.join(commonDir, LOCAL_FILE) }

export function readRelayInfo(commonDir: string): LocalRelayInfo | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(relayFile(commonDir), 'utf8')) as Partial<LocalRelayInfo>
    return v.schema === 2 && typeof v.port === 'number' && typeof v.pid === 'number' && typeof v.key === 'string' && v.key
      ? { schema: 2, port: v.port, pid: v.pid, room: String(v.room ?? ''), startedAt: Number(v.startedAt ?? 0), key: v.key }
      : undefined
  } catch { return undefined }
}

/** The port a clone's relay binds: derived from the common git dir, so racers collide on purpose (40000-59999). */
export function deterministicPort(commonDir: string): number {
  let real = commonDir
  try { real = fs.realpathSync.native(commonDir) } catch { /* use as given */ }
  const h = crypto.createHash('sha1').update('schema-2\0').update(real).digest()
  return 40000 + (h.readUInt32BE(0) % 20000)
}

/** Which clone a relay serves: a hash of its git common dir (the path itself is never sent). */
export function cloneId(commonDir: string): string {
  let real = commonDir
  try { real = fs.realpathSync.native(commonDir) } catch { /* use as given */ }
  return crypto.createHash('sha256').update(real).digest('hex')
}

/**
 * Who answers on 127.0.0.1:port: 'ours' is a relay for this clone that accepts `key`; 'foreign' is a
 * room relay for another clone or with another key (a stale or inconsistent discovery file); 'none' is
 * nothing, or something that is not a room relay.
 */
export async function probeRelay(port: number, commonDir: string, key: string, timeoutMs = 800): Promise<'ours' | 'foreign' | 'none'> {
  const h = await health(port, key, timeoutMs)
  if (h?.local !== true || h.schema !== 2 || h.hub !== 1) return 'none'
  return h.clone === cloneId(commonDir) && h.key === true ? 'ours' : 'foreign'
}

function health(port: number, key: string | undefined, timeoutMs: number): Promise<{ local?: unknown; schema?: unknown; hub?: unknown; clone?: unknown; key?: unknown } | undefined> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs, ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}) }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : undefined) } catch { resolve(undefined) } })
    })
    req.on('timeout', () => { req.destroy(); resolve(undefined) })
    req.on('error', () => resolve(undefined))
  })
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json' }

/**
 * Where the built browser view lives: ROOM_WEB_DIST, else `web/` next to the plugin bundle's
 * `server/` dir (plugins/room/web), else packages/web/dist for source runs. Undefined when none exists.
 */
export function findWebDist(): string | undefined {
  const here = path.dirname(new URL(import.meta.url).pathname)
  const candidates = [
    process.env.ROOM_WEB_DIST,
    path.resolve(here, '..', 'web'),            // plugins/room/server/room-mcp.mjs -> plugins/room/web
    path.resolve(here, '..', '..', 'web', 'dist'), // packages/relay/src -> packages/web/dist
    path.resolve(here, '..', '..', '..', 'web', 'dist'),
  ]
  for (const c of candidates) if (c && fs.existsSync(path.join(c, 'index.html'))) return c
  return undefined
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
function isLoopback(addr: string | undefined): boolean { return !!addr && LOOPBACK.has(addr) }

export interface RelayOptions {
  staticDir?: string
  key?: string
  commonDir?: string
  log?: (line: string) => void
  /** The clone's authority lock (needs `commonDir`): each room runs its hub, and closing releases the lock.
   *  Without it every hub request is answered `not-authority`. */
  hub?: RelayHubOptions
  /** Applied to that room's doc before anyone connects: a successor's own replica. */
  seed?: { room: string; update: Uint8Array }
}
export interface StartedRelay {
  port: number
  close(): Promise<void>
  /** A room's doc and its hub once started (tests drive hubs on fake clocks through this). */
  hubRoom(room: string): { doc: RoomDoc; hub?: Hub } | undefined
}

/** Start a relay on 127.0.0.1:port (0 = any free port). Rejects with EADDRINUSE when someone else won the race.
 *  Also serves the browser view (staticDir, default findWebDist()) at / and a /health line, so a local
 *  room has a projector link like a hosted one. Websockets are accepted from loopback only, and when
 *  `key` is set they must carry it as ?key= (the /health line stays open so joiners can recognise a relay). */
export function startRelay(port: number, opts: RelayOptions = {}): Promise<StartedRelay> {
  return new Promise((resolve, reject) => {
    if (opts.hub && !opts.commonDir) throw new Error("a relay hub needs the clone's common dir")
    const docOptions: DocOptions = {
      commonDir: opts.commonDir, log: opts.log, seed: opts.seed,
      ...(opts.hub ? { hub: { lock: opts.hub.lock, store: incarnationFile(opts.commonDir!), mono: opts.hub.mono ?? (() => performance.now()), wall: opts.hub.wall ?? Date.now, holderDead: holderDeadCheck() } } : {}),
    }
    const staticDir = opts.staticDir ? path.resolve(opts.staticDir) : findWebDist()
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/health') {
        // Open to joiners; with the clone's key it also confirms the key, so a stale discovery file is never trusted.
        const keyOk = !!opts.key && isLoopback(req.socket.remoteAddress) && req.headers.authorization === 'Bearer ' + opts.key
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, local: true, schema: 2, hub: 1, ...(opts.commonDir ? { clone: cloneId(opts.commonDir) } : {}), ...(keyOk ? { key: true } : {}) }))
        return
      }
      if (req.method === 'DELETE' && url.pathname === '/memory') {
        if (!opts.key || req.headers.authorization !== 'Bearer ' + opts.key || !isLoopback(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return }
        try {
          const room = url.searchParams.get('room') ?? ''
          const d = docs.get(encodeURIComponent(room))
          if (d?.memory) d.memory.forget()
          else if (opts.commonDir) fs.rmSync(memoryFile(opts.commonDir, room), { force: true })
          if (opts.commonDir) forgetLegacyLocal(opts.commonDir, room)
          res.writeHead(204); res.end()
        } catch { res.writeHead(500); res.end('could not forget local memory') }
        return
      }
      if (staticDir) {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
        const file = path.resolve(staticDir, rel)
        if (file.startsWith(staticDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
          fs.createReadStream(file).pipe(res)
          return
        }
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(staticDir ? 'room local relay\n' : 'room local relay (no browser view built: run npm run build -w @room/web)\n')
    })
    const wss = new WebSocketServer({ noServer: true })
    const docs = relayDocs()
    wss.on('connection', (conn, req) => attach(docs, conn, req, docOptions))
    const ticker = setInterval(() => {
      for (const [name, d] of docs) {
        d.hub?.tick()
        if (opts.commonDir && d.memory) try { catchUpLocal(opts.commonDir, decodeURIComponent(name), d.doc, opts.log) }
        catch (error) { opts.log?.(`local migration: ${error instanceof Error ? error.message : String(error)}`) }
      }
    }, 1000)
    ticker.unref?.()
    server.on('upgrade', (req, socket, head) => {
      const refuse = (code: number, why: string) => { socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`); socket.destroy() }
      if (!isLoopback(req.socket.remoteAddress)) return refuse(403, 'Forbidden')
      if (new URL(req.url ?? '/', 'http://x').searchParams.get('schema') !== '2') return refuse(426, 'update Room to 0.17 or later: this local room uses schema 2')
      try { decodeURIComponent((req.url ?? '/').split('?')[0]) } catch { return refuse(400, 'Bad Request') }
      if (opts.key) {
        const given = new URL(req.url ?? '/', 'http://x').searchParams.get('key') ?? ''
        const a = Buffer.from(given), b = Buffer.from(opts.key)
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return refuse(403, 'Forbidden: local room key missing or wrong')
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    })
    const signals = ['SIGTERM', 'SIGINT'] as const
    let closing: Promise<void> | undefined
    const onSignal = () => { void close() }
    const close = (): Promise<void> => closing ??= new Promise<void>(done => {
      for (const signal of signals) process.off(signal, onSignal)
      clearInterval(ticker)
      for (const d of docs.values()) { d.closed = true; d.hub?.stop(); d.memory?.close() }
      for (const c of wss.clients) c.terminate()
      wss.close(); server.close(() => {
        for (const d of docs.values()) { d.awareness.destroy(); d.doc.destroy() }
        docs.clear()
        opts.hub?.lock.release()
        done()
      })
    })
    server.once('error', e => { clearInterval(ticker); reject(e) })
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const bound = typeof addr === 'object' && addr ? addr.port : port
      for (const signal of signals) process.on(signal, onSignal)
      resolve({
        port: bound,
        close,
        hubRoom(room) {
          const d = docs.get(encodeURIComponent(room))
          return d?.room ? { doc: d.room, ...(d.hub ? { hub: d.hub } : {}) } : undefined
        },
      })
    })
  })
}

/**
 * Find the clone's local relay or become it. Then keep watching: if the relay dies and this
 * process is still around, take over on the same port so connected providers reconnect
 * without a URL change.
 *
 * Starting is race-free: only the holder of the clone's authority lock starts a relay, on the
 * port derived from the common dir; the others wait for its discovery file and join. If that
 * port is held by something that is not a room relay, the lock holder uses any free port.
 * `seed` returns this process's replica of the room: a takeover starts the relay from it.
 */
export class NoLocalRelay extends Error {
  constructor(room: string) { super(`no running local relay for ${room}`); this.name = 'NoLocalRelay' }
}

export async function ensureLocalRelay(commonDir: string, room: string, opts: { log?: (line: string) => void; watchMs?: number; staticDir?: string; seed?: () => Uint8Array; joinOnly?: boolean } = {}): Promise<LocalRelay> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  let owned: StartedRelay | null = null
  let port = 0
  let key = ''
  /** Publish the discovery file atomically: readers see the old file or the new one, never a partial one. */
  const write = () => {
    const file = relayFile(commonDir), tmp = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, JSON.stringify({ schema: 2, port, pid: process.pid, room, startedAt: Date.now(), key } satisfies LocalRelayInfo) + '\n', { mode: 0o600 })
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, file)
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to clean */ }
      log(`local relay: could not write ${file}: ${e instanceof Error ? e.message : e}`)
    }
  }
  /** The relay recorded in the file, if it serves this clone and accepts the recorded key; otherwise the file is stale. */
  const recorded = async (): Promise<LocalRelayInfo | undefined> => {
    const info = readRelayInfo(commonDir)
    if (!info) return undefined
    const who = await probeRelay(info.port, commonDir, info.key)
    if (who === 'foreign') log(`local room ${room}: ${relayFile(commonDir)} names a relay on 127.0.0.1:${info.port} that does not serve this clone with its key; treating the file as stale`)
    return who === 'ours' ? info : undefined
  }
  const adopt = (info: LocalRelayInfo, how: string) => {
    port = info.port; key = info.key
    log(`local room ${room}: ${how} relay on 127.0.0.1:${port} (pid ${info.pid}${pidAlive(info.pid) ? '' : ', pid gone but relay answers'})`)
  }

  /** Start this clone's relay under the authority lock; closing the relay releases the lock. */
  const start = (at: number, lock: AuthorityLock, seed?: Uint8Array): Promise<StartedRelay> =>
    startRelay(at, { key, staticDir: opts.staticDir, commonDir, log, hub: { lock }, ...(seed ? { seed: { room, update: seed } } : {}) })
  /** Another process holds the lock and is starting the relay: wait for its discovery file. */
  const awaitWinner = async (): Promise<LocalRelayInfo | undefined> => {
    let winner: LocalRelayInfo | undefined
    for (let i = 0; i < 20 && !winner; i++) { await new Promise(r => setTimeout(r, 100)); winner = await recorded() }
    return winner
  }

  const existing = await recorded()
  if (existing) adopt(existing, 'joined')
  else {
    if (opts.joinOnly) throw new NoLocalRelay(room)
    key = readRelayInfo(commonDir)?.key ?? crypto.randomBytes(16).toString('hex')
    const want = deterministicPort(commonDir)
    const lock = AuthorityLock.take(commonDir)
    if (!lock) {
      const winner = await awaitWinner()
      if (!winner) throw new Error(`local room ${room}: another process holds ${path.join(hubDir(commonDir), 'authority.lock')} but no relay answers; retry, or remove the lock if its process is gone`)
      adopt(winner, 'another process holds the relay authority; joined')
    } else {
      try {
        try { owned = await start(want, lock) }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e
          owned = await start(0, lock)
          log(`local room ${room}: port ${want} is taken by something else; using a free port`)
        }
      } catch (e) { lock.release(); throw e }
      port = owned.port
      write()
      log(`local room ${room}: started relay on 127.0.0.1:${port}`)
    }
  }

  let stopped = false
  let lost: string | undefined
  let ticking: Promise<void> | null = null
  const tick = async () => {
    if (stopped || owned || lost) return
    const who = await probeRelay(port, commonDir, key)
    if (stopped || who === 'ours') return
    if (who === 'foreign') {
      lost = `127.0.0.1:${port} is now another clone's relay`
      log(`local room ${room}: ${lost}; the session will join afresh`)
      return
    }
    if (opts.joinOnly) {
      lost = `the lead's local relay for ${room} is no longer running`
      log(`local room ${room}: ${lost}`)
      return
    }
    // Relay gone: take the authority from its dead owner, then its port. A live lock holder (a stalled
    // owner, or a survivor that won) keeps it; we reconnect to whoever serves.
    const lock = AuthorityLock.take(commonDir)
    if (!lock) return
    let started: StartedRelay
    try { started = await start(port, lock, opts.seed?.()) } catch { lock.release(); return /* the port is someone else's for now */ }
    if (stopped) { await started.close(); return }
    owned = started
    write()
    log(`local room ${room}: relay owner left; took over on 127.0.0.1:${port}`)
  }
  // One takeover attempt at a time; stop() waits for the one in flight.
  const timer = setInterval(() => {
    if (ticking) return
    const work = observeTakeover(tick, error => log(`local room ${room}: relay takeover failed: ${error instanceof Error ? error.message : String(error)}`))
    ticking = work
    void work.then(() => { if (ticking === work) ticking = null })
  }, opts.watchMs ?? 2000)
  timer.unref?.()

  return {
    url: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    port,
    key,
    get owned() { return owned !== null },
    get lost() { return lost },
    async forget() {
      const response = await fetch('http://127.0.0.1:' + port + '/memory?room=' + encodeURIComponent(room), {
        method: 'DELETE', headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error('could not forget local room memory: ' + response.status)
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      await ticking
      // The file stays: it records the port and key the survivors will take over with, and new
      // joiners probe the port before trusting it.
      if (owned) { await owned.close(); owned = null }
    },
  }
}
