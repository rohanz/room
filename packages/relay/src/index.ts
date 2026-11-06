/** Loopback relay transport, selective memory and hub. The standalone daemon owns its lifecycle. */
import { RoomMemory, finalSave, memoryFile } from './memory.js'
import { catchUpLocal, forgetLegacyLocal } from './local-migrate.js'
export { legacyRelayRunning } from './local-migrate.js'
import type { ProcessIdentity } from '@room/local-state/leases'
export { ensureLocalDaemon, startLocalDaemon, stopLocalDaemon, LOCAL_DAEMON_IDLE_MS } from './daemon.js'
export type { LocalDaemon, LocalDaemonOptions, StartedLocalDaemon } from './daemon.js'
import { AuthorityLock, holderDeadCheck, incarnationFile, relayLeaseFile } from './hub.js'
export { RoomMemory, memoryFile, loadMemory, saveMemory, FinalSaveError } from './memory.js'
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
import { docGeneration, generationGate, STALE_REPLICA_CODE, STALE_REPLICA_REASON, COMPACTED_UPDATE_REASON, ROOM_DOC_MAX_BYTES, RoomDoc } from '@room/shared'
import { ProofVerifier, localProofHeader, localViewKey, relayIdentity, relayIdentityProbe, relayProof, relayMetadataProof, sameProof, viewTicketProof, PROOF_WINDOW_MS } from './proof.js'
import { SecureSession } from './secure.js'
import { RelayAdmission, type RelayAdmissionLimits } from './limits.js'
import { RelayAwarenessBudget, awarenessLimits, type RelayAwarenessLimits } from './awareness.js'
export type { RelayAdmissionLimits } from './limits.js'
export type { RelayAwarenessLimits } from './awareness.js'
export { SecureSession } from './secure.js'
export { localProofHeader, localViewKey, relayHealth, relayIdentity, relayProof, viewTicketProof, ProofVerifier } from './proof.js'
import { HttpFailure, safeUrl, CURRENT_COMPAT, LEGACY_COMPAT, legacyAdvertisement, legacyHello, parseAdvertisement, selectContract, parseBootstrapFrame, BOOTSTRAP_MAX_BYTES, BOOTSTRAP_HELLO_TIMEOUT_MS, BOOTSTRAP_ACK_TIMEOUT_MS, BOOTSTRAP_MAX_PENDING_PER_PRINCIPAL, LEASE_TTL_MS, LEASE_RENEW_MS, type BootstrapHello, type BootstrapSelection, type CompatibilityRefusal } from '@room/hub-core'
export { safeUrl } from '@room/hub-core'

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
interface RelayDoc { doc: Y.Doc; awareness: awarenessProtocol.Awareness; presence: RelayAwarenessBudget; conns: Map<WebSocket, Set<number>>; memory?: RoomMemory; room?: RoomDoc; hub?: Hub; hubReady?: Promise<void>; closed?: boolean; hubError?: unknown; cap: RoomCap }
/** The live size cap of one room (the server's rule, hub-core/src/doc-cap.ts) and when it last logged a refusal. */
interface RoomCap { maxBytes: number; meter: DocSizeMeter; logged: number }
/** A room's live document cap; by default ROOM_DOC_MAX_BYTES (also the snapshot ceiling), measured at the server's cadence. */
export interface RelayDocCap { maxBytes?: number; meter?: DocSizeMeterOptions }
/** A relay started under the clone's authority lock runs a hub per room; test clocks are optional. */
export interface RelayHubOptions { lock: AuthorityLock; mono?: () => number; wall?: () => number }
interface RelayHubRuntime { lock: AuthorityLock; store: IncarnationStore; mono: () => number; wall: () => number; holderDead: ReturnType<typeof holderDeadCheck> }
interface DocOptions { commonDir?: string; log?: (line: string) => void; hub?: RelayHubRuntime; seed?: { room: string; update: Uint8Array }; readOnly?: boolean; socketQueueBytes?: number; docCap?: RelayDocCap; admission?: RelayAdmissionLimits; awareness?: RelayAwarenessLimits; admissionState?: RelayAdmission; accepting?: () => boolean; attached?: (conn: WebSocket, readOnly: boolean) => void; daemon?: boolean; compat?: typeof CURRENT_COMPAT }
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
/** ws 8.21's Receiver has no public dynamic payload-limit setter. Keep the private access
 * guarded and transport-local (the hosted transport has the same adapter). The receiver
 * checks fragmented message lengths at the frame header, before collecting their payloads. */
function boundRelayBootstrapInput(conn: WebSocket): { remaining(bytes: number): void; restore(): void } {
  const receiver = (conn as unknown as { _receiver?: { _maxPayload?: number } })._receiver
  const maximum = receiver?._maxPayload
  if (!receiver || typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum < 0) throw new Error('unsupported websocket receiver payload limit; update/restart Room')
  return {
    remaining: bytes => { receiver._maxPayload = Math.max(1, Math.min(maximum || Infinity, bytes)) },
    restore: () => { receiver._maxPayload = maximum },
  }
}
const bootstrapInputs = new WeakMap<WebSocket, ReturnType<typeof boundRelayBootstrapInput>>()
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
  d = { doc, awareness, presence: new RelayAwarenessBudget(awareness, opts.awareness), conns: new Map(), memory, cap: { maxBytes: opts.docCap?.maxBytes ?? ROOM_DOC_MAX_BYTES, meter, logged: 0 } }
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
  // Bare transport fixtures may supply an initial replica before the hub starts.
  if (opts.seed && name === encodeURIComponent(opts.seed.room)) Y.applyUpdate(doc, opts.seed.update)
  if (opts.hub) startRoomHub(d, decodeURIComponent(name), opts.hub, opts.commonDir!, opts.log ?? (() => {}), !!opts.daemon)
  return d
}
function startRoomHub(d: RelayDoc, room: string, rt: RelayHubRuntime, commonDir: string, log: (line: string) => void, strict = false): void {
  const roomDoc = d.room = new RoomDoc(d.doc)
  d.hubReady = startHub({ doc: roomDoc, mono: rt.mono, wall: rt.wall, log: line => log(`local room ${room}: ${line}`), store: rt.store, leases: relayLeaseFile(commonDir, room), requireLeaseLoad: strict, holderDead: rt.holderDead, authority: () => rt.lock.held(),
    full: () => !!d.memory?.status.capacity || d.cap.meter.size() > d.cap.maxBytes })
    .then(hub => {
      if (d.closed) { hub.stop(); return }
      hub.onPush((conn, push) => send(conn as WebSocket, encodeFrame(push)))
      d.hub = hub
    })
    .catch(e => { d.hubError = e; log(`local room ${room}: the hub could not start: ${e instanceof Error ? e.message : e}`) })
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
/** Preserve both the encoded modern route and legacy raw-slash/unnamespaced room routes. */
function relayRoomName(target: string | undefined): string { return encodeURIComponent(decodeURIComponent((target ?? '/').slice(1).split('?')[0])) }
function attach(docs: Map<string, RelayDoc>, conn: WebSocket, req: http.IncomingMessage, opts: DocOptions & { key: string }): void {
  const name = relayRoomName(req.url)
  const room = decodeURIComponent(name)
  const session = new SecureSession(opts.readOnly ? localViewKey(opts.key, room) : opts.key, room, 'relay')
  sessions.set(conn, session)
  const timer = setTimeout(() => conn.close(1008, 'secure handshake timeout'), 5000)
  handshakeCleanup.set(conn, () => { clearTimeout(timer); conn.off('message', handshake); dropSocket(conn); sessions.delete(conn); bootstrapInputs.delete(conn) })
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
      if (safeUrl(req.url).searchParams.get('negotiate') === '1' && raw.byteLength > BOOTSTRAP_MAX_BYTES + 16) { clearTimeout(timer); conn.close(4406, 'compatibility frame exceeds limit'); return }
      const first = session.decrypt(raw)
      if (opts.accepting && !opts.accepting()) { conn.close(1013, 'local daemon draining; retry'); return }
      clearTimeout(timer)
      handshakeCleanup.delete(conn)
      conn.off('message', handshake)
      if (safeUrl(req.url).searchParams.get('negotiate') === '1') attachNegotiating(docs, conn, name, req, opts, first)
      else {
        if (opts.daemon && !opts.readOnly) { conn.close(4406, 'daemon lifecycle negotiation required; update Room'); return }
        // Frozen baseline is selected before either direction of legacy automatic sync.
        const legacy = selectContract(LEGACY_COMPAT, CURRENT_COMPAT, { activeSchema: 2, readOnly: opts.readOnly })
        if (!legacy.ok) { conn.close(4406, 'legacy contract retired; update this client'); return }
        attachReady(docs, conn, name, opts, first, req)
        conn.emit('message', first, true)
      }
    } catch { clearTimeout(timer); conn.close(1008, 'invalid secure frame') }
  }
  conn.on('message', handshake)
  conn.on('close', () => { handshakeCleanup.get(conn)?.(); handshakeCleanup.delete(conn); clearTimeout(timer); dropSocket(conn); sessions.delete(conn); bootstrapInputs.delete(conn) })
}
/** Bootstrap lives inside the authenticated encrypted stream, before document/awareness handlers. */
function attachNegotiating(docs: Map<string, RelayDoc>, conn: WebSocket, name: string, req: http.IncomingMessage, opts: DocOptions, first: Buffer): void {
  let phase: 'hello' | 'selecting' | 'ack' | 'done' = 'hello'
  let hello: BootstrapHello | undefined
  let selection: BootstrapSelection | undefined
  let selectedDoc: RelayDoc | undefined
  let timer: ReturnType<typeof setTimeout>, expiresAt = 0, bytes = 0
  const cleanup = () => { clearTimeout(timer); conn.off('message', receive); handshakeCleanup.delete(conn) }
  const refuse = (reason: string) => { cleanup(); phase = 'done'; conn.close(4406, reason.slice(0, 120)) }
  const deadline = (ms: number) => { expiresAt = Date.now() + ms; clearTimeout(timer); timer = setTimeout(() => refuse('compatibility handshake timed out; reconnect Room'), ms); timer.unref?.() }
  const current = () => (!opts.accepting || opts.accepting()) && conn.readyState === conn.OPEN && !!selectedDoc && !selectedDoc.closed && (!opts.hub || opts.hub.lock.held())
  const receivePlain = async (plain: Uint8Array) => {
    if (opts.accepting && !opts.accepting()) { cleanup(); phase = 'done'; conn.close(1013, 'local daemon draining; retry'); return }
    if (Date.now() >= expiresAt) { refuse('compatibility handshake timed out; reconnect Room'); return }
    bytes += plain.byteLength
    if (bytes > BOOTSTRAP_MAX_BYTES || plain[0] !== MSG_HUB) { refuse('compatibility hello/ack required before sync'); return }
    // The next encrypted message adds a 16-byte authentication tag to the remaining plaintext budget.
    bootstrapInputs.get(conn)!.remaining(BOOTSTRAP_MAX_BYTES - bytes + 16)
    let frame
    try {
      const decoder = decoding.createDecoder(plain)
      decoding.readVarUint(decoder) // type 7 was checked above
      frame = parseBootstrapFrame(decodeFrame(decoder))
      if (decoding.hasContent(decoder)) throw new Error('trailing bootstrap bytes')
    }
    catch { refuse('invalid compatibility frame; update this client'); return }
    if (phase === 'hello') {
      if (!('op' in frame) || frame.op !== 'compat-hello') { refuse('compatibility hello required'); return }
      hello = frame
      phase = 'selecting'
      const selected = selectContract(frame.offer, opts.compat ?? CURRENT_COMPAT, { activeSchema: 2, readOnly: opts.readOnly, ...(!opts.readOnly && opts.daemon ? { requiredCapabilities: { 'room.daemon': [1] } } : {}) })
      if (!selected.ok) {
        send(conn, encodeFrame({ v: 1, re: frame.id, ok: false, error: selected.error }))
        refuse(compatibilityDetail(selected.error))
        return
      }
      selectedDoc = getDoc(docs, name, opts)
      await selectedDoc.hubReady
      if (conn.readyState !== conn.OPEN) return
      if (opts.accepting && !opts.accepting()) { cleanup(); phase = 'done'; conn.close(1013, 'local daemon draining; retry'); return }
      if (Date.now() >= expiresAt) { refuse('compatibility handshake timed out; reconnect Room'); return }
      if (opts.hub && !selectedDoc.hub) { cleanup(); phase = 'done'; conn.close(1013, 'relay hub unavailable; retry'); return }
      if (phase !== 'selecting' || !current()) { refuse('relay authority changed; reconnect Room'); return }
      if (!relayGeneration(conn, req, selectedDoc)) { cleanup(); phase = 'done'; return }
      selection = {
        v: 1, re: frame.id, ok: true, selectionId: crypto.randomBytes(16).toString('hex'), selection: selected.selection,
        compat: opts.compat ?? CURRENT_COMPAT, generation: docGeneration(selectedDoc.doc) ?? '0', policyRevision: 1,
        incarnation: selectedDoc.hub?.incarnation ?? 0, ttlMs: LEASE_TTL_MS, renewMs: LEASE_RENEW_MS, requiredCapabilities: !opts.readOnly && opts.daemon ? { 'room.daemon': [1] } : {},
      }
      const encoded = encodeFrame(selection)
      if (encoded.byteLength > BOOTSTRAP_MAX_BYTES) { refuse('relay compatibility selection exceeds limit'); return }
      phase = 'ack'
      deadline(BOOTSTRAP_ACK_TIMEOUT_MS)
      send(conn, encoded)
      return
    }
    if (phase !== 'ack' || !('op' in frame) || frame.op !== 'compat-ack' || frame.selectionId !== selection?.selectionId) {
      refuse('unexpected compatibility frame; reconnect Room'); return
    }
    // No await between the authority/generation recheck and document attachment.
    if (!current() || (docGeneration(selectedDoc!.doc) ?? '0') !== selection!.generation ||
        (selectedDoc!.hub?.incarnation ?? 0) !== selection!.incarnation) { refuse('relay authority changed; reconnect Room'); return }
    if (!relayGeneration(conn, req, selectedDoc!)) { cleanup(); phase = 'done'; return }
    if (!opts.readOnly && selectedDoc!.hub) {
      // compat-hello establishes the same hub session as the frozen legacy hello.
      // A later publisher hello is idempotent; operations are enabled as soon as ACK succeeds.
      const registered = selectedDoc!.hub.handle(conn, legacyHello(frame.id, hello!.offer.release ?? 'Room', hello!.sessionId), { local: true })
      if (!registered.ok) { cleanup(); phase = 'done'; conn.close(1013, 'relay hub session unavailable; reconnect Room'); return }
    }
    phase = 'done'
    cleanup()
    bootstrapInputs.get(conn)!.restore()
    bootstrapInputs.delete(conn)
    send(conn, encodeFrame({ v: 1, re: frame.id, ok: true }))
    conn.emit('room-compatible')
    attachReady(docs, conn, name, opts, undefined, req, true)
  }
  const receive = (raw: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
    if (phase === 'done' || conn.readyState !== conn.OPEN) return
    try {
      if (!binary) throw new Error('binary secure frames required')
      const length = raw instanceof ArrayBuffer ? raw.byteLength : Array.isArray(raw) ? raw.reduce((sum, part) => sum + part.byteLength, 0) : raw.byteLength
      if (length > BOOTSTRAP_MAX_BYTES + 16) { refuse('compatibility frame exceeds limit'); return }
      const plain = sessions.get(conn)!.decrypt(raw instanceof ArrayBuffer ? new Uint8Array(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw)
      void receivePlain(plain).catch(() => refuse('relay compatibility unavailable; reconnect Room'))
    } catch { refuse('invalid encrypted compatibility frame') }
  }
  handshakeCleanup.set(conn, cleanup)
  conn.on('message', receive)
  conn.once('close', cleanup)
  deadline(BOOTSTRAP_HELLO_TIMEOUT_MS)
  void receivePlain(first).catch(() => refuse('relay compatibility unavailable; reconnect Room'))
}
function relayGeneration(conn: WebSocket, req: http.IncomingMessage, d: RelayDoc): boolean {
  const decision = generationGate(safeUrl(req.url).searchParams.get('gen'), docGeneration(d.doc))
  if (decision === 'accept') return true
  conn.close(decision === 'stale' ? STALE_REPLICA_CODE : 4403, decision === 'stale' ? STALE_REPLICA_REASON : COMPACTED_UPDATE_REASON)
  return false
}
function attachReady(docs: Map<string, RelayDoc>, conn: WebSocket, name: string, opts: DocOptions, first: Buffer | undefined, req: http.IncomingMessage, negotiated = false): void {
  if (opts.accepting && !opts.accepting()) { conn.close(1013, 'local daemon draining; retry'); return }
  const d = getDoc(docs, name, opts)
  if (!relayGeneration(conn, req, d)) return
  d.conns.set(conn, new Set())
  opts.attached?.(conn, !!opts.readOnly)
  if (opts.socketQueueBytes) socketBudgets.set(conn, opts.socketQueueBytes)
  const allowState = stateRequestLimiter()
  const allowPresence = d.presence.connection(reason => conn.close(4429, reason))
  conn.binaryType = 'arraybuffer'
  conn.on('message', (raw: ArrayBuffer | Buffer | Buffer[]) => {
    if (failedSockets.has(conn) || conn.readyState !== conn.OPEN || (opts.accepting && !opts.accepting())) return
    let buf: Uint8Array
    try { buf = raw === first ? first : sessions.get(conn)!.decrypt(raw instanceof ArrayBuffer ? new Uint8Array(raw) : Array.isArray(raw) ? Buffer.concat(raw) : raw) }
    catch { conn.close(1008, 'invalid secure frame'); return }
    if (negotiated && buf[0] === MSG_HUB) {
      try {
        const frame = decodeFrame(buf) as { op?: string }
        if (frame.op === 'compat-hello' || frame.op === 'compat-ack') { conn.close(4406, 'selection is immutable; reconnect Room'); return }
      } catch { /* normal hub validation below */ }
    }
    if (!allowState(buf, conn.bufferedAmount)) { conn.close(1013, 'too many state requests'); return }
    // A view connection's writes are ignored below; a writer into a room over its cap is closed as the server does,
    // unless its write inserts nothing: a newcomer's sync step 2 and deletions still go through, so a local room
    // (with no operator to trim it) stays joinable and can shrink.
    const { cap } = d
    const over = opts.readOnly ? undefined : sizeCapRefusal(buf, bytes => d.memory?.status.capacity ? cap.maxBytes + 1 : cap.meter.size(bytes), cap.maxBytes, { allowNonGrowing: true })
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
          if (!allowPresence(buf)) break
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
  opts = { ...opts, awareness: awarenessLimits(opts.awareness) }
  const admission = opts.admissionState ?? new RelayAdmission(docs, opts.admission)
  let pending = 0
  return (conn, req) => {
    let release: (() => void) | undefined
    conn.on('error', error => {
      if (failedSockets.has(conn)) return
      failedSockets.add(conn)
      release?.()
      try { opts.log?.(`relay websocket: ${error instanceof Error ? error.message : String(error)}`) } catch { /* cleanup still matters */ }
      handshakeCleanup.get(conn)?.()
      handshakeCleanup.delete(conn)
      sessions.delete(conn)
      bootstrapInputs.delete(conn)
      dropSocket(conn)
      try { conn.terminate() } catch { /* already gone */ }
    })
    try {
      const target = safeUrl(req.url)
      if (target.searchParams.has('negotiate') && target.searchParams.get('negotiate') !== '1') { conn.close(4406, 'unsupported bootstrap; update this client'); return }
      if (target.searchParams.get('negotiate') === '1') {
        try {
          const bound = boundRelayBootstrapInput(conn)
          bound.remaining(BOOTSTRAP_MAX_BYTES + 16)
          bootstrapInputs.set(conn, bound)
        } catch (error) {
          opts.log?.(`relay bootstrap: ${error instanceof Error ? error.message : String(error)}`)
          conn.close(1011, 'relay bootstrap unavailable; update/restart Room')
          return
        }
        if (pending >= BOOTSTRAP_MAX_PENDING_PER_PRINCIPAL) { conn.close(1013, 'relay negotiation limit reached'); return }
        pending++
        let released = false
        const done = () => { if (!released) { released = true; pending-- } }
        conn.once('close', done)
        // Selection completion releases the pending slot before sync.
        conn.once('room-compatible', done)
      }
      const name = relayRoomName(req.url), reason = admission.refusal(name)
      if (reason) { conn.close(1013, reason); return }
      release = admission.reserve(name)
      conn.once('close', release)
      attach(docs, conn, req, { ...opts, readOnly: !!(req as http.IncomingMessage & { ticketView?: boolean }).ticketView })
    }
    catch (e) { opts.log?.(`relay connection: ${e instanceof Error ? e.message : e}`); conn.close(1008, 'Bad Request') }
  }
}

/** Historical session relays used `lead: true`; daemon discovery records its process birth identity. */
export interface LocalRelayInfo { preflight?: import('@room/local-state/protocol').PreflightResult; discovery?: number; compat?: unknown; runtime?: string; nonce?: string; schema: 2; port: number; pid: number; room: string; startedAt: number; key: string; canonicalWarning?: string; lead?: true | ProcessIdentity }

export interface LocalRelay {
  /** ws://127.0.0.1:<port> */
  url: string
  /** http://127.0.0.1:<port>: the relay API (the viewer opens from disk). */
  httpUrl: string
  port: number
  /** Private discovery secret used only to sign requests; lives in room/relay.json (0600). */
  key: string
  /** Compatibility marker; daemon client handles always return false. */
  owned: boolean
  /** A canonical port occupied by a relay of this clone, while this session uses another port. */
  canonicalWarning?: string
  /** Set when this clone's relay port is now served by another relay: the session must join afresh. */
  readonly lost?: string
  /** Forget this room's saved memory until the relay next restarts. */
  forget?(): Promise<void>
  /** Dispose this non-owning client handle; daemon lifecycle is independent. */
  stop(): Promise<void>
}

export const LOCAL_FILE = path.join('room', 'relay.json')

export function relayFile(commonDir: string): string { return path.join(commonDir, LOCAL_FILE) }

export function readRelayInfo(commonDir: string): LocalRelayInfo | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(relayFile(commonDir), 'utf8')) as Partial<LocalRelayInfo>
    return v.schema === 2 && typeof v.port === 'number' && typeof v.pid === 'number' && typeof v.key === 'string' && v.key
      ? { ...(v.discovery !== undefined ? { discovery: v.discovery } : {}), ...('compat' in v ? { compat: v.compat } : {}), ...(typeof v.runtime === 'string' ? { runtime: v.runtime } : {}), ...(typeof v.nonce === 'string' ? { nonce: v.nonce } : {}), schema: 2, port: v.port, pid: v.pid, room: String(v.room ?? ''), startedAt: Number(v.startedAt ?? 0), key: v.key, ...(typeof v.canonicalWarning === 'string' ? { canonicalWarning: v.canonicalWarning } : {}), ...(v.lead === true || (v.lead && typeof v.lead === 'object') ? { lead: v.lead } : {}) }
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
function compatibilityDetail(error: CompatibilityRefusal): string {
  const changes = error.requiredChanges.map(change => `${change.action} ${change.side} ${change.contract}${change.capability ? ` ${change.capability}` : ''}${change.range ? ` to ${change.range.min}-${change.range.max}` : change.versions ? ` to ${change.versions.join(',')}` : ''}`)
  return `${error.text} (${error.side}; ${error.code})${changes.length ? `; ${changes.join('; ')}` : ''}`
}
/** Identity is independent of contract support: an incompatible authenticated owner is still live. */
function relayContract(health: Record<string, unknown>): { compatible: boolean; detail?: string } {
  try {
    if (health.discovery !== undefined && health.discovery !== 1) return { compatible: false, detail: 'unsupported relay discovery format; update this client' }
    if (health.runtime !== undefined && health.runtime !== 'session-relay' && health.runtime !== 'daemon') return { compatible: false, detail: 'unsupported local runtime; update this client for the running relay' }
    const offer = 'compat' in health ? parseAdvertisement(health.compat) : legacyAdvertisement(health)
    if (!offer) return { compatible: false, detail: 'the relay does not implement the supported schema-2/proto-1 legacy adapter; update the relay' }
    const selected = selectContract(CURRENT_COMPAT, offer, { activeSchema: 2 })
    return selected.ok ? { compatible: true } : { compatible: false, detail: `${compatibilityDetail(selected.error)}` }
  } catch { return { compatible: false, detail: 'invalid relay compatibility advertisement; update or restart the relay' } }
}
async function probeRelayContract(port: number, commonDir: string, key: string, timeoutMs: number): Promise<{ status: 'ours' | 'foreign' | 'none' | 'slow' | 'incompatible'; detail?: string }> {
  const probe = await relayIdentityProbe(port, key, timeoutMs)
  if (probe.timedOut) return { status: 'slow' }
  const identity = probe.identity, h = identity?.health
  if (h?.local !== true) return { status: 'none' }
  if (!identity!.proven || h.clone !== cloneId(commonDir)) return { status: 'foreign' }
  const contract = relayContract(h)
  return { status: contract.compatible ? 'ours' : 'incompatible', detail: contract.detail }
}
export async function probeRelay(port: number, commonDir: string, key: string, timeoutMs = 800): Promise<'ours' | 'foreign' | 'none' | 'slow' | 'incompatible'> {
  return (await probeRelayContract(port, commonDir, key, timeoutMs)).status
}

/** Terminal refusal: the live owner must preserve its replica before an updated owner takes authority. */
export class LocalRelayCompatibilityError extends Error {
  constructor(port: number, pid: number | undefined, detail: string) {
    super(`WARN: local relay${pid === undefined ? '' : ` (pid ${pid})`} on 127.0.0.1:${port} is incompatible: ${detail}; drain local clients, let the owner save and exit, then restart Room on the compatible installed version`)
    this.name = 'LocalRelayCompatibilityError'
  }
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
  /** Initial state for bare transport integrations/tests, applied before the hub starts. */
  seed?: { room: string; update: Uint8Array }
  /** Bytes that may wait for one socket before a consumer already behind is cut off; default RELAY_SOCKET_QUEUE_BYTES. */
  socketQueueBytes?: number
  /** The live document cap per room; default ROOM_DOC_MAX_BYTES. */
  docCap?: RelayDocCap
  /** Retained and handshaking rooms (8), total sockets (200), and sockets per room (100). */
  admission?: RelayAdmissionLimits
  /** Hosted-equivalent presence bounds; options also permit smaller deterministic fixtures. */
  awareness?: RelayAwarenessLimits
  /** Waits between final-save attempts on close; default FINAL_SAVE_RETRY_MS (memory.ts). */
  finalSaveRetryMs?: readonly number[]
  /** Standalone process lifecycle; omitted by bare transport fixtures. */
  daemon?: { health: (authenticated?: boolean) => Record<string, unknown>; onSignal: () => void; writersChanged: (count: number) => void; stop?: (pid: number, nonce: string, saved: () => void) => Promise<void> }
}
export interface StartedRelay {
  port: number
  readonly connections: { writers: number; viewers: number; pending: number }
  /** Synchronous fence, including already-upgraded handshakes. Reopen only after a failed drain. */
  setDraining(value: boolean): void
  initialize(room: string): Promise<void>
  /** Startup rollback only: rejects if any authenticated client was attached. */
  abortUnpublished(): Promise<void>
  /** Saves each room's memory, then stops. If the save still fails after FINAL_SAVE_RETRY_MS, rejects with
   *  FinalSaveError and keeps serving: documents, clients and the authority lock stay until a later close or exit. */
  close(saved?: () => void): Promise<void>
  /** A room's doc and its hub once started (tests drive hubs on fake clocks through this). */
  hubRoom(room: string): { doc: RoomDoc; hub?: Hub } | undefined
}

/** Start a relay on 127.0.0.1:port (0 = any free port). Rejects with EADDRINUSE when someone else won the race.
 *  Serves only API endpoints and a /health line. Websockets are accepted from loopback only, and when
 *  `key` is set they must prove possession without sending it (the /health line stays open). */
export function startRelay(port: number, opts: RelayOptions = {}): Promise<StartedRelay> {
  return new Promise((resolve, reject) => {
    parseAdvertisement(CURRENT_COMPAT) // startup fails rather than truncating an oversized or invalid manifest
    if (opts.hub && !opts.commonDir) throw new Error("a relay hub needs the clone's common dir")
    let draining = false
    const writers = new Set<WebSocket>(), viewers = new Set<WebSocket>()
    const docOptions: DocOptions = {
      daemon: !!opts.daemon, compat: opts.daemon ? { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] } } : CURRENT_COMPAT, accepting: () => !draining,
      attached: (conn, readOnly) => {
        const group = readOnly ? viewers : writers
        group.add(conn)
        if (!readOnly) opts.daemon?.writersChanged(writers.size)
        const remove = () => { if (group.delete(conn) && !readOnly) opts.daemon?.writersChanged(writers.size) }
        conn.once('close', remove); conn.once('error', remove)
      },
      commonDir: opts.commonDir, log: opts.log, seed: opts.seed, socketQueueBytes: opts.socketQueueBytes, docCap: opts.docCap, admission: opts.admission, awareness: awarenessLimits(opts.awareness),
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
    const server = http.createServer(async (req, res) => {
      try {
      res.setHeader('Referrer-Policy', 'no-referrer')
      const url = safeUrl(req.url)
      if (obsolete(req, url)) { res.writeHead(400); res.end('use Authorization: Room-Proof or a view proof'); return }
      if (url.pathname === '/ws-ticket' && req.method === 'OPTIONS') {
        // The exchange requires an explicit proof, never ambient credentials.
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type' }); res.end(); return
      }
      // Batch 1 keeps the packaged viewer on the legacy route. Offer-bound negotiating
      // viewer tickets and pinned viewer contracts are deferred to the viewer batch.
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
        const health = { ok: true, local: true, schema: 2, hub: 1, pid: process.pid, discovery: 1, runtime: opts.daemon ? 'daemon' : 'session-relay', ...(opts.daemon?.health() ?? {}), ...(opts.daemon ? { writers: writers.size, viewers: viewers.size, pending: wss.clients.size - writers.size - viewers.size, storage: { io: [...docs.values()].some(d => d.memory?.status.io), capacity: [...docs.values()].some(d => d.memory?.status.capacity || d.cap.meter.size() > d.cap.maxBytes) } } : {}), compat: docOptions.compat, ...(opts.commonDir ? { clone: cloneId(opts.commonDir) } : {}) }
        const proof = opts.key && typeof nonce === 'string' && /^[a-f0-9]{32}$/.test(nonce) ? { proof: relayProof(opts.key, nonce, boundPort()), ...(opts.daemon ? { metadataProof: relayMetadataProof(opts.key, nonce, boundPort(), health) } : {}) } : {}
        res.end(JSON.stringify({ ...health, ...proof }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/daemon/stop' && opts.daemon?.stop) {
        if (!proofOk(req) || !isLoopback(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return }
        if (writers.size || draining) { res.writeHead(409); res.end(draining ? 'local daemon is already draining; inspect status and retry' : 'local daemon has active writers; quiesce clients before stopping'); return }
        try {
          await opts.daemon.stop(Number(url.searchParams.get('pid')), url.searchParams.get('nonce') ?? '', () => {
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ saved: true }))
          })
        } catch (error) { if (!res.writableEnded) { res.writeHead(409); res.end(error instanceof Error ? error.message : String(error)) } }
        return
      }
      if (url.pathname === '/daemon/status' && opts.daemon) {
        if (!proofOk(req) || !isLoopback(req.socket.remoteAddress)) { res.writeHead(403); res.end(); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ...opts.daemon.health(true), writers: writers.size, viewers: viewers.size, pending: wss.clients.size - writers.size - viewers.size, rooms: [...docs].map(([name, d]) => ({ room: decodeURIComponent(name), storage: { ...d.memory?.status, liveCapacity: d.cap.meter.size() > d.cap.maxBytes } })) }))
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
    const admission = docOptions.admissionState = new RelayAdmission(docs, opts.admission)
    wss.on('connection', relayConnectionHandler(docs, { ...docOptions, key: opts.key ?? '' }))
    const ticker = setInterval(() => {
      for (const [name, d] of docs) {
        d.presence.prune()
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
      if (draining) return refuse(503, 'local daemon draining; retry')
      if (!isLoopback(req.socket.remoteAddress)) return refuse(403, 'Forbidden')
      if (obsolete(req, url)) return refuse(400, 'use Authorization: Room-Proof or a browser ticket')
      if (url.searchParams.has('negotiate') && url.searchParams.get('negotiate') !== '1') return refuse(426, 'unsupported bootstrap; update this client')
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
      const capacityReason = admission.refusal(relayRoomName(req.url))
      if (capacityReason) return refuse(503, capacityReason)
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
      } catch (e) { opts.log?.(`relay upgrade: ${e instanceof Error ? e.message : e}`); refuse(e instanceof HttpFailure ? e.status : 500, e instanceof HttpFailure ? e.message : 'Internal Server Error') }
    })
    const signals = ['SIGTERM', 'SIGINT'] as const
    let closing: Promise<void> | undefined
    const onSignal = () => { if (opts.daemon) { opts.daemon.onSignal(); return }; close().catch(error => opts.log?.(`local relay: room state could not be saved on stop: ${error instanceof Error ? error.message : String(error)}`)) }
    // The relay holds the room's only current replica once the last writer has gone. Nothing is torn down
    // until every room's memory is saved: on a failed save the relay keeps serving and holding the lock.
    const close = (saved?: () => void): Promise<void> => closing ??= (async () => {
      if (opts.daemon) {
        for (const d of docs.values()) await d.hubReady
        await Promise.all([...docs.values()].flatMap(d => d.hub ? [d.hub.flushLeases()] : []))
      }
      // Each pass re-reads the rooms: one opened during a retry is saved too.
      await finalSave(() => [...docs.values()].flatMap(d => d.memory ? [d.memory] : []), opts.finalSaveRetryMs)
      saved?.()
      // Saved: tear down before any socket can deliver another update.
      await teardown()
    })().catch(error => { closing = undefined; throw error })
    const teardown = async (): Promise<void> => {
      for (const signal of signals) process.off(signal, onSignal)
      clearInterval(ticker)
      for (const d of docs.values()) { d.closed = true; d.hub?.stop(); d.memory?.detach() }
      for (const c of wss.clients) c.terminate()
      await new Promise<void>(done => {
        wss.close(); server.close(() => {
          for (const d of docs.values()) { d.awareness.destroy(); d.doc.destroy() }
          docs.clear()
          opts.hub?.lock.release()
          done()
        })
      })
    }
    server.once('error', e => { clearInterval(ticker); reject(e) })
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      const bound = typeof addr === 'object' && addr ? addr.port : port
      for (const signal of signals) process.on(signal, onSignal)
      resolve({
        port: bound,
        get connections() { return { writers: writers.size, viewers: viewers.size, pending: wss.clients.size - writers.size - viewers.size } },
        setDraining(value) { draining = value },
        async abortUnpublished() {
          if (writers.size || viewers.size) throw new Error('cannot discard a published relay replica')
          draining = true
          await teardown()
        },
        async initialize(room) {
          const d = getDoc(docs, encodeURIComponent(room), docOptions)
          await d.hubReady
          if (d.hubError) throw d.hubError
          if (opts.hub && !d.hub) throw new Error('local daemon hub could not initialize; repair private authority files')
        },
        close,
        hubRoom(room) {
          const d = docs.get(encodeURIComponent(room))
          return d?.room ? { doc: d.room, ...(d.hub ? { hub: d.hub } : {}) } : undefined
        },
      })
    })
  })
}
