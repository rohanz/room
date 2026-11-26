import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, conflictEndReason, digestPath, ExpiryTenure, manifestKey, memorySnapshot, openConflicts, participantRecord, participantsView, ROOM_STALE_MS,
  type ConflictKind, type ConflictSlot } from './index.js'
import { epochPublication } from './testing.js'

function fixture(kind: ConflictKind = 'contract', worker = false) {
  const room = new RoomDoc(); room.ensureRoomSalt()
  for (const name of ['A', 'B', 'C']) {
    epochPublication(room, name, 'a'.repeat(40))
    room.manifestHead.set(name, { ...room.manifestHead.get(name)!, level: 'full' })
  }
  if (worker) {
    room.participants.set('B\0holder', { ...participantRecord(room, 'B')!.holder!, workerId: 'w' })
    room.workerViews.set('w', { id: 'w', name: 'B', tag: 'b', lead: 'A', status: 'running', run: 1, host: 'codex', mode: 'here', task: 't', branch: 'b', startedAt: 1, fence: '1' })
  }
  const slot: ConflictSlot = { kind, owner: 'A', other: 'B', path: 'api.py', subject: 'call', consumers: ['consumer.py'], status: 'conflict', settled: 'conflict',
    inputs: 'i', factId: 'f', fence: '1', checkedAt: 1, openId: 'opening', endpoints: [{ name: 'A' }, { name: 'B', ...(worker ? { workerId: 'w' } : {}) }] }
  room.doc.getMap('conflicts').set('slot', slot)
  return { room, slot, close: () => room.doc.destroy() }
}

for (const kind of ['merge', 'edit-in-claim', 'claims', 'contract'] as const) describe(kind, () => {
  it('does not end for missing identity, view, grant or source evidence', () => {
    const f = fixture(kind, true)
    try {
      f.room.workerViews.clear(); f.room.manifestHead.delete('B'); f.room.participants.delete('B\0holder')
      expect(conflictEndReason(f.room, f.slot)).toBeUndefined()
      expect(openConflicts(f.room, 'A')).toHaveLength(1)
    } finally { f.close() }
  })
  it('ends on a completed clean evaluation or proven endpoint retirement/replacement', () => {
    const f = fixture(kind, true)
    try {
      expect(conflictEndReason(f.room, f.slot, { evaluated: 'clean' })).toBe('clean')
      f.room.participants.set('B\0holder', { ...participantRecord(f.room, 'B')!.holder!, workerId: 'new' })
      expect(conflictEndReason(f.room, f.slot)).toBe('replaced')
      expect(conflictEndReason(f.room, f.slot, { retiredWorkerIds: new Set(['w']) })).toBe('retired')
    } finally { f.close() }
  })
  it('existing seven-day expiry removes both-endpoint native slots, retaining unrelated peers', () => {
    const f = fixture(kind)
    try {
      const map = f.room.doc.getMap<ConflictSlot>('conflicts')
      map.set('reverse', { ...f.slot, owner: 'B', other: 'A' })
      map.set('unrelated', { ...f.slot, other: 'C', endpoints: [{ name: 'A' }, { name: 'C' }] })
      let now = 0
      const expiry = new ExpiryTenure('tenure', () => now)
      const awareness = { getStates: () => new Map([[1, { user: { name: 'A', kind: 'agent' }, sessionId: 'session-A' }], [3, { user: { name: 'C', kind: 'agent' }, sessionId: 'session-C' }]]) }
      expiry.observe(f.room, participantsView(f.room, awareness, 0), undefined, () => {})
      now = ROOM_STALE_MS
      expect(expiry.observe(f.room, participantsView(f.room, awareness, 0), undefined, () => {})).toEqual(['B'])
      expect([...map.keys()]).toEqual(['unrelated'])
      expect(openConflicts(f.room, 'A').map(entry => entry.other)).toEqual(['C'])
    } finally { f.close() }
  })
})

it.each(['starting', 'running', 'unknown', 'ambiguous', 'done', 'failed', 'stopped', 'collecting'] as const)('own-worker claim authority ends only on done (%s)', status => {
  for (const kind of ['edit-in-claim', 'claims', 'merge', 'contract'] as const) {
    const f = fixture(kind, true)
    try {
      f.room.workerViews.set('w', { ...f.room.workerViews.get('w')!, status })
      expect(conflictEndReason(f.room, f.slot, { ownWorker: { name: 'B', id: 'w', lead: 'A', status } })).toBe(status === 'done' && (kind === 'claims' || kind === 'edit-in-claim') ? 'claims-finished' : undefined)
    } finally { f.close() }
  }
})

it.each(['merge', 'edit-in-claim', 'claims', 'contract'] as const)('%s: stale final display is not authority to end a resumed worker conflict', kind => {
  const f = fixture(kind, true)
  try {
    for (const name of ['A', 'B']) {
      epochPublication(f.room, name, 'a'.repeat(40), 2)
      f.room.manifestHead.set(name, { ...f.room.manifestHead.get(name)!, level: 'full' })
    }
    f.room.participants.set('B\0holder', { ...participantRecord(f.room, 'B')!.holder!, workerId: 'w' })
    f.room.workerViews.set('w', { ...f.room.workerViews.get('w')!, status: 'done', run: 1, fence: '1' })
    expect(f.room.acceptedWorkerViewOf('B')).toBeUndefined()
    expect(conflictEndReason(f.room, f.slot)).toBeUndefined()
    expect(openConflicts(f.room, 'A')).toHaveLength(kind === 'edit-in-claim' ? 0 : 1)
  } finally { f.close() }
})

it.each(['merge', 'edit-in-claim', 'claims', 'contract'] as const)('%s: an unaccepted worker view cannot prove a replacement identity', kind => {
  const f = fixture(kind, true)
  try {
    const { workerId: _id, ...holder } = participantRecord(f.room, 'B')!.holder!
    f.room.participants.set('B\0holder', holder)
    epochPublication(f.room, 'R', 'a'.repeat(40), 2)
    f.room.workerViews.clear()
    f.room.workerViews.set('old', { id: 'old', name: 'B', lead: 'R', status: 'done', run: 1, startedAt: 1, fence: '1' } as never)
    expect(f.room.acceptedWorkerViewOf('B')).toBeUndefined()
    expect(conflictEndReason(f.room, f.slot)).toBeUndefined()
    expect(openConflicts(f.room, 'A')).toHaveLength(1)
  } finally { f.close() }
})

it('an accepted worker view remains identity evidence when the holder has not supplied a worker id', () => {
  const f = fixture('merge', true)
  try {
    const { workerId: _id, ...holder } = participantRecord(f.room, 'B')!.holder!
    f.room.participants.set('B\0holder', holder)
    f.slot.endpoints![1]!.workerId = 'predecessor'
    expect(f.room.acceptedWorkerViewOf('B')?.id).toBe('w')
    expect(conflictEndReason(f.room, f.slot)).toBe('replaced')
    f.room.workerViews.clear()
    expect(conflictEndReason(f.room, f.slot)).toBeUndefined()
  } finally { f.close() }
})

it.each(['starting', 'running', 'unknown', 'ambiguous', 'done', 'failed', 'stopped', 'collecting'] as const)(
  'raw own-worker display status only suppresses edit-in-claim delivery, without ending slots (%s)', status => {
    for (const kind of ['merge', 'edit-in-claim', 'claims', 'contract'] as const) {
      const f = fixture(kind, true)
      try {
        f.room.workerViews.set('w', { ...f.room.workerViews.get('w')!, status })
        expect(conflictEndReason(f.room, f.slot)).toBeUndefined()
        expect(openConflicts(f.room, 'A')).toHaveLength(kind === 'edit-in-claim' && status !== 'running' ? 0 : 1)
      } finally { f.close() }
    }
  },
)

it.each(['intent', 'declared'] as const)('a current explicit %s policy withdraws a contract grant', policy => {
  const f = fixture()
  try {
    const head = f.room.manifestHead.get('B')!
    if (policy === 'intent' || policy === 'declared') f.room.manifestHead.set('B', { ...head, level: policy })
    expect(conflictEndReason(f.room, f.slot)).toBe('grant-withdrawn')
    expect(openConflicts(f.room, 'A')).toEqual([])
  } finally { f.close() }
})

it('an excluded path is missing evidence, including normalized Unicode paths', () => {
  const f = fixture()
  try {
    f.slot.path = 'src/./café.py'
    f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, excluded: [digestPath(f.room.roomSalt!, 'src/café.py')] })
    expect(conflictEndReason(f.room, f.slot)).toBeUndefined()
  } finally { f.close() }
})

it('stale policy or held unreadable bytes are unknown; an explicit consumer grant narrowing is positive', () => {
  const f = fixture()
  try {
    const head = f.room.manifestHead.get('B')!
    f.room.manifestHead.set('B', { ...head, fence: 'old', level: 'intent' })
    expect(conflictEndReason(f.room, f.slot)).toBeUndefined()
    f.room.manifestHead.set('B', head)
    const entries = new Y.Map<import('./manifest.js').ManifestEntry>()
    entries.set('consumer.py', { state: 'held', held: 'binary', change: 'M', at: 1, fence: '1' })
    f.room.manifest.set(manifestKey('A', '1'), entries)
    expect(conflictEndReason(f.room, f.slot)).toBeUndefined()
    entries.set('consumer.py', { ...entries.get('consumer.py')!, held: 'scope' })
    expect(conflictEndReason(f.room, f.slot)).toBeUndefined()
    f.room.manifestHead.set('A', { ...f.room.manifestHead.get('A')!, level: 'declared', textPrefixes: [] })
    expect(conflictEndReason(f.room, f.slot)).toBe('grant-withdrawn')
  } finally { f.close() }
})

for (const kind of ['merge', 'edit-in-claim', 'claims', 'contract'] as const) it(`${kind}: only a persisted explicit sharing level can withdraw missing publication data`, () => {
  const f = fixture(kind)
  try {
    f.room.manifestHead.delete('B')
    const revisions = f.room.doc.getMap('completedPublicationRevisions')
    const revision = { name: 'B', epoch: 1, semRev: 10, rev: 10 }
    revisions.set('new-policy', revision)
    expect(conflictEndReason(f.room, f.slot)).toBeUndefined()
    revisions.set('new-policy', { ...revision, level: 'intent' })
    expect(conflictEndReason(f.room, f.slot)).toBe(kind === 'claims' ? undefined : 'grant-withdrawn')
    f.room.participants.delete('B\0holder')
    expect(conflictEndReason(f.room, f.slot)).toBeUndefined()
  } finally { f.close() }
})

it('snapshots keep only the already-published level alongside existing immutable revision coordinates', () => {
  const f = fixture(), restored = new RoomDoc()
  try {
    f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, level: 'intent', semRev: 2, rev: 2 })
    Y.applyUpdate(restored.doc, memorySnapshot(f.room.doc))
    const value = [...restored.doc.getMap<Record<string, unknown>>('completedPublicationRevisions').values()].find(row => row.name === 'B')!
    expect(value).toEqual({ name: 'B', epoch: 1, semRev: 2, rev: 2, level: 'intent' })
  } finally { restored.doc.destroy(); f.close() }
})

it('unreadable retained publication metadata is unknown and cannot block conflict cleanup', () => {
  const f = fixture()
  try {
    f.room.doc.getMap('completedPublications').set('damaged', { worker: { id: 'missing-fields' } })
    expect(conflictEndReason(f.room, f.slot)).toBeUndefined()
    expect(conflictEndReason(f.room, f.slot, { expiredParticipants: new Set(['B']) })).toBe('expired')
  } finally { f.close() }
})

it.each(['merge', 'edit-in-claim', 'claims', 'contract'] as const)('%s: a projection written under a superseded lead holder is not proof of replacement', kind => {
  const room = new RoomDoc(); room.ensureRoomSalt()
  try {
    epochPublication(room, 'A', 'a'.repeat(40), 1)
    epochPublication(room, 'L', 'a'.repeat(40), 2)
    const slot: ConflictSlot = { kind, owner: 'A', other: 'W', path: 'x', status: 'conflict', settled: 'conflict',
      inputs: 'i', factId: 'f', openId: 'opening', fence: '1', checkedAt: 1,
      endpoints: [{ name: 'A' }, { name: 'W', workerId: 'new-worker' }] }
    room.doc.getMap('conflicts').set('slot', slot)
    const project = (fence: string) => room.doc.transact(() => {
      room.participants.set('W\0id', { name: 'W', kind: 'agent' })
      room.participants.set('W\0proj', { projectedFrom: 'old-worker', projectedBy: 'L' })
      room.manifestHead.set('W', { ...room.manifestHead.get('A')!, projectedFrom: 'old-worker', projectedBy: 'L', fence, level: 'full' })
    })
    project('1')
    expect(conflictEndReason(room, slot)).toBeUndefined()
    expect(openConflicts(room, 'A')).toHaveLength(1)
    // The same projection under the lead's current holder is positive evidence.
    project('2')
    expect(conflictEndReason(room, slot)).toBe('replaced')
  } finally { room.doc.destroy() }
})

it.each(['merge', 'claims', 'edit-in-claim', 'contract'] as const)('%s: a former lead releasing a newer holder does not withdraw another lead\'s worker', kind => {
  const room = new RoomDoc(); room.ensureRoomSalt()
  try {
    for (const name of ['A', 'B', 'L', 'R']) epochPublication(room, name, 'a'.repeat(40), 2)
    room.participants.set('B\0proj', { projectedFrom: 'w', projectedBy: 'R' })
    room.manifestHead.set('B', { ...room.manifestHead.get('B')!, projectedFrom: 'w', projectedBy: 'R', level: 'full' })
    room.workerViews.set('w', { id: 'w', name: 'B', lead: 'L', tag: 'b', host: 'codex', mode: 'local', status: 'running', task: 't', branch: 'main', startedAt: 1, run: 1, fence: '1' })
    const slot: ConflictSlot = { kind, owner: 'A', other: 'B', path: 'x', status: 'conflict', settled: 'conflict',
      inputs: 'i', factId: 'f', openId: 'opening', endpoints: [{ name: 'A' }, { name: 'B', workerId: 'w' }], fence: '2', checkedAt: 1 }
    room.doc.getMap('conflicts').set('slot', slot)
    room.participants.set('L\0holder', { ...participantRecord(room, 'L')!.holder!, ended: 'released' })
    expect(conflictEndReason(room, slot)).toBeUndefined()
    expect(openConflicts(room, 'A')).toHaveLength(1)
    // The lead whose current holder wrote the projection does withdraw it.
    room.participants.set('R\0holder', { ...participantRecord(room, 'R')!.holder!, ended: 'released' })
    expect(conflictEndReason(room, slot)).toBe('withdrawn')
  } finally { room.doc.destroy() }
})
