import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import {
  admit, archiveSummary, BUS_BYTES, LEDGER_BUDGET, MAIL_BYTES, OUTCOMES_MAX, OWED_PER_RECIPIENT,
  highestSeq, OWED_TTL_MS, owed, REPLY_WINDOW_MS, trim,
} from './delivery.js'
import type { DeliveryCursor, MessageMap, Msg, MsgType } from './types.js'

const SHOWN = { s: 'session-1', via: 'reply' } as const

const NOW = Date.UTC(2026, 8, 28, 12)
const DAY = 24 * 60 * 60 * 1000
const P = { name: 'pat', kind: 'agent' as const }
const cursor = (frontier = 0, routed: string[] = []): DeliveryCursor => ({ frontier, routed: new Set(routed) })
const ids = (messages: readonly Msg[]) => messages.map(m => m.id)

let seq = 0
function msg(fields: Partial<Msg> & { type: Msg['type'] }): Msg {
  seq++
  return { id: `m_${String(seq).padStart(6, '0')}`, seq, priority: 'notify', from: 'quinn', fromKind: 'agent', at: NOW - DAY + seq, ...fields } as Msg
}
const question = (fields: Partial<Msg> = {}) => msg({ type: 'question', to: P.name, text: 'which token?', ...fields } as Partial<Msg> & { type: 'question' })
const broadcast = (fields: Partial<Msg> = {}) => msg({ type: 'note', text: 'heads up', ...fields } as Partial<Msg> & { type: 'note' })
const push = (room: RoomDoc, ...messages: Msg[]) => { room.bus.push(messages); return messages }
const roots = (room: RoomDoc) => ({
  bus: ids(room.messages()),
  mail: room.mail.toJSON(),
  archive: room.archive.toJSON(),
  outcomes: room.outcomes.toJSON(),
})
// Budgets count each message serialized on its own.
const perEntry = (messages: Iterable<Msg>) => [...messages].reduce((n, m) => n + new TextEncoder().encode(JSON.stringify(m)).length, 0)

// A kind that declared its own `to` (a SHA, a branch) would be addressed to a participant nobody holds.
type RedeclaresTo = { [K in MsgType]: undefined extends MessageMap[K]['to'] ? (MessageMap[K]['to'] extends string | undefined ? never : K) : K }[MsgType]
const everyKindAddressesParticipants: [RedeclaresTo] extends [never] ? true : false = true

describe('owed (test 1)', () => {
  it('rejects registered kinds whose `to` is anything but the addressee participant', () => {
    expect(everyKindAddressesParticipants).toBe(true)
  })

  it('offers addressed messages at or below the frontier and ignores broadcasts at or below it', () => {
    const room = new RoomDoc()
    const [q, old] = push(room, question(), broadcast())
    expect(ids(owed(room, P, cursor(highestSeq(room)), {}))).toEqual([q.id])
  })

  it('offers a broadcast with a higher seq at an earlier array position (SF1, by seq)', () => {
    const a = new RoomDoc(new Y.Doc()), b = new RoomDoc(new Y.Doc())
    a.doc.clientID = 2; b.doc.clientID = 1
    const [first] = push(a, broadcast({ from: 'ann' }))
    const frontier = highestSeq(a)
    const [late] = push(b, broadcast({ from: 'bea' }))
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc))
    expect(ids(a.messages()).indexOf(late.id)).toBeLessThan(ids(a.messages()).indexOf(first.id))
    expect(late.seq).toBeGreaterThan(frontier)
    expect(ids(owed(a, P, cursor(frontier), {}))).toEqual([late.id])
  })

  it('highestSeq is the largest seq on the bus, 0 for an empty one, and ignores a message without one', () => {
    const room = new RoomDoc()
    expect(highestSeq(room)).toBe(0)
    const [one, two] = push(room, broadcast(), broadcast())
    room.bus.insert(0, [{ ...broadcast(), seq: undefined }])
    expect(highestSeq(room)).toBe(Math.max(one.seq!, two.seq!))
    expect(ids(owed(room, P, cursor(0), {}))).toEqual([one.id, two.id])
  })

  it('skips routed broadcasts, outcomes, receipts and irrelevant messages, writing nothing for them', () => {
    const room = new RoomDoc()
    const [routed, ended, receipted, irrelevant, kept] = push(room, broadcast(), question(), question(), question(), question())
    room.outcomes.set(ended.id, { to: P.name, from: 'quinn', outcome: 'expired', at: NOW })
    room.markSeen(P.name, [receipted.id], SHOWN)
    const before = Y.encodeStateVector(room.doc)
    expect(ids(owed(room, P, cursor(0, [routed.id]), {}, m => m.id !== irrelevant.id))).toEqual([kept.id])
    expect(Y.encodeStateVector(room.doc)).toEqual(before)
    expect(room.seen(P.name).has(irrelevant.id)).toBe(false)
  })

  it('reads addressed mail, dedupes ids posted twice, and skips an agent’s own messages', () => {
    const room = new RoomDoc()
    const mailed = question()
    room.mail.set(mailed.id, mailed)
    const twice = question()
    push(room, twice, { ...twice }, question({ from: P.name }), question({ from: P.name, fromKind: 'human' }))
    const own = room.messages()[3]
    expect(ids(owed(room, P, cursor(), {}))).toEqual([mailed.id, twice.id, own.id])
  })

  it('routes broadcasts through messageForMe', () => {
    const room = new RoomDoc()
    const [fyi, notify] = push(room, broadcast({ priority: 'fyi' }), broadcast())
    expect(ids(owed(room, P, cursor(), {}))).toEqual([notify.id])
    expect(fyi.priority).toBe('fyi')
  })
})

describe('message lookup', () => {
  it('finds a message on the bus, then in mail', () => {
    const room = new RoomDoc()
    const [onBus] = push(room, question())
    const mailed = question()
    room.mail.set(mailed.id, mailed)
    expect(room.message(onBus.id)).toEqual(onBus)
    expect(room.message(mailed.id)).toEqual(mailed)
    expect(room.message('m_missing')).toBeUndefined()
  })
})

describe('trim', () => {
  it('moves owed and reply-eligible addressed messages to mail, archives everything that leaves', () => {
    const room = new RoomDoc()
    room.setScope({ by: 'quinn', byKind: 'agent', area: 'auth', summary: 'login', paths: ['auth/'] })
    const owedQ = question()
    const shownQ = question()
    const answeredQ = question()
    const answer = msg({ type: 'answer', to: 'quinn', inReplyTo: answeredQ.id, text: 'yes' } as Partial<Msg> & { type: 'answer' })
    const changed = msg({ type: 'changed', paths: ['auth/a.ts'], summary: 'x', priority: 'fyi' } as Partial<Msg> & { type: 'changed' })
    const release = msg({ type: 'release', claimId: 'c1', path: 'auth/a.ts', unfulfilled: [{ kind: 'rename', symbol: 'token' }] } as Partial<Msg> & { type: 'release' })
    push(room, owedQ, shownQ, answeredQ, answer, changed, release, broadcast())
    room.markSeen(P.name, [shownQ.id, answeredQ.id], SHOWN)
    room.markSeen('quinn', [answer.id], SHOWN)

    const report = trim(room, NOW, { busKeep: 1 })
    expect(report).toMatchObject({ removed: 6, archived: 6, mailed: 2 })
    expect(Object.keys(room.mail.toJSON()).sort()).toEqual([owedQ.id, shownQ.id].sort())
    expect(room.messages()).toHaveLength(1)
    expect(room.archive.get(changed.id)).toEqual(['changed', 'quinn', changed.at, ['auth']])
    expect(archiveSummary(room, 'auth')).toMatchObject({ messages: 2, counts: { changed: 1, release: 1 } })
    expect(archiveSummary(room).unfulfilled).toEqual([{ id: release.id, from: 'quinn', at: release.at, path: 'auth/a.ts', plans: [{ kind: 'rename', symbol: 'token' }] }])
    expect(archiveSummary(room).messages).toBe(6)

    const again = roots(room)
    expect(trim(room, NOW, { busKeep: 1 })).toEqual({ archived: 0, mailed: 0, expired: 0, evicted: 0, removed: 0 })
    expect(roots(room)).toEqual(again)
  })

  it('drops mail once receipted and outside its reply window', () => {
    const room = new RoomDoc()
    const answer = msg({ type: 'answer', to: P.name, inReplyTo: 'm_q', text: 'yes' } as Partial<Msg> & { type: 'answer' })
    const q = question()
    room.mail.set(answer.id, answer); room.mail.set(q.id, q)
    trim(room, NOW)
    expect(room.mail.size).toBe(2)
    room.markSeen(P.name, [answer.id, q.id], SHOWN)
    trim(room, NOW)
    expect([...room.mail.keys()]).toEqual([q.id])
    trim(room, q.at + REPLY_WINDOW_MS)
    expect(room.mail.size).toBe(0)
  })

  it('two trimmers on partitioned replicas converge to what one trimmer writes (test 2, MF9)', () => {
    const origin = new RoomDoc()
    origin.setScope({ by: 'quinn', byKind: 'agent', area: 'auth', summary: 'login', paths: ['auth/'] })
    for (let i = 0; i < 30; i++) push(origin, i % 3 === 0 ? question() : i % 3 === 1 ? broadcast() : msg({ type: 'changed', paths: ['auth/a.ts'], summary: `${i}`, priority: 'fyi' } as Partial<Msg> & { type: 'changed' }))
    origin.markSeen(P.name, [origin.messages()[3].id], SHOWN)
    const copy = () => { const r = new RoomDoc(new Y.Doc()); Y.applyUpdate(r.doc, Y.encodeStateAsUpdate(origin.doc)); return r }
    const single = copy(), a = copy(), b = copy()
    trim(single, NOW, { busKeep: 10 })
    trim(a, NOW, { busKeep: 10 }); trim(b, NOW, { busKeep: 10 })
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc)); Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc))
    expect(roots(a)).toEqual(roots(single))
    expect(roots(b)).toEqual(roots(single))
    expect(archiveSummary(a).messages).toBe(20)
    expect(a.messages()).toHaveLength(10)
  })
})

describe('bounds and admission (test 3, MF6, SF4)', () => {
  it('caps an offline recipient’s owed set at 200 with over-cap outcomes and refuses room_send past it', () => {
    const room = new RoomDoc()
    const flood: Msg[] = []
    for (let i = 0; i < 10_000; i++) flood.push(question({ at: NOW - DAY + i }))
    push(room, ...flood)
    const report = trim(room, NOW)
    const left = owed(room, P, cursor(), {})
    expect(left).toHaveLength(OWED_PER_RECIPIENT)
    expect(ids(left)).toEqual(ids(flood.slice(-OWED_PER_RECIPIENT)))
    expect(report.evicted).toBe(10_000 - OWED_PER_RECIPIENT)
    expect(room.outcomes.size).toBe(OUTCOMES_MAX)
    expect([...room.outcomes.values()].every(o => o.outcome === 'over-cap' && o.to === P.name && o.from === 'quinn')).toBe(true)
    expect(room.outcomes.has(flood.at(-OWED_PER_RECIPIENT - 1)!.id)).toBe(true)
    expect(admit(room, { type: 'question', to: P.name, text: 'one more' }, NOW)).toEqual({ ok: false, reason: `${P.name} has ${OWED_PER_RECIPIENT} undelivered messages; wait until it reads them` })
    expect(admit(room, { type: 'question', to: 'kim', text: 'hi' }, NOW)).toEqual({ ok: true })
  })

  it('evicts fyi, then notify, then questions, oldest first', () => {
    const room = new RoomDoc()
    const questions = Array.from({ length: OWED_PER_RECIPIENT + 1 }, () => question())
    const notes = Array.from({ length: 3 }, () => msg({ type: 'note', to: P.name, text: 'n' } as Partial<Msg> & { type: 'note' }))
    const fyi = msg({ type: 'note', to: P.name, text: 'f', priority: 'fyi' } as Partial<Msg> & { type: 'note' })
    push(room, fyi, ...questions, ...notes)
    trim(room, NOW)
    expect(room.outcomes.has(fyi.id)).toBe(true)
    expect(notes.filter(n => room.outcomes.has(n.id))).toHaveLength(3)
    expect(questions.filter(q => room.outcomes.has(q.id))).toEqual([questions[0]])
  })

  it('expires owed messages after 14 days and refuses messages over 64 KiB', () => {
    const room = new RoomDoc()
    const [stale, fresh] = push(room, question({ at: NOW - OWED_TTL_MS - 1 }), question())
    const report = trim(room, NOW)
    expect(report.expired).toBe(1)
    expect(room.outcomes.get(stale.id)).toEqual({ to: P.name, from: 'quinn', outcome: 'expired', at: NOW })
    expect(ids(room.messages())).toEqual([fresh.id])
    expect(ids(owed(room, P, cursor(), {}))).toEqual([fresh.id])
    expect(admit(room, { type: 'note', to: P.name, text: 'x'.repeat(64 * 1024) }, NOW)).toMatchObject({ ok: false, reason: expect.stringContaining('64 KiB') })
  })

  it('refuses room_send when the room’s store of owed messages is full', () => {
    const room = new RoomDoc()
    for (let i = 0; i < 25; i++) {
      const m = question({ to: `r${i}`, text: 'x'.repeat(60 * 1024) })
      room.mail.set(m.id, m)
    }
    expect(perEntry(room.mail.values())).toBeLessThan(MAIL_BYTES)
    expect(admit(room, { type: 'question', to: 'kim', text: 'x'.repeat(60 * 1024) }, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/^the room's message store is full \(\d+ KiB owed to others\)$/) })
  })

  it('100 recipients sent one 64 KiB message each: the bus is trimmed by bytes and the ledger stays under 4 MiB', () => {
    const room = new RoomDoc()
    for (let i = 0; i < 100; i++) push(room, question({ to: `r${i}`, text: 'x'.repeat(64 * 1024 - 300) }))
    trim(room, NOW)
    expect(perEntry(room.messages())).toBeLessThanOrEqual(BUS_BYTES)
    expect(perEntry(room.mail.values())).toBeLessThanOrEqual(MAIL_BYTES)
    const ledger = new Y.Doc()
    for (const name of ['mail', 'outcomes', 'archive']) for (const [k, v] of room.doc.getMap(name)) ledger.getMap(name).set(k, v)
    ledger.getArray('bus').push(room.messages())
    expect(Y.encodeStateAsUpdate(ledger).byteLength).toBeLessThan(LEDGER_BUDGET)
    const kept = new Set([...ids(room.messages()), ...room.mail.keys()])
    expect(kept.size + room.outcomes.size).toBe(100)
    expect([...room.outcomes.values()].every(o => o.outcome === 'over-cap')).toBe(true)
  })
})
