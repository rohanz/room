import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc, memorySnapshot, openConflicts, participantRecord, type ConflictKind, type RetiredWorker, type ParticipantSnapshot, type Version } from '@room/shared'
import { epochPublication } from '@room/shared/testing'
import { ConflictSet, ConflictSlots, slotKey } from '../src/conflict-set.js'
import { GraphIndex } from '../src/graph-index.js'
import { Ledger, isConflictItem } from '../src/ledger.js'
import { WakeReconciler } from '../src/wake-reconciler.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { publishFixture } from './fixtures/manifest.js'
import type { Session } from '../src/session.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const api = 'def call(a):\n    return a\n'
const changedApi = 'def call(a, b):\n    return a + b\n'
const consumer = 'from api import call\ncall(1)\n'

it.each(['clean', 'reopened'] as const)('a stale relay snapshot cannot replace a survivor\'s %s result', async transition => {
  const survivor = new RoomDoc(), restored = new RoomDoc()
  // A fresh snapshot has a different writer. Make its concurrent copied value win
  // deterministically if conflicts are accidentally persisted by value again.
  survivor.doc.clientID = 0
  const slots = new ConflictSlots(survivor, '1')
  const key = slotKey('A', 'merge', 'B', 'x')
  const settle = (status: 'clean' | 'conflict') => slots.settle(key, {
    kind: 'merge', owner: 'A', other: 'B', path: 'x', status,
    inputs: status, factId: status, lines: [1],
  })
  const s = { room: survivor, roomName: 'local/snapshot', me: { name: 'A', kind: 'agent' },
    awareness: { setLocalStateField() {} } } as unknown as Session
  const ledger = new Ledger({ sessionId: () => 'session-A', route: () => ({}) })
  ledger.bind(s)
  try {
    await settle('conflict')
    const first = openConflicts(survivor, 'A')[0]!
    const shown = ledger.open('reply')
    expect(ledger.select(s, shown).map(item => item.id)).toContain(first.id)
    ledger.commit(shown)
    const saved = memorySnapshot(survivor.doc)
    await settle('clean')
    if (transition === 'reopened') await settle('conflict')
    const expected = openConflicts(survivor, 'A').map(entry => entry.id)
    if (transition === 'reopened') {
      expect(expected).toHaveLength(1)
      expect(expected).not.toContain(first.id)
    }
    else expect(expected).toEqual([])

    Y.applyUpdate(restored.doc, saved)
    Y.applyUpdate(restored.doc, Y.encodeStateAsUpdate(survivor.doc))
    Y.applyUpdate(survivor.doc, Y.encodeStateAsUpdate(restored.doc))
    expect(openConflicts(restored, 'A').map(entry => entry.id)).toEqual(expected)
    expect(openConflicts(survivor, 'A').map(entry => entry.id)).toEqual(expected)
    const waking = ledger.candidates(s).filter(isConflictItem).filter(item => ledger.conflictWakeable(s, item))
    expect(waking.map(item => item.id)).toEqual(expected)
  } finally { ledger.unbind(s); survivor.doc.destroy(); restored.doc.destroy() }
})

/** Establish the alert by evaluation; never seed or settle a conflict slot by hand. */
async function recover(kind: ConflictKind, worker = true, ownerWorker = false, recovery: 'survivor' | 'receiver' = 'survivor') {
  const dir = fs.mkdtempSync(join(tmpdir(), 'room-conflict-recovery-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@test')
  fs.writeFileSync(join(dir, 'x'), 'base\n'); fs.writeFileSync(join(dir, 'api.py'), api)
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD'), original = new RoomDoc(), restored = new RoomDoc()
  const graphs: GraphIndex[] = [], sets: ConflictSet[] = [], wakes: WakeReconciler[] = []
  const states = new Map<number, unknown>()
  let peerClaim: string | undefined
  const publish = (room: RoomDoc, name: 'A' | 'B', clean = false) => {
    epochPublication(room, name, base)
    room.manifestHead.set(name, { ...room.manifestHead.get(name)!, level: 'full' })
    if (kind === 'contract') {
      if (name === 'A') publishFixture(room, name, 'consumer.py', consumer, { base })
      else {
        fs.writeFileSync(join(dir, 'api.py'), clean ? api : changedApi)
        publishFixture(room, name, 'api.py', clean ? api : changedApi, { base })
      }
    } else publishFixture(room, name, 'x', kind === 'claims' ? 'base\n' : name === 'A' || clean ? 'ours\n' : 'theirs\n', { base })
    if (name === 'B' && worker) {
      room.participants.set('B\0holder', { ...participantRecord(room, 'B')!.holder!, workerId: 'worker-B' })
      room.workerViews.set('worker-B', { id: 'worker-B', name: 'B', tag: 'B', lead: 'L', mode: 'here', host: 'codex', status: 'running', run: 1, task: 'test', branch: 'main', startedAt: 1, fence: '1' })
    }
    if (name === 'A' && ownerWorker) {
      room.participants.set('A\0holder', { ...participantRecord(room, 'A')!.holder!, workerId: 'worker-A' })
      room.workerViews.set('worker-A', { id: 'worker-A', name: 'A', tag: 'A', lead: 'LA', mode: 'here', host: 'codex', status: 'running', run: 1, task: 'test', branch: 'main', startedAt: 1, fence: '1' })
    }
    states.set(name === 'A' ? 1 : 2, { user: { name, kind: 'agent' }, sessionId: `session-${name}` })
  }
  const session = (room: RoomDoc) => ({ room, dir, roomName: 'local/recovery', me: { name: 'A', kind: 'agent' },
    awareness: { getStates: () => states, setLocalStateField() {} }, provider: { synced: true }, lease: { fence: () => '1' }, post: vi.fn(async () => ({ ok: true })) }) as unknown as Session
  const graph = async (room: RoomDoc) => {
    if (kind !== 'contract') return
    const value = new GraphIndex(room, 'B', dir, () => {}, { minPublishMs: 0, random: () => 0 })
    graphs.push(value); value.start(); await value.whenIdle()
    await vi.waitFor(() => expect(room.graphs.get('B')).toMatchObject({ status: 'ready', sourceRev: room.manifestHead.get('B')!.rev }))
    value.stop()
  }
  cleanups.push(async () => {
    for (const value of wakes) value.stop()
    for (const value of sets) value.stop()
    for (const value of graphs) value.stop()
    original.doc.destroy(); restored.doc.destroy(); await closeRegistryForDir(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  original.ensureRoomSalt(); publish(original, 'A'); publish(original, 'B')
  if (kind === 'claims') original.addClaim({ by: 'A', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'edit' })
  if (kind === 'claims' || kind === 'edit-in-claim') peerClaim = original.addClaim({ by: 'B', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'edit' }).id
  await graph(original)
  const initial = new ConflictSet(session(original)); sets.push(initial)
  await initial.reconcile('establish the real conflict')
  const opening = openConflicts(original, 'A').find(entry => entry.kind === kind)
  expect(opening, 'fixture must establish the requested kind through detection').toBeDefined()
  if (recovery === 'receiver') {
    const receiver = new Ledger({ sessionId: () => 'session-A', sessionDir: () => dir, route: () => ({}) })
    const before = session(original)
    receiver.bind(before)
    expect(receiver.candidates(before).some(item => item.id === opening!.id)).toBe(true)
    expect(receiver.flushConflicts()).toBe(true)
    receiver.unbind(before)
  }
  const peerHolder = participantRecord(original, 'B')!.holder!
  Y.applyUpdate(restored.doc, memorySnapshot(original.doc))
  // A crash survivor supplies the original CRDT history, never a fresh value copy.
  // Without one, only the receiver's own owed-wake record survives until re-evaluation.
  if (recovery === 'survivor') Y.applyUpdate(restored.doc, Y.encodeStateAsUpdate(original.doc))
  restored.workerViews.clear(); restored.manifestHead.clear(); restored.manifest.clear(); restored.graphs.clear()
  // The hub restores durable leases before awareness, worker views or publications return.
  restored.participants.set('B\0holder', peerHolder)
  states.clear(); publish(restored, 'A')
  const s = session(restored), set = new ConflictSet(s); sets.push(set)
  const ledger = new Ledger({ sessionId: () => 'session-A', sessionDir: () => dir, route: () => ({}) })
  const send = vi.fn(async () => 'socket' as const)
  const startWake = () => {
    ledger.bind(s)
    const value = new WakeReconciler({ ledger, bound: () => ({ host: 'claude', id: 'host' }), sessionDir: () => dir, send, windowMs: 0,
      audible: () => item => isConflictItem(item) })
    wakes.push(value); value.attach(s)
  }
  return { room: restored, s, set, ledger, send, opening: opening!, startWake,
    open: () => openConflicts(restored, 'A').filter(entry => entry.kind === kind),
    async republish(clean = false) {
      publish(restored, 'B', clean)
      if (clean && kind === 'claims') restored.removeClaim(peerClaim!)
      await graph(restored)
      await set.reconcile(clean ? 'peer returned with clean evidence' : 'peer returned still conflicting')
    },
    async unreadable() {
      publish(restored, 'B')
      const path = kind === 'contract' ? 'api.py' : 'x'
      const entries = restored.manifest.get('B\0' + '1')!
      entries.set(path, { ...entries.get(path)!, state: 'held', held: 'binary' })
      await set.reconcile('peer returned but its bytes are unreadable')
    },
    async withdrawSharing() {
      publish(restored, 'B')
      restored.manifestHead.set('B', { ...restored.manifestHead.get('B')!, level: 'intent', coverage: { kind: 'none', reason: 'intent' } })
      await set.reconcile('peer explicitly withdrew text sharing')
    },
    retire() {
      const record: RetiredWorker & { id: string } = { id: 'worker-B', name: 'B', tag: 'B', lead: 'L', host: 'codex', task: 'test', summary: 'done', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'merged' }
      restored.retireWorker(record.id, record, () => {})
    },
    read() { const batch = ledger.open('reply'), items = ledger.select(s, batch); ledger.commit(batch); return items }
  }
}

for (const kind of ['merge', 'edit-in-claim', 'claims', 'contract'] as const) describe(kind, () => {
  it('recovers an observed owed wake without a surviving conflict replica, then re-evaluates returning inputs', async () => {
    const f = await recover(kind, true, false, 'receiver')
    expect(f.open()).toEqual([])
    await f.set.reconcile('no surviving replica and peer inputs absent')
    f.startWake()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    expect(f.read()).toContainEqual(expect.objectContaining({ status: 'inactive', priority: f.opening.priority }))
    await f.republish()
    expect(f.open()).toHaveLength(1)
    expect(f.open()[0]!.id).not.toBe(f.opening.id)
    expect(f.open()[0]!.slots[0]!.settled).toBe('conflict')
  })
  it('keeps an unshown recovered conflict and its wake before the peer republishes', async () => {
    const f = await recover(kind)
    expect(f.open().map(entry => entry.id)).toEqual([f.opening.id])
    await f.set.reconcile('recovery with missing peer inputs')
    expect(f.open().map(entry => entry.id)).toEqual([f.opening.id])
    f.startWake()
    expect(f.ledger.candidates(f.s).some(item => item.id === f.opening.id)).toBe(true)
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    expect(f.ledger.conflictWakeRecorded(f.s, f.opening.id)).toBe(true)
  })
  it('keeps the opening and does not wake again when conflicting publications return', async () => {
    const f = await recover(kind)
    await f.set.reconcile('recovery with missing peer inputs'); f.startWake()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    await f.republish()
    expect(f.open().map(entry => entry.id)).toEqual([f.opening.id])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.send).toHaveBeenCalledOnce()
  })
  it('ends only after the returned pair is evaluated clean, with a courtesy and no wake', async () => {
    const f = await recover(kind)
    await f.set.reconcile('recovery with missing peer inputs'); f.startWake()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    expect(f.read().some(item => item.id === f.opening.id)).toBe(true)
    await f.republish(true)
    expect(f.open()).toEqual([])
    expect(f.read()).toContainEqual(expect.objectContaining({ id: f.opening.id + ':inactive', status: 'inactive', priority: 'fyi' }))
    expect(f.read().some(item => item.id === f.opening.id + ':inactive')).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.send).toHaveBeenCalledOnce()
  })
  it('does not deliver a recovered opening after its absent peer is explicitly retired', async () => {
    const f = await recover(kind)
    f.retire(); await f.set.reconcile('retired while away'); f.startWake()
    expect(f.open()).toEqual([])
    expect(f.ledger.candidates(f.s).some(item => item.id === f.opening.id)).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.send).not.toHaveBeenCalled()
  })
  it('keeps the original unshown wake when the peer republishes unreadable inputs', async () => {
    const f = await recover(kind)
    await f.set.reconcile('recovery with missing peer inputs')
    await f.unreadable()
    expect(f.open()).toMatchObject([{ id: f.opening.id, slots: [expect.objectContaining({ settled: 'conflict' })] }])
    // Matching claim anchors can still prove an overlap without the peer's current bytes.
    if (kind !== 'claims') expect(f.open()[0]!.slots[0]!.status).toBe('unknown')
    f.startWake()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    expect(f.ledger.conflictWakeRecorded(f.s, f.opening.id)).toBe(true)
  })
  it('distinguishes an explicit sharing-level withdrawal from missing recovery inputs', async () => {
    const f = await recover(kind)
    await f.set.reconcile('recovery with missing peer inputs')
    await f.withdrawSharing()
    f.startWake()
    if (kind === 'claims') {
      expect(f.open().map(entry => entry.id)).toEqual([f.opening.id])
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    } else {
      expect(f.open()).toEqual([])
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(f.send).not.toHaveBeenCalled()
    }
  })
})

it('missing ordinary-peer grant metadata after recovery is unknown, not a contract withdrawal', async () => {
  const f = await recover('contract', false)
  await f.set.reconcile('ordinary provider has not republished'); f.startWake()
  expect(f.open().map(entry => entry.id)).toEqual([f.opening.id])
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
})

it.each(['fetch', 'no-base-text', 'too-large'] as const)('a certified merge keeps one opening and wake through %s failure and recovery', async why => {
  const f = await recover('merge')
  await f.set.reconcile('initial recovery'); f.startWake()
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  const target = f.set as unknown as { read(snap: ParticipantSnapshot, path: string): Promise<Version> }
  const originalRead = target.read.bind(target)
  const read = vi.spyOn(target, 'read').mockImplementation((snap, path) => snap.name === 'B'
    ? Promise.resolve({ kind: 'unknown', why, detail: 'temporarily unreadable' }) : originalRead(snap, path))
  await f.republish()
  expect(f.open()).toMatchObject([{ id: f.opening.id, slots: [expect.objectContaining({ settled: 'conflict', status: 'unknown' })] }])
  read.mockRestore()
  // A subsequent publication revision makes the restored readable input eligible for recheck.
  const head = f.room.manifestHead.get('B')!
  f.room.manifestHead.set('B', { ...head, rev: head.rev + 1, semRev: head.semRev + 1 })
  await f.set.reconcile('the input is readable again')
  expect(f.open()).toMatchObject([{ id: f.opening.id, slots: [expect.objectContaining({ settled: 'conflict', status: 'conflict' })] }])
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(f.send).toHaveBeenCalledOnce()
})

it('an unreadable first evaluation keeps the existing possible result without a wake', async () => {
  const f = await recover('merge')
  await f.republish(true)
  expect(f.open()).toEqual([])
  const target = f.set as unknown as { read(snap: ParticipantSnapshot, path: string): Promise<Version> }
  const originalRead = target.read.bind(target)
  vi.spyOn(target, 'read').mockImplementation((snap, path) => snap.name === 'B'
    ? Promise.resolve({ kind: 'unknown', why: 'fetch', detail: 'temporarily unreadable' }) : originalRead(snap, path))
  await f.republish()
  expect(f.open()).toMatchObject([{ priority: 'fyi', slots: [expect.objectContaining({ settled: 'possible', status: 'possible' })] }])
  f.startWake(); await new Promise(resolve => setTimeout(resolve, 10))
  expect(f.send).not.toHaveBeenCalled()
})

it('an observed grant withdrawal stays possible even when the other input has a fetch failure', async () => {
  const f = await recover('merge')
  await f.republish(); f.startWake()
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
  const target = f.set as unknown as { read(snap: ParticipantSnapshot, path: string): Promise<Version> }
  const originalRead = target.read.bind(target)
  vi.spyOn(target, 'read').mockImplementation((snap, path) => snap.name === 'A'
    ? Promise.resolve({ kind: 'unknown', why: 'fetch', detail: 'temporarily unreadable' }) : originalRead(snap, path))
  const head = f.room.manifestHead.get('B')!, entries = f.room.manifest.get('B\0' + head.fence)!
  const { hash: _hash, ...entry } = entries.get('x')!
  entries.set('x', { ...entry, state: 'held', held: 'scope' })
  f.room.manifestHead.set('B', { ...head, level: 'declared', textPrefixes: [], rev: head.rev + 1, semRev: head.semRev + 1 })
  await f.set.reconcile('observed grant withdrawal with a separate unavailable input')
  expect(f.open()).toMatchObject([{ priority: 'fyi', slots: [expect.objectContaining({ settled: 'possible', status: 'possible' })] }])
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(f.send).toHaveBeenCalledOnce()
})
