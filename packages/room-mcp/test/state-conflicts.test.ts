import { afterEach, expect, it } from 'vitest'
import { RoomDoc, formatConflictLine, type ConflictKind, type ConflictSlot } from '@room/shared'
import { sessionConflicts } from '../src/tools/state-conflicts.js'
import type { Session } from '../src/session.js'

const created: RoomDoc[] = []
const session = (name = 'lead') => {
  const room = new RoomDoc()
  created.push(room)
  return { room, me: { name, kind: 'agent' } } as Session
}
const slot = (kind: ConflictKind, patch: Partial<ConflictSlot> = {}): ConflictSlot => ({
  kind, owner: 'lead', other: 'peer', path: 'a.ts', subject: kind === 'merge' ? undefined : 'subject',
  openId: 'opening', status: 'conflict', settled: 'conflict', inputs: '', factId: '', fence: '', checkedAt: 1,
  ...patch,
  endpoints: patch.endpoints ?? [{ name: patch.owner ?? 'lead' }, { name: patch.other ?? 'peer' }],
})
const put = (s: Session, key: string, value: ConflictSlot) => s.room.doc.getMap<ConflictSlot>('conflicts').set(key, value)
afterEach(() => { for (const room of created.splice(0)) room.doc.destroy() })

it('reads each room independently without combining their evidence', () => {
  const primary = session(), workers = session()
  put(primary, 'native', slot('merge', { path: 'a.ts' }))
  put(workers, 'native', slot('merge', { path: 'b.ts' }))
  const result = sessionConflicts([primary, workers])
  expect(result).toHaveLength(2)
  expect(result.map(value => value.conflict.slots.map(slot => slot.path))).toEqual([['a.ts'], ['b.ts']])
  expect(result.map(value => formatConflictLine(value.conflict))).toEqual([
    "[notify] CONFLICT: a.ts conflicts with peer's version", "[notify] CONFLICT: b.ts conflicts with peer's version",
  ])
})

it('keeps different openings and symbol subjects distinct', () => {
  const primary = session(), workers = session()
  put(primary, 'first', slot('merge'))
  put(workers, 'second', slot('merge', { openId: 'another-opening' }))
  for (const subject of ['first', 'second']) put(workers, 'contract-' + subject, slot('contract', { subject }))
  expect(sessionConflicts([primary, workers])).toHaveLength(4)
})

it('reads the participant identity used by each attached room', () => {
  const primary = session(), workers = session('local-lead')
  put(workers, 'mine', slot('contract', { owner: 'local-lead' }))
  put(workers, 'not-mine', slot('contract', { owner: 'someone-else' }))
  const result = sessionConflicts([primary, workers])
  expect(result).toHaveLength(1)
  expect(result[0].session).toBe(workers)
  expect(result[0].conflict.owner).toBe('local-lead')
})

it.each(['claims', 'contract'] as const)('keeps separate %s subjects with the same peer visible', kind => {
  const primary = session(), workers = session()
  put(primary, 'first', slot(kind, { subject: 'first' }))
  put(workers, 'second', slot(kind, { subject: 'second' }))
  expect(sessionConflicts([primary, workers])).toHaveLength(2)
})

it('keeps each room’s opening visible until that room clears it', () => {
  const primary = session(), workers = session()
  put(primary, 'native', slot('contract'))
  put(workers, 'copy', slot('contract'))
  expect(sessionConflicts([primary, workers])).toHaveLength(2)
  primary.room.doc.getMap('conflicts').delete('native')
  expect(sessionConflicts([primary, workers])).toHaveLength(1)
  expect(sessionConflicts([primary, workers])[0].session).toBe(workers)
  workers.room.doc.getMap('conflicts').delete('copy')
  expect(sessionConflicts([primary, workers])).toEqual([])
})
