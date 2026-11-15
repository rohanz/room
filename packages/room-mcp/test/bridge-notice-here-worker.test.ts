/** Review-only a7e9fe7f regression: another lead's team-room worker is not a projected local worker. */
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

it("keeps a possible conflict with another lead's where:here worker at its ordinary priority and wording", async () => {
  const t = await fixture([ORDERS, undefined])
  const name = 'Kieran+team-worker'
  let { record } = await seedRegistryWorker(t.kieran.team.dir, 'team-worker', { name, host: 'codex', mode: 'here',
    room: TEAM, lead: { participant: 'Kieran', room: TEAM, instance: t.kieran.registry.instance }, base: t.base, carriedBase: t.base })
  const process = fixtureProcess(800003, `fixture:${record.id}`, 'codex')
  record = await mutateWorkerFixture(t.kieran.registry, record.id, old => ({ ...old, seq: old.seq + 1,
    runs: [{ ...old.runs[0], launch: { outcome: 'launched', pid: 800003, process } }] }))
  git(t.kieran.team.dir, 'worktree', 'add', '-q', '-b', record.branch, record.dir, t.base)
  const worker = session(t.kieran.team.room, record.dir, name, t.base, false)
  t.kieran.team.room.participants.set(`${name}\0holder`, { ...participantRecord(t.kieran.team.room, name)!.holder!, workerId: record.id })
  connectAwareness(worker.awareness, t.kieran.team.awareness)
  connectAwareness(worker.awareness, t.rohan.team.awareness)
  publishFiles(worker, name, t.base, { [PATH]: NAME }, true)
  await projectWorkers(t.kieran.team, t.kieran.registry, 'Kieran', 'joined')
  expect(t.kieran.team.room.workerViewOf(name)).toMatchObject({ mode: 'here', lead: 'Kieran' })
  expect(t.kieran.team.room.manifestHead.get(name)?.projectedBy).toBeUndefined()
  await t.sync()
  const notes = warnings(t.rohan.local.room.messages(), 'Rohan')
  expect(notes).toHaveLength(1)
  expect.soft(notes[0]).toMatchObject({ priority: 'fyi' })
  expect.soft('text' in notes[0] && notes[0].text).not.toContain('two leads')
  expect(warnings(t.rohan.local.room.messages(), t.rohan.workerName)).toEqual([
    expect.objectContaining({ priority: 'fyi' }),
  ])
})
