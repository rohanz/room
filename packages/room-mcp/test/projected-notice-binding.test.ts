import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, gitBlobHash, manifestKey, outgoing, owed, participantRecord, type ManifestEntry } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { ConflictSet, ConflictSlots, slotKey, type ConflictSlot, type Evaluation } from '../src/conflict-set.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import type { Session } from '../src/session.js'
import { seedRegistryWorker } from './registry-fixture.js'
import { hubSeam } from './fixtures/hub.js'
import type { Post } from '../src/post.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'room-projected-notice-binding-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'review'); git('config', 'user.email', 'review@example.com')
  writeFileSync(join(dir, 'x'), 'base\n'); git('add', 'x'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD'), teamRoom = new RoomDoc(), localRoom = new RoomDoc()
  const registry = await registryForDir(dir)
  const { record } = await seedRegistryWorker(dir, 'a', { name: 'L+a', base, carriedBase: base,
    room: 'local/L', projectedInto: 'team/review', lead: { participant: 'L', room: 'local/L', instance: registry.instance } })
  const remoteId = 'w_remote_b'
  const aw = new Awareness(new Y.Doc()), remoteAw = new Awareness(new Y.Doc()), localAw = new Awareness(new Y.Doc())
  aw.setLocalState({ user: { name: 'L', kind: 'agent' }, sessionId: 'session-L' })
  remoteAw.setLocalState({ user: { name: 'R', kind: 'agent' }, sessionId: 'session-R' })
  applyAwarenessUpdate(aw, encodeAwarenessUpdate(remoteAw, [remoteAw.clientID]), 'review')
  function publish(room: RoomDoc, name: string, text?: string, id?: string, lead?: string, fence = '1') {
    epochPublication(room, name, base, Number(fence)); room.ensureRoomSalt()
    room.participants.set(`${name}\0id`, { name, kind: 'agent' })
    const entries = new Y.Map<ManifestEntry>()
    if (text) entries.set('x', { state: lead ? 'held' : 'shared', change: 'M',
      ...(lead ? { held: 'worker' as const } : {}), hash: gitBlobHash(text), fence, at: 1 })
    room.manifest.set(manifestKey(name, fence), entries)
    if (text && !lead) room.setOverlay(manifestKey(name, fence), 'x', text)
    room.manifestHead.set(name, { base, fence, coverage: { kind: 'all' }, complete: true,
      level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: Date.now(),
      ...(lead ? { projectedBy: lead, projectedFrom: id } : {}) })
    if (lead) {
      room.participants.delete(`${name}\0holder`)
      room.participants.set(`${name}\0proj`, { projectedBy: lead, projectedFrom: id })
    } else if (id) room.participants.set(`${name}\0holder`, { sessionId: `session-${name}`, epoch: 1, workerId: id })
  }
  publish(teamRoom, 'L'); publish(teamRoom, 'R')
  publish(teamRoom, record.name, 'alpha\n', record.id, 'L')
  publish(teamRoom, 'R+b', 'beta\n', remoteId, 'R')
  publish(localRoom, record.name, 'alpha\n', record.id)
  const teamSeam = hubSeam(teamRoom), localSeam = hubSeam(localRoom)
  const common = { dir, me: { name: 'L', kind: 'agent' }, lease: { fence: () => '1' }, daemon: { fence: '1' }, provider: { synced: true } }
  const team = { ...common, ...teamSeam, room: teamRoom, awareness: aw, roomName: 'team/review' } as unknown as Session
  const workers = { ...common, ...localSeam, room: localRoom, awareness: localAw, roomName: 'local/L' } as unknown as Session
  const sets: ConflictSet[] = []
  const makeSet = () => { const set = new ConflictSet(team, record.name, workers, () => {}, 0); sets.push(set); return set }
  const set = makeSet()
  cleanups.push(async () => {
    for (const set of sets) set.stop()
    teamSeam.hub.close(); localSeam.hub.close()
    for (const awareness of [aw, remoteAw, localAw]) { awareness.destroy(); awareness.doc.destroy() }
    teamRoom.doc.destroy(); localRoom.doc.destroy(); await closeRegistryForDir(dir)
    rmSync(dir, { recursive: true, force: true })
  })
  const key = slotKey(record.name, 'merge', 'R+b', 'x')
  const slots = teamRoom.doc.getMap<ConflictSlot>('conflicts')
  const copies = () => localRoom.messages().filter(m => m.type === 'merge-conflict')
  const restartRemote = () => teamRoom.participants.set('R\0holder', { ...participantRecord(teamRoom, 'R')!.holder!, epoch: 2 })
  return { set, makeSet, record, remoteId, key, slots, copies, restartRemote, teamRoom, localRoom, workers, publish }
}

it.each(['accepted', 'refuse-lead', 'duplicate-worker', 'duplicate-lead'] as const)('quiets exact projected conflict updates only after fresh acceptance of both copies (%s)', async firstPost => {
  const t = await fixture()
  // A known Git blob lets this pair compare the remote worker's held text exactly.
  execFileSync('git', ['-C', t.workers.dir, 'hash-object', '-w', '--stdin'], { input: 'beta\n' })
  const post = t.workers.post
  let intercepted = false
  t.workers.post = ((from, body, opts) => {
    if (!intercepted && firstPost === 'refuse-lead' && body.to === 'L') {
      intercepted = true
      return Object.assign(Promise.resolve({ ok: false as const, reason: 'unreachable' as const, text: 'lead post refused',
        msg: { ...outgoing(from, body, opts!.id!), at: 1 } }), { id: opts!.id! })
    }
    if (!intercepted && (firstPost === 'duplicate-worker' && body.to === t.record.name || firstPost === 'duplicate-lead' && body.to === 'L')) {
      intercepted = true
      // Seed the hub's prior body before returning its real duplicate acknowledgement.
      return Object.assign(post(from, body, opts).then(() => post(from, body, opts)), { id: opts!.id! })
    }
    return post(from, body, opts)
  }) as Post
  await t.set.reconcile('first exact conflict')
  expect(t.slots.get(t.key)?.settled).toBe('conflict')
  const addFile = (path: string) => {
    for (const [room, name, text, held] of [
      [t.teamRoom, t.record.name, 'alpha\n', true],
      [t.localRoom, t.record.name, 'alpha\n', false],
      [t.teamRoom, 'R+b', 'beta\n', true],
    ] as const) {
      room.manifest.get(manifestKey(name, '1'))!.set(path, { state: held ? 'held' : 'shared', change: 'A',
        ...(held ? { held: 'worker' as const } : {}), hash: gitBlobHash(text), fence: '1', at: 1 })
      if (!held) room.setOverlay(manifestKey(name, '1'), path, text)
      const head = room.manifestHead.get(name)!
      room.manifestHead.set(name, { ...head, rev: head.rev + 1, semRev: head.semRev + 1 })
    }
  }
  addFile('y')
  await t.set.reconcile('another exact file')
  addFile('z')
  await t.set.reconcile('third exact file')
  const worker = t.copies().filter(m => m.to === t.record.name)
  const lead = t.copies().filter(m => m.to === 'L')
  expect(worker.map(m => m.priority)).toEqual(['notify', firstPost === 'accepted' ? 'fyi' : 'notify', 'fyi'])
  expect(lead.map(m => m.priority)).toEqual(firstPost === 'refuse-lead' ? ['notify', 'fyi']
    : ['notify', firstPost === 'accepted' ? 'fyi' : 'notify', 'fyi'])
})

it.each(['own', 'remote'])('retains both exact subjects across remote restart and ends every copy when the %s worker retires', async endpoint => {
  const t = await fixture()
  await t.set.reconcile('both projected sources current')
  const before = t.copies()
  expect(before).toHaveLength(2)
  expect(before.every(m => m.noticeSubjects?.some(s => s.workerId === t.remoteId))).toBe(true)
  const binding = t.slots.get(t.key)!.projectedEpisode
  expect(binding?.endpoints).toEqual([{ name: t.record.name, workerId: t.record.id }, { name: 'R+b', workerId: t.remoteId }])
  // A lead acquires its next lease before its bridge has reprojected the workers.
  t.restartRemote()
  for (let n = 0; n < 3; n++) await t.set.reconcile('remote lead restarted, projection still at previous fence')
  // A new evaluator must recover the same identity from persisted slots, not its current snapshots.
  t.set.stop()
  await t.makeSet().reconcile('new evaluator in the same restart window')
  expect(t.slots.get(t.key)).toMatchObject({ status: 'possible', settled: 'possible', projectedEpisode: binding })
  expect(t.copies().map(m => m.id)).toEqual(before.map(m => m.id))
  const retired = endpoint === 'own' ? { id: t.record.id, name: t.record.name } : { id: t.remoteId, name: 'R+b' }
  t.localRoom.endWorkerNotices([retired], Date.now())
  expect(before.every(m => t.localRoom.outcomes.has(m.id))).toBe(true)
  for (const name of [t.workers.me.name, t.record.name]) expect(owed(t.localRoom, { name, kind: 'agent' },
    { frontier: 0, routed: new Set() }, {}).filter(m => m.type === 'merge-conflict')).toEqual([])
})

it('clears with the recorded endpoints after a remote lead reprojects at its new fence', async () => {
  const t = await fixture()
  await t.set.reconcile('possible conflict')
  const binding = t.slots.get(t.key)!.projectedEpisode
  t.restartRemote()
  await t.set.reconcile('old projection fence')
  t.publish(t.teamRoom, 'R', undefined, undefined, undefined, '2')
  t.publish(t.teamRoom, 'R+b', undefined, t.remoteId, 'R', '2')
  await t.set.reconcile('remote worker reverted and reprojected')
  await t.set.reconcile('replay clear')
  expect(t.copies()).toHaveLength(4)
  expect(t.slots.get(t.key)).toMatchObject({ settled: 'clean', projectedEpisode: binding })
  expect(t.copies().slice(2).every(m => m.clearedFrom === 'possible' && JSON.stringify(m.noticeSubjects) === JSON.stringify(binding!.endpoints))).toBe(true)
  t.localRoom.endWorkerNotices([{ id: t.remoteId, name: 'R+b' }], Date.now())
  expect(t.copies().every(m => t.localRoom.outcomes.has(m.id))).toBe(true)
})

it.each(['current', 'unknown first'])('starts a fresh bound episode for an unbound legacy slot (%s)', async state => {
  const t = await fixture()
  await t.set.reconcile('initial conflict')
  const before = t.copies().map(m => m.id)
  const { projectedEpisode: oldBinding, ...legacy } = t.slots.get(t.key)!
  // The preceding implementations persisted these fields, without endpoint identity.
  t.slots.set(t.key, legacy)
  if (state === 'unknown first') {
    t.restartRemote()
    await t.set.reconcile('unbound slot cannot be replayed using stale snapshots')
    expect(t.slots.get(t.key)).toMatchObject({ status: 'unknown', settled: 'none' })
    expect(t.slots.get(t.key)!.projectedEpisode).toBeUndefined()
    expect(t.copies().map(m => m.id)).toEqual(before)
    t.publish(t.teamRoom, 'R', undefined, undefined, undefined, '2')
    t.publish(t.teamRoom, 'R+b', 'beta\n', t.remoteId, 'R', '2')
  }
  t.set.stop()
  const fresh = t.makeSet()
  await fresh.reconcile('new positive evaluation of legacy state')
  const binding = t.slots.get(t.key)!.projectedEpisode!
  expect(binding.id).not.toBe(oldBinding!.id)
  expect(binding.endpoints).toEqual(oldBinding!.endpoints)
  expect(t.copies()).toHaveLength(4)
  expect(t.copies().slice(2).every(m => !before.includes(m.id) && m.id.includes(binding.id))).toBe(true)
  await fresh.reconcile('replay migrated slot')
  expect(t.copies()).toHaveLength(4)
})

it('groups exact projected file conflicts and replays or clears using their saved binding', async () => {
  const room = new RoomDoc(), seam = hubSeam(room)
  const subjects = vi.fn(() => [{ name: 'L+a', workerId: 'w_a' }, { name: 'R+b', workerId: 'w_b' }])
  const makeSlots = () => new ConflictSlots(room, seam.post, '1', Date.now, () => {}, seam.post, () => true, undefined, subjects)
  let slots = makeSlots()
  slots.deferPeerNotices = true
  const result: Evaluation = { owner: 'L+a', other: 'R+b', path: 'x', kind: 'merge', status: 'conflict', inputs: 'both', factId: 'both' }
  const x = slotKey(result.owner, 'merge', result.other, 'x'), y = slotKey(result.owner, 'merge', result.other, 'y')
  try {
    await slots.settle(x, result)
    await slots.settle(y, { ...result, path: 'y' })
    const binding = slots.get(x)!.projectedEpisode!
    expect(slots.get(y)!.projectedEpisode).toEqual(binding)
    await slots.replay(result.owner)
    expect(room.messages()).toHaveLength(1)
    // No current endpoint evidence exists during the restart window.
    subjects.mockImplementation(() => { throw new Error('replay must not query current endpoint identity') })
    slots = makeSlots()
    slots.deferPeerNotices = true
    await slots.settle(x, { ...result, status: 'unknown', inputs: 'stale' })
    await slots.settle(y, { ...result, path: 'y', status: 'unknown', inputs: 'stale' })
    await slots.replay(result.owner)
    expect(room.messages()).toHaveLength(1)
    for (const [key, path] of [[x, 'x'], [y, 'y']]) await slots.settle(key!, { ...result, path: path!, status: 'clean', inputs: 'reverted' })
    await slots.replay(result.owner)
    await slots.replay(result.owner)
    expect(room.messages()).toHaveLength(2)
    expect(room.messages().every(m => JSON.stringify(m.noticeSubjects) === JSON.stringify(binding.endpoints))).toBe(true)
    expect(room.messages()[1]).toMatchObject({ clearedFrom: 'conflict' })
  } finally { seam.hub.close(); room.doc.destroy() }
})

it.each(['possible', 'conflict'] as const)('opens a new %s episode when migrating a legacy projected slot', async status => {
  const room = new RoomDoc(), seam = hubSeam(room)
  const result: Evaluation = { owner: 'L+a', other: 'R+b', path: 'x', kind: 'merge', status, inputs: 'both', factId: 'both' }
  const key = slotKey(result.owner, 'merge', result.other, 'x')
  const endpoints = [{ name: result.owner, workerId: 'w_a' }, { name: result.other, workerId: 'w_b' }]
  try {
    // This produces the old serialized slot shape and id without a projected binding.
    const legacy = new ConflictSlots(room, seam.post, '1')
    await legacy.settle(key, result)
    const before = room.messages()[0]!.id
    const slots = new ConflictSlots(room, seam.post, '1', Date.now, () => {}, seam.post, () => true, undefined, () => endpoints)
    await slots.replay(result.owner)
    expect(room.messages()).toHaveLength(1)
    await slots.settle(key, result)
    const binding = slots.get(key)!.projectedEpisode!
    expect(binding.endpoints).toEqual(endpoints)
    expect(room.messages()).toHaveLength(2)
    expect(room.messages()[1]!.id).not.toBe(before)
    expect(room.messages()[1]!.id).toContain(binding.id)
    await slots.replay(result.owner)
    expect(room.messages()).toHaveLength(2)
  } finally { seam.hub.close(); room.doc.destroy() }
})
