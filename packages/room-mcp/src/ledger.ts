/**
 * The session's delivery ledger (ledger spec, "Arbitration and reservations"): one per host session,
 * across all of its rooms. Select only if unseen and not in flight; hand off; after a confirmed handoff,
 * record the receipt `seen:<P>[id] = {s, via, at}`. Reservations live in memory, expire and are never
 * receipts. Every operation is fenced on the participant's holder (invariant 5).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { highestSeq, deliveryIndex, isLegacyConflictMessage, messageForMe, owed, participantRecord, openConflicts, onOpenConflictsChanged, formatConflictLine, formatMsg, type MessageRouteContext, type Msg, type Via, type OpenConflict, type Priority, ROOM_STALE_MS } from '@room/shared'
import { writeAtomic } from './leases.js'
import { snapshotRead, type WorkerSnapshot } from './worker-store.js'
import type { WorkerRecord } from './worker-status.js'
import type { Session } from './session.js'

/** A reply batch is held until its transport write settles; a hook batch until the hook confirms. */
const REPLY_LEASE_MS = 60_000
export const HOOK_LEASE_MS = 10_000
/** Inactive lines are courtesies: keep at most eight, independently of opening history. */
const INACTIVE_CONFLICT_LIMIT = 8
/** Delivered facts for absent openings, independent of the eight presentation courtesies. */
const SETTLED_CONFLICT_LIMIT = 64

export type BatchKind = 'reply' | 'hook'
/** A local synthetic item (sharing disclosure, startup notice): delivered like a message, receipted in notices.json. */
export interface Notice {
  id: string; text: string
  /** A presentation chunk receipts its constituent events, never the chunk's changing membership. */
  receiptIds?: string[]
}
/** A conflict reference shares arbitration with messages, but never masquerades as a bus event. */
export interface ConflictDelivery {
  type: 'conflict-state'
  id: string
  priority: Priority
  to: string
  at?: number
  status: 'open' | 'inactive'
  conflict?: OpenConflict
  label: string
  fingerprint?: string
  /** The line carries a wake; its token only correlates delivery with a pending note. */
  wakeId?: string
}
export type DeliveryItem = Msg | ConflictDelivery
export const isConflictItem = (item: DeliveryItem): item is ConflictDelivery => item.type === 'conflict-state'
export const formatDeliveryItem = (item: DeliveryItem): string => isConflictItem(item)
  ? item.conflict ? formatConflictLine(item.conflict) : `[${item.priority}] previous alert no longer active: ${item.label}`
  : formatMsg(item)
type ConflictWake = { id: string; priority: Priority; woken?: boolean }
/** Presentation and wake delivery are independent: a fingerprint never acknowledges a token. */
type ConflictReceipt = { shown?: string; courtesy?: Priority; wake?: ConflictWake; label: string; at?: number }
type ConflictBucket = { participant: string; touchedAt?: number; entries: Record<string, ConflictReceipt>; delivered: Record<string, number>; pending?: ConflictReceipt }
type ConflictReceipts = Record<string, ConflictBucket>

/** Only the current record shape is accepted; uncertainty repeats a still-open wake. */
function readConflictReceipt(value: unknown): ConflictReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const entry = value as ConflictReceipt, wake = entry.wake
  if (Object.keys(entry).some(key => !['label', 'shown', 'courtesy', 'at', 'wake'].includes(key))
    || typeof entry.label !== 'string' || entry.shown !== undefined && (typeof entry.shown !== 'string' || !/^[a-f0-9]{64}$/.test(entry.shown))
    || entry.courtesy !== undefined && !['notify', 'interrupt'].includes(entry.courtesy)
    || entry.at !== undefined && !Number.isFinite(entry.at)) return
  if (wake !== undefined && (!wake || typeof wake !== 'object'
      || Array.isArray(wake) || Object.keys(wake).some(key => !['id', 'priority', 'woken'].includes(key))
      || typeof wake.id !== 'string' || !wake.id.length
      || !['notify', 'interrupt'].includes(wake.priority)
      || wake.woken !== undefined && typeof wake.woken !== 'boolean')) return
  return entry
}
const urgent = (a: Priority, b: Priority): Priority => a === 'interrupt' || b === 'interrupt' ? 'interrupt' : a === 'notify' || b === 'notify' ? 'notify' : 'fyi'
export interface Selected { s: Session; m: DeliveryItem; via: Via }
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex')
const clearingLabel = (entry: OpenConflict): string => {
  const first = entry.slots[0]!, paths = [...new Set(entry.slots.map(slot => slot.path))]
  const scope = entry.kind === 'merge' ? `merge ${paths.slice(0, 2).join(', ')}${paths.length > 2 ? ` and ${paths.length - 2} more files` : ''}`
    : entry.kind === 'contract' ? `contract ${first.path}:${first.subject ?? 'symbol'}`
    : entry.kind === 'claims' ? `claims ${first.path}:${first.subject ?? ''}` : `edit in claim ${first.path}`
  return `${scope.replace(/\0/g, ' / ').slice(0, 180)} with ${entry.other.slice(0, 80)}`
}

function noticeId(kind: string, text: string): string {
  return `n:${kind}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
}

export class Batch {
  readonly items: Selected[] = []
  readonly notices: Notice[] = []
  /** Reservations ended (released, expired, or committed). */
  settled = false
  committed = false
  timer?: ReturnType<typeof setTimeout>
  constructor(readonly id: string, readonly kind: BatchKind, readonly leaseMs: number) {}
  has(s: Session, id: string): boolean { return this.items.some(x => x.s === s && x.m.id === id) }
}

/** `frontier`: the highest hub seq the session had observed at its first bind in the room (ledger "Cursor"). */
interface Cursor { participant: string; frontier: number; routed: Set<string>; addressedFrom?: number }
type CursorFile = Record<string, { participant: string; frontier: number; routed: string[] }>

export interface LedgerOptions {
  /** The host session that receipts name (`s`); the fence compares the holder with it. */
  sessionId: () => string
  /** The bound session's directory, for cursor.json and notices.json; undefined keeps both in memory. */
  sessionDir?: () => string | undefined
  /** The inbox routing context for a room (claims, areas). */
  route: (s: Session) => MessageRouteContext
  /** Read-time relevance (relevance.ts); never written. */
  relevant?: (s: Session, m: Msg) => boolean
  /** After every release, expiry and commit: something may have become wakeable (MF8). */
  onSettled?: () => void
  log?: (line: string) => void
  /** How long a hook batch stays reserved without a confirm; default HOOK_LEASE_MS (tests shorten it). */
  hookLeaseMs?: number
}

const key = (s: Session, id: string) => `${s.roomName}\u0000${id}`

export class Ledger {
  private readonly reservations = new Map<string, Batch>()
  private readonly noticeReservations = new Map<string, Batch>()
  private readonly cursors = new WeakMap<Session, Cursor>()
  private readonly pendingNotices = new Map<string, Notice>()
  private readonly onDelivered = new Map<string, () => void>()
  private delivered?: Record<string, { at: number; via: Via }>
  private conflictRecord?: { file?: string; receipts: ConflictReceipts; loadedFromDisk: boolean }
  private conflictsDirty = false
  private readonly active = new Set<Session>()
  private readonly bound = new WeakSet<Session>()
  private readonly workerSnapshots = new WeakMap<Session, WorkerSnapshot>()

  /** Facts supplied by the async attachment/request boundary; callbacks never open storage. */
  supplyWorkers(s: Session, snapshot: WorkerSnapshot): void { this.workerSnapshots.set(s, snapshot) }

  private readonly legacyMailPending = new WeakMap<Session, Set<string>>()

  constructor(private readonly o: LedgerOptions) {}

  private workerEvidenceReady(s: Session): boolean {
    const facts = this.workerSnapshots.get(s)
    return !process.env.ROOM_WORKER_ID || !!facts?.available && facts.blockers.length === 0
  }

  /** A session may deliver for P only while it is P's holder (or no holder is recorded yet, before wave 4). */
  fenced(s: Session): boolean {
    // A joined session is fenced by its name lease's epoch (hub §4.1, §7); paused, it writes no receipt.
    if (s.lease) return s.lease.fence() !== undefined
    const holder = participantRecord(s.room, s.me.name)?.holder
    return !holder || holder.sessionId === this.o.sessionId()
  }

  open(kind: BatchKind, leaseMs = kind === 'hook' ? this.o.hookLeaseMs ?? HOOK_LEASE_MS : REPLY_LEASE_MS): Batch {
    return new Batch(randomUUID(), kind, leaseMs)
  }

  /** Seed the cursor at the session's first bind in a room (after its first sync). */
  bind(s: Session): void {
    this.active.add(s)
    this.cursor(s)
    this.prune(s)
    if (this.bound.has(s)) { this.receiptLegacyConflicts(s); return }
    this.bound.add(s)
    if (this.fenced(s)) this.conflictCandidates(s)
    // Capture owed openings synchronously: a later clean transaction may precede the wake microtask.
    // Observation needs no worker launch facts; only delivery waits for them.
    onOpenConflictsChanged(s.room, () => {
      if (this.active.has(s) && this.fenced(s)) this.conflictCandidates(s)
    })
    this.legacyMailPending.set(s, new Set())
    deliveryIndex(s.room).onMessagesChanged(changes => {
      this.queueLegacyConflicts(s, changes)
      this.receiptLegacyConflicts(s)
      if ([...changes.values()].some(copies => !copies.length)) this.prune(s)
    })
    // One initial scan; subsequent transactions supply only their changed indexed bodies.
    const initial = new Map<string, Msg[]>()
    for (const message of [...s.room.mail.values(), ...s.room.messages()]) if (message && typeof message.id === 'string') {
      const copies = initial.get(message.id) ?? []; copies.push(message); initial.set(message.id, copies)
    }
    this.queueLegacyConflicts(s, initial)
    this.receiptLegacyConflicts(s)
    s.room.outcomes.observe(event => {
      if ([...event.changes.keys.values()].some(change => change.action === 'delete')) this.prune(s)
    })
  }

  private queueLegacyConflicts(s: Session, changes: ReadonlyMap<string, readonly Msg[]>): void {
    const pending = this.legacyMailPending.get(s)!
    for (const [id, copies] of changes) {
      pending.delete(id)
      if (copies.length && copies.every(isLegacyConflictMessage) && copies.some(message => message.to === s.me.name)) pending.add(id)
    }
  }

  /** Only the active holder consumes its own obsolete messages; paused pending IDs track body changes. */
  private receiptLegacyConflicts(s: Session): void {
    const pending = this.legacyMailPending.get(s)
    if (!pending?.size || !this.active.has(s) || !this.fenced(s)) return
    const seen = s.room.seen(s.me.name), ids = [...pending].filter(id => !seen.has(id) && !s.room.outcomes.has(id))
    pending.clear()
    s.room.markSeen(s.me.name, ids, { s: this.o.sessionId(), via: 'reply' })
  }

  /** Keep receipt recovery through temporary detachment; inactive room buckets age out after seven days. */
  unbind(s: Session): void { this.active.delete(s); this.flushConflicts() }

  /** The highest hub seq `s` had observed at its first bind: only later messages can wake it (MF8). */
  frontier(s: Session): number { return this.cursor(s).frontier }

  /** Whether a live batch holds `id` (in flight, so not wakeable). */
  reserved(s: Session, id: string): boolean { return this.reservations.has(key(s, id)) }

  /** Owed messages of `s` that no live batch holds (nor `batch` itself) and `filter` accepts; nothing is reserved. */
  available(s: Session, batch: Batch, filter?: (m: DeliveryItem) => boolean): DeliveryItem[] {
    if (batch.settled) return []
    return this.candidates(s).filter(m => !batch.has(s, m.id) && !this.reservations.has(key(s, m.id)) && (!filter || filter(m)))
  }

  /** `available()`, reserved into `batch`, to be receipted `via` when the batch commits. */
  select(s: Session, batch: Batch, filter?: (m: DeliveryItem) => boolean, via: Via = batch.kind === 'hook' ? 'hook' : 'reply'): DeliveryItem[] {
    const chosen = this.available(s, batch, filter)
    if (chosen.length) this.lease(batch)
    for (const m of chosen) {
      batch.items.push({ s, m, via })
      this.reservations.set(key(s, m.id), batch)
    }
    return chosen
  }

  /** What `s` is owed now, reserved or not: for counts and wake decisions, never a receipt. */
  candidates(s: Session): DeliveryItem[] {
    if (!this.fenced(s)) return []
    this.receiptLegacyConflicts(s)
    // A worker's launch and prompt facts must arrive before delivery can choose a frontier.
    if (!this.workerEvidenceReady(s)) return []
    this.prune(s)
    const cursor = this.route(s)
    const prompt = new Set(this.promptIds(s))
    return [...this.conflictCandidates(s), ...owed(s.room, s.me, cursor, this.o.route(s), m => !prompt.has(m.id) && (this.o.relevant?.(s, m) ?? true))]
  }

  /** Conflict state uses local receipts beside cursor/notices; it never enters bus/mail/seen. */
  private conflictStorage(): NonNullable<Ledger['conflictRecord']> {
    const file = this.file('conflicts.json')
    if (!this.conflictRecord || this.conflictRecord.file !== file) {
      let receipts: ConflictReceipts = {}
      if (file) try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid conflict record')
        for (const stored of Object.values(value) as ConflictBucket[]) {
          if (!stored || typeof stored !== 'object' || Object.keys(stored).some(key => !['participant', 'entries', 'delivered', 'pending', 'touchedAt'].includes(key))
            || typeof stored.participant !== 'string' || !stored.entries || typeof stored.entries !== 'object' || Array.isArray(stored.entries)
            || !stored.delivered || typeof stored.delivered !== 'object' || Array.isArray(stored.delivered) || Object.values(stored.delivered).some(at => !Number.isFinite(at))
            || stored.touchedAt !== undefined && !Number.isFinite(stored.touchedAt)
            || Object.values(stored.entries).some(entry => !readConflictReceipt(entry) || entry.wake?.woken !== undefined)
            || stored.pending !== undefined && (!readConflictReceipt(stored.pending) || !stored.pending.wake)) throw new Error('invalid conflict record')
        }
        receipts = value
      } catch { /* Missing or unreadable: waking again is safe. */ }
      const previous = this.conflictRecord
      for (const [room, memory] of Object.entries(previous?.receipts ?? {})) {
        const disk = receipts[room]
        // After the initial bind, this process owns the latest receipts and removals. An
        // older directory must not resurrect an obligation already shown and forgotten.
        if (previous?.loadedFromDisk || !disk || disk.participant !== memory.participant) receipts[room] = memory
        else {
          const entries = { ...disk.entries }
          for (const [id, entry] of Object.entries(memory.entries)) {
            const old = entries[id], wake = entry.wake ?? old?.wake
            entries[id] = { ...old, ...entry, shown: entry.shown ?? old?.shown,
              wake: old?.wake && wake ? { ...wake, priority: urgent(old.wake.priority, wake.priority) } : wake }
          }
          const delivered = { ...disk.delivered }
          for (const [id, at] of Object.entries(memory.delivered)) delivered[id] = Math.min(delivered[id] ?? at, at)
          for (const [id, receipt] of Object.entries(entries)) if (delivered[id] !== undefined && receipt.shown) delete receipt.wake
          const pending = !memory.pending ? disk.pending : this.pendingConflict(disk.pending, memory.pending)
          receipts[room] = { ...disk, ...memory, entries, delivered, ...(pending ? { pending } : {}) }
        }
      }
      this.conflictRecord = { file, receipts, loadedFromDisk: previous?.loadedFromDisk === true || file !== undefined }
      // Even a clean in-memory record must be written to its new backing directory.
      if (previous) this.conflictsDirty = true
    }
    return this.conflictRecord
  }
  private conflictBucket(s: Session): ConflictBucket {
    const all = this.conflictStorage().receipts, stored = all[s.roomName]
    if (!stored || stored.participant !== s.me.name || !stored.entries || typeof stored.entries !== 'object' || Array.isArray(stored.entries))
      all[s.roomName] = { participant: s.me.name, entries: {}, delivered: {} }
    all[s.roomName]!.touchedAt = Date.now()
    return all[s.roomName]!
  }
  /** Persist a whole observed pass, not each opening; a failed write leaves it dirty and blocks waking. */
  flushConflicts(): boolean {
    const record = this.conflictStorage()
    const active = new Set([...this.active].map(s => s.roomName))
    for (const [room, bucket] of Object.entries(record.receipts)) if (!active.has(room) && !bucket.pending && !Object.values(bucket.entries).some(receipt => receipt.wake)
      && Date.now() - (bucket.touchedAt ?? 0) >= ROOM_STALE_MS) { delete record.receipts[room]; this.conflictsDirty = true }
    if (!this.conflictsDirty) return true
    if (record.file) try { writeAtomic(record.file, record.receipts) }
    catch (error) { this.o.log?.(`could not write conflict receipts: ${String(error)}`); return false }
    this.conflictsDirty = false
    return true
  }
  private pendingConflict(previous: ConflictReceipt | undefined, incoming: ConflictReceipt): ConflictReceipt {
    if (!previous) return { label: incoming.label, at: incoming.at, wake: incoming.wake }
    if (previous.wake!.id === incoming.wake!.id) return { ...previous, wake: { ...previous.wake!,
      priority: urgent(previous.wake!.priority, incoming.wake!.priority), woken: previous.wake!.woken || incoming.wake!.woken } }
    return { label: previous.label, at: previous.at ?? incoming.at,
      wake: { id: randomUUID(), priority: urgent(previous.wake!.priority, incoming.wake!.priority),
        woken: previous.wake!.woken === true && incoming.wake!.woken === true } }
  }
  private compactConflictReceipts(s: Session, current = openConflicts(s.room, s.me.name)): boolean {
    const bucket = this.conflictBucket(s), entries = bucket.entries, open = new Set(current.map(entry => entry.id)), inactive: string[] = []
    let changed = false
    for (const [id, receipt] of Object.entries(entries)) if (!open.has(id)) {
      if (receipt.wake && bucket.delivered[id] === undefined) {
        bucket.pending = this.pendingConflict(bucket.pending, receipt)
        delete entries[id]; changed = true
      } else {
        if (receipt.wake) { receipt.courtesy = receipt.wake.priority; delete receipt.wake; changed = true }
        if (receipt.shown || receipt.courtesy) inactive.push(id)
        else { delete entries[id]; changed = true }
      }
    }
    const settled = Object.keys(bucket.delivered).filter(id => !open.has(id)).sort((a, b) => bucket.delivered[a]! - bucket.delivered[b]!)
    for (const id of settled.slice(0, Math.max(0, settled.length - SETTLED_CONFLICT_LIMIT))) { delete bucket.delivered[id]; changed = true }
    // Courtesy history is expendable; an unshown owed wake is never evicted.
    for (const id of inactive.slice(0, Math.max(0, inactive.length - (INACTIVE_CONFLICT_LIMIT - (bucket.pending ? 1 : 0))))) { delete entries[id]; changed = true }
    return changed
  }
  private conflictCandidates(s: Session): ConflictDelivery[] {
    const current = openConflicts(s.room, s.me.name), bucket = this.conflictBucket(s), entries = bucket.entries
    const ids = new Set(current.map(entry => entry.id)), result: ConflictDelivery[] = []
    let changed = false
    for (const entry of current) {
      const receipt = entries[entry.id]
      if (receipt && receipt.label !== clearingLabel(entry)) { receipt.label = clearingLabel(entry); changed = true }
      const wake = receipt?.wake
      if (wake && bucket.delivered[entry.id] === undefined && urgent(wake.priority, entry.priority) !== wake.priority) {
        wake.priority = urgent(wake.priority, entry.priority)
        changed = true
      }
      if (entry.priority !== 'fyi' && bucket.delivered[entry.id] === undefined && !receipt?.wake) {
        entries[entry.id] = { ...receipt, wake: { priority: entry.priority, id: randomUUID() }, label: clearingLabel(entry),
          at: Math.max(...entry.slots.map(slot => slot.confirmedAt ?? 0)) || undefined }
        changed = true
      }
    }
    changed = this.compactConflictReceipts(s, current) || changed
    for (const entry of current) {
      const hash = fingerprint(formatConflictLine(entry)), receipt = entries[entry.id]
      const wake = receipt?.wake, priority = wake ? urgent(entry.priority, wake.priority) : entry.priority
      if (wake || receipt?.shown !== hash) result.push({ type: 'conflict-state', id: entry.id, priority, to: s.me.name,
        at: Math.max(...entry.slots.map(slot => slot.confirmedAt ?? 0)) || undefined,
        status: 'open', conflict: priority === entry.priority ? entry : { ...entry, priority }, label: clearingLabel(entry), fingerprint: hash,
        wakeId: wake?.id })
    }
    for (const [id, receipt] of Object.entries(entries)) if (!ids.has(id) && (receipt.shown || receipt.courtesy)) {
      result.push({ type: 'conflict-state', id: id + ':inactive', priority: receipt.courtesy ?? 'fyi', to: s.me.name,
        at: receipt.at, status: 'inactive', label: receipt.label })
    }
    const pending = bucket.pending?.wake
    if (pending) result.push({ type: 'conflict-state', id: 'state-conflict:inactive:' + pending.id, priority: pending.priority,
      to: s.me.name, at: bucket.pending!.at, status: 'inactive', label: bucket.pending!.label, wakeId: pending.id })
    if (changed) this.conflictsDirty = true
    return result
  }
  conflictWakeable(s: Session, item: ConflictDelivery): boolean {
    const bucket = this.conflictBucket(s)
    return !!item.wakeId && (item.status === 'open' ? bucket.delivered[item.id] === undefined
      : bucket.pending?.wake?.id === item.wakeId && !bucket.pending.wake.woken)
  }
  conflictWakeRecorded(s: Session, id: string): boolean {
    const bucket = this.conflictBucket(s)
    return bucket.delivered[id] !== undefined || id === 'state-conflict:inactive:' + bucket.pending?.wake?.id && bucket.pending?.wake?.woken === true
  }
  conflictsWoken(items: readonly { s: Session; m: DeliveryItem }[]): void {
    const changed = new Set<Session>()
    for (const { s, m } of items) {
      if (!isConflictItem(m) || !this.fenced(s)) continue
      const bucket = this.conflictBucket(s)
      if (m.status === 'open' && m.wakeId) {
        bucket.delivered[m.id] ??= Date.now(); changed.add(s)
      }
      if (m.wakeId && bucket.pending?.wake?.id === m.wakeId) { bucket.pending.wake.woken = true; changed.add(s) }
    }
    if (changed.size) {
      for (const s of changed) this.compactConflictReceipts(s)
      this.conflictsDirty = true; this.flushConflicts()
    }
  }

  /** Receipts for a confirmed handoff; a late commit for an expired batch still writes (a real handoff). */
  commit(batch: Batch): void {
    if (batch.committed) return
    batch.committed = true
    const conflictChanged = new Set<Session>()
    const groups = new Map<Session, Map<Via, string[]>>()
    for (const { s, m, via } of batch.items) {
      if (isConflictItem(m)) {
        if (!this.fenced(s)) continue
        const bucket = this.conflictBucket(s), entries = bucket.entries
        if (m.status === 'open') {
          const receipt = entries[m.id]
          if (m.wakeId) {
            bucket.delivered[m.id] ??= Date.now()
            if (receipt) delete receipt.wake
          }
          if (receipt) delete receipt.courtesy
          entries[m.id] = { ...receipt, shown: m.fingerprint, label: m.label, at: m.at }
        } else if (!m.wakeId) {
          const receipt = entries[m.id.slice(0, -':inactive'.length)]
          if (receipt) { delete receipt.shown; delete receipt.courtesy }
        }
        if (m.wakeId && bucket.pending?.wake?.id === m.wakeId) delete bucket.pending
        conflictChanged.add(s)
        continue
      }
      const byVia = groups.get(s) ?? new Map<Via, string[]>()
      byVia.set(via, [...byVia.get(via) ?? [], m.id])
      groups.set(s, byVia)
    }
    if (conflictChanged.size) {
      for (const s of conflictChanged) this.compactConflictReceipts(s)
      this.conflictsDirty = true; this.flushConflicts()
    }
    for (const [s, byVia] of groups) {
      if (!this.fenced(s)) { this.o.log?.(`not receipting in ${s.roomName}: this session no longer holds ${s.me.name}`); continue }
      s.room.doc.transact(() => {
        for (const [via, ids] of byVia) s.room.markSeen(s.me.name, ids, { s: this.o.sessionId(), via })
        this.prune(s)
      })
    }
    if (batch.notices.length) {
      const delivered = this.deliveredNotices()
      for (const n of batch.notices) {
        for (const id of n.receiptIds ?? [n.id]) delivered[id] = { at: Date.now(), via: batch.kind === 'hook' ? 'hook' : 'reply' }
        this.pendingNotices.delete(n.id)
      }
      this.persistNotices()
      for (const n of batch.notices) this.fireDelivered(n.id)
    }
    this.end(batch)
  }

  /**
   * The reply or hook output that selected these no longer carries them (it failed after selecting):
   * they are selectable again, and a later commit of this batch receipts nothing.
   */
  discard(batch: Batch): void {
    this.release(batch)
    batch.items.length = 0
    batch.notices.length = 0
  }

  /** A model action in the resumed worker run proves its one prompt-bearing turn was accepted. */
  acceptPrompt(s: Session): void {
    const ids = this.promptIds(s)
    if (ids.length && this.fenced(s)) {
      s.room.markSeen(s.me.name, ids, { s: this.o.sessionId(), via: 'prompt' })
      this.prune(s)
    }
  }

  private promptIds(s: Session): string[] {
    const id = process.env.ROOM_WORKER_ID, number = Number(process.env.ROOM_WORKER_RUN)
    if (!id || !Number.isSafeInteger(number) || !process.env.ROOM_LAUNCH_NONCE) return []
    try {
      const record = this.workerSnapshots.get(s) ? snapshotRead(this.workerSnapshots.get(s)!, id) : undefined, run = record?.runs.at(-1)
      if (record?.room !== s.roomName || record.name !== s.me.name || record.hostSessionId !== this.o.sessionId()
        || run?.n !== number || run.nonce !== process.env.ROOM_LAUNCH_NONCE || run.mode !== 'resume') return []
      return run.promptMsgIds
    } catch { return [] }
  }

  /** The handoff failed or was cancelled: the ids are selectable again. */
  release(batch: Batch): void {
    if (batch.settled) return
    this.end(batch)
  }

  /**
   * Offer a local notice until a confirmed handoff receipts it. `onDelivered` runs after that receipt, or
   * at once when notices.json already holds one (a crash between the receipt and the caller's own record).
   */
  notice(kind: string, text: string, onDelivered?: () => void): Notice {
    const n = { id: noticeId(kind, text), text }
    if (onDelivered) this.onDelivered.set(n.id, onDelivered)
    if (this.deliveredNotices()[n.id]) this.fireDelivered(n.id)
    else if (!this.pendingNotices.has(n.id)) { this.pendingNotices.set(n.id, n); this.o.onSettled?.() }
    return n
  }

  /** Offer event-keyed advice in bounded presentation chunks. Only confirmed events get receipts. */
  noticeEvents(kind: string, header: string, events: readonly { identity: string; text: string }[], budget: number): void {
    const delivered = this.deliveredNotices()
    const queued = new Set([...this.pendingNotices.values()].flatMap(n => n.receiptIds ?? [n.id]))
    let text = header, receiptIds: string[] = []
    const offer = () => {
      // This key arbitrates a chunk in memory; commit persists only its per-event receiptIds.
      const n = { id: noticeId(`${kind}:chunk`, receiptIds.join(',')), text, receiptIds }
      this.pendingNotices.set(n.id, n)
      this.o.onSettled?.()
    }
    for (const event of events) {
      const id = noticeId(kind, event.identity)
      if (delivered[id] || queued.has(id)) continue
      if (receiptIds.length && text.length + event.text.length + 2 > budget) {
        offer(); text = header; receiptIds = []
      }
      text += '\n' + event.text
      receiptIds.push(id)
      queued.add(id)
    }
    if (receiptIds.length) offer()
  }

  private fireDelivered(id: string): void {
    const fn = this.onDelivered.get(id)
    this.onDelivered.delete(id)
    try { fn?.() } catch (e) { this.o.log?.(`notice ${id}: ${e instanceof Error ? e.message : String(e)}`) }
  }

  /** How many notices wait for a handoff (the hooks' state.json says so without their text). */
  noticeCount(): number { return this.pendingNotices.size }

  /** Stop offering a notice that no longer applies. */
  withdraw(id: string): void { this.pendingNotices.delete(id) }

  /** Pending notices no live batch holds, reserved into `batch`. */
  notices(batch: Batch, budget = Infinity): Notice[] {
    if (batch.settled) return []
    const out: Notice[] = []
    for (const n of this.pendingNotices.values()) {
      if (this.noticeReservations.has(n.id) || batch.notices.some(x => x.id === n.id)) continue
      if (n.text.length + 1 > budget) continue
      budget -= n.text.length + 1
      this.lease(batch)
      batch.notices.push(n); out.push(n)
      this.noticeReservations.set(n.id, batch)
    }
    return out
  }

  private end(batch: Batch): void {
    batch.settled = true
    if (batch.timer) clearTimeout(batch.timer)
    for (const { s, m } of batch.items) if (this.reservations.get(key(s, m.id)) === batch) this.reservations.delete(key(s, m.id))
    for (const n of batch.notices) if (this.noticeReservations.get(n.id) === batch) this.noticeReservations.delete(n.id)
    this.o.onSettled?.()
  }

  /** Start or renew the reservation lease only after the reply actually selects content. */
  private lease(batch: Batch): void {
    if (batch.timer) clearTimeout(batch.timer)
    batch.timer = setTimeout(() => this.release(batch), batch.leaseMs)
    batch.timer.unref?.()
  }

  /** Only the current holder removes receipts for messages proven ended by archive or outcomes. */
  private prune(s: Session): void {
    s.room.pruneSeen(s.me.name, () => this.fenced(s))
  }

  /** The seq a worker's addressed messages start after (its first run's spawn): earlier ones went to a previous worker of that name. */
  spawnFrontier(s: Session, record: Pick<WorkerRecord, 'id' | 'name' | 'room' | 'runs'>, name = s.me.name): number | undefined { return spawnFrontier(s, record, name) }

  // ---- cursor (ledger "Cursor") -------------------------------------------------------------

  /** The cursor, with this call's routing decisions recorded: a broadcast `messageForMe` rejects goes to `routed` (MF2). */
  private route(s: Session): Cursor {
    const cursor = this.cursor(s)
    if (!this.workerEvidenceReady(s)) return cursor
    const context = this.o.route(s)
    const onBus = new Set<string>()
    let changed = false
    for (const m of s.room.messages()) {
      onBus.add(m.id)
      if (m.to || (m.seq ?? 0) <= cursor.frontier || cursor.routed.has(m.id) || messageForMe(s.me, m, context)) continue
      cursor.routed.add(m.id); changed = true
    }
    // `routed` only matters for bus broadcasts; ids that left the bus are dropped so the file stays bounded.
    for (const id of cursor.routed) if (!onBus.has(id)) { cursor.routed.delete(id); changed = true }
    if (changed) this.persistCursor(s, cursor)
    return cursor
  }

  private cursor(s: Session): Cursor {
    let cursor = this.cursors.get(s)
    if (cursor?.participant === s.me.name) return cursor
    const stored = this.readCursors()[s.roomName]
    const kept = stored?.participant === s.me.name && Number.isSafeInteger(stored.frontier)
    const facts = this.workerSnapshots.get(s)
    if (!this.workerEvidenceReady(s)) return cursor ?? { participant: s.me.name, frontier: kept ? stored.frontier : highestSeq(s.room), routed: new Set(kept ? stored.routed : []) }
    const spawn = ownSpawnFrontier(s, facts)
    cursor = kept
      ? { participant: s.me.name, frontier: stored.frontier, routed: new Set(stored.routed) }
      : { participant: s.me.name, frontier: ownLaunchFrontier(s, facts) ?? highestSeq(s.room), routed: new Set() }
    if (spawn !== undefined) cursor.addressedFrom = spawn
    // Missing or blocked worker evidence cannot establish a durable launch frontier.
    if (!this.workerEvidenceReady(s)) return cursor
    this.cursors.set(s, cursor)
    if (!kept) this.persistCursor(s, cursor)
    return cursor
  }

  private file(name: string): string | undefined {
    const dir = this.o.sessionDir?.()
    return dir ? path.join(dir, name) : undefined
  }

  private readCursors(): CursorFile {
    const file = this.file('cursor.json')
    if (!file) return {}
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as CursorFile } catch { return {} }
  }

  private persistCursor(s: Session, cursor: Cursor): void {
    const file = this.file('cursor.json')
    if (!file) return
    try {
      const all = this.readCursors()
      all[s.roomName] = { participant: cursor.participant, frontier: cursor.frontier, routed: [...cursor.routed] }
      writeAtomic(file, all)
    } catch (e) { this.o.log?.(`could not write ${file}: ${e instanceof Error ? e.message : String(e)}`) }
  }

  private deliveredNotices(): Record<string, { at: number; via: Via }> {
    if (!this.delivered) {
      const file = this.file('notices.json')
      try { this.delivered = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {} } catch { this.delivered = {} }
    }
    return this.delivered!
  }

  private persistNotices(): void {
    const file = this.file('notices.json')
    if (!file) return
    try { writeAtomic(file, this.deliveredNotices()) }
    catch (e) { this.o.log?.(`could not write ${file}: ${e instanceof Error ? e.message : String(e)}`) }
  }
}

/**
 * A spawned worker's seed: its own run's `busFrontier`, the lead's highest seq at launch intent, so the
 * lead's later briefing is above it (ledger "Cursor"). Everyone else takes the highest seq at first bind.
 */
function ownLaunchFrontier(s: Session, snapshot: WorkerSnapshot | undefined): number | undefined {
  const id = process.env.ROOM_WORKER_ID, run = Number(process.env.ROOM_WORKER_RUN)
  if (!id || !Number.isSafeInteger(run)) return undefined
  try {
    const record = snapshot ? snapshotRead(snapshot, id) : undefined
    return record?.name === s.me.name ? record.runs.find(r => r.n === run)?.busFrontier : undefined
  } catch { return undefined }
}

/**
 * A spawned worker's first run's `busFrontier`: addressed messages at or below it went to an earlier worker under
 * the same name (a reused tag). A resumed run keeps this anchor, so what was sent while it was stopped stays owed.
 */
function ownSpawnFrontier(s: Session, snapshot: WorkerSnapshot | undefined): number | undefined {
  const id = process.env.ROOM_WORKER_ID
  return id && snapshot ? spawnFrontier(s, snapshotRead(snapshot, id), s.me.name) : undefined
}

function spawnFrontier(s: Session, record: Pick<WorkerRecord, 'id' | 'name' | 'room' | 'runs'> | undefined, name: string): number | undefined {
  try {
    if (record?.name !== name || record.room !== s.roomName) return undefined
    const first = record.runs.find(r => r.n === 1) ?? record.runs[0]
    // An imported 0.16 worker has no spawn point: its earlier mail is its own. A spawn's frontier may be 0.
    return !first || first.launch?.outcome === 'imported' ? undefined : first.busFrontier
  } catch { return undefined }
}
