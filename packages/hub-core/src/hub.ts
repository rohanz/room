/**
 * The hub (docs/superpowers/specs/2026-09-28-hub.md): the one authority for name leases, bus order,
 * trim and participant expiry in a room. Transport-free and filesystem-free: adapters feed it frames
 * and a durable incarnation record, and call `tick` every second.
 */
import {
  BUS_KEEP, ExpiryTenure, MAX_MESSAGE_BYTES, MessageKinds, admit, defaultPriority, newId, trim, validParticipantName,
  type Msg, type MsgType, type ParticipantView, type ReleasePoster, type RoomDoc,
} from '@room/shared'
import {
  COUNTER_LIMIT, HUB_ORIGIN, HUB_PROTO, LEASE_RENEW_MS, LEASE_TTL_MS, SETTLE_MS, STARTING_RETRY_MS,
  encodeSeq, incarnationOf,
  type HolderIn, type LeaseLostReason, type PostIn, type Principal, type Push, type Reason, type Reply, type Req,
} from './protocol.js'

/** How often the hub trims the bus and measures absence (§8). */
export const MAINTENANCE_MS = 60_000

/** The durable incarnation record (§3). */
export interface IncarnationStore {
  /** Durably record and return `max(D + 1, floor)`, where `D` is the highest incarnation recorded so far. */
  advance(floor: number): Promise<number>
}

/**
 * An `IncarnationStore` over a durable `{max}` record: read `D`, take `max(D + 1, floor)`, write it, one call at
 * a time, so every hub sharing the record (the server's rooms, a relay's rooms) gets its own incarnation.
 */
export function serializedStore(record: { read(): Promise<number | undefined>; write(max: number): Promise<void> }): IncarnationStore {
  let queue: Promise<unknown> = Promise.resolve()
  return {
    advance(floor) {
      const run = queue.then(async () => {
        const next = Math.max((await record.read() ?? -1) + 1, floor)
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
  /** Monotonic milliseconds: lease TTLs and absence. */
  mono(): number
  /** Wall-clock milliseconds: message `at`, grant `at`, the incarnation floor. */
  wall(): number
  log(line: string): void
  store: IncarnationStore
  /** Relay: the holder process is gone (`liveness() === 'dead'`), so its lease ends at once. */
  holderDead?(h: HolderIn): boolean
  /** Relay: this process still holds the authority lock. */
  authority?(): boolean
  /** Server: may this principal hold `name`. */
  owns?(p: Principal, name: string): boolean
  /** Server: the room's document is over its size cap. */
  full?(): boolean
  /** Tests: a smaller per-incarnation counter limit than 2^21. */
  counterLimit?: number
}

export interface Hub {
  readonly incarnation: number
  stop(): void
  handle(conn: object, frame: unknown, p: Principal): Reply
  closed(conn: object): void
  /** Leases, re-assertion, trim and expiry; call every second. */
  tick(): void
  onPush(fn: (conn: object, push: Push) => void): void
}

type End = 'released' | 'expired'

/** The hub's record of a lease, at `participants[`${name}\0holder`]` (§4.1). */
export interface HubHolder extends HolderIn { epoch: number; at: number; ended?: End }

/**
 * The hub's own word on a name, kept after its lease ends: the latest epoch it granted, adopted or ended.
 * Re-assertion writes it back over stale replicas, and the settle window never adopts an epoch at or below
 * an ended one. `holder` is missing only for a lease adopted from a renew before its record synced.
 */
interface Known { epoch: number; at: number; holder?: HolderIn; ended?: End }
/** A live lease; it is also its name's `Known` until it ends. The TTL state lives only here (§4.1). */
interface Lease extends Known { renewed: number; conn?: object }

const HOLDER = '\u0000holder'
const holderKey = (name: string) => `${name}${HOLDER}`
const encoder = new TextEncoder()
const sizeOf = (value: unknown) => encoder.encode(JSON.stringify(value)).length
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isName = (v: unknown): v is string => typeof v === 'string' && validParticipantName(v) && v.length <= 200
const isCounter = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

function parseHolder(v: unknown): HolderIn | undefined {
  if (!isObject(v) || typeof v.sessionId !== 'string' || !v.sessionId || !Number.isInteger(v.pid)
    || typeof v.startTime !== 'string' || typeof v.executable !== 'string'
    || (v.workerId !== undefined && typeof v.workerId !== 'string')) return undefined
  return { sessionId: v.sessionId, pid: v.pid as number, startTime: v.startTime, executable: v.executable, ...(v.workerId !== undefined ? { workerId: v.workerId as string } : {}) }
}

/** A hub-written holder: one with a numeric epoch. Records without one predate the hub and are not its to judge. */
function hubHolder(v: unknown): HubHolder | undefined {
  const holder = parseHolder(v)
  if (!holder || !isObject(v) || !isCounter(v.epoch)) return undefined
  const ended = v.ended === 'released' || v.ended === 'expired' ? v.ended : undefined
  return { ...holder, epoch: v.epoch as number, at: typeof v.at === 'number' ? v.at : 0, ...(ended ? { ended } : {}) }
}

const sameRecord = (a: HubHolder | undefined, b: HubHolder) => !!a && JSON.stringify(a) === JSON.stringify(b)

function knownOf(record: HubHolder): Known {
  const { epoch, at, ended, ...holder } = record
  return { epoch, at, holder, ...(ended ? { ended } : {}) }
}

/** Fill in what a lease adopted from a renew lacked (its holder and grant time) from its epoch's record. */
function hydrate(known: Known, record: HubHolder): void {
  if (known.holder || record.epoch !== known.epoch) return
  const { at, holder } = knownOf(record)
  known.at = at
  known.holder = holder
}

const higher = (a: number | undefined, b: number | undefined) => a === undefined ? b : b === undefined ? a : Math.max(a, b)

/**
 * The highest epoch and seq visible in the doc, the baselines of the meta mirrors, and the highest
 * incarnation (§3's `S`).
 */
function visible(doc: RoomDoc): { epoch?: number; seq?: number; incarnation: number } {
  let epoch: number | undefined, seq: number | undefined
  const see = (v: unknown, kind: 'epoch' | 'seq') => {
    if (!isCounter(v)) return
    if (kind === 'epoch') epoch = higher(epoch, v); else seq = higher(seq, v)
  }
  const meta = doc.metaMap
  see(meta.get('hubEpoch'), 'epoch'); see(meta.get('hubSeq'), 'seq')
  for (const m of doc.bus.toArray()) see((m as { seq?: unknown })?.seq, 'seq')
  for (const m of doc.mail.values()) see((m as { seq?: unknown })?.seq, 'seq')
  for (const [key, value] of doc.participants.entries()) if (key.endsWith(HOLDER)) see((value as { epoch?: unknown })?.epoch, 'epoch')
  const incarnation = Math.max(isCounter(meta.get('hubIncarnation')) ? meta.get('hubIncarnation') as number : -1,
    ...[epoch, seq].map(v => v === undefined ? -1 : incarnationOf(v)))
  return { epoch, seq, incarnation }
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
  private settled = false
  private maintainedAt = 0
  private dirty = false
  private stopped = false
  private unauthorized = false
  private tenure!: ExpiryTenure
  private readonly leases = new Map<string, Lease>()
  private readonly records = new Map<string, Known>()
  private readonly greeted = new Set<object>()
  private push: (conn: object, push: Push) => void = () => {}
  private readonly onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === HUB_ORIGIN) return
    this.dirty = true
    if (this.settling()) this.adoptSynced()
  }

  constructor(private readonly host: HubHost) {
    this.limit = host.counterLimit ?? COUNTER_LIMIT
  }

  private get doc(): RoomDoc { return this.host.doc }

  async start(): Promise<void> {
    await this.incarnate()
    this.tenure = new ExpiryTenure(`inc:${this.incarnation}`, () => this.host.mono())
    this.startedAt = this.maintainedAt = this.host.mono()
    this.adoptSynced() // also takes the loaded mirror values as the baselines re-assertion restores
    this.doc.doc.on('update', this.onUpdate)
    this.host.log(`hub: incarnation ${this.incarnation}, ${this.leases.size} lease(s) carried over`)
  }

  /** Take a new incarnation (§3): durable before anything is issued under it. */
  private async incarnate(): Promise<void> {
    const floor = Math.max(visible(this.doc).incarnation + 1, this.incarnation + 1, Math.floor(this.host.wall() / 1000))
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

  onPush(fn: (conn: object, push: Push) => void): void { this.push = fn }

  closed(conn: object): void {
    this.greeted.delete(conn)
    for (const lease of this.leases.values()) if (lease.conn === conn) lease.conn = undefined
  }

  private settling(): boolean { return this.host.mono() - this.startedAt < SETTLE_MS }

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
    return k.holder && { ...k.holder, epoch: k.epoch, at: k.at, ...(k.ended ? { ended: k.ended } : {}) }
  }

  /** A lease is live from here: granted, or adopted from an earlier incarnation. The participant is back (§8). */
  private hold(name: string, lease: Lease): void {
    this.leases.set(name, lease)
    this.records.set(name, lease)
    this.tenure.present(this.doc, name, HUB_ORIGIN)
  }

  /**
   * The name's live lease. One past its TTL, or whose process is gone, ends here; so does one inherited from
   * an earlier incarnation whose own record now says it ended (that hub's release or expiry, synced late).
   */
  private live(name: string): Lease | undefined {
    const lease = this.leases.get(name)
    if (!lease) return undefined
    const record = incarnationOf(lease.epoch) < this.incarnation ? this.record(name) : undefined
    const ended = record?.epoch === lease.epoch ? record.ended : undefined
    const expired = this.host.mono() - lease.renewed >= LEASE_TTL_MS || !!(lease.holder && this.host.holderDead?.(lease.holder))
    if (!ended && !expired) return lease
    this.end(name, lease, ended ?? 'expired')
    this.notify(name, lease, 'expired')
    return undefined
  }

  private end(name: string, lease: Lease, how: End): void {
    this.leases.delete(name)
    const current = this.record(name)
    if (current) hydrate(lease, current)
    const ended: Known = { epoch: lease.epoch, at: lease.at, ...(lease.holder ? { holder: lease.holder } : {}), ended: how }
    this.records.set(name, ended)
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
    for (const [key, value] of this.doc.participants.entries()) {
      if (!key.endsWith(HOLDER)) continue
      const record = hubHolder(value)
      if (!record || incarnationOf(record.epoch) >= this.incarnation) continue
      const name = key.slice(0, -HOLDER.length)
      const known = this.records.get(name)
      const lease = this.leases.get(name)
      if (known && record.epoch <= known.epoch) {
        // A terminal record for a live lease's epoch ends it at its next `live` check.
        if (lease) hydrate(lease, record)
        continue
      }
      // A live lease below an earlier incarnation's record is itself inherited, and that grant superseded it.
      if (lease) { this.leases.delete(name); this.notify(name, lease, 'superseded') }
      if (record.ended) this.records.set(name, knownOf(record))
      else this.hold(name, { ...knownOf(record), renewed: this.host.mono() })
    }
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
    if (this.doc.bus.length > BUS_KEEP) trim(this.doc, wall, { origin: HUB_ORIGIN })
    return record
  }

  // ---- requests ----

  handle(conn: object, frame: unknown, p: Principal): Reply {
    const re = isObject(frame) && typeof frame.id === 'string' ? frame.id : ''
    const fail = (reason: Reason, text: string, extra: Record<string, unknown> = {}): Reply => ({ v: 1, re, ok: false, reason, text, ...extra })
    if (!isObject(frame) || frame.v !== 1 || !re || typeof frame.op !== 'string') {
      this.host.log(`hub: invalid frame ${JSON.stringify(frame)?.slice(0, 200)}`)
      return fail('invalid', 'a hub request needs v: 1, an id and an op')
    }
    if (!this.authorized()) return fail('not-authority', 'not the authority; reconnect')
    if ('readOnly' in p && p.readOnly) return fail('read-only', 'this connection is read-only')
    const req = frame as Req
    if (req.op === 'hello') return this.hello(conn, req, fail)
    if (!this.greeted.has(conn)) return fail('hello-first', 'send hello first')
    const starting = () => fail('starting', 'the hub is starting', { retryMs: STARTING_RETRY_MS })
    switch (req.op) {
      case 'acquire': return this.acquire(conn, req, p, fail, starting)
      case 'renew': return this.renew(conn, req, p, fail)
      case 'release': return this.release(req, fail)
      case 'post': return this.post(req, p, fail, starting)
      default: return fail('invalid', `unknown op ${JSON.stringify((req as { op: unknown }).op)}`)
    }
  }

  private hello(conn: object, req: Extract<Req, { op: 'hello' }>, fail: Fail): Reply {
    if (req.proto !== HUB_PROTO) {
      return fail('version', typeof req.proto === 'number' && req.proto > HUB_PROTO
        ? `[room] this room's hub speaks protocol ${HUB_PROTO}; the hub needs updating`
        : `[room] this room's hub speaks protocol ${HUB_PROTO}; update Room to 0.17 or later`)
    }
    this.greeted.add(conn)
    return { v: 1, re: req.id, ok: true, proto: HUB_PROTO, incarnation: this.incarnation, ttlMs: LEASE_TTL_MS, renewMs: LEASE_RENEW_MS, authority: true }
  }

  private acquire(conn: object, req: Extract<Req, { op: 'acquire' }>, p: Principal, fail: Fail, starting: () => Reply): Reply {
    const holder = parseHolder(req.holder)
    if (!isName(req.name) || !holder || (req.supersedes !== undefined && !isCounter(req.supersedes))) return fail('invalid', 'acquire needs a name and a holder')
    const { name } = req
    if (this.host.owns && !this.host.owns(p, name)) return fail('not-yours', `${name} is not a name this login may hold`)
    const live = this.live(name)
    if (!live && this.settling()) return starting()
    if (live && live.holder?.sessionId !== holder.sessionId && req.supersedes !== live.epoch) {
      return fail('held', `${name} is held by another session`, { holder: { sessionId: live.holder?.sessionId, since: live.at } })
    }
    const epoch = this.issue('epoch')
    if (epoch === undefined) return starting()
    if (live) this.notify(name, live, 'superseded')
    const lease = { epoch, holder, at: this.host.wall(), renewed: this.host.mono(), conn }
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
    const live = this.live(name)
    const ok = (): Reply => ({ v: 1, re: req.id, ok: true, ttlMs: LEASE_TTL_MS })
    if (live?.epoch === epoch) { live.renewed = this.host.mono(); live.conn = conn; return ok() }
    // A holder whose record has not synced yet renews an earlier incarnation's grant: adopt it (§4.4), unless
    // the hub already knows that epoch ended or a later one (a live lease is one too).
    const known = this.records.get(name)
    if (this.settling() && incarnationOf(epoch) < this.incarnation && (!known || epoch > known.epoch)
      && (!this.host.owns || this.host.owns(p, name))) {
      if (live) this.notify(name, live, 'superseded')
      const record = this.record(name)
      const synced = record?.epoch === epoch && !record.ended ? knownOf(record) : { epoch, at: this.host.wall() }
      this.hold(name, { ...synced, renewed: this.host.mono(), conn })
      this.host.log(`hub: adopted ${name} at epoch ${epoch} from a renew`)
      return ok()
    }
    return fail('stale', `epoch ${epoch} is not the live lease on ${name}`)
  }

  private release(req: Extract<Req, { op: 'release' }>, fail: Fail): Reply {
    if (!isName(req.name) || !isCounter(req.epoch)) return fail('invalid', 'release needs a name and an epoch')
    const live = this.live(req.name)
    const known = this.records.get(req.name)
    if (live?.epoch === req.epoch) this.end(req.name, live, 'released')
    else if (!(known?.epoch === req.epoch && known.ended)) return fail('stale', `epoch ${req.epoch} is not the live lease on ${req.name}`)
    return { v: 1, re: req.id, ok: true }
  }

  private post(req: Extract<Req, { op: 'post' }>, p: Principal, fail: Fail, starting: () => Reply): Reply {
    const msg = req.msg as PostIn | undefined
    if (!isObject(msg) || typeof msg.id !== 'string' || !msg.id || typeof msg.type !== 'string' || !MessageKinds[msg.type]
      || !isName(msg.from) || (msg.to !== undefined && typeof msg.to !== 'string')) return fail('invalid', 'post needs a message with an id, a known type and a sender')
    // The fence: the poster's own live lease, whatever `from` says (a bridge posts for its workers under its own).
    if (!isObject(req.lease) || !isName(req.lease.name) || !isCounter(req.lease.epoch)) return fail('invalid', "a post carries the poster's name lease")
    if (this.live(req.lease.name)?.epoch !== req.lease.epoch) return fail('stale', `epoch ${req.lease.epoch} is not the live lease on ${req.lease.name}`)
    const found = this.doc.messages().find(m => m.id === msg.id) ?? this.doc.mail.get(msg.id)
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
    if (!this.authorized()) return
    for (const name of [...this.leases.keys()]) this.live(name)
    if (this.settling()) return
    if (!this.settled) { this.settled = true; this.dirty = true }
    if (this.dirty) this.reassert()
    const now = this.host.mono()
    if (now - this.maintainedAt >= MAINTENANCE_MS) {
      this.maintainedAt = now
      trim(this.doc, this.host.wall(), { origin: HUB_ORIGIN })
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
        // A holder the hub never knew, above its own word and not live here: remember it as ended.
        if (current && !this.leases.has(name) && (!known || current.epoch > known.epoch)) {
          known = knownOf(current.ended ? current : { ...current, ended: 'expired' })
          this.records.set(name, known)
        }
        if (!known) continue
        if (current) hydrate(known, current)
        const want = this.recordOf(known)
        if (want) { if (!sameRecord(current, want)) doc.participants.set(holderKey(name), want) }
        else if (current && !current.ended) doc.participants.set(holderKey(name), { ...current, ended: 'expired' })
      }
      const meta = doc.metaMap
      if (meta.get('hubIncarnation') !== this.incarnation) meta.set('hubIncarnation', this.incarnation)
      if (this.lastEpoch !== undefined && meta.get('hubEpoch') !== this.lastEpoch) meta.set('hubEpoch', this.lastEpoch)
      if (this.lastSeq !== undefined && meta.get('hubSeq') !== this.lastSeq) meta.set('hubSeq', this.lastSeq)
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
      if (lease) { this.leases.delete(name); this.notify(name, lease, 'expired-participant') }
      this.records.delete(name)
    }
  }
}

type Fail = (reason: Reason, text: string, extra?: Record<string, unknown>) => Reply
