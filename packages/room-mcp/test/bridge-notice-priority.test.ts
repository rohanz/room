/** Review-only reproductions for 9f8e5383..9cc77f83. Fixtures copied from bridge-conflict-repro. No sockets. */
import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, gitBlobHash, manifestKey, participantRecord } from '@room/shared'
import type { Identity, ManifestEntry, Msg } from '@room/shared'
import { rulesFromText } from '@room/roomd/policy'
import { projectWorkers } from '../src/worker-projector.js'
import { Bridge, revokeLeadProjections } from '../src/bridge.js'
import { ConflictSet, reconcileProjectedConflicts } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import { seedRegistryWorker } from './registry-fixture.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { clearFixtureProcesses, fixtureLiveness, fixtureProcess } from './fixtures/process-liveness.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'
import { Ledger } from '../src/ledger.js'
import { WakeReconciler } from '../src/wake-reconciler.js'
import { shouldWakeOnMsg } from '@room/shared'

// Synthetic runs must have the same lifecycle on a process-capable preview host and in a sandbox.
vi.mock('../src/leases.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/leases.js')>()
  return { ...actual, liveness: (identity: Parameters<typeof actual.liveness>[0]) => fixtureLiveness(identity, actual.liveness) }
})

vi.setConfig({ testTimeout: 30_000 })

const PATH = 'api/handlers.py'
const BASE = 'def handle():\n    return 0\n'
const ORDERS = 'def handle():\n    return 10\n'
const NAME = 'def handle():\n    return 20\n'
const TEAM = 'github.com/example/service'
const cleanup: (() => void | Promise<void>)[] = []
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()

afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop()
  clearFixtureProcesses()
})

function room(): RoomDoc {
  const doc = new RoomDoc()
  cleanup.push(() => doc.doc.destroy())
  return doc
}

function awareness(doc = new Y.Doc()): Awareness {
  const a = new Awareness(doc)
  cleanup.push(() => { a.destroy(); doc.destroy() })
  return a
}

/** Forward update clocks too, like bridge.test.ts: identical heartbeats remain fresh. */
function connectAwareness(from: Awareness, to: Awareness): void {
  const forward = () => applyAwarenessUpdate(to, encodeAwarenessUpdate(from, [...from.getStates().keys()]), 'test')
  from.on('update', forward)
  forward()
  cleanup.push(() => from.off('update', forward))
}

function session(doc: RoomDoc, dir: string, name: string, base: string, local: boolean): Session {
  const me: Identity = { name, kind: 'agent', owner: name }
  const a = awareness()
  a.setLocalState({ user: me, sessionId: `session-${name}`, status: 'idle' })
  doc.participants.set(`${name}\0id`, me)
  doc.participants.set(`${name}\0holder`, { sessionId: `session-${name}`, epoch: 1 })
  doc.participants.set(`${name}\0git`, { branch: 'main', head: base, base, anchored: true, rev: 1, fence: '1' })
  const policyStore = testPolicyStore('full', policy => revokeLeadProjections(doc, name, '1', policy))
  const seam = hubSeam(doc)
  cleanup.push(() => seam.hub.close())
  const s = { ...seam, room: doc, awareness: a, me, dir, roomName: local ? `local/${name}` : TEAM,
    provider: { synced: true }, lease: { fence: () => '1' }, policyStore,
    daemon: { fence: '1', inputs: { policy: policyStore.policy, rules: rulesFromText('', 1 << 20, 1 << 24), head: base } },
    ...(local ? { local: { owned: true } } : {}),
  } as unknown as Session
  publish(s, name, base)
  return s
}

function publish(s: Session, name: string, base: string, text?: string): void {
  s.room.ensureRoomSalt()
  const entries = new Y.Map<ManifestEntry>()
  if (text !== undefined) entries.set(PATH, { change: 'M', state: 'shared', hash: gitBlobHash(text), size: Buffer.byteLength(text), at: Date.now(), fence: '1' })
  s.room.manifest.set(manifestKey(name, '1'), entries)
  if (text !== undefined) s.room.setOverlay(manifestKey(name, '1'), PATH, text)
  const previous = s.room.manifestHead.get(name)
  s.room.manifestHead.set(name, { base, fence: '1', coverage: { kind: 'all' }, level: 'full', excluded: [],
    complete: true, scannedAt: Date.now(), rev: (previous?.rev ?? 0) + 1, semRev: (previous?.semRev ?? 0) + 1 })
}

async function fixture(texts: [string | undefined, string | undefined] = [ORDERS, NAME]) {
  const root = mkdtempSync(join(tmpdir(), 'room-bridge-conflict-repro-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const origin = join(root, 'origin')
  mkdirSync(join(origin, 'api'), { recursive: true })
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, 'config', 'user.email', 'test@example.com'); git(origin, 'config', 'user.name', 'test')
  writeFileSync(join(origin, PATH), BASE)
  git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'baseline')
  const base = git(origin, 'rev-parse', 'HEAD')
  const a = room(), b = room()
  const forwardA = (u: Uint8Array) => Y.applyUpdate(b.doc, u)
  const forwardB = (u: Uint8Array) => Y.applyUpdate(a.doc, u)
  a.doc.on('update', forwardA); b.doc.on('update', forwardB)
  cleanup.push(() => { a.doc.off('update', forwardA); b.doc.off('update', forwardB) })

  async function lead(teamRoom: RoomDoc, name: string, tag: string, text: string | undefined, pid: number) {
    const dir = join(root, name)
    git(root, 'clone', '-q', '--no-hardlinks', origin, dir)
    cleanup.push(() => closeRegistryForDir(dir))
    const team = session(teamRoom, dir, name, base, false)
    const local = session(room(), dir, name, base, true)
    const registry = await registryForDir(dir)
    const workerName = `${name}+${tag}`
    let { record } = await seedRegistryWorker(dir, tag, { name: workerName, host: 'codex', mode: 'local',
      room: local.roomName, projectedInto: TEAM, lead: { participant: name, room: local.roomName, instance: registry.instance },
      base, carriedBase: base })
    const process = fixtureProcess(pid, `fixture:${record.id}`, 'codex')
    record = await mutateWorkerFixture(registry, record.id, old => ({ ...old, seq: old.seq + 1,
      runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid, process } }] }))
    git(dir, 'worktree', 'add', '-q', '-b', record.branch, record.dir, base)
    writeFileSync(join(record.dir, PATH), text ?? BASE)
    const worker = session(local.room, record.dir, workerName, base, true)
    local.room.participants.set(`${workerName}\0holder`, { ...participantRecord(local.room, workerName)!.holder!, workerId: record.id })
    connectAwareness(worker.awareness, local.awareness)
    publish(local, workerName, base, text)
    // Bridge projection does not need the worker's disk. Absence of these blobs in the other clone is essential.
    const reconcile = vi.fn(reconcileProjectedConflicts)
    const bridge = new Bridge(team, local, { registry, debounceMs: 0, reconcileConflicts: reconcile })
    cleanup.push(() => bridge.stop())
    const conflicts = new ConflictSet(team)
    cleanup.push(() => conflicts.stop())
    return { team, local, worker, workerName, record, registry, bridge, reconcile, conflicts }
  }
  const rohan = await lead(a, 'Rohan', 'orders-limit', texts[0], 800001)
  const kieran = await lead(b, 'Kieran', 'name-limit', texts[1], 800002)
  connectAwareness(rohan.team.awareness, kieran.team.awareness)
  connectAwareness(kieran.team.awareness, rohan.team.awareness)
  // Each bridge is reconciled again after both publications exist, with no timing-dependent sleep.
  const sync = async () => {
    await rohan.bridge.sync(); await kieran.bridge.sync(); await rohan.bridge.sync()
    await rohan.conflicts.reconcile('test'); await kieran.conflicts.reconcile('test')
  }
  return { rohan, kieran, base, sync }
}

function warnings(messages: Msg[], recipient: string): Msg[] {
  return messages.filter(m => m.to === recipient && (m.type === 'merge-conflict' || m.type === 'conflict'))
}


function publishFiles(s: Session, name: string, base: string, files: Record<string, string>, held = false): void {
  publish(s, name, base)
  const entries = s.room.manifest.get(manifestKey(name, '1'))!
  for (const [path, text] of Object.entries(files)) {
    entries.set(path, { change: 'M', state: held ? 'held' : 'shared',
      ...(held ? { held: 'scope' as const } : { hash: gitBlobHash(text) }), at: Date.now(), fence: '1' })
    if (!held) s.room.setOverlay(manifestKey(name, '1'), path, text)
  }
}

it('does not promote an exact peer update that only clears one of two conflicting paths', async () => {
  const t = await fixture([ORDERS, undefined])
  const extra = 'api/extra.py'
  publishFiles(t.rohan.local, t.rohan.workerName, t.base, { [PATH]: ORDERS, [extra]: 'a = 1\n' })
  publishFiles(t.kieran.team, 'Kieran', t.base, { [PATH]: NAME, [extra]: 'a = 2\n' })
  await t.sync()
  const initial = warnings(t.rohan.local.room.messages(), 'Rohan')
  expect(initial).toHaveLength(1)
  expect(initial[0]).toMatchObject({ priority: 'notify' })
  publishFiles(t.kieran.team, 'Kieran', t.base, { [PATH]: NAME, [extra]: 'a = 1\n' })
  await t.sync()
  const update = t.rohan.local.room.messages().filter(m => 'text' in m && m.text.includes('1 file cleared'))
  expect(update).toHaveLength(2)
  expect(update.find(m => m.to === t.rohan.workerName)).toMatchObject({ priority: 'fyi' })
  expect(update.find(m => m.to === 'Rohan')).toMatchObject({ priority: 'fyi' })
})

it('does not promote an approximate edit-in-claim notice', async () => {
  const t = await fixture([ORDERS, undefined])
  publishFiles(t.kieran.team, 'Kieran', t.base, { [PATH]: NAME }, true)
  t.kieran.team.room.addClaim({ path: PATH, from: 1, to: 2, by: 'Kieran', byKind: 'agent', intent: 'change handler' })
  await t.sync()
  const slots = [...t.rohan.team.room.doc.getMap<{ owner: string; kind: string; status: string }>('conflicts').values()]
  expect(slots).toContainEqual(expect.objectContaining({ owner: t.rohan.workerName, kind: 'edit-in-claim', status: 'possible' }))
  const notes = t.rohan.local.room.messages().filter(m => m.type === 'conflict')
  expect(notes).toHaveLength(2)
  expect(notes.find(m => m.to === t.rohan.workerName)).toMatchObject({ priority: 'fyi' })
  expect(notes.find(m => m.to === 'Rohan')).toMatchObject({ priority: 'fyi' })
})

it('does not tell a local lead to ask itself in a team room for a private possible conflict', async () => {
  const t = await fixture([undefined, undefined])
  publishFiles(t.rohan.local, 'Rohan', t.base, { [PATH]: NAME })
  publishFiles(t.rohan.local, t.rohan.workerName, t.base, { [PATH]: ORDERS }, true)
  await t.sync()
  await projectWorkers(t.rohan.local, t.rohan.registry, 'Rohan', 'joined')
  expect(t.rohan.local.room.workerViewOf(t.rohan.workerName)?.lead).toBe('Rohan')
  const set = new ConflictSet(t.rohan.local)
  cleanup.push(() => set.stop())
  await set.reconcile('private local pair')
  const notes = warnings(t.rohan.local.room.messages(), 'Rohan')
  expect(notes).toHaveLength(1)
  expect(notes[0]).toMatchObject({ priority: 'fyi' })
  expect('text' in notes[0] && notes[0].text).not.toContain('two leads')
  expect('text' in notes[0] && notes[0].text).not.toContain('ask Rohan in the team room')
})

it('wakes only each lead for an initially possible conflict; replay and clear do not wake again', async () => {
  const t = await fixture()
  const sends = new Map<string, string[]>()
  for (const s of [t.rohan.local, t.rohan.worker, t.kieran.local, t.kieran.worker]) {
    const id = `session-${s.me.name}`
    const ledger = new Ledger({ sessionId: () => id, route: () => ({}) })
    ledger.bind(s)
    const texts: string[] = []
    sends.set(s.me.name, texts)
    const wake = new WakeReconciler({ ledger, bound: () => ({ id, host: 'codex' }),
      sessionDir: () => undefined, turnProbe: { busy: async () => false }, windowMs: 0,
      send: async (_target, text) => { texts.push(text); return 'queue' } })
    wake.attach(s)
    const team = s === t.rohan.local ? t.rohan.team : s === t.kieran.local ? t.kieran.team : undefined
    if (team) { ledger.bind(team); wake.attach(team) }
    cleanup.push(() => wake.stop())
  }
  await t.sync()
  await vi.waitFor(() => {
    expect(sends.get('Rohan')).toHaveLength(1)
    expect(sends.get('Kieran')).toHaveLength(1)
  })
  const extra = 'api/extra.py'
  publishFiles(t.rohan.local, t.rohan.workerName, t.base, { [PATH]: ORDERS, [extra]: 'a = 1\n' })
  publishFiles(t.kieran.local, t.kieran.workerName, t.base, { [PATH]: NAME, [extra]: 'a = 2\n' })
  await t.sync()
  await vi.waitFor(() => {
    expect(sends.get('Rohan')).toHaveLength(2)
    expect(sends.get('Kieran')).toHaveLength(2)
  })
  const before = t.rohan.local.room.messages().map(m => m.id)
  for (let n = 0; n < 3; n++) await t.sync()
  expect(t.rohan.local.room.messages().map(m => m.id)).toEqual(before)
  for (const own of [t.rohan, t.kieran]) {
    expect(sends.get(own.workerName)).toEqual([])
    const notes = warnings(own.local.room.messages(), own.team.me.name)
    expect(notes).toHaveLength(2)
    expect(shouldWakeOnMsg({ name: 'unrelated-teammate', kind: 'agent' }, notes[0]).wake).toBe(false)
  }
  publishFiles(t.rohan.local, t.rohan.workerName, t.base, { [PATH]: NAME, [extra]: 'a = 2\n' })
  await t.sync()
  for (const own of [t.rohan, t.kieran]) {
    const cleared = own.local.room.messages().filter(m => m.type === 'merge-conflict' && m.clearedFrom === 'possible')
    expect(cleared).toHaveLength(4)
    expect(cleared.every(m => m.priority === 'fyi')).toBe(true)
    expect(sends.get(own.team.me.name)).toHaveLength(2)
    expect(sends.get(own.workerName)).toEqual([])
  }
})
