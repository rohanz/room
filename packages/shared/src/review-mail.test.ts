import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import { admit, deliveryIndex, BUS_BYTES, OUTCOMES_BYTES, OUTCOMES_MAX, OWED_TTL_MS, retireRecipient, owed, trim } from './delivery.js'
import { memorySnapshot } from './memory.js'
import type { Msg, RetiredWorker, WorkerView } from './types.js'

const NOW = 1_000_000
const message = (id: string, at = NOW - 1, to = 'lead+w'): Msg => ({
  id, type: 'note', from: 'lead', fromKind: 'agent', to, text: 'hello', priority: 'notify', at,
})
const retired = (name = 'lead+w', id = 'old'): RetiredWorker & { id: string } => ({
  id, name, tag: name, lead: 'lead', host: 'codex', task: '', summary: '', files: [], fileCount: 0,
  startedAt: NOW - 100, finishedAt: NOW - 10, retiredAt: NOW, outcome: 'clean',
})
const worker = (id: string): WorkerView => ({
  id, name: 'lead+w', tag: 'w', lead: 'lead', host: 'codex', mode: 'local', task: '', branch: 'b',
  status: 'running', run: 1, startedAt: NOW + 1, fence: 'f',
})
const copy = (a: RoomDoc): RoomDoc => {
  const b = new RoomDoc()
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc))
  return b
}
const merge = (a: RoomDoc, b: RoomDoc) => {
  const au = Y.encodeStateAsUpdate(a.doc), bu = Y.encodeStateAsUpdate(b.doc)
  Y.applyUpdate(a.doc, bu); Y.applyUpdate(b.doc, au)
}
const checkTotals = (room: RoomDoc) => {
  const index = deliveryIndex(room)
  const before = { bytes: index.owedBytes, recipients: structuredClone(index.recipients), ids: [...index.pending.keys()].sort() }
  index.rebuild()
  expect({ bytes: index.owedBytes, recipients: index.recipients, ids: [...index.pending.keys()].sort() }).toEqual(before)
}

it('leaves concurrent mail owed until the lead acts, independent of hub and retirement clocks', () => {
  const a = new RoomDoc()
  a.workerViews.set('old', worker('old'))
  const b = copy(a)
  deliveryIndex(a); deliveryIndex(b)
  a.retireWorker('old', retired(), () => {})
  b.bus.push([message('concurrent', NOW + 1)])
  merge(a, b)
  for (const room of [a, b]) {
    admit(room, { to: 'other', text: 'hello' }, NOW + 2)
    trim(room, NOW + 2)
    checkTotals(room)
    expect(deliveryIndex(room).pending.has('concurrent')).toBe(true)
    retireRecipient(room, 'lead+w', NOW + 2)
    checkTotals(room)
    expect(deliveryIndex(room).owedBytes).toBe(0)
  }
  a.doc.destroy(); b.doc.destroy()
})

it('keeps late predecessor mail owed under a reused name until the documented TTL', () => {
  const a = new RoomDoc()
  a.workerViews.set('old', worker('old'))
  const b = copy(a)
  deliveryIndex(a); deliveryIndex(b)
  a.retireWorker('old', retired(), () => {})
  a.workerViews.set('new', worker('new'))
  b.bus.push([message('late-old')])
  merge(a, b)
  for (const room of [a, b]) {
    admit(room, { to: 'other', text: 'hello' }, NOW + 2)
    trim(room, NOW + 2)
    checkTotals(room)
    expect(deliveryIndex(room).pending.has('late-old')).toBe(true)
    trim(room, NOW + OWED_TTL_MS + 1)
    expect(deliveryIndex(room).pending.has('late-old')).toBe(false)
    expect(room.outcomes.get('late-old')?.outcome).toBe('expired')
    checkTotals(room)
  }
  a.doc.destroy(); b.doc.destroy()
})

it('control: concurrent receipt and two authoritative retirement writers converge with exact running totals', () => {
  const a = new RoomDoc()
  a.bus.push([message('read')])
  const b = copy(a)
  deliveryIndex(a); deliveryIndex(b)
  a.retireWorker('old', retired(), () => {})
  b.markSeen('lead+w', ['read'], { s: 'worker', via: 'reply' })
  b.bus.push([message('late-old')])
  merge(a, b)
  for (const room of [a, b]) {
    checkTotals(room)
    retireRecipient(room, 'lead+w', NOW + 2)
    trim(room, NOW + 2)
    checkTotals(room)
    expect(deliveryIndex(room).owedBytes).toBe(0)
  }
  merge(a, b)
  expect(a.outcomes.toJSON()).toEqual(b.outcomes.toJSON())
  expect(a.outcomes.size).toBe(2)
  checkTotals(a); checkTotals(b)
  a.doc.destroy(); b.doc.destroy()
})

it('preserves successor mail on memory reload when the lead clock is ahead of the hub', () => {
  const a = new RoomDoc()
  a.retireWorker('old', retired(), () => {})
  a.workerViews.set('new', worker('new'))
  // Sent after the successor spawns, but its hub timestamp trails the lead's retirement clock.
  a.bus.push([message('successor-mail', NOW - 1)])
  trim(a, NOW + 2)
  expect(deliveryIndex(a).pending.has('successor-mail')).toBe(true)
  const b = new RoomDoc()
  Y.applyUpdate(b.doc, memorySnapshot(a.doc))
  admit(b, { to: 'other', text: 'hello' }, NOW + 2)
  expect.soft(deliveryIndex(b).pending.has('successor-mail')).toBe(true)
  expect.soft(b.outcomes.has('successor-mail')).toBe(false)
  checkTotals(a); checkTotals(b)
  a.doc.destroy(); b.doc.destroy()
})

it('control: retained retirement markers survive an actual saved-memory reload and history pruning', () => {
  const a = new RoomDoc()
  a.bus.push([message('old')])
  a.retireWorker('old', retired(), () => {})
  a.doc.getArray('retiredWorkers').delete(0, 1)
  trim(a, NOW + 31 * 86_400_000)
  const b = new RoomDoc()
  Y.applyUpdate(b.doc, memorySnapshot(a.doc))
  b.workerViews.set('new', worker('new'))
  b.bus.push([message('new', NOW + 31 * 86_400_000)])
  expect(owed(b, { name: 'lead+w' }, { frontier: 0, routed: new Set() }, {}).map(m => m.id)).toEqual(['new'])
  checkTotals(b)
  a.doc.destroy(); b.doc.destroy()
})

it('deletes retirement mail copies and bounds remaining markers by bus retention', () => {
  const room = new RoomDoc()
  const from = 'a'.repeat(196)
  const names = Array.from({ length: 40 }, (_, i) => `lead+${String(i).padStart(2, '0')}${'w'.repeat(189)}`)
  room.doc.transact(() => {
    for (let i = 0; i < 4000; i++) {
      const m = { ...message(`m${i}`, NOW - 1, names[i % 40]), from, text: 'x'.repeat(200) }
      if (i < 2000) room.bus.push([m]); else room.mail.set(m.id, m)
    }
    for (const name of names) room.retireWorker(name, retired(name, name), () => {})
  })
  trim(room, NOW)
  expect(room.mail.size).toBe(0)
  expect(room.outcomes.size).toBeLessThanOrEqual(OUTCOMES_MAX)
  const bytes = [...room.outcomes].reduce((n, [id, o]) => n + id.length + new TextEncoder().encode(JSON.stringify(o)).length, 0)
  expect(bytes).toBeLessThanOrEqual(Math.max(OUTCOMES_BYTES, BUS_BYTES + 128 * room.messages().length))
  for (const m of room.messages()) {
    const marker = m.id.length + new TextEncoder().encode(JSON.stringify(room.outcomes.get(m.id))).length
    expect(marker).toBeLessThanOrEqual(new TextEncoder().encode(JSON.stringify(m)).length + 128)
    expect(room.outcomes.get(m.id)?.outcome).toBe('recipient-retired')
  }
  checkTotals(room)
  room.doc.destroy()
})

it('measures authoritative retirement of 3,000 messages and unchanged follow-up admissions', () => {
  const room = new RoomDoc()
  room.doc.transact(() => {
    for (let i = 0; i < 100; i++) room.doc.getArray('retiredWorkers').push([retired(`lead+w${i}`, `w${i}`)])
    for (let i = 0; i < 3000; i++) {
      const m = { ...message(`m${i}`, NOW - 1, `lead+w${i % 100}`), text: 'x'.repeat(600) }
      if (i < 1500) room.bus.push([m]); else room.mail.set(m.id, m)
    }
  })
  const loaded = new RoomDoc()
  Y.applyUpdate(loaded.doc, memorySnapshot(room.doc))
  const start = performance.now()
  for (let i = 0; i < 100; i++) retireRecipient(loaded, `lead+w${i}`, NOW)
  expect(admit(loaded, { to: 'other', text: 'hello' }, NOW)).toEqual({ ok: true })
  const retiredMs = performance.now() - start
  const sv = Y.encodeStateVector(loaded.doc)
  const next = performance.now()
  for (let i = 0; i < 100; i++) expect(admit(loaded, { to: 'other', text: 'hello' }, NOW)).toEqual({ ok: true })
  console.log('review retirement', { retiredMs, admissions100Ms: performance.now() - next })
  expect(Y.encodeStateVector(loaded.doc)).toEqual(sv)
  expect(deliveryIndex(loaded).owedBytes).toBe(0)
  checkTotals(loaded)
  room.doc.destroy(); loaded.doc.destroy()
})
