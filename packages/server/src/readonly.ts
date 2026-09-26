/**
 * Read-only websocket connections (browser view keys). The y-websocket protocol carries two
 * message types: 0 = sync (sub-types 0 step1 = "send me your state", 1 step2 and 2 update =
 * writes) and 1 = awareness. A viewer may request state; document and awareness writes are
 * dropped before the shared-doc handler sees them.
 */
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as Y from 'yjs'
import { validParticipantName } from './names.js'

const MESSAGE_SYNC = 0
const SYNC_STEP2 = 1
const SYNC_UPDATE = 2

export function isWriteMessage(buf: Uint8Array): boolean {
  try {
    const d = decoding.createDecoder(buf)
    if (decoding.readVarUint(d) !== MESSAGE_SYNC) return false
    const sub = decoding.readVarUint(d)
    return sub === SYNC_STEP2 || sub === SYNC_UPDATE
  } catch {
    return true // malformed: never let it through
  }
}

function isAwarenessMessage(buf: Uint8Array): boolean {
  try { return decoding.readVarUint(decoding.createDecoder(buf)) === MESSAGE_AWARENESS } catch { return true }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data as Buffer[]))
  return new Uint8Array()
}

interface EmitterLike {
  emit(event: string | symbol, ...args: unknown[]): boolean
  once?(event: string | symbol, listener: (...args: unknown[]) => void): unknown
}

/** Wrap a view connection so inbound document or presence writes never reach its listeners. */
export function makeReadOnly(conn: EmitterLike, onDrop: () => void): void {
  const emit = conn.emit.bind(conn)
  conn.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === 'message') {
      const buf = toBytes(args[0])
      if (isWriteMessage(buf) || isAwarenessMessage(buf)) { onDrop(); return false }
    }
    return emit(event, ...args)
  }) as EmitterLike['emit']
}

const MESSAGE_AWARENESS = 1

/** A login may appear as itself or as login+<label>. */
export function ownsName(name: string, login: string): boolean {
  return validParticipantName(name) && validParticipantName(login) && (name === login || (name.startsWith(login + '+') && name.length > login.length + 1))
}

/** Keep owned presence and null (leaving) entries, preserving their IDs, clocks and JSON. */
export function filterAwareness(buf: Uint8Array, login: string, ownedClientIds?: Set<number>, clientOwners?: Map<number, string>): { buf: Uint8Array | null; stripped: string[] } {
  const stripped: string[] = []
  try {
    const d = decoding.createDecoder(buf)
    if (decoding.readVarUint(d) !== MESSAGE_AWARENESS) return { buf, stripped }
    const inner = decoding.createDecoder(decoding.readVarUint8Array(d))
    const n = decoding.readVarUint(inner)
    const entries = encoding.createEncoder()
    let kept = 0
    for (let i = 0; i < n; i++) {
      const clientID = decoding.readVarUint(inner), clock = decoding.readVarUint(inner)
      const raw = decoding.readVarString(inner)
      const state = JSON.parse(raw) as { user?: { name?: unknown; owner?: unknown }; host?: unknown; model?: unknown; effort?: unknown } | null
      const name = state?.user?.name, owner = state?.user?.owner
      if (state === null && ownedClientIds && !ownedClientIds.has(clientID)) {
        stripped.push(`(client ${clientID})`)
        continue
      }
      if (state !== null && clientOwners?.has(clientID) && clientOwners.get(clientID) !== login) {
        stripped.push(`(client ${clientID})`)
        continue
      }
      if (state !== null && (typeof name !== 'string' || !ownsName(name, login) || (owner !== undefined && owner !== login))) {
        stripped.push(typeof name === 'string' ? name : '(unnamed)')
        continue
      }
      encoding.writeVarUint(entries, clientID)
      encoding.writeVarUint(entries, clock)
      if (state) for (const key of ['host', 'model', 'effort'] as const) {
        const value = state[key]
        const clean = typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80) : ''
        if (clean) state[key] = clean
        else delete state[key]
      }
      encoding.writeVarString(entries, JSON.stringify(state))
      if (ownedClientIds) {
        if (state === null) { ownedClientIds.delete(clientID); if (clientOwners?.get(clientID) === login) clientOwners.delete(clientID) }
        else { ownedClientIds.add(clientID); clientOwners?.set(clientID, login) }
      }
      kept++
    }
    if (!kept) return { buf: null, stripped }
    const update = encoding.createEncoder()
    encoding.writeVarUint(update, kept)
    encoding.writeUint8Array(update, encoding.toUint8Array(entries))
    const message = encoding.createEncoder()
    encoding.writeVarUint(message, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(message, encoding.toUint8Array(update))
    return { buf: encoding.toUint8Array(message), stripped }
  } catch {
    return { buf: null, stripped } // malformed: never let it through
  }
}

export function isForeignIdentity(buf: Uint8Array, login: string): boolean {
  const result = filterAwareness(buf, login)
  return result.buf === null || result.stripped.length > 0
}

/** Filter inbound presence only; this is not document authorship verification. */
export function bindIdentity(conn: EmitterLike, login: string, onDrop: (login: string, name: string) => void, clientOwners = new Map<number, string>()): void {
  const emit = conn.emit.bind(conn)
  const ownedClientIds = new Set<number>()
  conn.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === 'message') {
      const result = filterAwareness(toBytes(args[0]), login, ownedClientIds, clientOwners)
      if (result.buf === null) {
        if (result.stripped.length) onDrop(login, result.stripped[0])
        return false
      }
      args[0] = result.buf
    }
    return emit(event, ...args)
  }) as EmitterLike['emit']
  conn.once?.('close', () => { for (const id of ownedClientIds) if (clientOwners.get(id) === login) clientOwners.delete(id) })
}

const PARTICIPANT_MAPS = ['overlays', 'deleted', 'overlayAt', 'scopes', 'graphs', 'colors', 'bases'] as const
/**
 * Narrow exceptions for records the current Room clients synthesize: Room-authored notices and
 * `pr#<n>` scope/metadata records. They are client-authored and are not authorship proof: any
 * authenticated member can forge them, so ordinary participant speech never belongs here.
 */
const TRUSTED_ROOM_MESSAGE_TYPES = new Set(['conflict', 'merge-conflict', 'contract', 'note'])
const TRUSTED_PR_NAME = /^pr#[1-9]\d*$/

function syncUpdate(buf: Uint8Array): Uint8Array | undefined {
  try {
    const d = decoding.createDecoder(buf)
    if (decoding.readVarUint(d) !== MESSAGE_SYNC) return undefined
    const subtype = decoding.readVarUint(d)
    if (subtype !== SYNC_STEP2 && subtype !== SYNC_UPDATE) return undefined
    return decoding.readVarUint8Array(d)
  } catch { return undefined }
}

function onlyMapDeletes(event: Y.YEvent<Y.AbstractType<unknown>>): boolean {
  const keys = event.changes.keys
  return event.target instanceof Y.Map && keys.size > 0 && [...keys.values()].every(change => change.action === 'delete')
}

/** One shadow document per room: inspected packets advance it; objected packets rebuild it from the real doc. */
export class DocumentIdentityGuard {
  private source?: Y.Doc
  private shadow?: Y.Doc
  private sourceUpdate?: (update: Uint8Array) => void
  private login?: string
  private violations: string[] = []

  constructor(private readonly current: () => Y.Doc | undefined) {}

  accept(message: Uint8Array, login: string): { ok: true } | { ok: false; reason: string } {
    const update = syncUpdate(message)
    if (!update) return isWriteMessage(message) ? { ok: false, reason: 'malformed Yjs update' } : { ok: true }
    const source = this.current()
    if (!source) return { ok: false, reason: 'room document is not ready' }
    this.prepare(source)
    const shadow = this.shadow!
    this.login = login; this.violations = []
    try { Y.applyUpdate(shadow, update, this) }
    catch { this.violations.push('malformed Yjs update') }
    finally { this.login = undefined }
    if (!this.violations.length) return { ok: true }
    const reason = this.violations[0]
    this.reset(source)
    return { ok: false, reason }
  }

  private prepare(source: Y.Doc): void {
    if (this.source === source && this.shadow) return
    this.reset(source)
  }

  private reset(source: Y.Doc): void {
    if (this.source && this.sourceUpdate) this.source.off('update', this.sourceUpdate)
    this.shadow?.destroy()
    this.source = source
    const shadow = this.shadow = new Y.Doc()
    for (const name of PARTICIPANT_MAPS) {
      const root = shadow.getMap(name)
      root.observeDeep(events => this.checkParticipantMap(name, root, events))
    }
    const flatBase = shadow.getMap<string>('basetextFlat')
    flatBase.observe(event => this.checkFlatBase(event))
    const claims = shadow.getMap<Record<string, unknown>>('claims')
    claims.observe(event => this.checkRecordMap('claim', claims, event, ['by']))
    const workers = shadow.getMap<Record<string, unknown>>('workers')
    workers.observe(event => this.checkRecordMap('worker', workers, event, ['name', 'lead']))
    shadow.getArray<Record<string, unknown>>('bus').observe(event => this.checkMessages(event))
    shadow.getArray<Record<string, unknown>>('retiredWorkers').observe(event => this.checkRetired(event))
    shadow.on('afterTransaction', transaction => this.checkDynamicRoots(transaction))
    Y.applyUpdate(shadow, Y.encodeStateAsUpdate(source))
    this.sourceUpdate = update => Y.applyUpdate(shadow, update)
    source.on('update', this.sourceUpdate)
  }

  private reject(reason: string): void { if (this.login && !this.violations.length) this.violations.push(reason) }

  private checkFlatBase(event: Y.YMapEvent<string>): void {
    const login = this.login
    if (!login) return
    for (const [key, change] of event.changes.keys) {
      if (change.action === 'delete') continue
      const split = key.indexOf('\u0000')
      const owner = split < 0 ? '' : key.slice(0, split)
      const rest = key.slice(split + 1)
      const colon = rest.indexOf(':')
      if (split < 0 || colon < 1 || colon === rest.length - 1 || rest.includes('\u0000') || !ownsName(owner, login)) this.reject(`basetextFlat mutation for ${owner || '(invalid owner)'}`)
    }
  }

  private checkParticipantMap(name: string, root: Y.Map<unknown>, events: Y.YEvent<Y.AbstractType<unknown>>[]): void {
    const login = this.login
    if (!login) return
    for (const event of events) {
      if (event.path.length) {
        const participant = String(event.path[0])
        if (!ownsName(participant, login) && !onlyMapDeletes(event)) this.reject(`${name} mutation for ${participant}`)
        continue
      }
      for (const [participant, change] of event.changes.keys) {
        if (change.action === 'delete') continue
        const trustedPr = name === 'scopes' && TRUSTED_PR_NAME.test(participant)
        if (!ownsName(participant, login) && !trustedPr) { this.reject(`${name} mutation for ${participant}`); continue }
        if (name === 'scopes') {
          const value = root.get(participant) as { by?: unknown } | undefined
          if (!value || typeof value.by !== 'string' || !(ownsName(value.by, login) || trustedPr && value.by === participant)) this.reject(`scope author ${String(value?.by)}`)
        }
      }
    }
  }

  private checkRecordMap(kind: string, root: Y.Map<Record<string, unknown>>, event: Y.YMapEvent<Record<string, unknown>>, fields: string[]): void {
    const login = this.login
    if (!login) return
    for (const [id, change] of event.changes.keys) {
      if (change.action === 'delete') continue
      const before = change.oldValue as Record<string, unknown> | undefined
      const after = root.get(id)
      for (const record of [before, after]) if (record) for (const field of fields) {
        const identity = record?.[field]
        if (typeof identity !== 'string' || !ownsName(identity, login)) this.reject(`${kind} ${id} has foreign ${field} ${String(identity)}`)
      }
    }
  }

  private checkMessages(event: Y.YArrayEvent<Record<string, unknown>>): void {
    const login = this.login
    if (!login) return
    for (const part of event.changes.delta) for (const message of part.insert ?? []) {
      const from = message.from, type = message.type
      if (typeof from === 'string' && ownsName(from, login)) continue
      if (from === 'room' && typeof type === 'string' && TRUSTED_ROOM_MESSAGE_TYPES.has(type)) continue
      this.reject(`message type ${String(type)} has foreign author ${String(from)}`)
    }
  }

  private checkRetired(event: Y.YArrayEvent<Record<string, unknown>>): void {
    const login = this.login
    if (!login) return
    for (const part of event.changes.delta) for (const record of part.insert ?? []) {
      for (const field of ['name', 'lead']) {
        const identity = record[field]
        if (typeof identity !== 'string' || !ownsName(identity, login)) this.reject(`retired worker has foreign ${field} ${String(identity)}`)
      }
    }
  }

  private checkDynamicRoots(transaction: Y.Transaction): void {
    const login = this.login, shadow = this.shadow
    if (!login || !shadow) return
    for (const [type, events] of transaction.changedParentTypes) {
      const root = [...shadow.share.entries()].find(([, value]) => value === type)?.[0]
      if (!root?.startsWith('seen:')) continue
      const participant = decodeURIComponent(root.slice(5))
      if (ownsName(participant, login)) continue
      if (!(events as Y.YEvent<Y.AbstractType<unknown>>[]).every(onlyMapDeletes)) this.reject(`read receipt mutation for ${participant}`)
    }
  }
}

export type DocumentIdentityMode = 'observe' | 'enforce'

/**
 * Inspect identity-bearing member updates. Observe mode reports objections but preserves the Yjs
 * stream; experimental enforce mode drops the whole packet and can desynchronise that client.
 */
export function bindDocumentIdentity(conn: EmitterLike, login: string, guard: DocumentIdentityGuard, onViolation: (login: string, reason: string) => void, mode: DocumentIdentityMode = 'observe'): void {
  const emit = conn.emit.bind(conn)
  conn.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === 'message') {
      const result = guard.accept(toBytes(args[0]), login)
      if (!result.ok) {
        onViolation(login, result.reason)
        if (mode === 'enforce') return false
      }
    }
    return emit(event, ...args)
  }) as EmitterLike['emit']
}

/**
 * Refuse writes into a room whose document has grown past `maxBytes`: the connection keeps
 * reading, its sync updates are dropped, and `onCap` fires (rate-limit it in the caller). The
 * size is asked for lazily, with the write message's byte length, so callers can cache an
 * O(doc) measurement and refresh it by traffic (see DocSizeMeter).
 */
export function capDocSize(conn: EmitterLike, sizeBytes: (messageBytes: number) => number, maxBytes: number, onCap: (size: number) => void): void {
  const emit = conn.emit.bind(conn)
  conn.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === 'message') {
      const buf = toBytes(args[0])
      if (isWriteMessage(buf)) {
        const size = sizeBytes(buf.byteLength)
        if (size > maxBytes) { onCap(size); return false }
      }
    }
    return emit(event, ...args)
  }) as EmitterLike['emit']
}

export interface DocSizeMeterOptions {
  /** Re-measure when the cached value is older than this. Default 30 s. */
  maxAgeMs?: number
  /** ... or after this many write messages since the last measurement. Default 200. */
  maxWrites?: number
  /** ... or after this many bytes of write messages since the last measurement. Default 8 MB. */
  maxBytes?: number
  now?: () => number
}

/**
 * A cached document-size measurement for one room. A purely time-based cache would let a
 * client push an unbounded amount through in the 30 s window between two measurements, so
 * the cache also expires by traffic: whichever of age, write count or bytes received trips
 * first forces a fresh measurement on the next write.
 */
export class DocSizeMeter {
  private cached?: { at: number; bytes: number }
  private writes = 0
  private received = 0
  private readonly maxAgeMs: number
  private readonly maxWrites: number
  private readonly maxBytes: number
  private readonly now: () => number

  constructor(private readonly measure: () => number, o: DocSizeMeterOptions = {}) {
    this.maxAgeMs = o.maxAgeMs ?? 30_000
    this.maxWrites = o.maxWrites ?? 200
    this.maxBytes = o.maxBytes ?? 8 * 1048576
    this.now = o.now ?? Date.now
  }

  /** Size of the document as of the last measurement, counting this write message towards the next one. */
  size(messageBytes = 0): number {
    const c = this.cached
    const stale = !c || this.now() - c.at >= this.maxAgeMs || this.writes >= this.maxWrites || this.received >= this.maxBytes
    if (stale) {
      const bytes = this.measure()
      this.cached = { at: this.now(), bytes }
      this.writes = 0
      this.received = 0
    }
    this.writes++
    this.received += messageBytes
    return this.cached!.bytes
  }
}
