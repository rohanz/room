import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, admit, deliveryIndex, owed, OWED_PER_RECIPIENT, type Msg } from '@room/shared'
import { Ledger } from '../src/ledger.js'
import type { Session } from '../src/session.js'

const rooms: RoomDoc[] = []
afterEach(() => { for (const room of rooms.splice(0)) room.doc.destroy() })
const room = () => { const r = new RoomDoc(); rooms.push(r); return r }
const kinds = ['merge-conflict', 'conflict', 'contract'] as const
function legacy(n: number, to = 'lead', text = 'x conflicts with worker'): Msg {
  const type = kinds[n % kinds.length]!
  return { id: `old:${n}`, type, from: 'room', fromKind: 'agent', to, path: 'x', text, priority: 'notify', at: Date.now(),
    noticeSubjects: [{ name: 'lead+w', workerId: 'w_old' }],
    ...(type === 'conflict' ? { claimId: 'c', otherClaimId: '' } : type === 'contract' ? { symbol: 'f' } : {}) } as Msg
}
const question = (to = 'lead', text = 'Can I proceed?'): Msg => ({ id: 'question', type: 'question', from: 'peer', fromKind: 'agent', to, text, priority: 'notify', at: Date.now() })
function reader(r: RoomDoc, current = true) {
  let held = current
  const s = { room: r, roomName: 'r', dir: '/unused', me: { name: 'lead', kind: 'agent' }, lease: { fence: () => held ? '1' : undefined } } as unknown as Session
  const ledger = new Ledger({ sessionId: () => 'session-lead', route: () => ({}) })
  ledger.bind(s)
  return { ledger, s, hold: () => { held = true } }
}
function fill(r: RoomDoc, storage: 'bus' | 'mail', count = OWED_PER_RECIPIENT, text?: string, to = 'lead') {
  const messages = Array.from({ length: count }, (_, n) => legacy(n, to, text))
  r.doc.transact(() => { if (storage === 'bus') r.bus.push(messages); else for (const m of messages) r.mail.set(m.id, m) })
  return messages
}

/** Frozen 0.17.55 owed/admission rule (9136509000 delivery.ts): every kind counts unless receipted or ended.
 * Deliberately independent of today's isOwed/admit exemptions. This models the hosted hub receiving
 * an ordinary Yjs receipt update; it never runs the upgraded reader or the new quota predicate.
 */
function oldServerAdmission(r: RoomDoc, message: Msg): { ok: boolean } {
  const pending = new Map<string, Msg>()
  for (const m of [...r.mail.values(), ...r.messages()]) if (m.to && !(m.from === m.to && m.fromKind !== 'human') && !r.outcomes.has(m.id) && !r.seen(m.to).has(m.id) && !pending.has(m.id)) pending.set(m.id, m)
  const size = (m: Msg) => new TextEncoder().encode(JSON.stringify(m)).length
  const theirs = [...pending.values()].filter(m => m.to === message.to)
  return { ok: theirs.length < 200 && theirs.reduce((n, m) => n + size(m), 0) + size(message) <= 256 * 1024
    && [...pending.values()].reduce((n, m) => n + size(m), 0) + size(message) <= 1.5 * 1024 * 1024 }
}

for (const storage of ['bus', 'mail'] as const) {
  it(`${storage}: the reported retired-subject quota reproduction excludes old conflict kinds for every recipient`, () => {
    const r = room(); fill(r, storage)
    r.retireWorkerState([{ name: 'lead+w', id: 'w_old' }], Date.now(), () => {})
    expect(owed(r, { name: 'lead' }, { frontier: 0, routed: new Set() }, {})).toEqual([])
    expect(admit(r, question(), Date.now())).toEqual({ ok: true })
    expect(deliveryIndex(r).recipients.has('lead')).toBe(false)
    expect(deliveryIndex(r).owedBytes).toBe(0)
    expect(deliveryIndex(r).verify()).toBeUndefined()
  })
  it(`${storage}: receipts from an upgraded reader free the unchanged 0.17.55 server's recipient quota`, () => {
    const server = room(), client = room(), old = fill(server, storage)
    expect(oldServerAdmission(server, question())).toEqual({ ok: false })
    Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(server.doc))
    reader(client)
    // Only the reader writes the receipt: the hosted document receives an ordinary replicated update.
    expect(server.seen('lead').size).toBe(0)
    expect(client.seen('lead').size).toBe(old.length)
    Y.applyUpdate(server.doc, Y.encodeStateAsUpdate(client.doc))
    expect(oldServerAdmission(server, question())).toEqual({ ok: true })
    for (const m of old) expect(server.seen('lead').get(m.id)).toMatchObject({ s: 'session-lead', via: 'reply' })
    expect(server.outcomes.size).toBe(0)
  })
  it(`${storage}: arriving legacy mail is silently receipted without consuming ordinary notes or another recipient's mail`, () => {
    const r = room(), f = reader(r)
    const ordinary: Msg = { ...question(), type: 'note', id: 'note', text: "Discuss lead+w's claims and old merge-conflict messages" }
    const old = [legacy(0), legacy(1), legacy(2), legacy(3, 'offline')]
    r.doc.transact(() => { if (storage === 'bus') r.bus.push([ordinary, ...old]); else for (const m of [ordinary, ...old]) r.mail.set(m.id, m) })
    expect([...r.seen('lead').keys()].sort()).toEqual(old.filter(m => m.to === 'lead').map(m => m.id).sort())
    expect(r.seen('offline').size).toBe(0)
    expect(f.ledger.candidates(f.s)).toEqual([ordinary])
    expect(r.outcomes.has(ordinary.id)).toBe(false)
    f.ledger.bind(f.s)
    expect(f.ledger.candidates(f.s)).toEqual([ordinary])
    expect(r.seen('lead').size).toBe(3)
  })
}
it('old-server byte accounting is unblocked by the same ordinary receipt update', () => {
  const server = room(), client = room(); fill(server, 'mail', 4, 'x'.repeat(60_000))
  const ordinary = question('lead', 'x'.repeat(40_000))
  expect(oldServerAdmission(server, ordinary)).toEqual({ ok: false })
  Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(server.doc)); reader(client)
  Y.applyUpdate(server.doc, Y.encodeStateAsUpdate(client.doc))
  expect(oldServerAdmission(server, ordinary)).toEqual({ ok: true })
})
it('a paused reader writes no receipt; its own receipt migration runs once it holds the name', () => {
  const r = room(); fill(r, 'mail', 3)
  const f = reader(r, false)
  expect(r.seen('lead').size).toBe(0)
  f.hold(); f.ledger.candidates(f.s)
  expect(r.seen('lead').size).toBe(3)
})
it('does not forge offline-recipient receipts to work around the old hosted server residual', () => {
  const server = room(), client = room(); fill(server, 'mail', OWED_PER_RECIPIENT, undefined, 'offline')
  Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(server.doc)); reader(client)
  Y.applyUpdate(server.doc, Y.encodeStateAsUpdate(client.doc))
  expect(server.seen('offline').size).toBe(0)
  expect(oldServerAdmission(server, question('offline'))).toEqual({ ok: false })
  expect(admit(client, question('offline'), Date.now())).toEqual({ ok: true })
})
it('ordinary messages still count against the quota even when their text mentions old conflict kinds', () => {
  const r = room()
  for (let n = 0; n < OWED_PER_RECIPIENT; n++) r.mail.set(`note:${n}`, { ...question(), type: 'note', id: `note:${n}`, text: 'merge-conflict contract conflict' })
  reader(r)
  expect(r.seen('lead').size).toBe(0)
  expect(admit(r, question(), Date.now())).toMatchObject({ ok: false })
})

it('does not receipt legacy mail after detachment and consumes it when this participant binds again', () => {
  const r = room(), f = reader(r)
  f.ledger.unbind(f.s)
  r.mail.set('old:0', legacy(0))
  expect(r.seen('lead').size).toBe(0)
  f.ledger.bind(f.s)
  expect(r.seen('lead').has('old:0')).toBe(true)
})
it('new byte accounting excludes obsolete mail even for an offline recipient', () => {
  const r = room(); fill(r, 'mail', 4, 'x'.repeat(60_000), 'offline')
  expect(admit(r, question('offline', 'x'.repeat(40_000)), Date.now())).toEqual({ ok: true })
  expect(r.seen('offline').size).toBe(0)
})

for (const storage of ['bus', 'mail'] as const) it(storage + ': receipt migration reads only new entries after binding', () => {
  const r = room(), f = reader(r)
  fill(r, storage, 100)
  const messages = vi.spyOn(r, 'messages'), values = vi.spyOn(r.mail, 'values'), entries = vi.spyOn(r.mail, 'entries')
  if (storage === 'bus') r.bus.push([legacy(101)])
  else r.mail.set('old:101', legacy(101))
  expect(r.seen('lead').has('old:101')).toBe(true)
  expect(messages).not.toHaveBeenCalled(); expect(values).not.toHaveBeenCalled(); expect(entries).not.toHaveBeenCalled()
  messages.mockRestore(); values.mockRestore(); entries.mockRestore()
})

for (const storage of ['bus', 'mail'] as const) it(storage + ': paused pending receipts forget removed bodies', () => {
  const r = room(), f = reader(r, false)
  for (let n = 0; n < 30; n++) {
    if (storage === 'bus') { r.bus.push([legacy(n)]); r.bus.delete(0, 1) }
    else { r.mail.set('same-key', legacy(n)); r.mail.delete('same-key') }
  }
  f.hold(); f.ledger.candidates(f.s)
  expect(r.seen('lead').size).toBe(0)
})
it('a recovered bus index also forgets removed pending legacy bodies', () => {
  const r = room(), f = reader(r, false)
  r.bus.push([legacy(0)])
  deliveryIndex(r).bus.stale = true
  r.bus.delete(0, 1)
  f.hold(); f.ledger.candidates(f.s)
  expect(r.seen('lead').size).toBe(0)
})
it('an ordinary copy sharing an old message ID is still delivered normally', () => {
  const r = room(), f = reader(r, false), old = legacy(0)
  r.mail.set(old.id, old)
  const ordinary = { ...question(), type: 'note' as const, id: old.id }
  r.bus.push([ordinary])
  f.hold()
  expect(f.ledger.candidates(f.s)).toEqual([ordinary])
  expect(r.seen('lead').size).toBe(0)
})
