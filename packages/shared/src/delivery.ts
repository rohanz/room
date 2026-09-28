import { participantRecord, type RoomDoc } from './doc.js'
import { messageAreas } from './ledger.js'
import { messageForMe, type MessageRouteContext } from './messages.js'
import { AWARENESS_FRESH_MS, type AwarenessView } from './views.js'
import type { ArchivedMsg, ArchivedRelease, DeliveryCursor, Identity, Msg, MsgType, Outcome, Presence, Scope } from './types.js'

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

/**
 * Everything `me` is owed: addressed messages in bus ∪ mail, and bus broadcasts outside the session's
 * frontier and `routed` that `messageForMe` accepts; minus receipts, outcomes and `!relevant`. Deduped
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
    else if (!cursor.frontier.has(m.id) && !cursor.routed.has(m.id) && messageForMe(me, m, route)) offer(m)
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
export interface TrimOptions { busKeep?: number; origin?: unknown }

/**
 * A pure, idempotent function of `(doc, now)`: every step only adds idempotent entries or removes items,
 * so two trimmers in a partition converge after merge.
 */
export function trim(doc: RoomDoc, now: number, opts: TrimOptions = {}): TrimReport {
  const report: TrimReport = { archived: 0, mailed: 0, expired: 0, evicted: 0, removed: 0 }
  const bus = doc.messages()
  const mail = new Map(doc.mail.entries())
  const answered = answeredIds([...bus, ...mail.values()])
  const eligible = (m: Msg) => replyEligible(m, answered, now)

  // 1. Beyond the newest `busKeep`, or beyond BUS_BYTES counted from the newest, messages leave the bus.
  let cutoff = Math.max(0, bus.length - Math.max(0, opts.busKeep ?? BUS_KEEP))
  for (let i = bus.length - 1, bytes = 0; i >= cutoff; i--) {
    bytes += sizeOf(bus[i])
    if (bytes > BUS_BYTES) { cutoff = i + 1; break }
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
  const scopes = doc.allScopes()
  const leaving = bus.filter((m, i) => i < cutoff || ended.has(m.id))
  const archived = new Map<string, ArchivedMsg>()
  for (const m of leaving) if (!doc.archive.has(m.id) && !archived.has(m.id)) archived.set(m.id, compact(m, scopes))
  const archive = [...doc.archive.entries(), ...archived.entries()]
    .map(([id, entry]) => ({ id, at: entry[2], size: id.length + sizeOf(entry), unfulfilled: !!entry[4] }))
  const keepArchive = newest(archive, ARCHIVE_MAX, ARCHIVE_BYTES)
  for (const id of newest(archive.filter(e => e.unfulfilled), ARCHIVE_UNFULFILLED_MAX, Infinity)) keepArchive.add(id)
  const outcomes = [...doc.outcomes.entries(), ...[...ended].filter(([id]) => !doc.outcomes.has(id))]
    .filter(([, o]) => now - o.at <= OUTCOMES_TTL_MS)
    .map(([id, o]) => ({ id, at: o.at, size: id.length + sizeOf(o) }))
  const keepOutcomes = newest(outcomes, OUTCOMES_MAX, OUTCOMES_BYTES)

  doc.doc.transact(() => {
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
  return report
}

export type Admission = { ok: true } | { ok: false; reason: string }

/**
 * Admission for an addressed post (MF6): trim, then check the recipient's owed caps and the room's store of
 * owed messages. Callers that must never be refused (automatic posts) post anyway and let the trim evict.
 */
export function admit(doc: RoomDoc, m: { to?: string; [field: string]: unknown }, now: number, opts: TrimOptions = {}): Admission {
  const size = sizeOf(m)
  if (size > MAX_MESSAGE_BYTES) return { ok: false, reason: `the message is ${Math.ceil(size / KiB)} KiB; the limit is ${MAX_MESSAGE_BYTES / KiB} KiB` }
  if (!m.to) return { ok: true }
  trim(doc, now, opts)
  const pending = new Map<string, Msg>()
  for (const x of [...doc.mail.values(), ...doc.messages()]) if (!pending.has(x.id) && isOwed(doc, x)) pending.set(x.id, x)
  const theirs = [...pending.values()].filter(x => x.to === m.to)
  const theirBytes = theirs.reduce((n, x) => n + sizeOf(x), 0)
  if (theirs.length >= OWED_PER_RECIPIENT || theirBytes + size > OWED_BYTES_PER_RECIPIENT) {
    return { ok: false, reason: `${m.to} has ${theirs.length} undelivered messages; wait until it reads them` }
  }
  const owedBytes = [...pending.values()].reduce((n, x) => n + sizeOf(x), 0)
  if (owedBytes + size > MAIL_BYTES) return { ok: false, reason: `the room's message store is full (${Math.round(owedBytes / KiB)} KiB owed to others)` }
  return { ok: true }
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

export interface TrimLeader { name: string; sessionId?: string }

/**
 * The trim leader, which limits churn; correctness never depends on it. Candidates are present PR-less
 * awareness states, fresh by participantsView's window. A name with a holder record counts only through
 * that holder's session. Non-workers come first, then the lowest name, then the lowest session id.
 */
export function trimLeader(doc: RoomDoc, awareness: AwarenessView, now: number): TrimLeader | undefined {
  const candidates: (TrimLeader & { worker: boolean })[] = []
  for (const [clientId, value] of awareness.getStates()) {
    const state = value as Partial<Presence> | null
    const name = state?.user?.name
    if (!name || name.startsWith('pr#')) continue
    const updated = awareness.meta?.get(clientId)?.lastUpdated
    if (updated !== undefined && (now - updated > AWARENESS_FRESH_MS || updated > now)) continue
    const holder = participantRecord(doc, name)?.holder
    if (holder && state.sessionId !== holder.sessionId) continue
    candidates.push({ name, ...(state.sessionId !== undefined ? { sessionId: state.sessionId } : {}), worker: holder?.workerId !== undefined || !!doc.workerOf(name) })
  }
  const bySession = (a?: string, b?: string) => a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : compare(a, b)
  candidates.sort((a, b) => Number(a.worker) - Number(b.worker) || compare(a.name, b.name) || bySession(a.sessionId, b.sessionId))
  if (!candidates.length) return undefined
  const { worker: _worker, ...leader } = candidates[0]
  return leader
}

/** Whether `me` is the elected leader; a session id is compared only when both sides carry one. */
export function leadsTrim(leader: TrimLeader | undefined, me: { name: string; sessionId?: string }): boolean {
  return !!leader && leader.name === me.name && (leader.sessionId === undefined || me.sessionId === undefined || leader.sessionId === me.sessionId)
}
