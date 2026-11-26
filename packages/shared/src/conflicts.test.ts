import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import { conflictEndReason, onOpenConflictsChanged, openConflicts, withConflictSlots, type ConflictSlot } from './conflicts.js'
const rooms: RoomDoc[] = []
afterEach(() => { for (const room of rooms.splice(0)) room.doc.destroy() })
const kinds = ['merge', 'edit-in-claim', 'claims', 'contract'] as const
const states = ['current', 'unknown', 'replaced', 'retired'] as const
for (const kind of kinds) it.each(states)(kind + ' endpoint %s uses the same open-state rule', state => {
  const room = new RoomDoc(); rooms.push(room)
  const slot: ConflictSlot = { owner: 'A', other: 'B', kind, path: 'x', subject: 'scope', status: 'conflict', settled: 'conflict', inputs: 'inputs', factId: 'fact', openId: 'opening', fence: '1', checkedAt: 1, endpoints: [{ name: 'A' }, { name: 'B', workerId: 'peer-1' }] }
  const workerId = state === 'current' ? 'peer-1' : state === 'replaced' ? 'peer-2' : undefined

    if (workerId) room.participants.set('B\0holder', { workerId })
    if (state === 'retired') room.doc.getArray('retiredWorkers').push([{ id: 'peer-1', name: 'B' }])
    room.doc.getMap('conflicts').set('slot', slot)
  expect(openConflicts(room, 'A')).toHaveLength(state === 'current' || state === 'unknown' ? 1 : 0)
})
it('invalid projection evidence is unknown, including while cached', () => {
  {
    const room = new RoomDoc(); rooms.push(room)
    const slot: ConflictSlot = { owner: 'A', other: 'B', kind: 'merge', path: 'x', status: 'conflict', settled: 'conflict', inputs: 'i', factId: 'f', openId: 'o', fence: '1', checkedAt: 1, endpoints: [{ name: 'A' }, { name: 'B', workerId: 'peer-1' }] }

      room.participants.set('B\0proj', { projectedFrom: 'unproved', projectedBy: 'L2' })
      room.manifestHead.set('B', { projectedFrom: 'different', projectedBy: 'L2' } as never)
      room.doc.getMap('conflicts').set('s', slot)
    const open = openConflicts(room, 'A'); expect(open).toHaveLength(1); expect(openConflicts(room, 'A')).toBe(open)
  }
})
it('unknown projection cannot use an unproved finished-worker view to end an overlap', () => {
  const room = new RoomDoc(); rooms.push(room)
  const slot: ConflictSlot = { owner: 'A', other: 'B', kind: 'edit-in-claim', path: 'x', status: 'conflict', settled: 'conflict', inputs: 'i', factId: 'f', openId: 'o', fence: '1', checkedAt: 1, endpoints: [{ name: 'A' }, { name: 'B', workerId: 'peer-1' }] }
  const evidence = { name: 'B', projection: { projectedFrom: 'peer-1', projectedBy: 'A' }, manifestProjection: { projectedFrom: 'unproved', projectedBy: 'A' }, worker: { id: 'peer-1', lead: 'A', status: 'done' as const } }

    room.participants.set('B\0proj', evidence.projection)
    room.manifestHead.set('B', evidence.manifestProjection as never)
    room.workerViews.set('peer-1', { name: 'B', startedAt: 1, ...evidence.worker } as never)
    room.doc.getMap('conflicts').set('s', slot)
  expect(conflictEndReason(room, slot)).toBeUndefined()
  expect(room.doc.getMap('conflicts').get('s')).toBe(slot)
  expect(openConflicts(room, 'A')).toEqual([]) // Main's display filter does not end the stored overlap.
})

it.each(['conflict', 'possible'] as const)('regenerates subset and union presentation (%s)', settled => {
  const room = new RoomDoc(); rooms.push(room)
  const make = (path: string): ConflictSlot => ({ owner: 'A', other: 'B', kind: 'merge', path, status: settled, settled, inputs: 'i', factId: 'f', openId: 'o', endpoints: [{ name: 'A' }, { name: 'B' }], fence: '1', checkedAt: 1 })
  for (const path of ['y', 'x']) {
    const slot = make(path)
    room.doc.getMap('conflicts').set(path, slot)
  }
  const original = openConflicts(room, 'A')[0]!, text = original.text
  const one = withConflictSlots(original, [make('y')])
  expect(one.text).not.toContain('2 files')
  expect(one.text).toContain(settled === 'possible' ? 'possible conflict in y' : 'y conflicts')
  const union = withConflictSlots(original, [make('z'), ...original.slots])
  expect(union.text).toContain(settled === 'possible' ? '3 files possibly conflict' : '3 files conflict')
  expect(union.slots.map(slot => slot.path)).toEqual(['x', 'y', 'z'])
  expect(union).toMatchObject({ id: original.id, owner: original.owner, priority: original.priority })
  expect(original.text).toBe(text); expect(original.slots).toHaveLength(2)
})
for (const kind of kinds) it.each(['old', 'missing-open-id', 'missing-endpoints'] as const)('rejects ' + kind + ' older identity (%s)', version => {
  const room = new RoomDoc(); rooms.push(room)
  const slot = { owner: 'A', other: 'B', kind, path: 'x', status: 'conflict', settled: 'conflict', inputs: 'old', factId: 'old', epoch: 1,
    projectedEpisode: { id: 'old-opening', endpoints: [{ name: 'A', workerId: 'old' }, { name: 'B' }] },
    ...(version === 'missing-open-id' ? { endpoints: [{ name: 'A' }, { name: 'B' }] } : version === 'missing-endpoints' ? { openId: 'partial' } : {}) }
  room.doc.getMap('conflicts').set('s', slot)
  expect(openConflicts(room)).toEqual([])
  expect(openConflicts(room, 'A')).toEqual([])
})

it('reads a projected worker opening for its lead in this room, updating recipient indexes when projections move', () => {
  const room = new RoomDoc(); rooms.push(room)
  const slot: ConflictSlot = { owner: 'W', other: 'P', kind: 'merge', path: 'x', status: 'possible', settled: 'possible',
    inputs: 'i', factId: 'f', openId: 'opening', fence: '1', checkedAt: 1, endpoints: [{ name: 'W', workerId: 'w' }, { name: 'P', workerId: 'p' }] }
  room.doc.getMap('conflicts').set('slot', slot)
  expect(openConflicts(room, 'L')).toEqual([])
  const project = (name: string, id: string, lead: string) => {
    room.participants.set(name + '\0proj', { projectedFrom: id, projectedBy: lead })
    room.manifestHead.set(name, { projectedFrom: id, projectedBy: lead } as never)
  }
  project('W', 'w', 'L')
  expect(openConflicts(room, 'L')).toMatchObject([{ owner: 'L', priority: 'fyi', text: expect.stringContaining('W: ') }])
  project('P', 'p', 'R')
  expect(openConflicts(room, 'L')).toMatchObject([{ priority: 'notify' }])
  expect(openConflicts(room, 'W')).toMatchObject([{ priority: 'fyi' }])
  project('W', 'w', 'next-lead')
  expect(openConflicts(room, 'L')).toEqual([])
  expect(openConflicts(room, 'next-lead')).toHaveLength(1)
  room.manifestHead.delete('W')
  expect(openConflicts(room, 'next-lead')).toEqual([])
  expect(openConflicts(room, 'W')).toHaveLength(1)
})

it.each(['conflicts', 'participants', 'manifestHead', 'workerViews', 'retiredWorkers', 'completedPublications', 'completedPublicationRevisions'] as const)(
  'notifies synchronously after %s invalidates the open-conflict query', input => {
    const room = new RoomDoc(); rooms.push(room)
    const slot: ConflictSlot = { owner: 'A', other: 'B', kind: 'merge', path: 'x', status: 'conflict', settled: 'conflict',
      inputs: 'i', factId: 'f', openId: 'o', fence: '1', checkedAt: 1, endpoints: [{ name: 'A' }, { name: 'B' }] }
    room.doc.getMap('conflicts').set('slot', slot)
    const before = openConflicts(room, 'A')
    const listener = vi.fn(() => openConflicts(room, 'A'))
    const unsubscribe = onOpenConflictsChanged(room, listener)
    const change = () => {
      if (input === 'conflicts') room.doc.getMap(input).set('slot', { ...slot, checkedAt: 2 })
      else if (input === 'retiredWorkers') room.doc.getArray(input).push([{ id: 'unrelated', name: 'C' }])
      else if (input === 'participants') room.participants.set('A\0holder', { sessionId: 'a', epoch: 1 })
      else if (input === 'manifestHead') room.manifestHead.set('A', { level: 'full', excluded: [], fence: '1' } as never)
      else if (input === 'workerViews') room.workerViews.set('w', { id: 'w', name: 'C', lead: 'L', startedAt: 1 } as never)
      else if (input === 'completedPublications') room.doc.getMap(input).set('cache', { worker: { name: 'C' }, holder: { epoch: 1 }, head: { semRev: 1, rev: 1 } })
      else room.doc.getMap(input).set('revision', { name: 'C', epoch: 1, semRev: 1, rev: 1 })
    }
    expect(listener).not.toHaveBeenCalled()
    change()
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.results[0]!.value).not.toBe(before)
    expect(listener.mock.results[0]!.value).toHaveLength(1)
    unsubscribe(); change()
    expect(listener).toHaveBeenCalledOnce()
  },
)

it.each([false, true])('notifies once after all recipient-index inputs in a transaction update (remote=%s)', remote => {
  const room = new RoomDoc(), source = remote ? new RoomDoc() : room
  rooms.push(room); if (remote) rooms.push(source)
  const slot: ConflictSlot = { owner: 'W', other: 'P', kind: 'merge', path: 'x', status: 'conflict', settled: 'conflict',
    inputs: 'i', factId: 'f', openId: 'opening', fence: '1', checkedAt: 1, endpoints: [{ name: 'W', workerId: 'w' }, { name: 'P' }] }
  source.doc.getMap('conflicts').set('slot', slot)
  if (remote) Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(source.doc))
  expect(openConflicts(room, 'L')).toEqual([])
  const observed: string[][] = []
  onOpenConflictsChanged(room, () => observed.push(openConflicts(room, 'L').map(entry => entry.slots[0]!.openId!)))
  source.doc.transact(() => {
    source.participants.set('W\0proj', { projectedFrom: 'w', projectedBy: 'L' })
    source.manifestHead.set('W', { projectedFrom: 'w', projectedBy: 'L' } as never)
    source.doc.getMap('conflicts').set('slot', { ...slot, openId: 'latest' })
  })
  if (remote) Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(source.doc))
  expect(observed).toEqual([['latest']])
})

it('ignores non-input edits and retains changed-key query work with many unrelated conflicts', () => {
  const room = new RoomDoc(); rooms.push(room)
  const map = room.doc.getMap<ConflictSlot>('conflicts')
  for (let n = 0; n < 1_000; n++) map.set(String(n), { owner: 'A' + n, other: 'B', kind: 'merge', path: 'x', status: 'conflict', settled: 'conflict',
    inputs: 'i', factId: 'f', openId: 'o', fence: '1', checkedAt: 1, endpoints: [{ name: 'A' + n }, { name: 'B' }] })
  const before = openConflicts(room, 'A0'), listener = vi.fn(() => openConflicts(room, 'A0'))
  onOpenConflictsChanged(room, listener)
  const entries = vi.spyOn(map, 'entries'), values = vi.spyOn(map, 'values'), keys = vi.spyOn(map, 'keys'), iterate = vi.spyOn(map, Symbol.iterator)
  room.metaMap.set('roomSalt', 'changed')
  room.doc.getMap('claims').set('claim', { by: 'A0', path: 'x', from: 200, to: 210 })
  const manifest = new Y.Map<import('./manifest.js').ManifestEntry>(), manifestKey = 'A0\0' + '1'
  room.manifest.set(manifestKey, manifest)
  manifest.set('x', { state: 'held' } as never)
  room.setOverlay(manifestKey, 'x', 'new text')
  expect(listener).not.toHaveBeenCalled()
  expect(openConflicts(room, 'A0')).toBe(before)
  map.set('1', { ...map.get('1')!, checkedAt: 2 })
  expect(listener).toHaveBeenCalledOnce()
  expect(listener.mock.results[0]!.value).toBe(before)
  for (const spy of [entries, values, keys, iterate]) expect(spy).not.toHaveBeenCalled()
})
