import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import { manifestKey } from './manifest.js'
import type { RetiredWorker, WorkerView } from './types.js'

const ignore = () => {}

const record = (id = 'w_old', name = 'lead+worker', at = 1): RetiredWorker & { id: string } => ({
  id, name, tag: 'worker', lead: 'lead', host: 'codex', task: 'task', summary: 'done',
  files: ['a.ts'], fileCount: 1, startedAt: at, finishedAt: at + 1, retiredAt: at + 2, outcome: 'merged',
})
const view = (id: string, name = 'lead+worker', startedAt = 1): WorkerView => ({
  id, tag: 'worker', name, lead: 'lead', mode: 'local', host: 'codex', task: 'task', branch: 'room/worker',
  status: 'done', run: 1, startedAt, fence: 'lead-session',
})
const holder = (workerId?: string) => ({ sessionId: 's', machine: 'm', pid: 1, startTime: 't', executable: 'e', ...(workerId ? { workerId } : {}) })

/** Live state under `name`, as its daemon or projector would have written it. */
function populate(room: RoomDoc, name: string): void {
  room.setOverlay(name, 'a.ts', 'old')
  room.setScope({ by: name, byKind: 'agent', area: 'test', summary: 'x', paths: ['a.ts'] })
  room.addClaim({ by: name, byKind: 'agent', path: 'a.ts', from: 1, to: 1, intent: 'change' })
  room.graphs.set(name, {} as never)
  room.setBaseOf(name, 'old')
  room.assignColor(name)
  room.participants.set(`${name}\u0000git`, { branch: 'b', head: 'h', base: 'h', anchored: true, rev: 1, fence: 'f' })
  room.manifestHead.set(name, { base: 'h', fence: 'f', coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })
  const entries = new Y.Map()
  room.manifest.set(manifestKey(name, 'f'), entries as never)
  entries.set('a.ts', { change: 'M', state: 'held', held: 'worker', at: 1, fence: 'f' })
  room.markSeen(name, ['m1'], { s: 's', via: 'mcp' } as never)
}
const live = (room: RoomDoc, name: string) => ({
  claims: room.openClaims().filter(c => c.by === name).length, scope: !!room.scope(name), head: room.manifestHead.has(name),
  manifest: [...room.manifest.keys()].some(k => k.startsWith(`${name}\u0000`)), git: room.participants.has(`${name}\u0000git`),
  overlay: room.overlays.has(name), graph: room.graphs.has(name),
})

describe('retireWorker(id): retirement keyed by worker ID (registry §12)', () => {
  it('removes all live state under the name in one transaction, releases claims, and archives once per id', () => {
    const room = new RoomDoc(), r = record()
    room.workerViews.set(r.id, view(r.id))
    room.participants.set(`${r.name}\u0000holder`, holder(r.id))
    populate(room, r.name)
    const slot = room.colors.get(r.name)
    room.setOverlay('teammate', 'a.ts', 'keep')
    let updates = 0
    room.doc.on('update', () => { updates++ })
    const releases: unknown[] = []
    room.retireWorker(r.id, r, (from, body) => { releases.push({ from, body }) })
    expect(updates).toBe(1)
    expect(live(room, r.name)).toEqual({ claims: 0, scope: false, head: false, manifest: false, git: false, overlay: false, graph: false })
    expect([...room.participants.keys()].filter(k => k.startsWith(`${r.name}\u0000`))).toEqual([])
    for (const map of [room.colors, room.bases]) expect(map.has(r.name)).toBe(false)
    expect(room.seen(r.name).size).toBe(0)
    expect(releases).toMatchObject([{ from: { name: r.name }, body: { type: 'release', summary: 'retired' } }])
    expect(room.workerViews.has(r.id)).toBe(false)
    expect(room.text('a.ts', 'teammate')).toBe('keep')
    expect(room.retiredWorkers()).toEqual([r])
    expect(room.assignColor('new worker')).toBe(slot)
    room.retireWorker(r.id, r, ignore)
    expect(room.retiredWorkers()).toHaveLength(1)
    room.doc.destroy()
  })

  it('caps archive fields and drops oldest entries beyond 200', () => {
    const room = new RoomDoc()
    const files = Array.from({ length: 70 }, (_, i) => `${i}.ts`)
    for (let i = 0; i < 201; i++) room.retireWorker(`w_${i}`, { ...record(`w_${i}`, `w${i}`, i), files, fileCount: 70, task: 't'.repeat(300), summary: 's'.repeat(500) }, ignore)
    const records = room.retiredWorkers()
    expect(records).toHaveLength(200)
    expect(records[0].name).toBe('w1')
    expect(records[199]).toMatchObject({ task: 't'.repeat(200), summary: 's'.repeat(400), files: files.slice(0, 50), fileCount: 70 })
    room.doc.destroy()
  })

  it('never touches a newer worker spawned under the same tag', () => {
    const room = new RoomDoc(), old = record('w_old')
    room.workerViews.set(old.id, view(old.id))
    room.workerViews.set('w_new', view('w_new', old.name, 10))
    room.participants.set(`${old.name}\u0000holder`, holder('w_new'))
    populate(room, old.name)
    room.retireWorker(old.id, old, ignore)
    expect(live(room, old.name)).toEqual({ claims: 1, scope: true, head: true, manifest: true, git: true, overlay: true, graph: true })
    expect(room.workerViews.has('w_new')).toBe(true)
    expect(room.workerViews.has(old.id)).toBe(false)
    expect(room.retiredWorkers().map(r => r.id)).toEqual([old.id])
    room.doc.destroy()
  })

  it('without a holder, a newer worker view under the name keeps the name live', () => {
    const room = new RoomDoc(), old = record('w_old')
    room.workerViews.set('w_new', view('w_new', old.name, 10))
    populate(room, old.name)
    room.retireWorker(old.id, old, ignore)
    expect(live(room, old.name).claims).toBe(1)
    expect(room.retiredWorkers()).toHaveLength(1)
    room.doc.destroy()
  })

  it('keeps a standalone participant that reused the name (holder without this worker id)', () => {
    const room = new RoomDoc(), old = record('w_old')
    room.participants.set(`${old.name}\u0000holder`, holder())
    populate(room, old.name)
    room.retireWorker(old.id, old, ignore)
    expect(live(room, old.name)).toMatchObject({ claims: 1, scope: true, head: true })
    room.doc.destroy()
  })

  it('a team projection is removed only for the worker it is projected from', () => {
    const room = new RoomDoc(), old = record('w_old')
    room.participants.set(`${old.name}\u0000proj`, { projectedFrom: 'w_new', projectedBy: 'lead' })
    populate(room, old.name)
    room.retireWorker(old.id, old, ignore)
    expect(live(room, old.name).head).toBe(true)
    room.participants.set(`${old.name}\u0000proj`, { projectedFrom: old.id, projectedBy: 'lead' })
    room.retireWorker(old.id, old, ignore)
    expect(live(room, old.name)).toMatchObject({ head: false, manifest: false, git: false, claims: 0 })
    expect(room.participants.has(`${old.name}\u0000proj`)).toBe(false)
    room.doc.destroy()
  })
})
