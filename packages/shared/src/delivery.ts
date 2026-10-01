import * as Y from 'yjs'
import { BusIndex } from './bus-index.js'
import type { RoomDoc } from './doc.js'
import { messageAreas } from './ledger.js'
import { messageForMe, validMessageShape, type MessageRouteContext } from './messages.js'
import type { ArchivedMsg, ArchivedRelease, DeliveryCursor, Identity, Msg, MsgType, Outcome, Scope } from './types.js'

// The one delivery ledger: docs/superpowers/specs/2026-09-28-ledger.md ("The trim", "Message lookup").

const KiB = 1024
const MiB = 1024 * KiB
const DAY_MS = 24 * 60 * 60 * 1000

export const BUS_KEEP = 2000
export const BUS_BYTES = 1.5 * MiB
export const MAIL_MAX = 2000
export const MAIL_BYTES = 1.5 * MiB
export const OWED_PER_RECIPIENT = 200
export const OWED_BYTES_PER_RECIPIENT = 256 * KiB
export const ARCHIVE_MAX = 5000
export const ARCHIVE_BYTES = 512 * KiB
export const ARCHIVE_UNFULFILLED_MAX = 200
export const OUTCOMES_MAX = 2000
export const OUTCOMES_BYTES = 256 * KiB
export const OUTCOMES_TTL_MS = 30 * DAY_MS
export const RECEIPTS_BYTES = 256 * KiB
/** One serialized budget for the ledger's memory roots (4 MiB). */
export const LEDGER_BUDGET = BUS_BYTES + MAIL_BYTES + ARCHIVE_BYTES + OUTCOMES_BYTES + RECEIPTS_BYTES
export const REPLY_WINDOW_MS = 14 * DAY_MS
export const OWED_TTL_MS = 14 * DAY_MS
export const MAX_MESSAGE_BYTES = 64 * KiB

const encoder = new TextEncoder()
const sizeOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).length
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
/** The deterministic order `(at, id)`, oldest first. */
const byAge = (a: { at: number; id: string }, b: { at: number; id: string }): number => a.at - b.at || compare(a.id, b.id)

const selfSent = (m: Msg): boolean => m.from === m.to && m.fromKind !== 'human'
const addressedTo = (m: Msg, name: string): boolean => m.to === name && !selfSent(m)
const receipted = (doc: RoomDoc, name: string, id: string): boolean => doc.seen(name).has(id)

/** Addressed, with neither a receipt nor a terminal outcome. */
function isOwed(doc: RoomDoc, m: Msg): boolean {
  return !!m.to && !selfSent(m) && !doc.outcomes.has(m.id) && !receipted(doc, m.to, m.id)
}

function answeredIds(messages: Iterable<Msg>): Set<string> {
  const out = new Set<string>()
  for (const m of messages) if ((m.type === 'answer' || m.type === 'note') && m.inReplyTo) out.add(m.inReplyTo)
  return out
}

/** An addressed question or note that can still be answered, receipted or not (SF2). */
function replyEligible(m: Msg, answered: ReadonlySet<string>, now: number): boolean {
  return !!m.to && (m.type === 'question' || m.type === 'note') && !answered.has(m.id) && now - m.at < REPLY_WINDOW_MS
}

/** The highest hub `seq` on the bus (hub §3: seqs only increase, across hub restarts too); 0 when there is none. */
export function highestSeq(doc: RoomDoc): number {
  let high = 0
  for (const m of doc.messages()) if (typeof m.seq === 'number' && m.seq > high) high = m.seq
  return high
}

/**
 * Everything `me` is owed: addressed messages in bus ∪ mail, and bus broadcasts above the session's
 * frontier seq and outside `routed` that `messageForMe` accepts; minus receipts, outcomes and `!relevant`. Deduped
 * by id. Pure: relevance and routing are read-time decisions and write nothing.
 */
export function owed(doc: RoomDoc, me: Pick<Identity, 'name'>, cursor: DeliveryCursor, route: MessageRouteContext,
  relevant: (m: Msg) => boolean = () => true): Msg[] {
  const out = new Map<string, Msg>()
  const offer = (m: Msg) => {
    if (!out.has(m.id) && !doc.outcomes.has(m.id) && !receipted(doc, me.name, m.id) && relevant(m)) out.set(m.id, m)
  }
  for (const m of [...doc.mail.values()].sort(byAge)) if (addressedTo(m, me.name)) offer(m)
  for (const m of doc.messages()) {
    if (m.to) { if (addressedTo(m, me.name)) offer(m) }
    else if ((m.seq ?? 0) > cursor.frontier && !cursor.routed.has(m.id) && messageForMe(me, m, route)) offer(m)
  }
  return [...out.values()]
}

function compact(m: Msg, scopes: readonly Scope[]): ArchivedMsg {
  const entry: ArchivedMsg = [m.type, m.from, m.at, messageAreas(m, scopes)]
  if (m.type === 'release' && m.unfulfilled?.length) {
    entry.push({ path: m.path, plans: m.unfulfilled, ...(m.summary ? { summary: m.summary } : {}) })
  }
  return entry
}

/** Past a cap: receipted reply-eligible entries first, then owed fyi, notify, interrupt; questions last. */
function evictionClass(m: Msg, owedNow: boolean): number {
  if (!owedNow) return 0
  if (m.type === 'question') return 4
  return m.priority === 'fyi' ? 1 : m.priority === 'notify' ? 2 : 3
}

/** Keep the newest entries by `(at, id)` within a count and a byte budget. */
function newest<T extends { at: number; id: string; size: number }>(entries: T[], max: number, budget: number): Set<string> {
  const kept = new Set<string>()
  let spent = 0
  for (const e of [...entries].sort((a, b) => byAge(b, a))) {
    if (kept.size >= max || spent + e.size > budget) break
    kept.add(e.id); spent += e.size
  }
  return kept
}

export interface TrimReport { archived: number; mailed: number; expired: number; evicted: number; removed: number }
export interface TrimOptions { busKeep?: number; busBytes?: number; origin?: unknown }

/**
 * A pure, idempotent function of `(doc, now)`: every step only adds idempotent entries or removes items,
 * so two trimmers in a partition converge after merge.
 */
export function trim(doc: RoomDoc, now: number, opts: TrimOptions = {}): TrimReport {
  const report: TrimReport = { archived: 0, mailed: 0, expired: 0, evicted: 0, removed: 0 }
  const rawBus = doc.messages()
  const badBus: number[] = []
  rawBus.forEach((m, i) => { if (!validMessageShape(m)) badBus.push(i) })
  if (badBus.length) doc.doc.transact(() => { for (const i of badBus.reverse()) doc.bus.delete(i, 1) }, opts.origin)
  const bus = doc.messages()
  const mail = new Map([...doc.mail.entries()].filter(([id, m]) => typeof id === 'string' && validMessageShape(m)))
  const answered = answeredIds([...bus, ...mail.values()])
  const eligible = (m: Msg) => replyEligible(m, answered, now)

  // 1. Beyond the newest `busKeep`, or beyond BUS_BYTES counted from the newest, messages leave the bus.
  let cutoff = Math.max(0, bus.length - Math.max(0, opts.busKeep ?? BUS_KEEP))
  for (let i = bus.length - 1, bytes = 0; i >= cutoff; i--) {
    bytes += sizeOf(bus[i])
    if (bytes > (opts.busBytes ?? BUS_BYTES)) { cutoff = i + 1; break }
  }
  const stored = new Map<string, Msg>()
  // 2. Mail stays while owed or answerable.
  for (const [id, m] of mail) if (isOwed(doc, m) || eligible(m)) stored.set(id, m)
  for (const m of bus.slice(0, cutoff)) if (!stored.has(m.id) && !mail.has(m.id) && (isOwed(doc, m) || eligible(m))) stored.set(m.id, m)

  // 3. Bounds. Owed messages are counted over bus ∪ mail, deduped by id.
  const pending = new Map<string, Msg>()
  for (const m of [...stored.values(), ...bus.slice(cutoff)]) if (!pending.has(m.id) && isOwed(doc, m)) pending.set(m.id, m)
  const ended = new Map<string, Outcome>()
  const end = (m: Msg, outcome: Outcome['outcome']) => {
    ended.set(m.id, { to: m.to!, from: m.from, outcome, at: now })
    pending.delete(m.id); stored.delete(m.id)
    if (outcome === 'expired') report.expired++; else report.evicted++
  }
  for (const m of [...pending.values()]) if (now - m.at > OWED_TTL_MS) end(m, 'expired')
  const byRecipient = new Map<string, Msg[]>()
  for (const m of pending.values()) {
    const list = byRecipient.get(m.to!)
    if (list) list.push(m); else byRecipient.set(m.to!, [m])
  }
  const evictionOrder = (a: Msg, b: Msg) => evictionClass(a, pending.has(a.id)) - evictionClass(b, pending.has(b.id)) || byAge(a, b)
  for (const list of byRecipient.values()) {
    let count = list.length, bytes = list.reduce((n, m) => n + sizeOf(m), 0)
    for (const m of list.sort(evictionOrder)) {
      if (count <= OWED_PER_RECIPIENT && bytes <= OWED_BYTES_PER_RECIPIENT) break
      end(m, 'over-cap'); count--; bytes -= sizeOf(m)
    }
  }
  let mailCount = stored.size, mailBytes = [...stored.values()].reduce((n, m) => n + sizeOf(m), 0)
  for (const m of [...stored.values()].sort(evictionOrder)) {
    if (mailCount <= MAIL_MAX && mailBytes <= MAIL_BYTES) break
    mailCount--; mailBytes -= sizeOf(m)
    if (pending.has(m.id)) end(m, 'over-cap')
    else { stored.delete(m.id); report.evicted++ }
  }

  // 4. Retention of the archive and outcomes, over existing entries plus this trim's.
  const scopes = [...doc.scopes.values()].filter(s => s && typeof s.area === 'string' && Array.isArray(s.paths))
  const leaving = bus.filter((m, i) => i < cutoff || ended.has(m.id))
  const archived = new Map<string, ArchivedMsg>()
  for (const m of leaving) if (!doc.archive.has(m.id) && !archived.has(m.id)) archived.set(m.id, compact(m, scopes))
  const archive = [...doc.archive.entries(), ...archived.entries()]
    .filter(([id, entry]) => typeof id === 'string' && Array.isArray(entry) && typeof entry[2] === 'number' && Array.isArray(entry[3]))
    .map(([id, entry]) => ({ id, at: entry[2], size: id.length + sizeOf(entry), unfulfilled: !!entry[4] }))
  const keepArchive = newest(archive, ARCHIVE_MAX, ARCHIVE_BYTES)
  for (const id of newest(archive.filter(e => e.unfulfilled), ARCHIVE_UNFULFILLED_MAX, Infinity)) keepArchive.add(id)
  const outcomes = [...doc.outcomes.entries(), ...[...ended].filter(([id]) => !doc.outcomes.has(id))]
    .filter(([id, o]) => typeof id === 'string' && o && Number.isFinite(o.at) && typeof o.to === 'string' && typeof o.from === 'string' && ['expired', 'over-cap', 'recipient-retired'].includes(o.outcome) && now - o.at <= OUTCOMES_TTL_MS)
    .map(([id, o]) => ({ id, at: o.at, size: id.length + sizeOf(o) }))
  const keepOutcomes = newest(outcomes, OUTCOMES_MAX, OUTCOMES_BYTES)

  doc.doc.transact(() => {
    for (const [id, m] of doc.mail.entries()) if (!validMessageShape(m)) doc.mail.delete(id)
    for (const [id, entry] of archived) if (keepArchive.has(id)) { doc.archive.set(id, entry); report.archived++ }
    for (const id of [...doc.archive.keys()]) if (!keepArchive.has(id)) doc.archive.delete(id)
    for (const id of [...doc.mail.keys()]) if (!stored.has(id)) doc.mail.delete(id)
    for (const [id, m] of stored) if (!doc.mail.has(id)) { doc.mail.set(id, m); report.mailed++ }
    for (const [id, o] of ended) if (keepOutcomes.has(id) && !doc.outcomes.has(id)) doc.outcomes.set(id, o)
    for (const id of [...doc.outcomes.keys()]) if (!keepOutcomes.has(id)) doc.outcomes.delete(id)
    // Delete backwards so earlier indexes stay valid; Yjs deletes per item, so concurrent trimmers converge.
    for (let i = bus.length - 1; i >= 0;) {
      if (i >= cutoff && !ended.has(bus[i].id)) { i--; continue }
      let start = i
      while (start > 0 && (start - 1 < cutoff || ended.has(bus[start - 1].id))) start--
      doc.bus.delete(start, i - start + 1)
      report.removed += i - start + 1
      i = start - 1
    }
  }, opts.origin)
  deliveryIndex(doc).markTrimmed(now, opts)
  return report
}

export type Admission = { ok: true } | { ok: false; reason: string }

/** Process-local, rebuildable aggregates. All observers also see member/remote transactions. */
export class DeliveryIndex {
  readonly bus: BusIndex
  readonly recipients = new Map<string, { count: number; bytes: number }>()
  readonly pending = new Map<string, Msg>()
  owedBytes = 0
  private sizes = new Map<string, number>()
  private badMail = new Set<string>()
  private badOutcomes = new Set<string>()
  private mailCopies = new Map<string, Map<string, Msg>>()
  private mailIds = new Map<string, string>()
  private clean = false
  private cleanKeep = BUS_KEEP
  private cleanBytes = BUS_BYTES
  private oldest = Infinity
  private oldestOutcome = Infinity
  private changed = new Set<string>()
  private rebuildPending = false
  private rootNames = new Map<Y.AbstractType<any>, string>()
  private readonly afterTransaction = (tx: Y.Transaction) => {
    // Root names are immutable. Refresh the cache only when a previously unknown root appears.
    let unknown = false
    for (const type of tx.changed.keys()) if (type.parent === null && !this.rootNames.has(type)) { unknown = true; break }
    if (unknown) this.cacheRoots()
    for (const [type, keys] of tx.changed) {
      if (!(type instanceof Y.Map) || !this.rootNames.get(type)?.startsWith('seen:')) continue
      for (const key of keys) if (key !== null) this.changed.add(key)
    }
    const changed = this.changed
    this.changed = new Set()
    if (this.rebuildPending) { this.rebuildPending = false; this.rebuildAggregates() }
    else this.refreshMany(changed)
  }

  private cacheRoots(): void {
    for (const [name, type] of this.doc.doc.share) this.rootNames.set(type, name)
  }

  constructor(readonly doc: RoomDoc) {
    this.bus = new BusIndex(doc.bus, (ids, rebuilt) => {
      this.clean = false
      if (rebuilt) this.rebuildPending = true
      else for (const id of ids) this.changed.add(id)
    })
    doc.mail.observe(e => {
      for (const key of e.keysChanged) {
        const oldId = this.mailIds.get(key)
        this.checkMail(key)
        if (oldId) this.changed.add(oldId)
        const id = this.mailIds.get(key)
        if (id) this.changed.add(id)
      }
    })
    doc.outcomes.observe(e => {
      for (const id of e.keysChanged) { this.checkOutcome(id); this.changed.add(id) }
    })
    doc.archive.observe(e => { for (const id of e.keysChanged) if (this.bus.count(id)) this.bus.changed.add(id) })
    this.rebuildAggregates()
    this.cacheRoots()
    doc.doc.on('afterTransaction', this.afterTransaction)
    doc.doc.on('destroy', () => doc.doc.off('afterTransaction', this.afterTransaction))
  }

  private checkMail(key: string): void {
    const old = this.mailIds.get(key)
    if (old) {
      const copies = this.mailCopies.get(old)
      copies?.delete(key)
      if (!copies?.size) this.mailCopies.delete(old)
      this.mailIds.delete(key)
    }
    const m = this.doc.mail.get(key)
    if (this.doc.mail.has(key) && !validMessageShape(m)) this.badMail.add(key)
    else this.badMail.delete(key)
    if (validMessageShape(m)) {
      let copies = this.mailCopies.get(m.id)
      if (!copies) this.mailCopies.set(m.id, copies = new Map())
      copies.set(key, m); this.mailIds.set(key, m.id)
    }
  }

  private checkOutcome(id: string): void {
    const o = this.doc.outcomes.get(id)
    if (this.doc.outcomes.has(id) && (!o || !Number.isFinite(o.at) || typeof o.to !== 'string'
      || typeof o.from !== 'string' || !['expired', 'over-cap', 'recipient-retired'].includes(o.outcome))) this.badOutcomes.add(id)
    else this.badOutcomes.delete(id)
    if (o && Number.isFinite(o.at)) this.oldestOutcome = Math.min(this.oldestOutcome, o.at)
    if (this.bus.count(id)) this.bus.changed.add(id)
  }

  private refreshMany(ids: ReadonlySet<string>): void {
    const ordered = new Map<string, Msg[]>()
    for (const id of ids) if (this.bus.count(id) + (this.mailCopies.get(id)?.size ?? 0) > 1) ordered.set(id, [])
    if (ordered.size) {
      // One pass per transaction, never per duplicate id. Legacy admission offers mail before bus.
      for (const m of this.doc.mail.values()) if (validMessageShape(m)) ordered.get(m.id)?.push(m)
      for (const m of this.doc.bus.toArray()) if (validMessageShape(m)) ordered.get(m.id)?.push(m)
    }
    for (const id of ids) this.refresh(id, ordered.get(id))
  }

  private refresh(id: string, ordered?: readonly Msg[]): void {
    const prior = this.pending.get(id)
    if (prior) {
      const size = this.sizes.get(id)!
      const count = this.recipients.get(prior.to!)!
      count.count--; count.bytes -= size; this.owedBytes -= size
      if (!count.count) this.recipients.delete(prior.to!)
      this.pending.delete(id); this.sizes.delete(id)
    }
    const mail = this.mailCopies.get(id)
    const bus = this.bus.ids.get(id)
    const candidates = ordered ?? [...(mail?.values() ?? []), ...(bus?.values() ?? [])]
    const m = candidates.find(m => validMessageShape(m) && isOwed(this.doc, m))
    if (m) {
      const size = sizeOf(m)
      const count = this.recipients.get(m.to!) ?? { count: 0, bytes: 0 }
      count.count++; count.bytes += size; this.owedBytes += size
      this.recipients.set(m.to!, count); this.pending.set(id, m); this.sizes.set(id, size)
      this.oldest = Math.min(this.oldest, m.at)
    }
    // Mail/receipt/outcome changes and answers can change a previous cap refusal.
    if (prior || m || candidates.some(m => validMessageShape(m) && (m.to || ('inReplyTo' in m && m.inReplyTo)))) this.clean = false
  }

  /** Debug/recovery check: callers can snapshot aggregates, rebuild, then compare to full recompute. */
  rebuild(): void {
    this.bus.rebuild()
    this.rebuildAggregates()
  }

  private rebuildAggregates(): void {
    this.pending.clear(); this.recipients.clear(); this.sizes.clear()
    this.badMail.clear(); this.badOutcomes.clear(); this.mailCopies.clear(); this.mailIds.clear(); this.owedBytes = 0
    this.oldest = this.oldestOutcome = Infinity; this.clean = false
    for (const id of this.doc.mail.keys()) this.checkMail(id)
    for (const id of this.doc.outcomes.keys()) this.checkOutcome(id)
    this.refreshMany(new Set([...this.bus.ids.keys(), ...this.mailCopies.keys()]))
  }

  markTrimmed(now: number, opts: TrimOptions): void {
    this.cleanKeep = opts.busKeep ?? BUS_KEEP
    this.cleanBytes = opts.busBytes ?? BUS_BYTES
    // Recompute these minima once per full trim, not per post or tick.
    this.oldest = Math.min(Infinity, ...[...this.pending.values()].map(m => m.at))
    this.oldestOutcome = Math.min(Infinity, ...[...this.doc.outcomes.values()].map(o => o.at))
    this.clean = this.bus.invalid === 0 && !this.badMail.size && !this.badOutcomes.size
      && now - this.oldest <= OWED_TTL_MS
  }

  certain(now: number): boolean {
    // Trim removes malformed/expired state. Aliases and duplicate ids are represented exactly.
    return !this.bus.invalid && !this.badMail.size && !this.badOutcomes.size
      && now - this.oldestOutcome <= OUTCOMES_TTL_MS
  }

  trimmed(now: number, opts: TrimOptions): boolean {
    return this.clean && this.certain(now) && now - this.oldest <= OWED_TTL_MS
      && this.cleanKeep === (opts.busKeep ?? BUS_KEEP) && this.cleanBytes === (opts.busBytes ?? BUS_BYTES)
  }
}

// Keyed by the Y.Doc, not the RoomDoc wrapper: wrappers are cheap and may be recreated, observers are not.
const indexes = new WeakMap<object, DeliveryIndex>()
export function deliveryIndex(doc: RoomDoc): DeliveryIndex {
  let index = indexes.get(doc.doc)
  if (!index) { index = new DeliveryIndex(doc); indexes.set(doc.doc, index) }
  return index
}

/**
 * Admission uses running caps when acceptance is certain. Malformed remote/expired/over-cap states
 * use the original trim first to preserve legacy outcomes; a clean refusal is cached until data changes.
 * Normal acceptance never trims. Automatic posts bypass admission and trim in batches/maintenance.
 */
export function admit(doc: RoomDoc, m: { to?: string; [field: string]: unknown }, now: number, opts: TrimOptions = {}): Admission {
  const size = sizeOf(m)
  if (size > MAX_MESSAGE_BYTES) return { ok: false, reason: `the message is ${Math.ceil(size / KiB)} KiB; the limit is ${MAX_MESSAGE_BYTES / KiB} KiB` }
  if (!m.to) return { ok: true }
  const index = deliveryIndex(doc)
  const caps = (): Admission => {
    const theirs = index.recipients.get(m.to!) ?? { count: 0, bytes: 0 }
    if (theirs.count >= OWED_PER_RECIPIENT || theirs.bytes + size > OWED_BYTES_PER_RECIPIENT)
      return { ok: false, reason: `${m.to} has ${theirs.count} undelivered messages; wait until it reads them` }
    if (index.owedBytes + size > MAIL_BYTES)
      return { ok: false, reason: `the room's message store is full (${Math.round(index.owedBytes / KiB)} KiB owed to others)` }
    return { ok: true }
  }
  const answer = caps()
  if (index.certain(now) && (answer.ok || index.trimmed(now, opts))) return answer
  trim(doc, now, opts)
  return caps()
}

export interface ArchiveSummary {
  messages: number
  counts: Partial<Record<MsgType, number>>
  lastSeen: Record<string, number>
  lastAt: number
  unfulfilled: ({ id: string; from: string; at: number } & ArchivedRelease)[]
}

/** Counts derived at read time from `archive`, for the room or one area. */
export function archiveSummary(doc: RoomDoc, area?: string): ArchiveSummary {
  const out: ArchiveSummary = { messages: 0, counts: {}, lastSeen: {}, lastAt: 0, unfulfilled: [] }
  for (const [id, [type, from, at, areas, unfulfilled]] of doc.archive.entries()) {
    if (area !== undefined && !areas.includes(area)) continue
    out.messages++
    out.counts[type] = (out.counts[type] ?? 0) + 1
    out.lastSeen[from] = Math.max(out.lastSeen[from] ?? 0, at)
    out.lastAt = Math.max(out.lastAt, at)
    if (unfulfilled) out.unfulfilled.push({ id, from, at, ...unfulfilled })
  }
  out.unfulfilled.sort(byAge)
  return out
}
