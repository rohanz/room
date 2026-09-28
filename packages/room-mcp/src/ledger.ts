/**
 * The session's delivery ledger (ledger spec, "Arbitration and reservations"): one per host session,
 * across all of its rooms. Select only if unseen and not in flight; hand off; after a confirmed handoff,
 * record the receipt `seen:<P>[id] = {s, via, at}`. Reservations live in memory, expire and are never
 * receipts. Every operation is fenced on the participant's holder (invariant 5).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { highestSeq, messageForMe, owed, participantRecord, type MessageRouteContext, type Msg, type Via } from '@room/shared'
import { writeAtomic } from './leases.js'
import { registrySnapshotForDir } from './worker-registry.js'
import type { Session } from './session.js'
import { workerCarried } from './worker-registry.js'

/** A reply batch is held until its transport write settles; a hook batch until the hook confirms. */
export const REPLY_LEASE_MS = 60_000
export const HOOK_LEASE_MS = 10_000

export type BatchKind = 'reply' | 'hook'
/** A local synthetic item (sharing disclosure, startup notice): delivered like a message, receipted in notices.json. */
export interface Notice { id: string; text: string }
export interface Selected { s: Session; m: Msg; via: Via }

export function noticeId(kind: string, text: string): string {
  return `n:${kind}:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
}

export class Batch {
  readonly items: Selected[] = []
  readonly notices: Notice[] = []
  /** Reservations ended (released, expired, or committed). */
  settled = false
  committed = false
  timer?: ReturnType<typeof setTimeout>
  constructor(readonly id: string, readonly kind: BatchKind) {}
  has(s: Session, id: string): boolean { return this.items.some(x => x.s === s && x.m.id === id) }
}

/** `frontier`: the highest hub seq the session had observed at its first bind in the room (ledger "Cursor"). */
interface Cursor { participant: string; frontier: number; routed: Set<string> }
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
  private delivered?: Record<string, { at: number; via: Via }>

  constructor(private readonly o: LedgerOptions) {}

  /** A session may deliver for P only while it is P's holder (or no holder is recorded yet, before wave 4). */
  fenced(s: Session): boolean {
    const holder = participantRecord(s.room, s.me.name)?.holder
    return !holder || holder.sessionId === this.o.sessionId()
  }

  open(kind: BatchKind, leaseMs = kind === 'hook' ? this.o.hookLeaseMs ?? HOOK_LEASE_MS : REPLY_LEASE_MS): Batch {
    const batch = new Batch(randomUUID(), kind)
    batch.timer = setTimeout(() => this.release(batch), leaseMs)
    batch.timer.unref?.()
    return batch
  }

  /** Seed the cursor at the session's first bind in a room (after its first sync). */
  bind(s: Session): void { this.cursor(s) }

  /** The highest hub seq `s` had observed at its first bind: only later messages can wake it (MF8). */
  frontier(s: Session): number { return this.cursor(s).frontier }

  /** Whether a live batch holds `id` (in flight, so not wakeable). */
  reserved(s: Session, id: string): boolean { return this.reservations.has(key(s, id)) }

  /** Owed messages of `s` that no live batch holds (nor `batch` itself) and `filter` accepts; nothing is reserved. */
  available(s: Session, batch: Batch, filter?: (m: Msg) => boolean): Msg[] {
    if (batch.settled) return []
    return this.candidates(s).filter(m => !batch.has(s, m.id) && !this.reservations.has(key(s, m.id)) && (!filter || filter(m)))
  }

  /** `available()`, reserved into `batch`, to be receipted `via` when the batch commits. */
  select(s: Session, batch: Batch, filter?: (m: Msg) => boolean, via: Via = batch.kind === 'hook' ? 'hook' : 'reply'): Msg[] {
    const chosen = this.available(s, batch, filter)
    for (const m of chosen) {
      batch.items.push({ s, m, via })
      this.reservations.set(key(s, m.id), batch)
    }
    return chosen
  }

  /** What `s` is owed now, reserved or not: for counts and wake decisions, never a receipt. */
  candidates(s: Session): Msg[] {
    if (!this.fenced(s)) return []
    const cursor = this.route(s)
    return owed(s.room, s.me, cursor, this.o.route(s), m => this.o.relevant?.(s, m) ?? true)
  }

  /** Receipts for a confirmed handoff; a late commit for an expired batch still writes (a real handoff). */
  commit(batch: Batch): void {
    if (batch.committed) return
    batch.committed = true
    const groups = new Map<Session, Map<Via, string[]>>()
    for (const { s, m, via } of batch.items) {
      const byVia = groups.get(s) ?? new Map<Via, string[]>()
      byVia.set(via, [...byVia.get(via) ?? [], m.id])
      groups.set(s, byVia)
    }
    for (const [s, byVia] of groups) {
      if (!this.fenced(s)) { this.o.log?.(`not receipting in ${s.roomName}: this session no longer holds ${s.me.name}`); continue }
      s.room.doc.transact(() => { for (const [via, ids] of byVia) s.room.markSeen(s.me.name, ids, { s: this.o.sessionId(), via }) })
    }
    if (batch.notices.length) {
      const delivered = this.deliveredNotices()
      for (const n of batch.notices) { delivered[n.id] = { at: Date.now(), via: batch.kind === 'hook' ? 'hook' : 'reply' }; this.pendingNotices.delete(n.id) }
      this.persistNotices()
    }
    this.end(batch)
  }

  /**
   * The lead's receipt for a follow-up it put in a resumed worker's prompt. Until resume acceptance
   * (ledger "Resume prompt", wave 4) moves it to the worker's own MCP, the lead writes it after the post.
   */
  commitPrompt(s: Session, participant: string, ids: readonly string[]): void {
    s.room.markSeen(participant, ids, { s: this.o.sessionId(), via: 'prompt' })
  }

  /** The handoff failed or was cancelled: the ids are selectable again. */
  release(batch: Batch): void {
    if (batch.settled) return
    this.end(batch)
  }

  /** Offer a local notice until a confirmed handoff receipts it. */
  notice(kind: string, text: string): Notice {
    const n = { id: noticeId(kind, text), text }
    if (!this.deliveredNotices()[n.id] && !this.pendingNotices.has(n.id)) { this.pendingNotices.set(n.id, n); this.o.onSettled?.() }
    return n
  }

  /** How many notices wait for a handoff (the hooks' state.json says so without their text). */
  noticeCount(): number { return this.pendingNotices.size }

  /** Stop offering a notice that no longer applies. */
  withdraw(id: string): void { this.pendingNotices.delete(id) }

  /** Pending notices no live batch holds, reserved into `batch`. */
  notices(batch: Batch): Notice[] {
    if (batch.settled) return []
    const out: Notice[] = []
    for (const n of this.pendingNotices.values()) {
      if (this.noticeReservations.has(n.id) || batch.notices.some(x => x.id === n.id)) continue
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

  // ---- cursor (ledger "Cursor") -------------------------------------------------------------

  /** The cursor, with this call's routing decisions recorded: a broadcast `messageForMe` rejects goes to `routed` (MF2). */
  private route(s: Session): Cursor {
    const cursor = this.cursor(s)
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
    cursor = kept
      ? { participant: s.me.name, frontier: stored.frontier, routed: new Set(stored.routed) }
      : { participant: s.me.name, frontier: ownLaunchFrontier(s) ?? highestSeq(s.room), routed: new Set() }
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
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
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
    try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeAtomic(file, this.deliveredNotices()) }
    catch (e) { this.o.log?.(`could not write ${file}: ${e instanceof Error ? e.message : String(e)}`) }
  }
}

/**
 * A spawned worker's seed: its own run's `busFrontier`, the lead's highest seq at launch intent, so the
 * lead's later briefing is above it (ledger "Cursor"). Everyone else takes the highest seq at first bind.
 */
function ownLaunchFrontier(s: Session): number | undefined {
  const id = process.env.ROOM_WORKER_ID, run = Number(process.env.ROOM_WORKER_RUN)
  if (!id || !Number.isSafeInteger(run)) return undefined
  try {
    const record = registrySnapshotForDir(s.dir).read(id)
    return record?.name === s.me.name ? record.runs.find(r => r.n === run)?.busFrontier : undefined
  } catch { return undefined }
}
