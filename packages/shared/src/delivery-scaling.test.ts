// Frozen pre-index implementation: test-only semantic oracle for arbitrary replicated docs.
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { admit as indexedAdmit, trim as indexedTrim, deliveryIndex } from './delivery.js'
import { RoomDoc } from './doc.js'
import { messageAreas } from './ledger.js'
import { validMessageShape } from './messages.js'
import type { ArchivedMsg, Msg, Outcome, Scope } from './types.js'

// The one delivery ledger: docs/superpowers/specs/2026-09-28-ledger.md ("The trim", "Message lookup").

const KiB = 1024
const MiB = 1024 * KiB
const DAY_MS = 24 * 60 * 60 * 1000

const BUS_KEEP = 2000
const BUS_BYTES = 1.5 * MiB
const MAIL_MAX = 2000
const MAIL_BYTES = 1.5 * MiB
const OWED_PER_RECIPIENT = 200
const OWED_BYTES_PER_RECIPIENT = 256 * KiB
const ARCHIVE_MAX = 5000
const ARCHIVE_BYTES = 512 * KiB
const ARCHIVE_UNFULFILLED_MAX = 200
const OUTCOMES_MAX = 2000
const OUTCOMES_BYTES = 256 * KiB
const OUTCOMES_TTL_MS = 30 * DAY_MS
const REPLY_WINDOW_MS = 14 * DAY_MS
const OWED_TTL_MS = 14 * DAY_MS
const MAX_MESSAGE_BYTES = 64 * KiB

const encoder = new TextEncoder()
const sizeOf = (value: unknown): number => encoder.encode(JSON.stringify(value)).length
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
/** The deterministic order `(at, id)`, oldest first. */
const byAge = (a: { at: number; id: string }, b: { at: number; id: string }): number => a.at - b.at || compare(a.id, b.id)

const selfSent = (m: Msg): boolean => m.from === m.to && m.fromKind !== 'human'
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

interface TrimReport { archived: number; mailed: number; expired: number; evicted: number; removed: number }
interface TrimOptions { busKeep?: number; origin?: unknown }

/**
 * A pure, idempotent function of `(doc, now)`: every step only adds idempotent entries or removes items,
 * so two trimmers in a partition converge after merge.
 */
function trim(doc: RoomDoc, now: number, opts: TrimOptions = {}): TrimReport {
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
  return report
}

type Admission = { ok: true } | { ok: false; reason: string }

/**
 * Admission for an addressed post (MF6): trim, then check the recipient's owed caps and the room's store of
 * owed messages. Callers that must never be refused (automatic posts) post anyway and let the trim evict.
 */
function admit(doc: RoomDoc, m: { to?: string; [field: string]: unknown }, now: number, opts: TrimOptions = {}): Admission {
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


const roots = (room: RoomDoc) => ({ bus: room.messages(), mail: room.mail.toJSON(), archive: room.archive.toJSON(), outcomes: room.outcomes.toJSON() })
const clone = (room: RoomDoc) => { const copy = new RoomDoc(); Y.applyUpdate(copy.doc, Y.encodeStateAsUpdate(room.doc)); return copy }
const message = (id: string, fields: Partial<Msg> = {}): Msg => ({ id, type: 'note', text: 'x', from: 'ada', fromKind: 'agent', priority: 'notify', at: 100, ...fields } as Msg)

// Deterministic random generation, no timing assertions or network.
it('matches the old admission and trim on arbitrary expired, over-cap and conflicting docs', () => {
  let seed = 48271
  const rand = (max: number) => { seed = (seed * 16807) % 2147483647; return seed % max }
  const now = OWED_TTL_MS + 1000
  let accepted = 0, refused = 0
  for (let run = 0; run < 150; run++) {
    const doc = new RoomDoc(), keep = rand(40), mode = run % 5, count = mode === 0 ? 200 + rand(160) : rand(300)
    for (let i = 0; i < count; i++) {
      const id = mode < 2 ? `m-${i}` : `m-${rand(250)}`
      const m = message(id, { to: mode === 0 ? 'p-0' : mode === 1 ? `p-${rand(40)}` : rand(5) ? `p-${rand(3)}` : undefined, at: rand(3) ? now - rand(1000) : 0,
        type: rand(4) ? 'note' : 'question', priority: ['fyi', 'notify', 'interrupt'][rand(3)] as Msg['priority'],
        text: 'x'.repeat(mode === 1 ? 12000 : rand(12) ? rand(100) : 10000), ...(rand(6) ? {} : { inReplyTo: `m-${rand(250)}` }) } as Partial<Msg>)
      if (rand(4)) doc.bus.push([m]); else doc.mail.set(mode === 4 && !rand(3) ? `alias-${id}` : id, m)
      if (!rand(7) && m.to) doc.markSeen(m.to, [id], { s: 's', via: 'reply' })
      if (!rand(11)) doc.outcomes.set(id, { to: m.to ?? 'p-0', from: m.from, at: rand(2) ? now : -OUTCOMES_TTL_MS, outcome: 'over-cap' })
    }
    if (!rand(3)) doc.bus.push([{ id: 'bad', type: 'note', text: 5 } as never])
    if (!rand(3)) doc.mail.set('bad', null as never)
    if (!rand(3)) doc.outcomes.set('bad', null as never)
    const oracle = clone(doc)
    const post = { to: `p-${rand(3)}`, type: 'question', from: 'ada', text: 'x'.repeat(rand(32000)) }
    const result = indexedAdmit(doc, post, now, { busKeep: keep })
    if (result.ok) accepted++; else refused++
    expect(result, `admission run ${run}`).toEqual(admit(oracle, post, now, { busKeep: keep }))
    indexedTrim(doc, now, { busKeep: keep })
    trim(oracle, now, { busKeep: keep })
    expect(roots(doc), `trim run ${run}`).toEqual(roots(oracle))
    doc.doc.destroy(); oracle.doc.destroy()
  }
  expect(accepted).toBeGreaterThan(0); expect(refused).toBeGreaterThan(0)
})

function check(room: RoomDoc) {
  const index = deliveryIndex(room)
  const bytes = (m: Msg) => new TextEncoder().encode(JSON.stringify(m)).length
  const bus = room.messages()
  expect(index.bus.entries.size).toBe(bus.length)
  expect(index.bus.bytes).toBe(bus.reduce((n, m) => n + bytes(m), 0))
  const counts = new Map<string, number>()
  for (const m of bus) counts.set(m.id, (counts.get(m.id) ?? 0) + 1)
  expect(new Map([...index.bus.ids].map(([id, values]) => [id, values.size]))).toEqual(counts)
  for (const id of counts.keys()) expect(room.message(id)).toEqual(bus.find(m => m.id === id))
  const pending = new Map<string, Msg>()
  for (const m of [...room.mail.values(), ...bus]) if (!pending.has(m.id) && isOwed(room, m)) pending.set(m.id, m)
  expect(new Set(index.pending.keys())).toEqual(new Set(pending.keys()))
  expect(index.owedBytes).toBe([...pending.values()].reduce((n, m) => n + bytes(m), 0))
  const recipients = new Map<string, { count: number; bytes: number }>()
  for (const m of pending.values()) {
    const prior = recipients.get(m.to!) ?? { count: 0, bytes: 0 }; prior.count++; prior.bytes += bytes(m); recipients.set(m.to!, prior)
  }
  expect(index.recipients).toEqual(recipients)
  const before = { bytes: index.owedBytes, recipients: new Map([...index.recipients].map(([id, x]) => [id, { ...x }])) }
  index.rebuild()
  expect(index.owedBytes).toBe(before.bytes); expect(index.recipients).toEqual(before.recipients)
}

it('indexes remote updates, out-of-order pending structs, splits, merges, undo and reload', () => {
  const a = new RoomDoc(), b = new RoomDoc()
  deliveryIndex(a); deliveryIndex(b)
  a.doc.transact(() => {
    a.bus.push([message('a', { to: 'pat' }), message('b', { to: 'pat' }), message('c')])
    a.bus.push([message('d', { to: 'quinn' })])
  })
  check(a)
  const first = Y.encodeStateAsUpdate(a.doc), frontier = Y.encodeStateVector(a.doc)
  a.bus.insert(2, [message('insert', { to: 'pat' })]) // splits the original multi-value Item
  const second = Y.encodeStateAsUpdate(a.doc, frontier)
  Y.applyUpdate(b.doc, second); check(b) // structs pending until their left origin arrives
  Y.applyUpdate(b.doc, first); check(b)
  b.bus.delete(1, 2); check(b)
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc)); check(a)
  const undo = new Y.UndoManager(a.bus)
  a.doc.transact(() => { a.bus.push([message('undo', { to: 'pat' })]); a.bus.push([message('tail')]) })
  check(a); undo.undo(); check(a); undo.redo(); check(a)
  a.markSeen('pat', ['a', 'undo'], { s: 's', via: 'reply' }); check(a)
  a.seen('pat').delete('a'); check(a)
  a.mail.set('mail', message('mail', { to: 'pat' })); check(a)
  a.outcomes.set('mail', { to: 'pat', from: 'ada', outcome: 'over-cap', at: 1 }); check(a)
  a.outcomes.delete('mail'); check(a)
  a.mail.delete('mail'); check(a)
  const reloaded = clone(a); check(reloaded)
  undo.destroy(); a.doc.destroy(); b.doc.destroy(); reloaded.doc.destroy()
})


it('uses the cap index without rescanning clean refusals and reacts to remote receipts', () => {
  const room = new RoomDoc(), now = 1000
  room.bus.push(Array.from({ length: 200 }, (_, i) => message(`m-${i}`, { to: 'pat' })))
  const post = { to: 'pat', type: 'note', text: 'x' }
  const before = clone(room)
  expect(indexedAdmit(room, post, now)).toEqual(admit(before, post, now)) // recovery cap trim
  const original = room.bus.toArray
  room.bus.toArray = () => { throw new Error('clean cap admission scanned bus') }
  expect(indexedAdmit(room, post, now)).toEqual({ ok: false, reason: 'pat has 200 undelivered messages; wait until it reads them' })
  room.bus.toArray = original
  const replica = clone(room)
  replica.markSeen('pat', ['m-0'], { s: 's', via: 'reply' })
  Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(replica.doc))
  check(room)
  room.bus.toArray = () => { throw new Error('safe acceptance scanned bus') }
  expect(indexedAdmit(room, post, now)).toEqual({ ok: true })
  room.bus.toArray = original
  room.doc.destroy(); before.doc.destroy(); replica.doc.destroy()
})

it('rebuilds safely on an unexpected replicated bus content type', () => {
  const room = new RoomDoc(), index = deliveryIndex(room)
  room.bus.push([message('good', { to: 'pat' })])
  room.bus.push([new Y.Map() as never])
  expect(index.bus.entries.size).toBe(2)
  expect(index.bus.invalid).toBe(1)
  expect(index.pending.get('good')).toEqual(room.bus.get(0))
  room.bus.delete(1, 1)
  check(room)
  expect(index.bus.invalid).toBe(0)
  room.doc.destroy()
})
