import { describe, expect, it } from 'vitest'
import { RoomDoc } from './doc.js'
import type { RetiredWorker } from './types.js'

const record = (name = 'lead+worker', at = 1): RetiredWorker => ({
  name, tag: 'worker', lead: 'lead', host: 'codex', task: 'task', summary: 'done',
  files: ['a.ts'], fileCount: 1, startedAt: at, finishedAt: at + 1, retiredAt: at + 2, outcome: 'merged',
})

describe('worker retirement archive', () => {
  it('removes all live state in one transaction, releases claims, and frees the colour and name', () => {
    const room = new RoomDoc(), r = record()
    room.setWorker({ ...r, dir: '/repo', branch: 'room/worker', pid: 1, status: 'done' })
    room.setOverlay(r.name, 'a.ts', 'old')
    room.markDeleted(r.name, 'b.ts')
    room.setScope({ by: r.name, byKind: 'agent', area: 'test', summary: 'x', paths: ['a.ts'] })
    room.addClaim({ by: r.name, byKind: 'agent', path: 'a.ts', from: 1, to: 1, intent: 'change' })
    room.graphs.set(r.name, {} as never)
    room.setBaseOf(r.name, 'old')
    const slot = room.assignColor(r.name)
    room.setOverlay('teammate', 'a.ts', 'keep')
    let updates = 0
    room.doc.on('update', () => { updates++ })
    room.retireParticipant(r.name, r)
    expect(updates).toBe(1)
    expect(room.changedPaths(r.name)).toEqual([])
    for (const map of [room.overlays, room.deleted, room.overlayAt, room.scopes, room.graphs, room.colors, room.bases]) expect(map.has(r.name)).toBe(false)
    expect(room.openClaims()).toEqual([])
    expect(room.messages()).toMatchObject([{ type: 'release', summary: 'retired' }])
    expect(room.workerOf(r.name)).toBeUndefined()
    expect(room.text('a.ts', 'teammate')).toBe('keep')
    expect(room.retiredWorkers()).toEqual([r])
    expect(room.assignColor('new worker')).toBe(slot)
    room.retireParticipant(r.name, r)
    expect(room.retiredWorkers()).toHaveLength(1)
    room.doc.destroy()
  })

  it('caps archive fields and drops oldest entries beyond 200', () => {
    const room = new RoomDoc()
    const files = Array.from({ length: 70 }, (_, i) => `${i}.ts`)
    for (let i = 0; i < 201; i++) room.retireParticipant(`w${i}`, { ...record(`w${i}`, i), files, fileCount: 70, task: 't'.repeat(300), summary: 's'.repeat(500) })
    const records = room.retiredWorkers()
    expect(records).toHaveLength(200)
    expect(records[0].name).toBe('w1')
    expect(records[199]).toMatchObject({ task: 't'.repeat(200), summary: 's'.repeat(400), files: files.slice(0, 50), fileCount: 70 })
    room.doc.destroy()
  })

  it('does not let a stale retirement clear a reused name', () => {
    const room = new RoomDoc(), r = record()
    room.setWorker({ ...r, startedAt: 10, dir: '/repo', branch: 'room/worker', pid: 1, status: 'running' })
    room.setOverlay(r.name, 'new.ts', 'keep')
    room.retireParticipant(r.name, r)
    expect(room.changedPaths(r.name)).toEqual(['new.ts'])
    expect(room.retiredWorkers()).toEqual([])
    room.doc.destroy()
  })
})
