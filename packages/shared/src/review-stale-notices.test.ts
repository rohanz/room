import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import { deliveryIndex, owed } from './delivery.js'
import type { Msg, RetiredWorker } from './types.js'
import { validParticipantName } from './identity.js'

const old: RetiredWorker & { id: string } = { id: 'old', name: 'lead+w', tag: 'w', lead: 'lead', host: 'codex', task: '', summary: '', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'clean' }
const notice = (id: string, subjects?: Msg['noticeSubjects'], to = 'lead'): Extract<Msg, { type: 'merge-conflict' }> => ({ id: `cf:${id}`, from: 'room', fromKind: 'agent', to, type: 'merge-conflict', path: 'x', text: "x conflicts with lead+w's version", priority: 'notify', at: 1, ...(subjects ? { noticeSubjects: subjects } : {}) })
const pending = (room: RoomDoc) => owed(room, { name: 'lead' }, { frontier: 0, routed: new Set() }, {}).map(m => m.id)
const totals = (room: RoomDoc) => {
  const index = deliveryIndex(room)
  const values = () => ({ bytes: index.owedBytes, recipients: structuredClone(index.recipients), ids: [...index.pending.keys()].sort() })
  const before = values(); index.rebuild(); expect(values()).toEqual(before)
}
const sync = (a: RoomDoc, b: RoomDoc) => {
  const au = Y.encodeStateAsUpdate(a.doc), bu = Y.encodeStateAsUpdate(b.doc)
  Y.applyUpdate(a.doc, bu); Y.applyUpdate(b.doc, au)
  totals(a); totals(b)
}

it('preserves a legacy notice about a distinct live participant whose name extends a retired subject prefix', () => {
  const room = new RoomDoc(), live = "lead+w's version-review"
  try {
    expect(validParticipantName(live)).toBe(true)
    room.doc.getArray('retiredWorkers').push([old])
    room.participants.set(`${live}\0id`, { name: live, kind: 'agent' })
    room.participants.set(`${live}\0holder`, { sessionId: 'live', epoch: 1 })
    room.bus.push([{ ...notice('different-live-name'), text: `x conflicts with ${live}'s version at lines 1` }])
    expect.soft(pending(room)).toEqual(['cf:different-live-name'])
    room.retireWorkerState([old], 10, () => {})
    expect(room.outcomes.has('cf:different-live-name')).toBe(false)
  } finally { room.doc.destroy() }
})

it('keeps an unreplaced legacy possible notice naming both held endpoints until ordinary expiry', () => {
  const room = new RoomDoc()
  try {
    room.doc.getArray('retiredWorkers').push([old])
    room.bus.push([{ ...notice('both-held'), priority: 'fyi', text: 'lead+w and lead+live changed x too, outside their declared area; Room cannot check this merge' }])
    expect(pending(room)).toEqual(['cf:both-held'])
    room.retireWorkerState([old], 10, () => {})
    expect(deliveryIndex(room).pending.has('cf:both-held')).toBe(true)
    expect(room.outcomes.has('cf:both-held')).toBe(false)
  } finally { room.doc.destroy() }
})

it.each([true, false])('preserves a live ordinary namesake (holder=%s), legacy and structured', holder => {
  const room = new RoomDoc()
  try {
    room.doc.getArray('retiredWorkers').push([old])
    room.participants.set(`${old.name}\0id`, { name: old.name, kind: 'agent' })
    if (holder) room.participants.set(`${old.name}\0holder`, { sessionId: 'ordinary', epoch: 2 })
    room.bus.push([notice('legacy'), notice('structured', [{ name: old.name }])])
    room.retireWorkerState([old], 10, () => {})
    expect(pending(room)).toEqual(['cf:legacy', 'cf:structured']); totals(room)
  } finally { room.doc.destroy() }
})

it('retires a pair notice when either endpoint retired, while preserving live/live notices', () => {
  const room = new RoomDoc()
  try {
    room.bus.push([notice('mixed', [{ name: old.name, workerId: old.id }, { name: 'live', workerId: 'live-id' }]), notice('live', [{ name: 'live', workerId: 'live-id' }, { name: 'lead' }])])
    room.retireWorker(old.id, old, () => {})
    expect(pending(room)).toEqual(['cf:live']); totals(room)
  } finally { room.doc.destroy() }
})

it('converges late concurrent notices and concurrent healing without corrupting delivery totals', () => {
  const a = new RoomDoc(), b = new RoomDoc()
  try {
    a.bus.push([notice('initial', [{ name: old.name, workerId: old.id }]), notice('to-and-about', [{ name: old.name, workerId: old.id }], old.name)])
    sync(a, b)
    a.retireWorker(old.id, old, () => {})
    b.bus.push([notice('late', [{ name: old.name, workerId: old.id }])])
    sync(a, b)
    expect(pending(a)).toEqual([]); expect(pending(b)).toEqual([])
    a.retireWorkerState([old], 10, () => {}); b.retireWorkerState([old], 11, () => {})
    sync(a, b)
    expect([...deliveryIndex(a).pending]).toEqual([])
    expect([...a.outcomes]).toEqual([...b.outcomes])
    expect(a.outcomes.get('cf:to-and-about')?.outcome).toBe('recipient-retired')
    expect(a.outcomes.get('cf:late')?.outcome).toBe('expired')
  } finally { a.doc.destroy(); b.doc.destroy() }
})
