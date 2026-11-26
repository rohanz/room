import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, gitBlobHash, manifestKey, openConflicts, participantRecord, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { Bridge } from '../src/bridge.js'
import { ConflictSet } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import { projectWorkers } from '../src/worker-projector.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { slotKey } from '../src/conflict-set.js'
import { seedRegistryWorker, finishWorker } from './registry-fixture.js'
import { hubSeam } from './fixtures/hub.js'
import { Ledger } from '../src/ledger.js'
import { WakeReconciler } from '../src/wake-reconciler.js'

const stops: (() => unknown)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const stop of stops.splice(0).reverse()) await stop() })

async function setup(names = ['L+a', 'L+b']) {
  const dir = mkdtempSync(join(tmpdir(), 'room-bridge-family-'))
  stops.push(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.email', 'review@example.com'); git('config', 'user.name', 'review')
  writeFileSync(join(dir, 'x'), 'base\n'); git('add', 'x'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const registry = await registryForDir(dir)
  stops.push(() => closeRegistryForDir(dir))
  const teamRoom = new RoomDoc(), localRoom = new RoomDoc()
  stops.push(() => teamRoom.doc.destroy(), () => localRoom.doc.destroy())
  function session(room: RoomDoc, name: string, roomName: string): Session {
    const awareness = new Awareness(new Y.Doc())
    const me = { name, kind: 'agent' as const, owner: 'L' }
    awareness.setLocalState({ user: me, sessionId: `session-${name}` })
    const seam = hubSeam(room)
    stops.push(() => { seam.hub.close(); awareness.destroy(); awareness.doc.destroy() })
    return { ...seam, room, awareness, me, dir, roomName, lease: { fence: () => '1' },
      daemon: { fence: '1' }, provider: { synced: true } } as unknown as Session
  }
  const team = session(teamRoom, 'L', 'team/review'), local = session(localRoom, 'L', 'local/review')
  function publish(room: RoomDoc, name: string, text?: string, workerId?: string, projected = false) {
    epochPublication(room, name, base, 1)
    room.participants.set(`${name}\0id`, { name, kind: 'agent', owner: 'L' })
    room.ensureRoomSalt()
    room.participants.set(`${name}\0holder`, { sessionId: `session-${name}`, epoch: 1, ...(workerId ? { workerId } : {}) })
    const entries = new Y.Map<ManifestEntry>()
    if (text !== undefined) entries.set('x', { change: 'M', state: projected ? 'held' : 'shared',
      ...(projected ? { held: 'worker' as const } : {}), hash: gitBlobHash(text), fence: '1', at: 1 })
    room.manifest.set(manifestKey(name, '1'), entries)
    if (text !== undefined && !projected) room.setOverlay(manifestKey(name, '1'), 'x', text)
    room.manifestHead.set(name, { base, fence: '1', coverage: { kind: 'all' }, complete: true,
      level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: Date.now(),
      ...(projected ? { projectedFrom: workerId, projectedBy: 'L' } : {}) })
    if (projected) {
      room.participants.delete(`${name}\0holder`)
      room.participants.set(`${name}\0proj`, { projectedFrom: workerId, projectedBy: 'L' })
    }
  }
  publish(teamRoom, 'L'); publish(localRoom, 'L')
  const records = []
  for (const [index, [tag, text]] of [['a', 'alpha\n'], ['b', 'beta\n']].entries()) {
    const { record } = await seedRegistryWorker(dir, tag, { name: names[index], base, carriedBase: base,
      room: local.roomName, projectedInto: team.roomName, lead: { participant: 'L', room: local.roomName, instance: registry.instance } })
    records.push(record)
    git('worktree', 'add', '-q', '-b', record.branch, record.dir, base)
    writeFileSync(join(record.dir, 'x'), text)
    publish(localRoom, record.name, text, record.id)
    publish(teamRoom, record.name, text, record.id, true)
    for (const room of [localRoom, teamRoom]) room.workerViews.set(record.id, {
      id: record.id, name: record.name, lead: 'L', tag, mode: 'local', host: 'codex',
      task: 'review', branch: record.branch, status: 'running', run: 1, startedAt: record.createdAt, fence: '1',
    })
  }
  function checker(s: Session, owner = s.me.name, notices = s) {
    const set = new ConflictSet(s, owner, notices, () => {}, 0)
    stops.push(() => set.stop())
    return set
  }
  const conflicts = (name: string) => openConflicts(localRoom, name).filter(c => c.kind === 'merge')
  return { dir, team, local, records, registry, checker, conflicts, session, publish }
}

it('does not duplicate a same-lead worker pair already checked in the private room', async () => {
  const t = await setup(), [a] = t.records
  const ordinary = t.checker(t.session(t.local.room, a.name, t.local.roomName))
  await ordinary.reconcile('ordinary local worker comparison')
  expect(t.conflicts(a.name)).toHaveLength(1)
  await t.checker(t.team, a.name, t.local).reconcile('projected comparison of the same pair')
  expect(t.conflicts(a.name)).toHaveLength(1)
})

it('tells both sibling workers once and never publishes their private conflict in the team room', async () => {
  const t = await setup(), wakes = new Map<string, string[]>()
  const bridge = new Bridge(t.team, t.local, { registry: t.registry })
  bridge.start(); stops.push(() => bridge.stop())
  for (const record of t.records) {
    const s = t.session(t.local.room, record.name, t.local.roomName)
    const ledger = new Ledger({ sessionId: () => `session-${record.name}`, route: () => ({}) })
    ledger.bind(s)
    const sends: string[] = []; wakes.set(record.name, sends)
    const wake = new WakeReconciler({ ledger, bound: () => ({ id: `session-${record.name}`, host: 'codex' }),
      sessionDir: () => undefined, windowMs: 0, turnProbe: { busy: async () => false },
      send: async (_target, text) => { sends.push(text); return 'queue' } })
    wake.attach(s); stops.push(() => wake.stop())
    const checker = t.checker(s)
    await checker.reconcile('private sibling conflict')
    await checker.reconcile('unchanged private sibling conflict')
  }
  await vi.waitFor(() => { for (const sends of wakes.values()) expect(sends).toHaveLength(1) })
  for (const record of t.records) {
    expect(t.conflicts(record.name)).toHaveLength(1)
    await t.checker(t.team, record.name, t.local).reconcile('projected family comparison')
  }
  await bridge.sync()
  expect(t.local.room.messages().filter(message => message.type === 'note' && message.text?.startsWith('[team room]'))).toEqual([])
  expect(t.team.room.doc.getMap('conflicts').size).toBe(0)
  expect(t.team.room.messages().filter(m => ['merge-conflict', 'conflict', 'contract'].includes(m.type))).toEqual([])
  await finishWorker(t.local, t.records[1].tag)
  await t.registry.beginRetirement(t.records[1].id, await t.registry.archiveOf(t.records[1], { summary: 'collected' }))
  await projectWorkers(t.local, t.registry, 'L', 'joined')
  expect(t.conflicts(t.records[0].name)).toEqual([])
})

it('creates no sibling projection copies to leave owed after either worker retires', async () => {
  const t = await setup(), [a, b] = t.records
  for (const worker of [a, b]) await t.checker(t.team, worker.name, t.local).reconcile('same-lead projections')
  expect(t.conflicts('L')).toEqual([])
  await finishWorker(t.local, b.tag)
  await t.registry.beginRetirement(b.id, await t.registry.archiveOf(b, { summary: 'collected' }))
  await projectWorkers(t.local, t.registry, 'L', 'joined')
  const pending = openConflicts(t.local.room, t.local.me.name)
  expect(pending).toEqual([])
})

it('keeps a projected owner out of the ordinary lead comparison in the team room', async () => {
  const t = await setup()
  t.publish(t.team.room, 'L', 'lead edit\n')
  await t.checker(t.team).reconcile('lead and own projected worker')
  expect(openConflicts(t.team.room, 'L')).toEqual([])
})


it('compares a lead and its own local workers exactly only in their private room', async () => {
  const t = await setup()
  t.publish(t.local.room, 'L', 'lead edit\n')
  t.publish(t.team.room, 'L', 'lead edit\n')
  await t.checker(t.local).reconcile('private lead and workers')
  expect(t.conflicts('L')).toHaveLength(2)
  expect(t.conflicts('L').every(m => m.priority === 'notify')).toBe(true)
  await t.checker(t.team).reconcile('team lead and workers')
  expect(openConflicts(t.team.room)).toEqual([])
})

it('still warns a teammate from another family about the projected local worker', async () => {
  const t = await setup()
  t.publish(t.team.room, 'Kieran', 'teammate edit\n')
  const observer = t.session(t.team.room, 'Kieran', t.team.roomName)
  applyAwarenessUpdate(observer.awareness, encodeAwarenessUpdate(t.team.awareness, [t.team.awareness.clientID]), 'test')
  await t.checker(observer).reconcile('other family')
  const conflicts = openConflicts(t.team.room, 'Kieran').filter(c => c.kind === 'merge')
  expect(conflicts).toHaveLength(2)
  expect(conflicts.every(m => m.priority === 'fyi')).toBe(true)
})


it('uses exact registry projection ownership even for names without a lead prefix', async () => {
  const t = await setup(['first-worker', 'second-worker'])
  t.publish(t.team.room, 'L', 'lead edit\n')
  await t.checker(t.team).reconcile('ordinary team')
  for (const record of t.records) await t.checker(t.team, record.name, t.local).reconcile('projected sibling')
  expect(openConflicts(t.team.room)).toEqual([])
  expect(openConflicts(t.local.room)).toEqual([])
})


it('keeps a retiring worker in its family while its team projection awaits withdrawal', async () => {
  const t = await setup(), [a] = t.records
  t.publish(t.team.room, 'L', 'lead edit\n')
  await finishWorker(t.local, a.tag)
  await t.registry.beginRetirement(a.id, await t.registry.archiveOf(a, { summary: 'collected' }))
  await t.checker(t.team).reconcile('retirement before team withdrawal')
  await t.checker(t.team, a.name, t.local).reconcile('retiring projected owner')
  expect(openConflicts(t.team.room)).toEqual([])
  expect(t.conflicts('L')).toEqual([])
})


it.each(['missing', 'malformed', 'unreadable', 'quarantined'])('blocks a %s own-worker record without misclassifying it as another family', async damage => {
  const t = await setup(), [worker] = t.records
  t.publish(t.team.room, 'L', 'lead edit\n')
  const file = join(t.registry.root, 'workers', `${worker.id}.json`)
  if (damage === 'missing') rmSync(file)
  if (damage === 'malformed') writeFileSync(file, '{malformed')
  if (damage === 'quarantined') {
    const quarantine = join(t.registry.root, 'quarantine')
    mkdirSync(quarantine, { recursive: true })
    fs.renameSync(file, join(quarantine, `${worker.id}.json.bad-test`))
  }
  if (damage === 'unreadable') {
    const read = fs.readFileSync.bind(fs)
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return read(...args)
    })
  }
  await expect(t.checker(t.team).reconcile('damaged ownership evidence')).rejects.toThrow(/blocked|unavailable/)
  expect(openConflicts(t.team.room)).toEqual([])
})


it.each(['restarted', 'released', 'expired', 'offline'])('leaves an own %s projection updating instead of warning on the team bus', async state => {
  const t = await setup(), [worker] = t.records
  t.publish(t.team.room, 'L', 'lead edit\n')
  await t.checker(t.team).reconcile('current family projection')
  const lead = participantRecord(t.team.room, 'L')!
  if (state === 'restarted') {
    t.team.room.participants.set('L\0holder', { ...lead.holder!, epoch: 2 })
    t.team.room.participants.set('L\0git', { ...lead.git!, fence: '2' })
    t.team.room.manifestHead.set('L', { ...t.team.room.manifestHead.get('L')!, fence: '2' })
    t.team.room.manifest.set(manifestKey('L', '2'), new Y.Map([...t.team.room.manifest.get(manifestKey('L', '1'))!]
      .map(([path, entry]) => [path, { ...entry, fence: '2' }])))
    t.team.room.setOverlay(manifestKey('L', '2'), 'x', 'lead edit\n')
    t.team.lease!.fence = () => '2'
    t.team.daemon.fence = '2'
  } else if (state === 'offline') t.team.awareness.setLocalState(null)
  else t.team.room.participants.set('L\0holder', { ...lead.holder!, ended: state })
  await t.checker(t.team).reconcile('projection no longer has its lead fence')
  // This is the ordinary updating-input path, not an accepted-family exclusion.
  expect(t.team.room.doc.getMap('conflicts').get(slotKey('L', 'merge', worker.name, '*'))).toMatchObject({ status: 'unknown', settled: 'none' })
  await t.checker(t.team, worker.name, t.local).reconcile('stale projected owner')
  expect(openConflicts(t.team.room)).toEqual([])
  expect(openConflicts(t.local.room)).toEqual([])
})

it('compares a where-here worker as an ordinary team participant', async () => {
  const t = await setup(), [worker] = t.records
  await mutateWorkerFixture(t.registry, worker.id, record => ({ ...record, seq: record.seq + 1,
    mode: 'here', room: t.team.roomName, projectedInto: undefined,
    lead: { ...record.lead, room: t.team.roomName } }))
  t.publish(t.team.room, 'L', 'lead edit\n')
  t.publish(t.team.room, worker.name, 'ordinary worker edit\n', worker.id)
  t.team.room.participants.delete(`${worker.name}\0proj`)
  const view = t.team.room.workerViews.get(worker.id)!
  t.team.room.workerViews.set(worker.id, { ...view, mode: 'here' })
  await t.checker(t.team).reconcile('worker joined the team room itself')
  expect(openConflicts(t.team.room, 'L')).toEqual([
    expect.objectContaining({ priority: 'notify', slots: [expect.objectContaining({ path: 'x' })] }),
  ])
})

it('does not treat a wrong-fence projection claim as family', async () => {
  const t = await setup()
  t.publish(t.team.room, 'L', 'lead edit\n')
  t.publish(t.team.room, 'R', 'other member edit\n')
  const head = t.team.room.manifestHead.get('R')!, record = participantRecord(t.team.room, 'R')!
  t.team.room.participants.set('R\0proj', { projectedFrom: 'w_claim', projectedBy: 'L' })
  t.team.room.participants.set('R\0git', { ...record.git!, fence: '999' })
  t.team.room.manifestHead.set('R', { ...head, projectedFrom: 'w_claim', projectedBy: 'L', fence: '999' })
  await t.checker(t.team).reconcile('unaccepted projection takes normal updating path')
  expect(t.team.room.doc.getMap('conflicts').get(slotKey('L', 'merge', 'R', '*'))).toMatchObject({ status: 'unknown', settled: 'none' })
  t.team.room.participants.delete('R\0proj')
  t.team.room.participants.set('R\0git', record.git!)
  t.team.room.manifestHead.set('R', head)
  await t.checker(t.team).reconcile('ordinary publication still compared')
  expect(openConflicts(t.team.room, 'L')).toEqual([
    expect.objectContaining({ owner: 'L', priority: 'notify' }),
  ])
})

it.each(['different', 'empty'])('requires matching nonempty participant and manifest projection identities (%s)', async identity => {
  const t = await setup()
  t.publish(t.team.room, 'L', 'lead edit\n')
  t.publish(t.team.room, 'R', 'other member edit\n')
  t.team.room.participants.set('R\0proj', { projectedFrom: identity === 'empty' ? '' : 'w_claim', projectedBy: 'L' })
  t.team.room.manifestHead.set('R', { ...t.team.room.manifestHead.get('R')!, projectedFrom: identity === 'empty' ? '' : 'w_different', projectedBy: 'L' })
  await t.checker(t.team).reconcile('inconsistent projection is not family')
  expect(openConflicts(t.team.room, 'L')).toEqual([
    expect.objectContaining({ owner: 'L', priority: 'notify' }),
  ])
})

it('states the trust boundary: a member can copy a public lead fence and suppress its own comparison', async () => {
  const t = await setup()
  t.publish(t.team.room, 'L', 'lead edit\n')
  t.publish(t.team.room, 'R', 'other member edit\n')
  // This is a statement of the existing trust boundary, not an authorship guarantee.
  // All changed fields belong to R; the public epoch is current, but L did not write them.
  t.team.room.participants.set('R\0proj', { projectedFrom: 'w_claim', projectedBy: 'L' })
  t.team.room.manifestHead.set('R', { ...t.team.room.manifestHead.get('R')!, projectedFrom: 'w_claim', projectedBy: 'L' })
  await t.checker(t.team).reconcile('matching public projection facts')
  expect(t.team.room.doc.getMap('conflicts').get(slotKey('L', 'merge', 'R', 'x'))).toBeUndefined()
  expect(t.team.room.doc.getMap('conflicts').get(slotKey('L', 'merge', 'R', '*'))).toBeUndefined()
  expect(openConflicts(t.team.room)).toEqual([])
})
