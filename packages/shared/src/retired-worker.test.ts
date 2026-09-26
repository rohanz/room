import { expect, it } from 'vitest'
import { RoomDoc } from './doc.js'
import type { RetiredWorker } from './types.js'

it('clears legacy worker claims and overlays even when retirement archive already exists', () => {
  const room = new RoomDoc()
  const record: RetiredWorker = { name: 'lead+old', tag: 'old', lead: 'lead', host: 'codex', task: 'task', summary: '', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'clean' }
  room.retireParticipant(record.name, record)
  room.claims.set('c1', { id: 'c1', by: record.name, byKind: 'agent', path: 'old.ts', from: 1, to: 2, intent: 'old', at: 1 })
  room.setOverlay(record.name, 'old.ts', 'ghost')
  room.workers.set(record.tag, { tag: record.tag, name: record.name, lead: record.lead, host: record.host, task: record.task, dir: '/tmp/gone', branch: 'room/old', pid: -1, startedAt: record.startedAt, status: 'done' })
  room.retireParticipant(record.name, record)
  expect(room.openClaims()).toEqual([])
  expect(room.changedPaths(record.name)).toEqual([])
  expect(room.workers.has(record.tag)).toBe(false)
})

it('clears predecessor coordination when a worker tag is replaced', () => {
  const room = new RoomDoc()
  const worker = { tag: 'old', name: 'lead+old', lead: 'lead', host: 'codex', task: 'task', dir: '/tmp/old', branch: 'room/old', pid: 1, startedAt: 1, status: 'failed', gen: 1 }
  room.setWorker(worker as Parameters<typeof room.setWorker>[0])
  room.claims.set('c1', { id: 'c1', by: worker.name, byKind: 'agent', path: 'old.ts', from: 1, to: 2, intent: 'old', at: 1 })
  room.setOverlay(worker.name, 'old.ts', 'ghost')
  room.setWorker({ ...worker, startedAt: 2, gen: 2 } as Parameters<typeof room.setWorker>[0])
  expect(room.openClaims()).toEqual([])
  expect(room.changedPaths(worker.name)).toEqual([])
})

it('sweeps legacy archived records without git or process checks', () => {
  const room = new RoomDoc()
  const record: RetiredWorker = { name: 'lead+old', tag: 'old', lead: 'lead', host: 'codex', task: 'task', summary: '', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'clean' }
  room.retireParticipant(record.name, record)
  room.workers.set(record.tag, { tag: record.tag, name: record.name, lead: record.lead, host: record.host, task: record.task, dir: '/missing', branch: 'room/old', pid: -1, startedAt: 1, status: 'done' })
  room.setOverlay(record.name, 'old.ts', 'ghost')
  for (const { worker, record } of room.legacyRetirements()) room.retireParticipant(worker.name, record)
  expect(room.workers.size).toBe(0)
  expect(room.changedPaths(record.name)).toEqual([])
})

it('does not clear a currently active participant who reused an archived name', () => {
  const room = new RoomDoc()
  const record: RetiredWorker = { name: 'lead+old', tag: 'old', lead: 'lead', host: 'codex', task: 'task', summary: '', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'clean' }
  room.retireParticipant(record.name, record)
  room.setOverlay(record.name, 'new.ts', 'new work')
  expect(room.legacyRetirements(new Set([record.name]))).toEqual([])
  expect(room.changedPaths(record.name)).toEqual(['new.ts'])
})

it('keeps a newer standalone participant’s state after it disconnects with an archived worker name', () => {
  const room = new RoomDoc()
  const record: RetiredWorker = { name: 'lead+codex', tag: 'codex', lead: 'lead', host: 'codex', task: 'old task', summary: '', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'clean' }
  room.retireParticipant(record.name, record)
  room.setOverlay(record.name, 'new.ts', 'new work')
  room.setScope({ by: record.name, byKind: 'agent', area: 'new', summary: 'new session', paths: ['new.ts'] })
  room.addClaim({ path: 'new.ts', from: 1, to: 1, by: record.name, byKind: 'agent', intent: 'new work' })
  room.setBaseOf(record.name, 'new-base')
  expect(room.legacyRetirements(new Set())).toEqual([])
  expect(room.changedPaths(record.name)).toEqual(['new.ts'])
  expect(room.scope(record.name)?.area).toBe('new')
  expect(room.openClaims().map(c => c.by)).toEqual([record.name])
  expect(room.baseOf(record.name)).toBe('new-base')
})

it('leaves reused-name state when worker records disagree about its generation', () => {
  const room = new RoomDoc()
  const record: RetiredWorker = { name: 'lead+codex', tag: 'codex', lead: 'lead', host: 'codex', task: 'old', summary: '', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'clean' }
  room.retireParticipant(record.name, record)
  room.workers.set('codex', { tag: 'codex', name: record.name, lead: record.lead, host: 'codex', task: 'old', dir: '/old', branch: 'old', pid: -1, startedAt: 1, status: 'done' })
  room.workers.set('new', { tag: 'new', name: record.name, lead: record.lead, host: 'codex', task: 'new', dir: '/new', branch: 'new', pid: -1, startedAt: 4, status: 'running' })
  room.setOverlay(record.name, 'new.ts', 'new work')
  expect(room.legacyRetirements()).toEqual([])
  expect(room.changedPaths(record.name)).toEqual(['new.ts'])
})
