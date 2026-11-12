import { expect, it } from 'vitest'
import { RoomDoc, owed, deliveryIndex, participantRecord, validMessageShape, type Msg, type RetiredWorker } from '@room/shared'

const retired: RetiredWorker & { id: string } = { id: 'w_old', name: 'lead+w', tag: 'w', lead: 'lead', host: 'codex', task: '', summary: '', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'clean' }
const notice = (text: string, type: 'conflict' | 'merge-conflict' | 'contract' = 'merge-conflict'): Msg => ({
  id: 'cf:old', from: 'room', fromKind: 'agent', to: 'lead', path: 'x', text, type, at: 1, priority: 'notify',
  ...(type === 'conflict' ? { claimId: '', otherClaimId: '' } : type === 'contract' ? { symbol: 'f' } : {}),
} as Msg)
const pending = (room: RoomDoc) => owed(room, { name: 'lead' }, { frontier: 0, routed: new Set() }, {}).map(m => m.id)

it.each([
  notice("x conflicts with lead+w's version at lines 1"),
  notice("3 files conflict with lead+w's version: x at lines 1; y at lines 2"),
  notice("2 files no longer conflict with lead+w's version: x, y"),
  notice("you edited x inside lead+w's claim at line 1", 'conflict'),
  notice("your earlier change to x overlaps lead+w's new claim at line 1", 'conflict'),
  notice("lead+w edited x inside your claim", 'conflict'),
  notice("lead+w's earlier change to x overlaps your new claim", 'conflict'),
  notice('concurrent overlapping claims in x with lead+w', 'conflict'),
  notice('claims in x may overlap with lead+w; line mapping is approximate', 'conflict'),
  notice("you may have edited x inside lead+w's claims at lines 1, 3; line mapping is approximate", 'conflict'),
  notice('lead+w changed x too, outside their declared area; Room cannot check this merge'),
  notice('the conflict with lead+w cleared'),
  notice('lead+w changed f in x', 'contract'),
])('does not infer a retired subject from saved $type text', m => {
  const room = new RoomDoc()
  try {
    room.doc.getArray('retiredWorkers').push([retired])
    room.mail.set(m.id, m); room.bus.push([{ ...m, id: 'cf:bus' }])
    expect(pending(room)).toEqual([m.id, 'cf:bus'])
    room.retireWorkerState([retired], 5, () => {})
    expect(room.mail.size).toBe(1)
    expect([...deliveryIndex(room).pending.keys()].sort()).toEqual([m.id, 'cf:bus'].sort())
    expect(room.outcomes.has(m.id)).toBe(false)
  } finally { room.doc.destroy() }
})

it('ends exact retired dependencies while preserving live successors, ordinary mentions and unresolved live conflicts', () => {
  const room = new RoomDoc()
  try {
    room.doc.getArray('retiredWorkers').push([retired])
    room.participants.set('lead+w\0holder', { workerId: 'w_new', sessionId: 'new', epoch: 2 })
    const old = { ...notice('old'), noticeSubjects: [{ name: retired.name, workerId: retired.id }] }
    const current = { ...notice('live competing edits'), id: 'cf:new', noticeSubjects: [{ name: retired.name, workerId: 'w_new' }] }
    const legacy = { ...notice("x conflicts with lead+w's version"), id: 'cf:legacy' }
    const mention = { ...notice('Discuss lead+w'), id: 'note', type: 'note' as const }
    const live = { ...notice("x conflicts with lead+live's version"), id: 'cf:live' }
    room.bus.push([old, current, legacy, mention, live])
    expect(pending(room)).toEqual(['cf:new', 'cf:legacy', 'note', 'cf:live'])
    room.retireWorkerState([retired], 5, () => {})
    expect(pending(room)).toEqual(['cf:new', 'cf:legacy', 'note', 'cf:live'])
    expect(participantRecord(room, retired.name)?.holder?.workerId).toBe('w_new')
    expect(room.outcomes.has(old.id)).toBe(true)
    for (const m of [current, legacy, mention, live]) expect(room.outcomes.has(m.id)).toBe(false)
  } finally { room.doc.destroy() }
})

it('does not treat a retired name inside a file path or a longer participant name as the subject', () => {
  const room = new RoomDoc()
  try {
    room.doc.getArray('retiredWorkers').push([retired])
    room.bus.push([{ ...notice("lead+w/file conflicts with lead+worker's version"), path: 'lead+w/file' }])
    expect(pending(room)).toEqual(['cf:old'])
  } finally { room.doc.destroy() }
})

it('validates exact bounded subject metadata only on notice message kinds', () => {
  const m = { ...notice('live'), noticeSubjects: [{ name: 'lead+w', workerId: 'w' }] }
  expect(validMessageShape(m)).toBe(true)
  for (const noticeSubjects of [[], [null], [{ name: '' }], [{ name: 'w', workerId: 2 }], [{ name: 'w', extra: true }], Array(3).fill({ name: 'w' })])
    expect(validMessageShape({ ...m, noticeSubjects })).toBe(false)
  expect(validMessageShape({ id: 'note', from: 'room', type: 'note', text: 'x', noticeSubjects: m.noticeSubjects })).toBe(false)
})
