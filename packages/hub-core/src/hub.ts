/**
 * The hub (docs/superpowers/specs/2026-09-28-hub.md): the one authority for name leases, bus order,
 * trim and participant expiry in a room. Transport-free and filesystem-free: adapters feed it frames
 * and a durable incarnation record, and call `tick` every second.
 */
import {
  BUS_KEEP, ExpiryTenure, MAX_MESSAGE_BYTES, MessageKinds, admit, defaultPriority, trim, validParticipantName,
  type Msg, type ParticipantView, type RoomDoc,
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

/** The hub's record of a lease, at `participants[`${name}\0holder`]` (§4.1). */
export interface HubHolder extends HolderIn { epoch: number; at: number; ended?: 'released' | 'expired' }

interface Lease { epoch: number; holder?: HolderIn; at: number; renewed: number; conn?: object }

const holderKey = (name: string) => `${name}\u0000holder`
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

/** The highest incarnation visible in the doc (§3's `S`). */
function seenIncarnation(doc: RoomDoc): number {
  let max = -1
  const see = (v: unknown) => { if (isCounter(v)) max = Math.max(max, incarnationOf(v)) }
  const meta = doc.metaMap
  if (isCounter(meta.get('hubIncarnation'))) max = Math.max(max, meta.get('hubIncarnation') as number)
  see(meta.get('hubEpoch')); see(meta.get('hubSeq'))
  for (const m of doc.bus.toArray()) see((m as { seq?: unknown })?.seq)
  for (const m of doc.mail.values()) see((m as { seq?: unknown })?.seq)
  for (const [key, value] of doc.participants.entries()) if (key.endsWith('\u0000holder')) see((value as { epoch?: unknown })?.epoch)
  return max
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
    this.adoptSynced()
    this.doc.doc.on('update', this.onUpdate)
    this.host.log(`hub: incarnation ${this.incarnation}, ${this.leases.size} lease(s) carried over`)
  }

  /** Take a new incarnation (§3): durable before anything is issued under it. */
  private async incarnate(): Promise<void> {
    const floor = Math.max(seenIncarnation(this.doc) + 1, this.incarnation + 1, Math.floor(this.host.wall() / 1000))
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

  private recordOf(lease: Lease & { holder: HolderIn }): HubHolder { return { ...lease.holder, epoch: lease.epoch, at: lease.at } }

  /** The name's live lease; one past its TTL, or whose process is gone, ends here. */
  private live(name: string): Lease | undefined {
    const lease = this.leases.get(name)
    if (!lease) return undefined
    if (this.host.mono() - lease.renewed < LEASE_TTL_MS && !(lease.holder && this.host.holderDead?.(lease.holder))) return lease
    this.end(name, lease, 'expired')
    this.notify(name, lease, 'expired')
    return undefined
  }

  private end(name: string, lease: Lease, how: 'released' | 'expired'): void {
    this.leases.delete(name)
    const current = this.record(name)
    const base = current?.epoch === lease.epoch ? current : lease.holder ? this.recordOf({ ...lease, holder: lease.holder }) : undefined
    if (base) this.doc.doc.transact(() => { this.doc.participants.set(holderKey(name), { ...base, ended: how }) }, HUB_ORIGIN)
    this.host.log(`hub: lease ${lease.epoch} on ${name} ${how}`)
  }

  /** Inherited from an earlier incarnation, not granted by this one. */
  private inherited(lease: Lease): boolean { return incarnationOf(lease.epoch) < this.incarnation }

  /** Carry over un-ended holders from earlier incarnations with a fresh TTL (§4.4). */
  private adoptSynced(): void {
    for (const [key, value] of this.doc.participants.entries()) {
      if (!key.endsWith('\u0000holder')) continue
      const record = hubHolder(value)
      if (!record || record.ended || incarnationOf(record.epoch) >= this.incarnation) continue
      const name = key.slice(0, -'\u0000holder'.length)
      const lease = this.leases.get(name)
      const { epoch, at, ended: _ended, ...holder } = record
      if (lease?.epoch === epoch) { lease.holder ??= holder; continue }
      if (lease && !(this.inherited(lease) && epoch > lease.epoch)) continue
      if (lease) this.notify(name, lease, 'superseded')
      this.leases.set(name, { epoch, holder, at, renewed: this.host.mono() })
    }
  }

  /** The next epoch or seq, or undefined while a new incarnation is being taken. */
  private issue(kind: 'epoch' | 'seq'): number | undefined {
    if (this.reincarnating) return undefined
    const n = kind === 'epoch' ? this.epochs : this.seqs
    if (n >= this.limit) {
      this.reincarnating = this.incarnate()
        .catch(e => this.host.log(`hub: could not take a new incarnation: ${e instanceof Error ? e.message : e}`))
        .finally(() => { this.reincarnating = undefined })
      return undefined
    }
    if (kind === 'epoch') this.epochs++; else this.seqs++
    return encodeSeq(this.incarnation, n)
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
    this.leases.set(name, lease)
    this.lastEpoch = epoch
    this.doc.doc.transact(() => {
      this.doc.participants.set(holderKey(name), this.recordOf(lease))
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
    // A holder whose record has not synced yet renews an earlier incarnation's grant: adopt it (§4.4).
    if (this.settling() && incarnationOf(epoch) < this.incarnation && (!live || (this.inherited(live) && epoch > live.epoch))
      && (!this.host.owns || this.host.owns(p, name))) {
      if (live) this.notify(name, live, 'superseded')
      const record = this.record(name)
      const { epoch: _e, at: _a, ended: _x, ...holder } = record?.epoch === epoch ? record : ({} as Partial<HubHolder>)
      this.leases.set(name, { epoch, ...(holder.sessionId ? { holder: holder as HolderIn } : {}), at: record?.epoch === epoch ? record.at : this.host.wall(), renewed: this.host.mono(), conn })
      this.host.log(`hub: adopted ${name} at epoch ${epoch} from a renew`)
      return ok()
    }
    return fail('stale', `epoch ${epoch} is not the live lease on ${name}`)
  }

  private release(req: Extract<Req, { op: 'release' }>, fail: Fail): Reply {
    if (!isName(req.name) || !isCounter(req.epoch)) return fail('invalid', 'release needs a name and an epoch')
    const live = this.live(req.name)
    if (live?.epoch === req.epoch) this.end(req.name, live, 'released')
    else if (!(this.record(req.name)?.epoch === req.epoch && this.record(req.name)?.ended)) return fail('stale', `epoch ${req.epoch} is not the live lease on ${req.name}`)
    return { v: 1, re: req.id, ok: true }
  }

  private post(req: Extract<Req, { op: 'post' }>, p: Principal, fail: Fail, starting: () => Reply): Reply {
    const msg = req.msg as PostIn | undefined
    if (!isObject(msg) || typeof msg.id !== 'string' || !msg.id || typeof msg.type !== 'string' || !MessageKinds[msg.type]
      || !isName(msg.from) || (msg.to !== undefined && typeof msg.to !== 'string')) return fail('invalid', 'post needs a message with an id, a known type and a sender')
    if (req.lease !== undefined) {
      if (!isObject(req.lease) || !isName(req.lease.name) || !isCounter(req.lease.epoch)) return fail('invalid', 'post lease needs a name and an epoch')
      if (this.live(req.lease.name)?.epoch !== req.lease.epoch) return fail('stale', `epoch ${req.lease.epoch} is not the live lease on ${req.lease.name}`)
    }
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
    const seq = this.issue('seq')
    if (seq === undefined) return starting()
    let priority: Msg['priority']
    try { priority = (msg.priority as Msg['priority'] | undefined) ?? defaultPriority(msg) }
    catch { return fail('invalid', `cannot prioritise a ${msg.type} message`) }
    const record = { ...msg, priority, seq, at: wall } as unknown as Msg
    this.lastSeq = seq
    this.doc.doc.transact(() => {
      this.doc.bus.push([record])
      this.doc.metaMap.set('hubSeq', seq)
    }, HUB_ORIGIN)
    if (this.doc.bus.length > BUS_KEEP) trim(this.doc, wall, { origin: HUB_ORIGIN })
    return { v: 1, re: req.id, ok: true, seq, at: wall }
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
      const names = new Set(this.leases.keys())
      for (const [key, value] of doc.participants.entries()) if (key.endsWith('\u0000holder') && hubHolder(value)) names.add(key.slice(0, -'\u0000holder'.length))
      for (const name of names) {
        const current = this.record(name)
        const lease = this.leases.get(name)
        if (lease?.holder) {
          const want = this.recordOf({ ...lease, holder: lease.holder })
          if (!sameRecord(current, want)) doc.participants.set(holderKey(name), want)
        } else if (lease) {
          if (current?.epoch === lease.epoch && !current.ended) { const { epoch: _e, at: _a, ended: _x, ...holder } = current; lease.holder = holder }
        } else if (current && !current.ended) doc.participants.set(holderKey(name), { ...current, ended: 'expired' })
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

  /** Measure absence as "no live lease" and expire at ROOM_STALE_DAYS (§8). */
  private expire(): void {
    const view: ParticipantView[] = []
    for (const key of this.doc.participants.keys()) {
      if (!key.endsWith('\u0000holder')) continue
      const name = key.slice(0, -'\u0000holder'.length)
      view.push({ name, fresh: !!this.live(name), visible: true })
    }
    for (const name of this.tenure.observe(this.doc, view, HUB_ORIGIN)) {
      this.host.log(`hub: expired ${name}: no lease for the room's stale period`)
      const lease = this.leases.get(name)
      if (lease) { this.leases.delete(name); this.notify(name, lease, 'expired-participant') }
    }
  }
}

type Fail = (reason: Reason, text: string, extra?: Record<string, unknown>) => Reply
