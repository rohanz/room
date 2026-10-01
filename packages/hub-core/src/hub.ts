/**
 * The hub (docs/superpowers/specs/2026-09-28-hub.md): the one authority for name leases, bus order,
 * trim and participant expiry in a room. Transport-free and filesystem-free: adapters feed it frames
 * and a durable incarnation record, and call `tick` every second.
 */
import {
  BUS_BYTES, BUS_KEEP, deliveryIndex, ExpiryTenure, MAX_MESSAGE_BYTES, MessageKinds, admit, defaultPriority, newId, trim, validMessageShape, validParticipantName,
  type Msg, type MsgType, type ParticipantView, type ReleasePoster, type RoomDoc,
} from '@room/shared'
import {
  COUNTER_LIMIT, HUB_ORIGIN, HUB_PROTO, LEASE_RENEW_MS, LEASE_TTL_MS, SETTLE_MS, STARTING_RETRY_MS,
  encodeSeq, incarnationOf,
  type HolderIn, type LeaseLostReason, type PostIn, type Principal, type Push, type Reason, type Reply, type Req,
} from './protocol.js'

/** How often the hub trims the bus and measures absence (§8). */
export const MAINTENANCE_MS = 60_000
export const MAX_HUB_FRAME_BYTES = 96 * 1024
/** Adapter budget per connection, including malformed and refused hub frames. Above the per-lease post rate:
 *  a client flushing a backlog after a reconnect sends hundreds of posts back to back. */
export const MAX_HUB_REQUESTS_PER_SECOND = 500
export const MAX_HUB_REPLY_ID_LENGTH = 128
export const hubReplyId = (frame: unknown): string => isObject(frame) && typeof frame.id === 'string' && frame.id.length <= MAX_HUB_REPLY_ID_LENGTH ? frame.id : ''
export class HubRequestBudget {
  private readonly connections = new WeakMap<object, { at: number; count: number }>()
  take(conn: object, now = Date.now()): number | undefined {
    const current = this.connections.get(conn)
    if (!current || now - current.at >= 1000) { this.connections.set(conn, { at: now, count: 1 }); return undefined }
    if (current.count >= MAX_HUB_REQUESTS_PER_SECOND) return Math.max(1, 1000 - (now - current.at))
    current.count++
    return undefined
  }
}
export const MAX_HOLDER_FIELD_LENGTH = 512
export const MAX_LEASES_PER_ROOM = 512
export const MAX_LEASES_PER_PRINCIPAL = 64
export const MAX_RETAINED_NAMES = 1024
export const MAX_RETAINED_NAMES_PER_PRINCIPAL = 128
export const POST_RATE_PER_LEASE = 250
export const POST_RATE_PER_PRINCIPAL = 500
export const POST_RATE_PER_ROOM = 1000
export const POST_RATE_WINDOW_MS = 1000
export const MAX_RATE_KEYS = 2048
export const MAX_INCARNATION_AHEAD = 1_000_000

/** The durable incarnation record (§3). */
export interface IncarnationStore {
  current?(ceiling?: number): Promise<number | undefined>
  /** Durably record and return `max(D + 1, floor)`, where `D` is the highest incarnation recorded so far. */
  advance(floor: number): Promise<number>
}

/** Private, authority-owned lease state. Replicated holder records are only a mirror. */
export interface StoredLease { name: string; epoch: number; at: number; holder: HolderIn; principal: string; session: string; ended?: 'released' | 'expired' }
export interface LeaseStore { read(): Promise<StoredLease[]>; write(leases: StoredLease[]): Promise<void> }

/**
 * An `IncarnationStore` over a durable `{max}` record: read `D`, take `max(D + 1, floor)`, write it, one call at
 * a time, so every hub sharing the record (the server's rooms, a relay's rooms) gets its own incarnation.
 */
export function serializedStore(record: { read(): Promise<number | undefined>; write(max: number): Promise<void> }): IncarnationStore {
  let queue: Promise<unknown> = Promise.resolve()
  const valid = (v: number | undefined, ceiling = 2 ** 32 - 1) => v !== undefined && Number.isSafeInteger(v) && v >= 0 && v < 2 ** 32 && v <= ceiling ? v : undefined
  return {
    current: async ceiling => valid(await record.read(), ceiling),
    advance(floor) {
      const run = queue.then(async () => {
        if (!Number.isSafeInteger(floor) || floor < 0 || floor >= 2 ** 32) throw new RoomStateError('incarnation floor is out of range')
        const next = Math.max((valid(await record.read(), floor + MAX_INCARNATION_AHEAD) ?? -1) + 1, floor)
        if (next >= 2 ** 32) throw new RoomStateError('incarnation counter exhausted')
        await record.write(next)
        return next
      })
      queue = run.catch(() => undefined)
      return run
    },
  }
}

export interface HubHost {
  doc: RoomDoc
  /** This process created the room and loaded no prior room document. */
  fresh?: boolean
  /** Monotonic milliseconds: lease TTLs and absence. */
  mono(): number
  /** Wall-clock milliseconds: message `at`, grant `at`, the incarnation floor. */
  wall(): number
  log(line: string): void
  store: IncarnationStore
  leases?: LeaseStore
  /** Relay: the holder process is gone (`liveness() === 'dead'`), so its lease ends at once. */
  holderDead?(h: HolderIn): boolean
  /** Relay: this process still holds the authority lock. */
  authority?(): boolean
  /** Server: may this principal hold `name`. */
  owns?(p: Principal, name: string): boolean
  /** Server: the room's document is over its size cap. */
  full?(): boolean
  /** Server: why the room cannot take coordination writes now (its storage is failing); undefined when it can. */
  unavailable?(): string | undefined
  /** Tests: retained history size for the operation-count scaling proof. */
  busKeep?: number
  /** Tests: a smaller per-incarnation counter limit than 2^21. */
  counterLimit?: number
}

/** The room's replicated state is not something a hub may start from; the durable record was left untouched. */
export class RoomStateError extends Error {
  override readonly name = 'RoomStateError'
}

export interface Hub {
  readonly incarnation: number
  stop(): void
  /** Tests and orderly handoff may await pending lease persistence; requests never do. */
  flushLeases(): Promise<void>
  handle(conn: object, frame: unknown, p: Principal, frameBytes?: number): Reply
  closed(conn: object): void
  /** Leases, re-assertion, trim and expiry; call every second. */
  tick(): void
  onPush(fn: (conn: object, push: Push) => void): void
}

type End = 'released' | 'expired'

/** The hub's record of a lease, at `participants[`${name}\0holder`]` (§4.1). */
export interface HubHolder extends HolderIn { epoch: number; at: number; ended?: End; session?: string; principal?: string }

/**
 * The hub's own word on a name, kept after its lease ends: the latest epoch it granted, adopted or ended.
 * Re-assertion writes it back over stale replicas, and the settle window never adopts an epoch at or below
 * an ended one. This table is reconstructed only from private lease storage.
 */
interface Known { epoch: number; at: number; holder?: HolderIn; ended?: End; principal?: string; session?: string }
/** A live lease; it is also its name's `Known` until it ends. The TTL state lives only here (§4.1). */
interface Lease extends Known { renewed: number; conn?: object }

const HOLDER = '\u0000holder'
const holderKey = (name: string) => `${name}${HOLDER}`
const encoder = new TextEncoder()
const sizeOf = (value: unknown) => encoder.encode(JSON.stringify(value)).length
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isName = (v: unknown): v is string => typeof v === 'string' && validParticipantName(v) && v.length <= 200
const isCounter = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < 2 ** 32 * COUNTER_LIMIT

function parseHolder(v: unknown, record = false): HolderIn | undefined {
  if (!isObject(v) || typeof v.sessionId !== 'string' || !v.sessionId || v.sessionId.length > MAX_HOLDER_FIELD_LENGTH
    || !Number.isSafeInteger(v.pid) || (v.pid as number) < 0 || (v.pid as number) > 2 ** 31 - 1
    || typeof v.startTime !== 'string' || v.startTime.length > MAX_HOLDER_FIELD_LENGTH
    || typeof v.executable !== 'string' || v.executable.length > MAX_HOLDER_FIELD_LENGTH
    || (v.workerId !== undefined && (typeof v.workerId !== 'string' || v.workerId.length > MAX_HOLDER_FIELD_LENGTH))
    || Object.keys(v).some(k => !['sessionId', 'pid', 'startTime', 'executable', 'workerId', ...(record ? ['epoch', 'at', 'ended', 'session', 'principal'] : [])].includes(k))) return undefined
  return { sessionId: v.sessionId, pid: v.pid as number, startTime: v.startTime, executable: v.executable, ...(v.workerId !== undefined ? { workerId: v.workerId as string } : {}) }
}

/** A hub-written holder: one with a numeric epoch. Records without one predate the hub and are not its to judge. */
function hubHolder(v: unknown): HubHolder | undefined {
  const holder = parseHolder(v, true)
  if (!holder || !isObject(v) || !isCounter(v.epoch) || !Number.isFinite(v.at)
    || (v.ended !== undefined && v.ended !== 'released' && v.ended !== 'expired')
    || (v.session !== undefined && (typeof v.session !== 'string' || v.session.length > MAX_HOLDER_FIELD_LENGTH))
    || (v.principal !== undefined && (typeof v.principal !== 'string' || v.principal.length > MAX_HOLDER_FIELD_LENGTH))) return undefined
  const ended = v.ended === 'released' || v.ended === 'expired' ? v.ended : undefined
  return { ...holder, epoch: v.epoch as number, at: typeof v.at === 'number' ? v.at : 0, ...(ended ? { ended } : {}),
    ...(typeof v.session === 'string' ? { session: v.session } : {}), ...(typeof v.principal === 'string' ? { principal: v.principal } : {}) }
}

const sameRecord = (a: HubHolder | undefined, b: HubHolder) => !!a && JSON.stringify(a) === JSON.stringify(b)

const higher = (a: number | undefined, b: number | undefined) => a === undefined ? b : b === undefined ? a : Math.max(a, b)

/**
 * The highest epoch and seq visible in the doc, the baselines of the meta mirrors, and the highest
 * incarnation (§3's `S`).
 */
function visible(doc: RoomDoc): { epoch?: number; seq?: number; incarnation: number; invalid: boolean } {
  let epoch: number | undefined, seq: number | undefined
  let invalid = false
  const see = (v: unknown, kind: 'epoch' | 'seq') => {
    if (v === undefined) return
    if (!isCounter(v)) { invalid = true; return }
    if (kind === 'epoch') epoch = higher(epoch, v); else seq = higher(seq, v)
  }
  const meta = doc.metaMap
  see(meta.get('hubEpoch'), 'epoch'); see(meta.get('hubSeq'), 'seq')
  for (const m of doc.bus.toArray()) see((m as { seq?: unknown })?.seq, 'seq')
  for (const m of doc.mail.values()) see((m as { seq?: unknown })?.seq, 'seq')
  // Holder records are replicated member-controlled content, never an authority counter source.
  const rawIncarnation = meta.get('hubIncarnation')
  if (rawIncarnation !== undefined && (!Number.isSafeInteger(rawIncarnation) || (rawIncarnation as number) < 0 || (rawIncarnation as number) >= 2 ** 32)) invalid = true
  const incarnation = Math.max(isCounter(rawIncarnation) ? rawIncarnation as number : -1,
    ...[epoch, seq].map(v => v === undefined ? -1 : incarnationOf(v)))
  return { epoch, seq, incarnation, invalid }
}

export async function startHub(host: HubHost): Promise<Hub> {
  const hub = new RoomHub(host)
  await hub.start()
  return hub
}

class RoomHub implements Hub {
  incarnation = 0
  private readonly limit: number
  private epochs = 0
  private seqs = 0
  private lastEpoch?: number
  private lastSeq?: number
  private reincarnating?: Promise<void>
  private startedAt = 0
  private freshAtStart = false
  private settled = false
  private maintainedAt = 0
  private dirty = false
  private stopped = false
  private unauthorized = false
  private unavailableSince?: number
  private tenure!: ExpiryTenure
  private readonly leases = new Map<string, Lease>()
  private readonly records = new Map<string, Known>()
  private readonly unadopted = new Map<string, StoredLease>()
  private stored = new Map<string, StoredLease>()
  private leaseWrite?: Promise<void>
  private leaseDirty = false
  private leaseWriteFailed = false
  private readonly greeted = new Set<object>()
  private readonly sessions = new Map<object, string>()
  private readonly rates = new Map<string, { at: number; count: number }>()
  private push: (conn: object, push: Push) => void = () => {}
  private readonly onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === HUB_ORIGIN) return
    this.dirty = true
    if (this.settling() && !this.storageUnavailable()) this.adoptSynced()
  }

  constructor(private readonly host: HubHost) {
    this.limit = host.counterLimit ?? COUNTER_LIMIT
  }

  private get doc(): RoomDoc { return this.host.doc }

  async start(): Promise<void> {
    if (this.host.unavailable?.()) throw new Error('hub storage unavailable at startup')
    const before = visible(this.doc)
    const wallFloor = Math.floor(this.host.wall() / 1000)
    const trusted = Math.max(await this.host.store.current?.(wallFloor + MAX_INCARNATION_AHEAD) ?? -1, wallFloor, this.incarnation)
    if (before.invalid || before.incarnation > trusted || trusted >= 2 ** 32) throw new RoomStateError('room hub counters exceed the trusted incarnation bound')
    this.freshAtStart = this.host.fresh === true && before.epoch === undefined && before.seq === undefined && before.incarnation < 0
      && ![...this.doc.participants.keys()].some(key => key.endsWith(HOLDER))
    await this.incarnate()
    if (this.host.leases) {
      try {
        const rows: unknown = await this.host.leases.read()
        if (!Array.isArray(rows) || rows.length > MAX_RETAINED_NAMES) throw new Error('invalid lease count')
        const loaded = new Map<string, StoredLease>()
        for (const row of rows) {
          if (!isObject(row) || Object.keys(row).some(k => !['name', 'epoch', 'at', 'holder', 'principal', 'session', 'ended'].includes(k))
            || !isName(row.name) || !isCounter(row.epoch) || incarnationOf(row.epoch) >= this.incarnation
            || !Number.isFinite(row.at) || (row.at as number) < 0 || !parseHolder(row.holder)
            || typeof row.principal !== 'string' || !row.principal || row.principal.length > MAX_HOLDER_FIELD_LENGTH
            || typeof row.session !== 'string' || !row.session || row.session.length > MAX_HOLDER_FIELD_LENGTH
            || (row.ended !== undefined && row.ended !== 'released' && row.ended !== 'expired')
            || loaded.has(row.name)) throw new Error('invalid lease record')
          loaded.set(row.name, row as unknown as StoredLease)
        }
        this.stored = loaded
      } catch (e) { this.stored.clear(); this.host.log(`hub: lease store unreadable; no leases adopted: ${e instanceof Error ? e.message : e}`) }
    }
    this.tenure = new ExpiryTenure(`inc:${this.incarnation}`, () => this.host.mono())
    this.startedAt = this.maintainedAt = this.host.mono()
    this.adoptStored()
    deliveryIndex(this.doc) // Start observers before the first member update.
    this.adoptSynced() // only mirror baselines; never ownership
    this.doc.doc.on('update', this.onUpdate)
    this.host.log(`hub: incarnation ${this.incarnation}, ${this.leases.size} lease(s) carried over`)
  }

  /** Take a new incarnation (§3): durable before anything is issued under it. */
  private async incarnate(): Promise<void> {
    const seen = visible(this.doc)
    const wallFloor = Math.floor(this.host.wall() / 1000)
    const trusted = Math.max(await this.host.store.current?.(wallFloor + MAX_INCARNATION_AHEAD) ?? -1, wallFloor, this.incarnation)
    if (seen.invalid || seen.incarnation > trusted || trusted >= 2 ** 32) throw new RoomStateError('room hub counters exceed the trusted incarnation bound')
    const floor = Math.max(seen.incarnation + 1, this.incarnation + 1, wallFloor)
    const next = await this.host.store.advance(floor)
    if (!Number.isInteger(next) || next < floor || next >= 2 ** 32) throw new Error(`incarnation store returned ${next} for floor ${floor}`)
    this.incarnation = next
    this.epochs = this.seqs = 0
    this.doc.doc.transact(() => { this.doc.metaMap.set('hubIncarnation', next) }, HUB_ORIGIN)
  }

  stop(): void {
    this.stopped = true
    this.doc.doc.off('update', this.onUpdate)
  }

  async flushLeases(): Promise<void> {
    if (!this.host.leases) return
    while (this.leaseWrite || this.leaseDirty) {
      if (!this.leaseWrite) { this.leaseWriteFailed = false; this.writeLeases() }
      await this.leaseWrite
      if (this.leaseWriteFailed) throw new Error('lease store write failed')
    }
  }

  onPush(fn: (conn: object, push: Push) => void): void { this.push = fn }

  closed(conn: object): void {
    this.greeted.delete(conn)
    this.sessions.delete(conn)
    for (const lease of this.leases.values()) if (lease.conn === conn) lease.conn = undefined
  }

  private settling(): boolean { return !this.freshAtStart && this.host.mono() - this.startedAt < SETTLE_MS }

  private notify(name: string, lease: Lease, reason: LeaseLostReason): void {
    if (lease.conn) this.push(lease.conn, { v: 1, push: 'lease-lost', name, epoch: lease.epoch, reason })
  }

  private authorized(): boolean {
    if (this.stopped) return false
    if (!this.host.authority || this.host.authority()) { this.unauthorized = false; return true }
    if (!this.unauthorized) {
      this.unauthorized = true
      this.host.log('hub: lost the authority lock; answering not-authority')
      for (const [name, lease] of this.leases) this.notify(name, lease, 'not-authority')
    }
    return false
  }

  // ---- leases ----

  private record(name: string): HubHolder | undefined { return hubHolder(this.doc.participants.get(holderKey(name))) }

  /** The doc record for what the hub knows of a name, when it knows the holder. */
  private recordOf(k: Known): HubHolder | undefined {
    return k.holder && { ...k.holder, epoch: k.epoch, at: k.at, ...(k.ended ? { ended: k.ended } : {}),
      ...(k.session ? { session: k.session } : {}), ...(k.principal ? { principal: k.principal } : {}) }
  }

  /** A lease is live from here: granted, or adopted from an earlier incarnation. The participant is back (§8). */
  private hold(name: string, lease: Lease): void {
    this.leases.set(name, lease)
    this.records.set(name, lease)
    this.tenure.present(this.doc, name, HUB_ORIGIN)
    this.remember(name, lease)
  }

  private remember(name: string, known: Known): void {
    if (!known.holder || !known.principal || !known.session) return
    this.stored.set(name, { name, epoch: known.epoch, at: known.at, holder: known.holder,
      principal: known.principal, session: known.session, ...(known.ended ? { ended: known.ended } : {}) })
    this.leaseDirty = true
    this.leaseWriteFailed = false
    this.writeLeases()
  }

  private writeLeases(): void {
    if (!this.host.leases || this.leaseWrite || !this.leaseDirty) return
    this.leaseDirty = false
    const snapshot = [...this.stored.values()]
    this.leaseWrite = Promise.resolve().then(() => this.host.leases!.write(snapshot))
      .catch(e => { this.leaseDirty = true; this.leaseWriteFailed = true; this.host.log(`hub: lease store write failed: ${e instanceof Error ? e.message : e}`) })
      .finally(() => { this.leaseWrite = undefined; if (this.leaseDirty && !this.stopped && !this.leaseWriteFailed) this.writeLeases() })
  }

  private adoptStored(): void {
    for (const record of this.stored.values()) {
      if (this.allocationFailure(record.name, record.principal, !record.ended)) {
        this.unadopted.set(record.name, record)
        this.stored.delete(record.name); this.leaseDirty = true; continue
      }
      const known: Known = { epoch: record.epoch, at: record.at, holder: record.holder,
        principal: record.principal, session: record.session, ...(record.ended ? { ended: record.ended } : {}) }
      if (record.ended) this.records.set(record.name, known)
      else {
        this.leases.set(record.name, { ...known, renewed: this.host.mono() })
        this.records.set(record.name, known)
        this.tenure.present(this.doc, record.name, HUB_ORIGIN)
      }
    }
    this.writeLeases()
  }

  private principal(p: Principal): string { return 'local' in p ? 'local' : p.id ?? `login:${p.login ?? ''}` }

  private owner(conn: object, p: Principal, name: string, lease: Known | undefined): boolean {
    if (this.host.owns && !this.host.owns(p, name)) return false
    if (!lease?.principal || lease.principal !== this.principal(p)) return false
    const session = this.sessions.get(conn)
    return !!session && (lease?.session ? lease.session === session : lease?.holder?.sessionId === session)
  }

  private storageUnavailable(): string | undefined {
    const text = this.host.unavailable?.()
    if (text) { this.unavailableSince ??= this.host.mono(); return text }
    if (this.unavailableSince !== undefined) {
      this.unavailableSince = undefined
      const now = this.host.mono()
      for (const lease of this.leases.values()) lease.renewed = now
      this.maintainedAt = now
      this.tenure = new ExpiryTenure(`inc:${this.incarnation}`, () => this.host.mono())
    }
    return undefined
  }

  private unavailable(fail: Fail): Reply | undefined {
    const text = this.storageUnavailable()
    return text ? fail('unavailable', text, { retryMs: 1000 }) : undefined
  }

  private limited(key: string, limit: number): number | undefined {
    const now = this.host.mono()
    const rate = this.rates.get(key)
    if (!rate || now - rate.at >= POST_RATE_WINDOW_MS) {
      if (!rate && this.rates.size >= MAX_RATE_KEYS) {
        for (const [k, v] of this.rates) if (now - v.at >= POST_RATE_WINDOW_MS) this.rates.delete(k)
        if (this.rates.size >= MAX_RATE_KEYS) {
          const oldLease = [...this.rates.keys()].find(k => k.startsWith('lease:'))
          if (oldLease) this.rates.delete(oldLease)
        }
      }
      this.rates.set(key, { at: now, count: 1 }); return undefined
    }
    if (rate.count >= limit) return Math.max(1, POST_RATE_WINDOW_MS - (now - rate.at))
    rate.count++
    return undefined
  }

  private pruneRecords(): void {
    if (this.records.size < MAX_RETAINED_NAMES) return
    const ended = [...this.records].filter(([name, r]) => r.ended && !this.leases.has(name)).sort((a, b) => a[1].at - b[1].at)
    for (const [name] of ended) {
      if (this.records.size < MAX_RETAINED_NAMES) break
      this.records.delete(name)
      this.stored.delete(name); this.leaseDirty = true; this.writeLeases()
      this.doc.doc.transact(() => { this.doc.participants.delete(holderKey(name)) }, HUB_ORIGIN)
    }
  }

  private prunePrincipal(principal: string): void {
    const mine = [...this.records].filter(([, r]) => r.principal === principal)
    if (mine.length < MAX_RETAINED_NAMES_PER_PRINCIPAL) return
    const ended = mine.filter(([name, r]) => r.ended && !this.leases.has(name)).sort((a, b) => a[1].at - b[1].at)
    for (const [name] of ended) {
      if ([...this.records.values()].filter(r => r.principal === principal).length < MAX_RETAINED_NAMES_PER_PRINCIPAL) break
      this.records.delete(name)
      this.stored.delete(name); this.leaseDirty = true; this.writeLeases()
      this.doc.doc.transact(() => { this.doc.participants.delete(holderKey(name)) }, HUB_ORIGIN)
    }
  }

  /** The same allocation budget governs new grants and both ways of carrying a synced holder. */
  private allocationFailure(name: string, principal: string, live: boolean): string | undefined {
    this.prunePrincipal(principal)
    this.pruneRecords()
    if (live && [...this.leases].filter(([n]) => n !== name).length >= MAX_LEASES_PER_ROOM) return 'the room has too many live leases'
    if (live && [...this.leases].filter(([n, l]) => n !== name && l.principal === principal).length >= MAX_LEASES_PER_PRINCIPAL) return 'this principal has too many live leases'
    if ([...this.records].filter(([n]) => n !== name).length >= MAX_RETAINED_NAMES) return 'the room has too many retained names'
    if ([...this.records].filter(([n, r]) => n !== name && r.principal === principal).length >= MAX_RETAINED_NAMES_PER_PRINCIPAL) return 'this principal has too many retained names'
    return undefined
  }

  /**
   * The name's live lease. One past its TTL, or whose process is gone, ends here; so does one inherited from
   * an earlier incarnation whose own record now says it ended (that hub's release or expiry, synced late).
   */
  private live(name: string): Lease | undefined {
    const lease = this.leases.get(name)
    if (!lease) return undefined
    const expired = this.host.mono() - lease.renewed >= LEASE_TTL_MS || !!(lease.holder && this.host.holderDead?.(lease.holder))
    if (!expired) return lease
    this.end(name, lease, 'expired')
    this.notify(name, lease, 'expired')
    return undefined
  }

  private end(name: string, lease: Lease, how: End): void {
    this.leases.delete(name)
    const ended: Known = { epoch: lease.epoch, at: lease.at, ...(lease.holder ? { holder: lease.holder } : {}), principal: lease.principal, session: lease.session, ended: how }
    this.records.set(name, ended)
    this.remember(name, ended)
    const record = this.recordOf(ended)
    if (record) this.doc.doc.transact(() => { this.doc.participants.set(holderKey(name), record) }, HUB_ORIGIN)
    this.host.log(`hub: lease ${lease.epoch} on ${name} ${how}`)
  }

  /**
   * Take in earlier incarnations' holders (§4.4), at the start and while settling: an un-ended one above
   * what the hub knows is carried over with a fresh TTL, an ended one is remembered. The mirrors' baselines
   * rise to the highest values seen.
   */
  private adoptSynced(): void {
    const seen = visible(this.doc)
    this.lastEpoch = higher(this.lastEpoch, seen.epoch)
    this.lastSeq = higher(this.lastSeq, seen.seq)
  }

  /** Whether `count` more values can be issued now; if not, a new incarnation is taken (§3). */
  private reserve(kind: 'epoch' | 'seq', count: number): boolean {
    if (this.reincarnating) return false
    if ((kind === 'epoch' ? this.epochs : this.seqs) + count <= this.limit) return true
    this.reincarnating = this.incarnate()
      .catch(e => this.host.log(`hub: could not take a new incarnation: ${e instanceof Error ? e.message : e}`))
      .finally(() => { this.reincarnating = undefined })
    return false
  }

  /** The next epoch or seq, or undefined while a new incarnation is being taken. */
  private issue(kind: 'epoch' | 'seq'): number | undefined {
    if (!this.reserve(kind, 1)) return undefined
    const n = kind === 'epoch' ? this.epochs++ : this.seqs++
    return encodeSeq(this.incarnation, n)
  }

  /** Append a message with the next seq and the hub's `at`, mirrored in `meta.hubSeq`; undefined while reincarnating. */
  private append(msg: Record<string, unknown> & { id: string; type: MsgType; from: string }, wall: number): Msg | undefined {
    const seq = this.issue('seq')
    if (seq === undefined) return undefined
    const record = { ...msg, seq, at: wall } as unknown as Msg
    this.lastSeq = seq
    this.doc.doc.transact(() => {
      this.doc.bus.push([record])
      this.doc.metaMap.set('hubSeq', seq)
    }, HUB_ORIGIN)
    const keep = this.host.busKeep ?? BUS_KEEP
    // Count hysteresis amortises the full O(n) pass; byte hysteresis reserves one maximum post.
    const highBytes = BUS_BYTES - MAX_MESSAGE_BYTES - 1024
    if (this.doc.bus.length > keep + Math.max(1, Math.ceil(keep / 10)) || deliveryIndex(this.doc).bus.bytes > highBytes)
      trim(this.doc, wall, { origin: HUB_ORIGIN, busKeep: keep, busBytes: highBytes * 0.9 })
    return record
  }

  // ---- requests ----

  handle(conn: object, frame: unknown, p: Principal, frameBytes?: number): Reply {
    const re = hubReplyId(frame)
    const fail = (reason: Reason, text: string, extra: Record<string, unknown> = {}): Reply => ({ v: 1, re, ok: false, reason, text, ...extra })
    try { return this.handleSafe(conn, frame, p, fail, frameBytes) }
    catch (error) { this.host.log(`hub: rejected request: ${error instanceof Error ? error.message : String(error)}`); return fail('invalid', 'invalid hub request') }
  }

  private handleSafe(conn: object, frame: unknown, p: Principal, fail: Fail, frameBytes?: number): Reply {
    const re = isObject(frame) && typeof frame.id === 'string' ? frame.id : ''
    if ((frameBytes ?? sizeOf(frame)) > MAX_HUB_FRAME_BYTES) return fail('too-large', 'hub request exceeds the frame limit')
    if (!isObject(frame) || frame.v !== 1 || !re || re.length > 128 || typeof frame.op !== 'string') {
      this.host.log(`hub: invalid frame ${JSON.stringify(frame)?.slice(0, 200)}`)
      return fail('invalid', 'a hub request needs v: 1, an id and an op')
    }
    const fields: Record<string, string[]> = {
      hello: ['proto', 'schema', 'client', 'sessionId'], acquire: ['name', 'holder', 'supersedes'],
      renew: ['name', 'epoch'], release: ['name', 'epoch'], post: ['lease', 'msg', 'auto'],
    }
    const op = frame.op as string
    if (fields[op] && Object.keys(frame).some(k => !['v', 'id', 'op', ...fields[op]].includes(k))) return fail('invalid', 'unknown hub request field')
    if (!this.authorized()) return fail('not-authority', 'not the authority; reconnect')
    if ('readOnly' in p && p.readOnly) return fail('read-only', 'this connection is read-only')
    const req = frame as Req
    if (req.op === 'hello') return this.hello(conn, req, fail)
    if (!this.greeted.has(conn)) return fail('hello-first', 'send hello first')
    const starting = () => fail('starting', 'the hub is starting', { retryMs: STARTING_RETRY_MS })
    switch (req.op) {
      case 'acquire': return this.acquire(conn, req, p, fail, starting)
      case 'renew': return this.renew(conn, req, p, fail)
      case 'release': return this.release(conn, req, p, fail)
      case 'post': return this.post(conn, req, p, fail, starting)
      default: return fail('invalid', `unknown op ${JSON.stringify((req as { op: unknown }).op)}`)
    }
  }

  private hello(conn: object, req: Extract<Req, { op: 'hello' }>, fail: Fail): Reply {
    if (req.proto !== HUB_PROTO) {
      return fail('version', typeof req.proto === 'number' && req.proto > HUB_PROTO
        ? `[room] this room's hub speaks protocol ${HUB_PROTO}; the hub needs updating`
        : `[room] this room's hub speaks protocol ${HUB_PROTO}; update Room to 0.17 or later`)
    }
    if (typeof req.sessionId !== 'string' || !req.sessionId || req.sessionId.length > MAX_HOLDER_FIELD_LENGTH
      || typeof req.client !== 'string' || req.client.length > 128 || req.schema !== 2) return fail('invalid', 'hello needs a supported schema, client and session')
    this.greeted.add(conn)
    this.sessions.set(conn, req.sessionId)
    return { v: 1, re: req.id, ok: true, proto: HUB_PROTO, incarnation: this.incarnation, ttlMs: LEASE_TTL_MS, renewMs: LEASE_RENEW_MS, authority: true }
  }

  private acquire(conn: object, req: Extract<Req, { op: 'acquire' }>, p: Principal, fail: Fail, starting: () => Reply): Reply {
    const holder = parseHolder(req.holder)
    if (!isName(req.name) || !holder || (req.supersedes !== undefined && !isCounter(req.supersedes))) return fail('invalid', 'acquire needs a name and a holder')
    const { name } = req
    if (this.host.owns && !this.host.owns(p, name)) return fail('not-yours', `${name} is not a name this login may hold`)
    const unavailable = this.unavailable(fail)
    if (unavailable) return unavailable
    if (this.host.full?.()) return fail('room-full', "this room's document is over its size limit")
    const live = this.live(name)
    // `supersedes` is the explicit handoff (a lead's reservation passed to its worker): any session of the SAME
    // principal may take the lease by its epoch; the epoch is public, so another principal never may.
    if (req.supersedes !== undefined && this.records.get(name)?.epoch === req.supersedes
      && this.records.get(name)?.principal !== this.principal(p)) return fail('not-yours', `${name} belongs to another principal`)
    if (!live && this.settling()) return starting()
    if (live && live.principal !== this.principal(p)) return fail('not-yours', `${name} belongs to another principal`)
    if (live && req.supersedes !== live.epoch
      && (live.holder?.sessionId !== holder.sessionId || (live.session ?? live.holder?.sessionId) !== this.sessions.get(conn))) {
      return fail('held', `${name} is held by another session`, { holder: { sessionId: live.holder?.sessionId, since: live.at } })
    }
    const capacity = this.allocationFailure(name, this.principal(p), true)
    if (capacity) return fail('room-full', capacity)
    const epoch = this.issue('epoch')
    if (epoch === undefined) return starting()
    if (live) this.notify(name, live, 'superseded')
    const lease = { epoch, holder, at: this.host.wall(), renewed: this.host.mono(), conn, principal: this.principal(p), session: this.sessions.get(conn) }
    this.lastEpoch = epoch
    this.doc.doc.transact(() => {
      this.hold(name, lease)
      this.doc.participants.set(holderKey(name), this.recordOf(lease)!)
      this.doc.metaMap.set('hubEpoch', epoch)
    }, HUB_ORIGIN)
    this.host.log(`hub: granted ${name} to ${holder.sessionId} at epoch ${epoch}${live ? ` (superseding ${live.epoch})` : ''}`)
    return { v: 1, re: req.id, ok: true, epoch, ttlMs: LEASE_TTL_MS }
  }

  private renew(conn: object, req: Extract<Req, { op: 'renew' }>, p: Principal, fail: Fail): Reply {
    if (!isName(req.name) || !isCounter(req.epoch)) return fail('invalid', 'renew needs a name and an epoch')
    const { name, epoch } = req
    const existing = this.leases.get(name) ?? this.records.get(name)
    const denied = this.unadopted.get(name)
    if (denied?.epoch === epoch && denied.principal === this.principal(p) && denied.session === this.sessions.get(conn))
      return fail('room-full', 'the stored lease exceeds this room’s lease quota')
    if (this.host.owns && !this.host.owns(p, name) || existing?.epoch === epoch && !this.owner(conn, p, name, existing)) {
      return fail('not-yours', `${name} belongs to another holder session`)
    }
    const outage = this.unavailable(fail)
    if (outage) {
      const lease = this.leases.get(name)
      if (lease?.epoch !== epoch) return outage
      lease.renewed = this.host.mono()
      lease.conn = conn
      return { v: 1, re: req.id, ok: true, ttlMs: LEASE_TTL_MS }
    }
    const live = this.live(name)
    const ok = (): Reply => ({ v: 1, re: req.id, ok: true, ttlMs: LEASE_TTL_MS })
    if (live?.epoch === epoch) {
      if (!this.owner(conn, p, name, live)) return fail('not-yours', `${name} belongs to another holder session`)
      live.renewed = this.host.mono(); live.conn = conn; return ok()
    }
    return fail('stale', `epoch ${epoch} is not the live lease on ${name}`)
  }

  private release(conn: object, req: Extract<Req, { op: 'release' }>, p: Principal, fail: Fail): Reply {
    if (!isName(req.name) || !isCounter(req.epoch)) return fail('invalid', 'release needs a name and an epoch')
    const existing = this.leases.get(req.name) ?? this.records.get(req.name)
    if (this.host.owns && !this.host.owns(p, req.name) || existing?.epoch === req.epoch && !this.owner(conn, p, req.name, existing)) {
      return fail('not-yours', `${req.name} belongs to another holder session`)
    }
    const unavailable = this.unavailable(fail)
    if (unavailable) return unavailable
    const live = this.live(req.name)
    const known = this.records.get(req.name)
    if ((live?.epoch === req.epoch || known?.epoch === req.epoch) && !this.owner(conn, p, req.name, live ?? known)) return fail('not-yours', `${req.name} belongs to another holder session`)
    if (live?.epoch === req.epoch) this.end(req.name, live, 'released')
    else if (!(known?.epoch === req.epoch && known.ended)) return fail('stale', `epoch ${req.epoch} is not the live lease on ${req.name}`)
    return { v: 1, re: req.id, ok: true }
  }

  private post(conn: object, req: Extract<Req, { op: 'post' }>, p: Principal, fail: Fail, starting: () => Reply): Reply {
    const msg = req.msg as PostIn | undefined
    if (sizeOf(msg) > MAX_MESSAGE_BYTES) return fail('too-large', `the message exceeds ${MAX_MESSAGE_BYTES / 1024} KiB`)
    if (!validMessageShape(msg) || !msg.id || !isName(msg.from) || (msg.to !== undefined && !isName(msg.to))
      || msg.at !== undefined || msg.seq !== undefined || (req.auto !== undefined && typeof req.auto !== 'boolean')) return fail('invalid', 'post has invalid message fields')
    // The fence: the poster's own live lease, whatever `from` says (a bridge posts for its workers under its own).
    if (!isObject(req.lease) || Object.keys(req.lease).some(k => k !== 'name' && k !== 'epoch')
      || !isName(req.lease.name) || !isCounter(req.lease.epoch)) return fail('invalid', "a post carries the poster's name lease")
    const existing = this.leases.get(req.lease.name) ?? this.records.get(req.lease.name)
    if (this.host.owns && !this.host.owns(p, req.lease.name)
      || existing?.epoch === req.lease.epoch && !this.owner(conn, p, req.lease.name, existing)) {
      return fail('not-yours', `${req.lease.name} belongs to another holder session`)
    }
    const unavailable = this.unavailable(fail)
    if (unavailable) return unavailable
    const live = this.live(req.lease.name)
    if (live?.epoch !== req.lease.epoch) return fail('stale', `epoch ${req.lease.epoch} is not the live lease on ${req.lease.name}`)
    if (!this.owner(conn, p, req.lease.name, live)) return fail('not-yours', `${req.lease.name} belongs to another holder session`)
    const retryMs = this.limited(`lease:${req.lease.name}`, POST_RATE_PER_LEASE)
      ?? this.limited(`principal:${this.principal(p)}`, POST_RATE_PER_PRINCIPAL)
      ?? this.limited('room', POST_RATE_PER_ROOM)
    if (retryMs) return fail('rate-limited', 'posting too quickly; retry shortly', { retryMs })
    const found = this.doc.message(msg.id)
    if (found) {
      const seq = (found as { seq?: unknown }).seq
      return { v: 1, re: req.id, ok: true, ...(isCounter(seq) ? { seq } : {}), at: found.at, duplicate: true }
    }
    if (this.doc.archive.has(msg.id) || this.doc.outcomes.has(msg.id)) return { v: 1, re: req.id, ok: true, duplicate: true, gone: true }
    const size = sizeOf(msg)
    if (size > MAX_MESSAGE_BYTES) return fail('too-large', `the message is ${Math.ceil(size / 1024)} KiB; the limit is ${MAX_MESSAGE_BYTES / 1024} KiB`)
    if (this.host.full?.()) return fail('room-full', "this room's document is over its size limit; close and reopen the repo, or ask the operator to raise ROOM_DOC_MAX_MB")
    const wall = this.host.wall()
    if (msg.to && !req.auto) {
      const admission = admit(this.doc, msg, wall, { origin: HUB_ORIGIN })
      if (!admission.ok) return fail('over-cap', admission.reason)
    }
    if (this.host.owns && !this.host.owns(p, msg.from)) this.host.log(`hub: observed a post from ${JSON.stringify(msg.from)} by ${'login' in p ? p.login ?? 'an anonymous connection' : 'a local connection'}; accepted`)
    let priority: Msg['priority']
    try { priority = (msg.priority as Msg['priority'] | undefined) ?? defaultPriority(msg) }
    catch { return fail('invalid', `cannot prioritise a ${msg.type} message`) }
    const record = this.append({ ...msg, priority }, wall)
    if (!record) return starting()
    return { v: 1, re: req.id, ok: true, seq: (record as unknown as { seq: number }).seq, at: wall }
  }

  // ---- maintenance ----

  tick(): void {
    if (this.leaseWriteFailed) { this.leaseWriteFailed = false; this.writeLeases() }
    try { this.tickSafe() }
    catch (error) { this.host.log(`hub: maintenance failed: ${error instanceof Error ? error.message : String(error)}`) }
  }

  private tickSafe(): void {
    if (!this.authorized()) return
    if (this.storageUnavailable()) return
    for (const name of [...this.leases.keys()]) this.live(name)
    if (this.settling()) return
    if (!this.settled) { this.settled = true; this.dirty = true }
    if (this.dirty) this.reassert()
    const now = this.host.mono()
    if (now - this.maintainedAt >= MAINTENANCE_MS) {
      this.maintainedAt = now
      // Deliberate full O(n) maintenance pass once per minute (TTL, mail/archive/outcome bounds).
      trim(this.doc, this.host.wall(), { origin: HUB_ORIGIN, busKeep: this.host.busKeep })
      this.expire()
    }
  }

  /** Rewrite hub-owned values a stale replica won back (§4.4). */
  private reassert(): void {
    this.dirty = false
    const { doc } = this
    const archived = (id: string) => doc.archive.has(id) || doc.outcomes.has(id)
    doc.doc.transact(() => {
      const names = new Set(this.records.keys())
      for (const [key, value] of doc.participants.entries()) if (key.endsWith(HOLDER) && hubHolder(value)) names.add(key.slice(0, -HOLDER.length))
      for (const name of names) {
        const current = this.record(name)
        let known = this.records.get(name)
        // Unverified replicas have no authority over ownership or terminal state.
        if (!known) {
          if (current && !current.ended)
            doc.participants.set(holderKey(name), { ...current, ended: 'expired' })
          continue
        }
        const want = this.recordOf(known)
        if (want) { if (!sameRecord(current, want)) doc.participants.set(holderKey(name), want) }
      }
      const meta = doc.metaMap
      if (meta.get('hubIncarnation') !== this.incarnation) meta.set('hubIncarnation', this.incarnation)
      if (this.lastEpoch !== undefined && meta.get('hubEpoch') !== this.lastEpoch) meta.set('hubEpoch', this.lastEpoch)
      if (this.lastSeq !== undefined && meta.get('hubSeq') !== this.lastSeq) meta.set('hubSeq', this.lastSeq)
      const index = deliveryIndex(doc).bus
      const changed = new Set(index.changed)
      index.changed.clear()
      // Ordinary ticks inspect only changed ids. A rare duplicate/archive resurrection needs array order.
      if (![...changed].some(id => index.count(id) > 1 || (index.count(id) && archived(id)))) return
      const seen = new Set<string>()
      const drop: number[] = []
      doc.bus.toArray().forEach((m, i) => {
        const id = (m as { id?: unknown })?.id
        if (typeof id !== 'string') return
        if (seen.has(id) || archived(id)) drop.push(i)
        seen.add(id)
      })
      for (const i of drop.reverse()) doc.bus.delete(i, 1)
    }, HUB_ORIGIN)
  }

  /**
   * Measure absence as "no live lease" and expire at ROOM_STALE_DAYS (§8). An expired participant's claims
   * are released with sequenced notices, so a pass runs only when every claim could get a seq.
   */
  private expire(): void {
    if (!this.reserve('seq', Math.min(this.doc.claims.size, this.limit))) return
    const view: ParticipantView[] = []
    for (const key of this.doc.participants.keys()) {
      if (!key.endsWith(HOLDER)) continue
      const name = key.slice(0, -HOLDER.length)
      view.push({ name, fresh: !!this.live(name), visible: true })
    }
    const wall = this.host.wall()
    const post: ReleasePoster = (from, body) =>
      this.append({ ...body, priority: body.priority ?? defaultPriority(body), id: newId('m_'), from: from.name, fromKind: from.kind }, wall)
    for (const name of this.tenure.observe(this.doc, view, HUB_ORIGIN, post)) {
      this.host.log(`hub: expired ${name}: no lease for the room's stale period`)
      const lease = this.leases.get(name)
      if (lease) { this.end(name, lease, 'expired'); this.notify(name, lease, 'expired-participant') }
      this.records.delete(name)
      this.stored.delete(name); this.leaseDirty = true; this.writeLeases()
    }
  }
}

type Fail = (reason: Reason, text: string, extra?: Record<string, unknown>) => Reply
