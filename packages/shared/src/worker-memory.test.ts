import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, participantRecord } from './doc.js'
import { memorySnapshot } from './memory.js'
import { manifestChangers, manifestHeadOf, manifestKey, manifestNames, manifestPaths, snapshot, snapshotPath, snapshotStillCurrent, versionOf, type ManifestEntry } from './manifest.js'
import { gitBlobHash } from './manifest-node.js'
import { participantsView } from './views.js'
import type { CompletedPublication } from './worker-memory.js'
import type { WorkerView } from './types.js'

const docs: Y.Doc[] = []
afterEach(() => { for (const doc of docs.splice(0)) doc.destroy() })
const room = () => { const r = new RoomDoc(); docs.push(r.doc); return r }
const cache = (r: RoomDoc) => r.doc.getMap<CompletedPublication>('completedPublications')
function project(r: RoomDoc, worker: WorkerView, epoch = 100) {
  r.participants.set('lead\0holder', { sessionId: `lead-${epoch}`, epoch, pid: 1, startTime: 't', executable: 'codex', at: 1 })
  r.workerViews.set(worker.id, { ...worker, fence: String(epoch) })
}
function fixture() {
  const r = room(), name = 'lead+worker', key = manifestKey(name, '1')
  r.doc.clientID = 1 // Snapshot identities must outrank originals in merge regressions.
  r.ensureRoomSalt()
  const worker: WorkerView = { id: 'w1', name, lead: 'lead', tag: 'worker', mode: 'here', host: 'codex', task: 'test', branch: 'worker', status: 'done', run: 1, startedAt: 1, finishedAt: 2, fence: '100' }
  project(r, worker)
  r.participants.set(`${name}\0holder`, { workerId: 'w1', sessionId: 's1', epoch: 1, pid: 1, startTime: 't', executable: 'codex', at: 1, ended: 'released' })
  r.participants.set(`${name}\0git`, { base: 'base', head: 'base', fence: '1', rev: 1 })
  r.manifestHead.set(name, { base: 'base', fence: '1', coverage: { kind: 'all' }, level: 'declared', excluded: [], complete: true, rev: 1, semRev: 1, scannedAt: 2 })
  const entries = new Y.Map<ManifestEntry>()
  r.manifest.set(key, entries)
  entries.set('app.py', { change: 'M', state: 'shared', hash: gitBlobHash('x = 42\n'), fence: '1', at: 2 })
  entries.set('secret.py', { change: 'M', state: 'held', held: 'scope', fence: '1', at: 2 })
  r.setOverlay(key, 'app.py', 'x = 42\n')
  r.setBaseText(name, 'base', 'app.py', 'x = 1\n')
  return { r, name, key, worker }
}
function restore(source: RoomDoc, maxBytes?: number) {
  const wire = new Y.Doc(); docs.push(wire)
  Y.applyUpdate(wire, Y.encodeStateAsUpdate(source.doc))
  const next = room(), log = vi.fn()
  const update = memorySnapshot(wire, { maxBytes, log })
  Y.applyUpdate(next.doc, update)
  return { next, log, size: update.byteLength }
}

it('keeps a cold cache dormant until the live lead reprojects the matching completed worker', async () => {
  const { r, name, worker } = fixture()
  const { next } = restore(r)
  expect(cache(next).size).toBe(1)
  for (const map of [next.participants, next.workerViews, next.manifestHead, next.manifest, next.overlays, next.ownedBaseTexts]) expect(map.size).toBe(0)
  expect(snapshot(next, name, [])).toBeUndefined()
  expect(manifestPaths(next, name)).toEqual([])
  expect(next.baseText(name, 'base', 'app.py')).toBeUndefined()
  project(next, worker)
  expect(await versionOf(snapshot(next, name, []), 'app.py')).toMatchObject({ kind: 'text', text: 'x = 42\n' })
  expect(await versionOf(snapshotPath(next, name, [], 'secret.py'), 'secret.py')).toMatchObject({ kind: 'held' })
  expect(manifestPaths(next, name)).toEqual(['app.py', 'secret.py'])
  expect(manifestChangers(next, 'app.py')).toEqual([name])
  expect(manifestNames(next)).toEqual([name])
  expect(participantsView(next, { getStates: () => new Map() }, Date.now())).toContainEqual(expect.objectContaining({ name, fresh: false, visible: true }))
  expect(manifestHeadOf(next, name)?.base).toBe('base')
  expect(next.manifestHead.size).toBe(0)
})

it('retains a dormant cache through repeated cold restarts and requires a fresh projection each time', async () => {
  const { r, name, worker } = fixture()
  let current = r
  for (let epoch = 101; epoch <= 103; epoch++) {
    current = restore(current).next
    expect(snapshot(current, name, [])).toBeUndefined()
    project(current, worker, epoch)
    expect(await versionOf(snapshot(current, name, []), 'app.py')).toMatchObject({ kind: 'text', text: 'x = 42\n' })
    expect(current.baseText(name, 'base', 'app.py')).toBe('x = 1\n')
  }
})

it.each(['missing lead', 'ended lead', 'stale lead fence', 'running', 'new run', 'reused name', 'new holder epoch'])('rejects cached reads with %s authority', kind => {
  const { r, name, worker } = fixture()
  const { next } = restore(r)
  project(next, worker)
  const before = snapshot(next, name, [])!
  expect(before).toBeDefined()
  if (kind === 'missing lead') next.participants.delete('lead\0holder')
  if (kind === 'ended lead') next.participants.set('lead\0holder', { ...participantRecord(next, 'lead')!.holder!, ended: 'released' })
  if (kind === 'stale lead fence') next.participants.set('lead\0holder', { ...participantRecord(next, 'lead')!.holder!, epoch: 101 })
  if (kind === 'running') project(next, { ...worker, status: 'running' })
  if (kind === 'new run') project(next, { ...worker, run: 2 })
  if (kind === 'reused name' || kind === 'new holder epoch') next.participants.set(`${name}\0holder`, {
    ...participantRecord(r, name)!.holder!, ...(kind === 'reused name' ? { workerId: 'w2' } : { epoch: 2 }),
  })
  expect(snapshot(next, name, [])).toBeUndefined()
  expect(next.baseText(name, 'base', 'app.py')).toBeUndefined()
  expect(snapshotStillCurrent(next, before, [])).toBe(false)
})

it.each(['source first', 'cache first'])('does not resurrect retired publications when stale replicas merge (%s)', order => {
  const { r, name, worker } = fixture()
  const { next } = restore(r)
  r.retireWorker(worker.id, { id: worker.id, name, lead: worker.lead, tag: worker.tag, host: worker.host,
    task: worker.task, files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'merged', summary: 'collected' }, () => {})
  const first = order === 'source first' ? r : next, second = first === r ? next : r
  Y.applyUpdate(second.doc, Y.encodeStateAsUpdate(first.doc))
  Y.applyUpdate(first.doc, Y.encodeStateAsUpdate(second.doc))
  for (const merged of [r, next]) {
    expect(merged.manifestHead.has(name)).toBe(false)
    expect(merged.overlays.size).toBe(0)
    expect(merged.workerViews.has(worker.id)).toBe(false)
    expect(snapshot(merged, name, [])).toBeUndefined()
    expect(cache(restore(merged).next).size).toBe(0)
    // Bounded display history is not the source of authority: even after it is
    // trimmed, the old cache alone cannot recreate a current lead projection.
    const history = merged.doc.getArray('retiredWorkers')
    history.delete(0, history.length)
    expect(snapshot(merged, name, [])).toBeUndefined()
  }
})

it.each(['withdrawn', 'incomplete', 'narrowed'])('gives a live %s head precedence over cached text', async kind => {
  const { r, name, key, worker } = fixture()
  const { next } = restore(r)
  project(next, worker)
  const before = snapshot(next, name, [])!
  next.participants.set(`${name}\0holder`, participantRecord(r, name)!.holder!)
  next.participants.set(`${name}\0git`, participantRecord(r, name)!.git!)
  const head = { ...r.manifestHead.get(name)!, rev: 2, semRev: 2 }
  if (kind === 'withdrawn') head.coverage = { kind: 'none', reason: 'not-publisher' }
  if (kind === 'incomplete') head.complete = false
  next.manifestHead.set(name, head)
  const entries = new Y.Map<ManifestEntry>()
  next.manifest.set(key, entries)
  if (kind === 'narrowed') entries.set('app.py', { change: 'M', state: 'held', held: 'scope', fence: '1', at: 3 })
  const live = snapshot(next, name, [])!
  expect(live.retained).toBeUndefined()
  expect(snapshotStillCurrent(next, before, [])).toBe(false)
  expect(await versionOf(live, 'app.py')).toMatchObject(kind === 'narrowed' ? { kind: 'held' }
    : { kind: 'unknown', why: kind === 'withdrawn' ? 'not-publisher' : 'updating' })
  const cold = restore(next).next
  project(cold, worker)
  expect(await versionOf(snapshot(cold, name, []), 'app.py')).not.toMatchObject({ kind: 'text' })
})

it.each(['withdrawn', 'incomplete', 'narrowed', 'intent'])('does not revive old cached text after a %s policy survives a cold restart', async kind => {
  const { r, name, worker } = fixture()
  const stale = restore(r).next
  const head = r.manifestHead.get(name)!
  // Incomplete/intent policy transitions can advance semRev without changing rev.
  r.manifestHead.set(name, { ...head, semRev: head.semRev + 1,
    ...(kind === 'incomplete' ? { complete: false } : kind === 'intent' ? { level: 'intent' as const }
      : { coverage: { kind: 'none' as const, reason: 'not-publisher' as const } }) })
  if (kind === 'narrowed') {
    r.manifestHead.set(name, { ...head, rev: head.rev + 1, semRev: head.semRev + 1 })
    r.manifest.get(manifestKey(name, head.fence))!.set('app.py', { change: 'M', state: 'held', held: 'scope', fence: head.fence, at: 3 })
  }
  const cold = restore(r, kind === 'narrowed' ? 400 : undefined).next
  project(cold, worker, 101)
  Y.applyUpdate(cold.doc, Y.encodeStateAsUpdate(stale.doc))
  Y.applyUpdate(stale.doc, Y.encodeStateAsUpdate(cold.doc))
  for (const merged of [cold, stale]) {
    expect(await versionOf(snapshot(merged, name, []), 'app.py')).not.toMatchObject({ kind: 'text' })
    expect(merged.baseText(name, 'base', 'app.py')).toBeUndefined()
    const again = restore(merged).next
    project(again, worker, 102)
    expect(await versionOf(snapshot(again, name, []), 'app.py')).not.toMatchObject({ kind: 'text' })
  }
})

it('keeps revision denials when a stale live head arrives before the next save', async () => {
  const { r, name } = fixture()
  const oldLive = Y.encodeStateAsUpdate(r.doc)
  const livePeer = room()
  Y.applyUpdate(livePeer.doc, oldLive)
  const before = snapshot(livePeer, name, [])!
  const head = r.manifestHead.get(name)!
  r.manifestHead.set(name, { ...head, level: 'intent', semRev: head.semRev + 1 })
  const cold = restore(r).next
  Y.applyUpdate(livePeer.doc, Y.encodeStateAsUpdate(cold.doc))
  expect(snapshotStillCurrent(livePeer, before, [])).toBe(false)
  Y.applyUpdate(cold.doc, oldLive)
  expect(cold.manifestHead.get(name)?.level).toBe('declared')
  expect(await versionOf(snapshot(cold, name, []), 'app.py')).toMatchObject({ kind: 'unknown', why: 'updating' })
  expect(await versionOf(snapshotPath(cold, name, [], 'app.py'), 'app.py')).toMatchObject({ kind: 'unknown', why: 'updating' })
  expect(cold.baseText(name, 'base', 'app.py')).toBeUndefined()
  const saved = restore(cold).next
  expect(cache(saved).size).toBe(0)
  expect([...saved.doc.getMap('completedPublicationRevisions').values()]).toEqual([
    { name, epoch: 1, semRev: 2, rev: 1 },
  ])
})

it('retains a newer holder boundary after cold restart even before that holder publishes', async () => {
  const { r, name, worker } = fixture()
  const stale = restore(r).next
  r.participants.set(`${name}\0holder`, { ...participantRecord(r, name)!.holder!, epoch: 2, workerId: 'w2' })
  const cold = restore(r).next
  project(cold, worker)
  Y.applyUpdate(cold.doc, Y.encodeStateAsUpdate(stale.doc))
  expect(await versionOf(snapshot(cold, name, []), 'app.py')).not.toMatchObject({ kind: 'text' })
  expect(cache(restore(cold).next).size).toBe(0)
})

it('compacts immutable revision markers to the latest per name on every save', () => {
  const { r, name } = fixture()
  const merged = room()
  for (let semRev = 1; semRev <= 4; semRev++) {
    r.manifestHead.set(name, { ...r.manifestHead.get(name)!, semRev })
    Y.applyUpdate(merged.doc, Y.encodeStateAsUpdate(restore(r).next.doc))
  }
  expect(merged.doc.getMap('completedPublicationRevisions').size).toBe(4)
  const saved = restore(merged).next
  expect([...saved.doc.getMap('completedPublicationRevisions').values()]).toEqual([
    { name, epoch: 1, semRev: 4, rev: 1 },
  ])
  expect([...cache(saved).values()].map(p => p.head.semRev)).toEqual([4])
})

it('treats shedding unchanged text for budget as eviction rather than policy revocation', async () => {
  const { r, name, worker } = fixture()
  const stale = restore(r).next
  const cold = restore(r, 400).next
  expect(cache(cold).size).toBe(0)
  expect(cold.doc.getMap('completedPublicationRevisions').size).toBe(1)
  project(cold, worker)
  Y.applyUpdate(cold.doc, Y.encodeStateAsUpdate(stale.doc))
  expect(await versionOf(snapshot(cold, name, []), 'app.py')).toMatchObject({ kind: 'text', text: 'x = 42\n' })
})

it.each(['running', 'reused name', 'incomplete', 'withdrawn', 'intent', 'retired'])('does not initially retain %s publications', kind => {
  const { r, name, worker } = fixture()
  const head = r.manifestHead.get(name)!
  if (kind === 'running') project(r, { ...worker, status: 'running' })
  if (kind === 'reused name') r.participants.set(`${name}\0holder`, { ...participantRecord(r, name)!.holder!, workerId: 'w2' })
  if (kind === 'incomplete') r.manifestHead.set(name, { ...head, complete: false })
  if (kind === 'withdrawn') r.manifestHead.set(name, { ...head, coverage: { kind: 'none', reason: 'not-publisher' } })
  if (kind === 'intent') r.manifestHead.set(name, { ...head, level: 'intent' })
  if (kind === 'retired') r.workerViews.delete(worker.id)
  expect(cache(restore(r).next).size).toBe(0)
})

it('omits held, orphan, deleted and old-fence text from the persisted cache', () => {
  const { r, name, key, worker } = fixture()
  r.setOverlay(key, 'secret.py', 'held-secret-marker')
  r.setOverlay(key, 'orphan.py', 'orphan-secret-marker')
  r.manifest.get(key)!.set('gone.py', { change: 'D', state: 'shared', hash: 'old', fence: '1', at: 2 })
  r.setOverlay(key, 'gone.py', 'deleted-secret-marker')
  r.manifest.get(key)!.set('old.py', { change: 'M', state: 'shared', hash: 'old', fence: '0', at: 2 })
  r.setOverlay(key, 'old.py', 'old-fence-secret-marker')
  r.setBaseText(name, 'base', 'secret.py', 'held-base-secret-marker')
  r.setBaseText(name, 'base', 'orphan.py', 'orphan-base-secret-marker')
  r.setBaseText(name, 'older-base', 'app.py', 'old-base-secret-marker')
  const { next } = restore(r)
  const publication = [...cache(next).values()][0]
  expect(publication.worker.id).toBe(worker.id)
  expect(publication.texts).toEqual([['app.py', 'x = 42\n']])
  expect(publication.baseTexts).toEqual([['app.py', 'x = 1\n']])
  expect(publication.entries.map(([path]) => path)).toEqual(['app.py', 'secret.py', 'gone.py'])
  expect(JSON.stringify(publication)).not.toContain('secret-marker')
})

it('drops a whole publication before coordination when the snapshot budget is exceeded', () => {
  const { r, key } = fixture()
  r.setOverlay(key, 'app.py', 'x'.repeat(10_000))
  r.mail.set('q1', { id: 'q1', to: 'lead', text: 'owed' } as never)
  const { next, log, size } = restore(r, 2_000)
  expect(cache(next).size).toBe(0)
  expect(next.mail.has('q1')).toBe(true)
  expect(size).toBeLessThan(2_000)
  expect(log).toHaveBeenCalledWith(expect.stringContaining('dropped 1 completed worker publications'))
})
