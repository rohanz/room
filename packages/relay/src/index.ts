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
import { AuthorityLock, holderDeadCheck, hubDir, incarnationFile, relayLeaseFile } from './hub.js'
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
import { DOC_SIZE_CAP_CODE, DocSizeMeter, HUB_ORIGIN, MSG_HUB, STARTING_RETRY_MS, MAX_HUB_FRAME_BYTES, HubRequestBudget, hubReplyId, decodeFrame, encodeFrame, sizeCapReason, sizeCapRefusal, startHub, type DocSizeMeterOptions, type Hub, type IncarnationStore, type Reply } from '@room/hub-core'
import { ROOM_DOC_MAX_BYTES, RoomDoc } from '@room/shared'
import { ProofVerifier, localProofHeader, localViewKey, relayHealth, relayIdentity, relayProof, sameProof, viewTicketProof, PROOF_WINDOW_MS } from './proof.js'
import { SecureSession } from './secure.js'
export { SecureSession } from './secure.js'
export { localProofHeader, localViewKey, relayHealth, relayIdentity, relayProof, viewTicketProof, ProofVerifier } from './proof.js'
class HttpFailure extends Error { constructor(public status: number, message: string) { super(message) } }
export function safeUrl(target: string | undefined): URL {
  if (!target || !target.startsWith('/') || target.startsWith('//') || /[\x00-\x1f\x7f]/.test(target)) throw new HttpFailure(400, 'Bad Request')
  try { return new URL(target, 'http://x') } catch { throw new HttpFailure(400, 'Bad Request') }
}

/** Convert a takeover failure into a reported, settled operation for the interval owner. */
export async function observeTakeover(work: () => Promise<void>, report: (error: unknown) => void): Promise<void> {
  try { await work() } catch (error) { try { report(error) } catch { /* reporting must not reject the interval */ } }
}

// ---- a minimal y-websocket relay (the wire protocol of y-websocket 3.x; private memory persistence) ----
const MSG_SYNC = 0, MSG_AWARENESS = 1
export const RELAY_STATE_REQUESTS_PER_MINUTE = 10
export const RELAY_STATE_QUEUE_BYTES = 1024 * 1024
export function stateRequestLimiter(now: () => number = Date.now): (buf: Uint8Array, queued: number) => boolean {
  let started = now(), count = 0
  return (buf, queued) => {
    try {
      const dec = decoding.createDecoder(buf)
      const kind = decoding.readVarUint(dec)
      if (kind !== 3 && (kind !== MSG_SYNC || decoding.readVarUint(dec) !== syncProtocol.messageYjsSyncStep1)) return true
    } catch { return true }
    if (now() - started >= 60_000) { started = now(); count = 0 }
    return ++count <= RELAY_STATE_REQUESTS_PER_MINUTE && queued <= RELAY_STATE_QUEUE_BYTES
  }
}
interface RelayDoc { doc: Y.Doc; awareness: awarenessProtocol.Awareness; conns: Map<WebSocket, Set<number>>; memory?: RoomMemory; room?: RoomDoc; hub?: Hub; closed?: boolean; cap: RoomCap }
/** The live size cap of one room (the server's rule, hub-core/src/doc-cap.ts) and when it last logged a refusal. */
interface RoomCap { maxBytes: number; meter: DocSizeMeter; logged: number }
/** A room's live document cap; by default ROOM_DOC_MAX_BYTES (also the snapshot ceiling), measured at the server's cadence. */
export interface RelayDocCap { maxBytes?: number; meter?: DocSizeMeterOptions }
/** A relay started under the clone's authority lock runs a hub per room; test clocks are optional. */
export interface RelayHubOptions { lock: AuthorityLock; mono?: () => number; wall?: () => number }
interface RelayHubRuntime { lock: AuthorityLock; store: IncarnationStore; mono: () => number; wall: () => number; holderDead: ReturnType<typeof holderDeadCheck> }
interface DocOptions { commonDir?: string; log?: (line: string) => void; hub?: RelayHubRuntime; seed?: { room: string; update: Uint8Array }; readOnly?: boolean; socketQueueBytes?: number; docCap?: RelayDocCap }
function relayDocs(): Map<string, RelayDoc> { return new Map() }
/** One full document (the 64 MiB snapshot ceiling) plus slack may wait for one socket; four such queues for all. */
export const RELAY_SOCKET_QUEUE_BYTES = 68 * 1024 * 1024
export const RELAY_TOTAL_QUEUE_BYTES = 256 * 1024 * 1024
export function relayOutputAllowed(queued: number, aggregateQueued: number, nextBytes: number, socketBudget = RELAY_SOCKET_QUEUE_BYTES): boolean {
  return (queued === 0 || queued + nextBytes <= socketBudget) && aggregateQueued + nextBytes <= RELAY_TOTAL_QUEUE_BYTES
}
/** A relay started with its own per-socket budget (RelayOptions.socketQueueBytes) records it per connection. */
const socketBudgets = new WeakMap<WebSocket, number>()
const sessions = new WeakMap<WebSocket, SecureSession>()
const handshakeCleanup = new WeakMap<WebSocket, () => void>()
const failedSockets = new WeakSet<WebSocket>()
const queued = new Map<WebSocket, number>()
let totalQueued = 0
let stateReservation = 0
function dropSocket(conn: WebSocket): void {
  totalQueued -= queued.get(conn) ?? 0
  queued.delete(conn)
}
function full(conn: WebSocket): void {
  conn.close(1013, 'relay output queue full')
  setTimeout(() => { if (conn.readyState !== conn.CLOSED) conn.terminate() }, 1000).unref?.()
}
function capacityFor(bytes: number, except: WebSocket): boolean {
  if (totalQueued + stateReservation + bytes > RELAY_TOTAL_QUEUE_BYTES) {
    for (const [slow, amount] of [...queued].sort((a, b) => b[1] - a[1])) {
      if (totalQueued + stateReservation + bytes <= RELAY_TOTAL_QUEUE_BYTES) break
      if (slow === except || amount === 0) continue
      // Discard its queued bytes immediately, so the replacement frame never shares
      // the process budget with a slow reader's pending output.
      slow.close(1013, 'relay output queue full')
      slow.terminate()
      dropSocket(slow)
    }
  }
  return totalQueued + stateReservation + bytes <= RELAY_TOTAL_QUEUE_BYTES
}
function send(conn: WebSocket, buf: Uint8Array): void {
  if (conn.readyState !== conn.OPEN) return
  const session = sessions.get(conn)
  if (!session?.ready) return
  const bytes = buf.byteLength + 16
  const own = queued.get(conn) ?? 0
  if (own > 0 && own + bytes > (socketBudgets.get(conn) ?? RELAY_SOCKET_QUEUE_BYTES)) { full(conn); return }
  if (!capacityFor(bytes, conn)) { full(conn); return }
  try {
    const frame = session.encrypt(buf)
    queued.set(conn, own + bytes); totalQueued += bytes
    conn.send(frame, error => {
      if (queued.has(conn)) { queued.set(conn, Math.max(0, (queued.get(conn) ?? 0) - bytes)); totalQueued -= bytes }
      if (error) full(conn)
    })
  } catch { dropSocket(conn); try { conn.close() } catch { /* gone */ } }
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
  const meter = new DocSizeMeter(() => Y.encodeStateAsUpdate(doc).byteLength, opts.docCap?.meter)
  d = { doc, awareness, conns: new Map(), memory, cap: { maxBytes: opts.docCap?.maxBytes ?? ROOM_DOC_MAX_BYTES, meter, logged: 0 } }
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    // Hub writes count towards the next measurement, as the server's do.
    if (origin === HUB_ORIGIN) meter.size(update.byteLength)
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
  if (opts.hub) startRoomHub(d, decodeURIComponent(name), opts.hub, opts.commonDir!, opts.log ?? (() => {}))
  return d
}
function startRoomHub(d: RelayDoc, room: string, rt: RelayHubRuntime, commonDir: string, log: (line: string) => void): void {
  const roomDoc = d.room = new RoomDoc(d.doc)
  startHub({ doc: roomDoc, mono: rt.mono, wall: rt.wall, log: line => log(`local room ${room}: ${line}`), store: rt.store, leases: relayLeaseFile(commonDir, room), holderDead: rt.holderDead, authority: () => rt.lock.held(),
    full: () => d.cap.meter.size() > d.cap.maxBytes })
    .then(hub => {
      if (d.closed) { hub.stop(); return }
      hub.onPush((conn, push) => send(conn as WebSocket, encodeFrame(push)))
      d.hub = hub
    })
    .catch(e => log(`local room ${room}: the hub could not start: ${e instanceof Error ? e.message : e}`))
}
const hubBudget = new HubRequestBudget()
/** The raw type-7 frame is checked before decode, even while the hub is unavailable. */
export function hubReply(d: RelayDoc, conn: WebSocket, raw: Uint8Array, hubOn: boolean, readOnly = false): Reply {
  const retryMs = hubBudget.take(conn)
  if (retryMs) return { v: 1, re: '', ok: false, reason: 'rate-limited', text: 'hub requests too frequent', retryMs }
  if (raw.byteLength > MAX_HUB_FRAME_BYTES) return { v: 1, re: '', ok: false, reason: 'too-large', text: 'hub request exceeds the frame limit' }
  let frame: unknown
  try { frame = decodeFrame(raw) } catch { frame = undefined }
  const re = hubReplyId(frame)
  if (!hubOn) return { v: 1, re, ok: false, reason: 'not-authority', text: 'not the authority; reconnect' }
  if (readOnly) return { v: 1, re, ok: false, reason: 'read-only', text: 'this connection is read-only' }
  if (!d.hub) return { v: 1, re, ok: false, reason: 'starting', text: 'the hub is starting', retryMs: STARTING_RETRY_MS }
  return d.hub.handle(conn, frame, { local: true }, raw.byteLength)
}
function attach(docs: Map<string, RelayDoc>, conn: WebSocket, req: http.IncomingMessage, opts: DocOptions & { key: string }): void {
  const name = encodeURIComponent(decodeURIComponent((req.url ?? '/').slice(1).split('?')[0]))
  const room = decodeURIComponent(name)
  const session = new SecureSession(opts.readOnly ? localViewKey(opts.key, room) : opts.key, room, 'relay')
  sessions.set(conn, session)
  const timer = setTimeout(() => conn.close(1008, 'secure handshake timeout'), 5000)
  handshakeCleanup.set(conn, () => { clearTimeout(timer); conn.off('message', handshake); dropSocket(conn); sessions.delete(conn) })
  timer.unref?.()
  let hello = false
  const handshake = (raw: Buffer, binary: boolean) => {
    try {
      if (!binary) throw new Error('binary secure frames required')
      if (!hello) {
        hello = true
        const reply = session.relayHello(raw)
        if (!capacityFor(reply.length, conn)) { full(conn); return }
        queued.set(conn, reply.length); totalQueued += reply.length
        conn.send(reply, error => {
          if (queued.has(conn)) { queued.set(conn, Math.max(0, (queued.get(conn) ?? 0) - reply.length)); totalQueued -= reply.length }
          if (error) full(conn)
        })
        return
      }
      const first = session.decrypt(raw)
      clearTimeout(timer)
      handshakeCleanup.delete(conn)
      conn.off('message', handshake)
      attachReady(docs, conn, name, opts, first)
      conn.emit('message', first, true)
    } catch { clearTimeout(timer); conn.close(1008, 'invalid secure frame') }
  }
  conn.on('message', handshake)
  conn.on('close', () => { handshakeCleanup.get(conn)?.(); handshakeCleanup.delete(conn); clearTimeout(timer); dropSocket(conn); sessions.delete(conn) })
}
function attachReady(docs: Map<string, RelayDoc>, conn: WebSocket, name: string, opts: DocOptions, first: Buffer): void {
  const d = getDoc(docs, name, opts)
  d.conns.set(conn, new Set())
  if (opts.socketQueueBytes) socketBudgets.set(conn, opts.socketQueueBytes)
  const allowState = stateRequestLimiter()
  conn.binaryType = 'arraybuffer'
  conn.on('message', (raw: ArrayBuffer | Buffer | Buffer[]) => {
    let buf: Uint8Array
    try { buf = raw === first ? first : sessions.get(conn)!.decrypt(raw instanceof ArrayBuffer ? new Uint8Array(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw) }
    catch { conn.close(1008, 'invalid secure frame'); return }
    if (!allowState(buf, conn.bufferedAmount)) { conn.close(1013, 'too many state requests'); return }
    // A view connection's writes are ignored below; a writer into a room over its cap is closed as the server does.
    const { cap } = d
    const over = opts.readOnly ? undefined : sizeCapRefusal(buf, bytes => cap.meter.size(bytes), cap.maxBytes)
    if (over !== undefined) {
      const now = Date.now()
      if (cap.logged < now - 60_000) { cap.logged = now; opts.log?.(`local room ${decodeURIComponent(name)}: refusing writes: the document is ${(over / 1048576).toFixed(1)} MB (cap ${(cap.maxBytes / 1048576).toFixed(0)} MB)`) }
      conn.close(DOC_SIZE_CAP_CODE, sizeCapReason(cap.maxBytes))
      return
    }
    try {
      const dec = decoding.createDecoder(buf)
      const enc = encoding.createEncoder()
      switch (decoding.readVarUint(dec)) {
        case MSG_SYNC:
          if (opts.readOnly && decoding.peekVarUint(dec) !== syncProtocol.messageYjsSyncStep1) break
          // Reserve room for a full snapshot before y-protocols allocates its reply.
          // Live docs can exceed the snapshot ceiling; send() still enforces the hard process cap.
          const step1 = decoding.peekVarUint(dec) === syncProtocol.messageYjsSyncStep1
          if (step1 && !capacityFor(RELAY_SOCKET_QUEUE_BYTES, conn)) { full(conn); return }
          if (step1) stateReservation += RELAY_SOCKET_QUEUE_BYTES
          encoding.writeVarUint(enc, MSG_SYNC)
          try { syncProtocol.readSyncMessage(dec, enc, d.doc, conn) }
          finally { if (step1) stateReservation -= RELAY_SOCKET_QUEUE_BYTES }
          if (encoding.length(enc) > 1) send(conn, encoding.toUint8Array(enc))
          break
        case MSG_AWARENESS:
          if (opts.readOnly) break
          awarenessProtocol.applyAwarenessUpdate(d.awareness, decoding.readVarUint8Array(dec), conn)
          break
        case MSG_HUB:
          send(conn, encodeFrame(hubReply(d, conn, buf, !!opts.hub, opts.readOnly)))
          break
      }
    } catch { /* malformed message: ignore */ }
  })
  const bye = () => {
    if (!d.conns.has(conn)) return
    const ids = d.conns.get(conn)
    d.conns.delete(conn)
    dropSocket(conn)
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

/** The first operation on every accepted websocket is its error listener. */
export function relayConnectionHandler(docs: Map<string, RelayDoc>, opts: DocOptions & { key: string }): (conn: WebSocket, req: http.IncomingMessage) => void {
  return (conn, req) => {
    conn.on('error', error => {
      if (failedSockets.has(conn)) return
      failedSockets.add(conn)
      try { opts.log?.(`relay websocket: ${error instanceof Error ? error.message : String(error)}`) } catch { /* cleanup still matters */ }
      handshakeCleanup.get(conn)?.()
      handshakeCleanup.delete(conn)
      sessions.delete(conn)
      dropSocket(conn)
      try { conn.terminate() } catch { /* already gone */ }
    })
    try { safeUrl(req.url); attach(docs, conn, req, { ...opts, readOnly: !!(req as http.IncomingMessage & { ticketView?: boolean }).ticketView }) }
    catch (e) { opts.log?.(`relay connection: ${e instanceof Error ? e.message : e}`); conn.close(1008, 'Bad Request') }
  }
}

export interface LocalRelayInfo { schema: 2; port: number; pid: number; room: string; startedAt: number; key: string; canonicalWarning?: string }

export interface LocalRelay {
  /** ws://127.0.0.1:<port> */
  url: string
  /** http://127.0.0.1:<port>: the relay API (the viewer opens from disk). */
  httpUrl: string
  port: number
  /** Private discovery secret used only to sign requests; lives in room/relay.json (0600). */
  key: string
  /** True when this process runs the relay. */
  owned: boolean
  /** A canonical port occupied by a relay of this clone, while this session uses another port. */
  canonicalWarning?: string
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
      ? { schema: 2, port: v.port, pid: v.pid, room: String(v.room ?? ''), startedAt: Number(v.startedAt ?? 0), key: v.key, ...(typeof v.canonicalWarning === 'string' ? { canonicalWarning: v.canonicalWarning } : {}) }
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
 * Who answers on 127.0.0.1:port: 'ours' is a relay for this clone that proves possession of `key`; 'foreign' is a
 * room relay for another clone or with another key (a stale or inconsistent discovery file); 'none' is
 * nothing, or something that is not a room relay.
 */
export async function probeRelay(port: number, commonDir: string, key: string, timeoutMs = 800): Promise<'ours' | 'foreign' | 'none'> {
  const identity = await relayIdentity(port, key, timeoutMs)
  const h = identity?.health
  if (h?.local !== true || h.schema !== 2 || h.hub !== 1) return 'none'
  // A Room relay that did not prove this clone's key (another clone's, or one holding another key) is foreign.
  return identity!.proven && h.clone === cloneId(commonDir) ? 'ours' : 'foreign'
}

export type RelayIdentity = Awaited<ReturnType<typeof relayIdentity>>
/** Classify an occupied canonical port without trusting the discovery key. */
export function canonicalRelayWarning(port: number, commonDir: string, identity: RelayIdentity, info?: LocalRelayInfo): { roomRelay: boolean; warning?: string } {
  const h = identity?.health
  if (h?.ok !== true || h.local !== true) return { roomRelay: false }
  // 0.16 did not advertise a clone; on this clone's derived port, treat it as this room.
  if (typeof h.clone === 'string' && h.clone !== cloneId(commonDir)) return { roomRelay: true }
  const pid = info?.port === port ? info.pid : typeof h.pid === 'number' ? h.pid : undefined
  const started = info?.port === port && info.startedAt ? new Date(info.startedAt).toISOString() : undefined
  const details = [pid !== undefined ? `pid ${pid}` : undefined, started ? `started ${started}` : undefined].filter(Boolean).join(', ')
  return { roomRelay: true, warning: `an older Room session${details ? ` (${details})` : ''} still holds this room's relay on 127.0.0.1:${port}; quit it or reconnect Room there` }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
function isLoopback(addr: string | undefined): boolean { return !!addr && LOOPBACK.has(addr) }

export interface RelayOptions {
  /** Legacy option ignored: the relay never serves executable viewer content. */
  staticDir?: string
  key?: string
  /** Browser ticket lifetime; default 60 seconds, capped at 60 seconds. */
  ticketTtlMs?: number
  commonDir?: string
  log?: (line: string) => void
  /** The clone's authority lock (needs `commonDir`): each room runs its hub, and closing releases the lock.
   *  Without it every hub request is answered `not-authority`. */
  hub?: RelayHubOptions
  /** Applied to that room's doc before anyone connects: a successor's own replica. */
  seed?: { room: string; update: Uint8Array }
  /** Bytes that may wait for one socket before a consumer already behind is cut off; default RELAY_SOCKET_QUEUE_BYTES. */
  socketQueueBytes?: number
  /** The live document cap per room; default ROOM_DOC_MAX_BYTES. */
  docCap?: RelayDocCap
}
export interface StartedRelay {
  port: number
  close(): Promise<void>
  /** A room's doc and its hub once started (tests drive hubs on fake clocks through this). */
  hubRoom(room: string): { doc: RoomDoc; hub?: Hub } | undefined
}

/** Start a relay on 127.0.0.1:port (0 = any free port). Rejects with EADDRINUSE when someone else won the race.
 *  Serves only API endpoints and a /health line. Websockets are accepted from loopback only, and when
 *  `key` is set they must prove possession without sending it (the /health line stays open). */
export function startRelay(port: number, opts: RelayOptions = {}): Promise<StartedRelay> {
  return new Promise((resolve, reject) => {
    if (opts.hub && !opts.commonDir) throw new Error("a relay hub needs the clone's common dir")
    const docOptions: DocOptions = {
      commonDir: opts.commonDir, log: opts.log, seed: opts.seed, socketQueueBytes: opts.socketQueueBytes, docCap: opts.docCap,
      ...(opts.hub ? { hub: { lock: opts.hub.lock, store: incarnationFile(opts.commonDir!), mono: opts.hub.mono ?? (() => performance.now()), wall: opts.hub.wall ?? Date.now, holderDead: holderDeadCheck() } } : {}),
    }
    const requestedTicketTtl = opts.ticketTtlMs ?? 60_000
    const ticketTtl = Number.isFinite(requestedTicketTtl) ? Math.max(1, Math.min(60_000, requestedTicketTtl)) : 60_000
    const tickets = new Map<string, { room: string; expires: number }>()
    const ticketRate = new Map<string, { count: number; until: number }>()
    const viewNonces = new Map<string, number>()
    let verifier: ProofVerifier | undefined
    const boundPort = () => (server.address() as { port: number } | null)?.port ?? port
    const proofOk = (req: http.IncomingMessage): boolean => !!opts.key && (verifier ??= new ProofVerifier(opts.key, boundPort())).verify(req.headers.authorization, req.method ?? 'GET', req.url ?? '/')
    const obsolete = (req: http.IncomingMessage, url: URL): boolean => /^Bearer /i.test(req.headers.authorization ?? '') || url.searchParams.has('key')
    const viewOk = (value: Record<string, unknown>, room: string, now: number): boolean => {
      if (!opts.key || typeof value.ts !== 'number' || !Number.isSafeInteger(value.ts) || typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(value.nonce)) return false
      if (Math.abs(now - value.ts) > PROOF_WINDOW_MS) return false
      for (const [nonce, expiry] of viewNonces) if (expiry <= now) viewNonces.delete(nonce)
      if (viewNonces.has(value.nonce) || viewNonces.size >= 10_000) return false
      const expected = viewTicketProof(localViewKey(opts.key, room), room, value.ts, value.nonce)
      if (!sameProof(value.proof, expected)) return false
      viewNonces.set(value.nonce, now + PROOF_WINDOW_MS)
      return true
    }
    const server = http.createServer((req, res) => {
      try {
      res.setHeader('Referrer-Policy', 'no-referrer')
      const url = safeUrl(req.url)
      if (obsolete(req, url)) { res.writeHead(400); res.end('use Authorization: Room-Proof or a view proof'); return }
      if (url.pathname === '/ws-ticket' && req.method === 'OPTIONS') {
        // The exchange requires an explicit proof, never ambient credentials.
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type' }); res.end(); return
      }
      if (req.method === 'POST' && url.pathname === '/ws-ticket') {
        res.setHeader('Access-Control-Allow-Origin', '*')
        if (!isLoopback(req.socket.remoteAddress)) { res.writeHead(403); res.end('Forbidden'); return }
        const ip = req.socket.remoteAddress ?? '?', now = Date.now(), prior = ticketRate.get(ip)
        const budget = prior && prior.until > now ? prior : { count: 0, until: now + 60_000 }
        ticketRate.set(ip, budget)
        if (++budget.count > 60) { res.writeHead(429); res.end('rate limited'); return }
        let body = ''
        req.on('data', part => { body += part; if (body.length > 4096) req.destroy() })
        req.on('end', () => {
          let value: Record<string, unknown>
          try { value = JSON.parse(body) } catch { res.writeHead(400); res.end('bad request'); return }
          // `null`, a number or an array parses: only an object has the fields read below.
          if (!value || typeof value !== 'object' || Array.isArray(value)) { res.writeHead(400); res.end('bad request'); return }
          if ('key' in value) { res.writeHead(400); res.end('use a view proof'); return }
          const room = value.room
          if (value.schema !== 2 || typeof room !== 'string' || !room.startsWith('local/')) { res.writeHead(400); res.end('schema 2 local room required'); return }
          if (!proofOk(req) && !viewOk(value, room, now)) { res.writeHead(403); res.end('Forbidden'); return }
          for (const [key, t] of tickets) if (t.expires <= now) tickets.delete(key)
          if (tickets.size >= 10000) { res.writeHead(503); res.end('too many pending tickets'); return }
          const ticket = crypto.randomBytes(16).toString('hex')
          tickets.set(ticket, { room, expires: now + ticketTtl })
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ticket, expiresIn: Math.ceil(ticketTtl / 1000) }))
        })
        return
      }
      if (url.pathname === '/health') {
        // A nonce lets joiners authenticate this listener before sending any authority.
        const nonce = req.headers['x-room-nonce']
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, local: true, schema: 2, hub: 1, ...(opts.commonDir ? { clone: cloneId(opts.commonDir) } : {}), ...(opts.key && typeof nonce === 'string' && /^[a-f0-9]{32}$/.test(nonce) ? { proof: relayProof(opts.key, nonce, boundPort()) } : {}) }))
        return
      }
      if (req.method === 'DELETE' && url.pathname === '/memory') {
        if (!proofOk(req) || !isLoopback(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return }
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
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Room opens the browser view from the file link printed by your agent.\n')
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not Found\n')
      } catch (e) { opts.log?.(`relay http: ${e instanceof Error ? e.message : e}`); if (!res.writableEnded) { res.writeHead(e instanceof HttpFailure ? e.status : 500); res.end(e instanceof HttpFailure ? e.message : 'Internal Server Error') } }
    })
    const wss = new WebSocketServer({ noServer: true })
    wss.on('headers', headers => headers.push('Referrer-Policy: no-referrer'))
    const docs = relayDocs()
    wss.on('connection', relayConnectionHandler(docs, { ...docOptions, key: opts.key ?? '' }))
    const ticker = setInterval(() => {
      for (const [name, d] of docs) {
        try { d.hub?.tick() }
        catch (error) { opts.log?.(`hub maintenance ${name}: ${error instanceof Error ? error.message : String(error)}`) }
        if (opts.commonDir && d.memory) try { catchUpLocal(opts.commonDir, decodeURIComponent(name), d.doc, opts.log) }
        catch (error) { opts.log?.(`local migration: ${error instanceof Error ? error.message : String(error)}`) }
      }
    }, 1000)
    ticker.unref?.()
    server.on('upgrade', (req, socket, head) => {
      // First, before anything can refuse: a refusal writes to a socket the client may already have reset (EPIPE).
      socket.on('error', () => {})
      const refuse = (code: number, why: string) => { socket.write(`HTTP/1.1 ${code} ${why}\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n`); socket.destroy() }
      try {
      const url = safeUrl(req.url)
      if (!isLoopback(req.socket.remoteAddress)) return refuse(403, 'Forbidden')
      if (obsolete(req, url)) return refuse(400, 'use Authorization: Room-Proof or a browser ticket')
      if (url.searchParams.get('schema') !== '2') return refuse(426, 'update Room to 0.17 or later: this local room uses schema 2')
      try { decodeURIComponent((req.url ?? '/').split('?')[0]) } catch { return refuse(400, 'Bad Request') }
      if (opts.key) {
        const issued = url.searchParams.get('ticket')
        const ticket = issued ? tickets.get(issued) : undefined
        if (issued) tickets.delete(issued)
        const room = decodeURIComponent(url.pathname.slice(1))
        const ticketOk = !!ticket && ticket.expires > Date.now() && ticket.room === room
        if (issued && !ticketOk) return refuse(403, 'websocket ticket invalid or expired')
        if (!ticketOk && !proofOk(req)) return refuse(403, 'Forbidden: local room proof missing or wrong')
        if (ticketOk) (req as http.IncomingMessage & { ticketView?: boolean }).ticketView = true
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
      } catch (e) { opts.log?.(`relay upgrade: ${e instanceof Error ? e.message : e}`); refuse(e instanceof HttpFailure ? e.status : 500, e instanceof HttpFailure ? e.message : 'Internal Server Error') }
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
  let canonicalWarning: string | undefined
  /** Publish the discovery file atomically: readers see the old file or the new one, never a partial one. */
  const write = () => {
    const file = relayFile(commonDir), tmp = `${file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, JSON.stringify({ schema: 2, port, pid: process.pid, room, startedAt: Date.now(), key, canonicalWarning } satisfies LocalRelayInfo) + '\n', { mode: 0o600 })
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
          const collision = canonicalRelayWarning(want, commonDir, await relayIdentity(want, key), readRelayInfo(commonDir))
          owned = await start(0, lock)
          canonicalWarning = collision.warning
          log(`local room ${room}: ${collision.warning ?? (collision.roomRelay ? `port ${want} is held by another clone's Room relay; using a free port` : `port ${want} is taken by something else; using a free port`)}`)
        }
      } catch (e) { lock.release(); throw e }
      port = owned.port
      write()
      log(`local room ${room}: started relay on 127.0.0.1:${port}`)
    }
  }

  // Later joiners adopt the fallback relay from discovery, but the canonical conflict remains.
  const canonicalPort = deterministicPort(commonDir)
  if (port !== canonicalPort) {
    const identity = await relayIdentity(canonicalPort, key)
    const collision = canonicalRelayWarning(canonicalPort, commonDir, identity, readRelayInfo(commonDir))
    canonicalWarning = collision.warning ? canonicalWarning ?? readRelayInfo(commonDir)?.canonicalWarning ?? collision.warning : undefined
  }

  let stopped = false
  let lost: string | undefined
  let ticking: Promise<void> | null = null
  const tick = async () => {
    if (stopped) return
    if (canonicalWarning) {
      const identity = await relayIdentity(canonicalPort, key)
      if (!canonicalRelayWarning(canonicalPort, commonDir, identity, readRelayInfo(commonDir)).warning) canonicalWarning = undefined
    }
    if (owned || lost) return
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
    get canonicalWarning() { return canonicalWarning },
    get owned() { return owned !== null },
    get lost() { return lost },
    async forget() {
      if (!await relayHealth(port, key)) throw new Error('local relay identity could not be verified')
      const resource = '/memory?room=' + encodeURIComponent(room)
      const response = await fetch('http://127.0.0.1:' + port + resource, {
        method: 'DELETE', headers: { authorization: localProofHeader(key, 'DELETE', resource, port) }, signal: AbortSignal.timeout(5000),
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
