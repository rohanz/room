/** Regressions from the 2026-11-15 two-clone team-room runs. Test-only, no sockets. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, completedPublicationOf, gitBlobHash, manifestKey, manifestPaths, memorySnapshot, openConflicts, participantRecord, participantsView, snapshot, versionOf } from '@room/shared'
import type { Identity, ManifestEntry, RoomDoc as RoomDocType } from '@room/shared'
import { rulesFromText } from '@room/roomd/policy'
import { projectWorkers } from '../src/worker-projector.js'
import { Bridge, revokeLeadProjections } from '../src/bridge.js'
import { ConflictSet, reconcileProjectedConflicts, slotKey } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import { closeRegistryForDir, registryForDir, WorkerRegistry } from '../src/worker-registry.js'
import { finishWorker, seedRegistryWorker } from './registry-fixture.js'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { clearFixtureProcesses, finishFixtureProcess, fixtureLiveness, fixtureProcess } from './fixtures/process-liveness.js'
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

function relays(room: RoomDocType, to: string) { return room.messages().filter(m => m.type === 'note' && m.to === to && m.text?.startsWith('[team room]')) }

function conflicts(room: RoomDocType, recipient: string) {
  return openConflicts(room, recipient).filter(c => c.kind === 'merge' || c.kind === 'edit-in-claim' || c.kind === 'claims')
}

describe('two-clone projected worker conflict reproductions (2026-11-15)', () => {
  it('warns each lead and its local worker when full-sharing projected workers edit the same function', async () => {
    const t = await fixture()
    await t.sync()
    for (const [own, other] of [[t.rohan, t.kieran], [t.kieran, t.rohan]]) {
      const views = participantsView(own.team.room, own.team.awareness, Date.now())
      for (const w of [own.workerName, other.workerName]) {
        const projected = snapshot(own.team.room, w, views)!
        expect(projected.fenceValid).toBe(true)
        expect(projected.head).toMatchObject({ level: 'full', coverage: { kind: 'all' }, complete: true })
        expect(projected.entries.get(PATH)).toMatchObject({ state: 'held', held: 'worker', hash: expect.any(String) })
        expect(own.team.room.workerViewOf(w)).toMatchObject({ status: 'running' })
      }
      expect(own.reconcile).toHaveBeenCalledWith({ team: own.team, workers: own.local, owner: own.workerName })
      // Inspect the actual worker/worker slot: this proves the pair was evaluated, not filtered out.
      const slot = own.team.room.doc.getMap('conflicts').get(slotKey(own.workerName, 'merge', other.workerName, PATH))
      expect.soft(slot, `worker pair result: ${JSON.stringify(slot)}`).toMatchObject({ status: expect.stringMatching(/^(conflict|possible)$/) })
      expect(relays(own.local.room, own.workerName)).toEqual([])
      expect(conflicts(own.local.room, own.workerName)).toEqual([])
      expect(conflicts(own.team.room, own.team.me.name)).toEqual([expect.objectContaining({ priority: 'notify' })])
    }
  })

  it('keeps hashless possible conflicts quiet for workers and shows leads their native team state', async () => {
    const t = await fixture()
    // Control: the same pair with hashes withheld takes the existing possible-conflict branch.
    await t.rohan.team.policyStore.setRequested('declared')
    await t.kieran.team.policyStore.setRequested('declared')
    await t.sync()
    for (const [own, other] of [[t.rohan, t.kieran], [t.kieran, t.rohan]]) {
      expect(own.team.room.doc.getMap('conflicts').get(slotKey(own.workerName, 'merge', other.workerName, PATH))).toMatchObject({ status: 'possible' })
      expect(relays(own.local.room, own.workerName)).toEqual([])
      expect(conflicts(own.local.room, own.workerName)).toEqual([])
      expect(conflicts(own.team.room, own.team.me.name)).toEqual([expect.objectContaining({ priority: 'notify' })])
    }
  })


  it('warns a teammate who edits a finished, exited, uncollected projected worker path', async () => {
    const t = await fixture()
    // Keep the teammate unchanged while the worker runs and completes.
    publish(t.kieran.local, t.kieran.workerName, t.base)
    // Make the remote worker's hash resolvable so this case isolates withdrawal from the first bug.
    const known = join(t.kieran.team.dir, 'known-worker.py')
    writeFileSync(known, ORDERS)
    expect(git(t.kieran.team.dir, 'hash-object', '-w', known)).toBe(gitBlobHash(ORDERS))
    await t.sync()
    expect(manifestPaths(t.kieran.team.room, t.rohan.workerName)).toEqual([PATH])

    await finishWorker(t.rohan.local, t.rohan.record.tag, { status: 'done', summary: 'orders limit complete' })
    t.rohan.worker.awareness.setLocalState(null)
    const holder = participantRecord(t.rohan.local.room, t.rohan.workerName)!.holder!
    t.rohan.local.room.participants.set(`${t.rohan.workerName}\0holder`, { ...holder, ended: 'released' })
    await t.rohan.bridge.sync()
    expect(t.kieran.team.room.workerViewOf(t.rohan.workerName)).toMatchObject({ status: 'done' })
    expect((await t.rohan.registry.read(t.rohan.record.id))!.phase).toBe('active') // not collected/retired
    // The same completed source still resolves locally after presence and the name lease end.
    const source = snapshot(t.rohan.local.room, t.rohan.workerName,
      participantsView(t.rohan.local.room, t.rohan.local.awareness, Date.now()))!
    expect(await versionOf(source, PATH)).toMatchObject({ kind: 'text', text: ORDERS })

    publish(t.kieran.team, t.kieran.team.me.name, t.base, NAME)
    await t.kieran.conflicts.reconcile('teammate edits after worker exit')
    expect.soft(manifestPaths(t.kieran.team.room, t.rohan.workerName), 'uncollected completed path stays projected').toContain(PATH)
    expect.soft(conflicts(t.kieran.team.room, t.kieran.team.me.name), 'teammate warned after completed worker exits').not.toEqual([])
  })

  it('warns the teammate about the same known worker version while the source is still live', async () => {
    const t = await fixture()
    const known = join(t.kieran.team.dir, 'known-worker.py')
    writeFileSync(known, ORDERS)
    git(t.kieran.team.dir, 'hash-object', '-w', known)
    publish(t.kieran.team, t.kieran.team.me.name, t.base, NAME)
    await t.sync()
    expect(conflicts(t.kieran.team.room, t.kieran.team.me.name)).toContainEqual(
      expect.objectContaining({ owner: t.kieran.team.me.name, slots: [expect.objectContaining({ path: PATH })] }),
    )
  })

  it('keeps equal held hashes clean without needing either remote blob', async () => {
    const t = await fixture([ORDERS, ORDERS])
    await t.sync()
    for (const [own, other] of [[t.rohan, t.kieran], [t.kieran, t.rohan]]) {
      expect(own.team.room.doc.getMap('conflicts').has(slotKey(own.workerName, 'merge', other.workerName, PATH))).toBe(false)
      for (const recipient of [own.team.me.name, own.workerName]) expect(conflicts(own.local.room, recipient)).toEqual([])
    }
  })

  it.each([0, 1])('does not warn when only side %s changed', async changed => {
    const t = await fixture(changed === 0 ? [ORDERS, undefined] : [undefined, NAME])
    await t.sync()
    for (const own of [t.rohan, t.kieran]) for (const recipient of [own.team.me.name, own.workerName])
      expect(conflicts(own.local.room, recipient)).toEqual([])
  })

  it('compares exact worker texts when the remote version is readable', async () => {
    const t = await fixture()
    for (const [own, otherText] of [[t.rohan, NAME], [t.kieran, ORDERS]] as const) {
      const known = join(own.team.dir, 'known.py')
      writeFileSync(known, otherText); git(own.team.dir, 'hash-object', '-w', known)
    }
    await t.sync()
    for (const [own, other] of [[t.rohan, t.kieran], [t.kieran, t.rohan]]) {
      expect(own.team.room.doc.getMap('conflicts').get(slotKey(own.workerName, 'merge', other.workerName, PATH))).toMatchObject({ status: 'conflict' })
      expect(relays(own.local.room, own.workerName)).toEqual([expect.objectContaining({ priority: 'notify' })])
    }
  })

  it('narrows a finished worker projection and does not restore forbidden hashes', async () => {
    const t = await fixture()
    await finishExited(t.rohan)
    await t.rohan.bridge.sync()
    expect(t.rohan.team.room.manifest.get(manifestKey(t.rohan.workerName, '1'))!.get(PATH)?.hash).toBe(gitBlobHash(ORDERS))
    await t.rohan.team.policyStore.setRequested('declared')
    expect(t.rohan.team.room.manifest.get(manifestKey(t.rohan.workerName, '1'))!.get(PATH)?.hash).toBeUndefined()
    await t.rohan.bridge.sync()
    expect(t.rohan.team.room.manifest.get(manifestKey(t.rohan.workerName, '1'))!.get(PATH)).toMatchObject({ state: 'held' })
    expect(t.rohan.team.room.manifest.get(manifestKey(t.rohan.workerName, '1'))!.get(PATH)?.hash).toBeUndefined()
    await t.rohan.team.policyStore.setRequested('intent')
    await t.rohan.bridge.sync()
    expect(manifestPaths(t.rohan.team.room, t.rohan.workerName)).toEqual([])
  })

  it('does not inherit completed output when a resumed run has not published, even if it reports done', async () => {
    const t = await fixture()
    await finishExited(t.rohan)
    await t.rohan.bridge.sync()
    expect(manifestPaths(t.rohan.team.room, t.rohan.workerName)).toEqual([PATH])
    const record = await mutateWorkerFixture(t.rohan.registry, t.rohan.record.id, old => ({ ...old, seq: old.seq + 1,
      runs: [...old.runs, { ...old.runs[0], n: 2, mode: 'resume', nonce: 'second-run', intentAt: Date.now() + 1,
        launch: { outcome: 'launched', pid: 800003, process: fixtureProcess(800003, 'second-run', 'codex') } }] }))
    await projectWorkers(t.rohan.local, t.rohan.registry, t.rohan.local.me.name, 'joined')
    await t.rohan.bridge.sync()
    expect(manifestPaths(t.rohan.team.room, t.rohan.workerName)).toEqual([])
    await t.rohan.registry.writeReport(record.id, { run: 2, nonce: 'second-run', chain: [], joinedAt: record.runs[1].intentAt,
      done: { at: Date.now(), summary: 'no new publication', changed: [] } })
    finishFixtureProcess(800003)
    await t.rohan.registry.writeExit(record.id, { run: 2, code: 0, at: Date.now(), witnessed: true })
    await projectWorkers(t.rohan.local, t.rohan.registry, t.rohan.local.me.name, 'joined')
    await t.rohan.bridge.sync()
    expect(manifestPaths(t.rohan.team.room, t.rohan.workerName)).toEqual([])
    publish(t.rohan.local, t.rohan.workerName, t.base, NAME)
    const head = t.rohan.local.room.manifestHead.get(t.rohan.workerName)!
    t.rohan.local.room.manifestHead.set(t.rohan.workerName, { ...head, scannedAt: record.runs[1].intentAt + 1 })
    await t.rohan.bridge.sync()
    expect(t.rohan.team.room.manifest.get(manifestKey(t.rohan.workerName, '1'))!.get(PATH)?.hash).toBe(gitBlobHash(NAME))
  })

  it('never gives a same-tag successor its predecessor publication', async () => {
    const t = await fixture(), own = t.rohan
    await finishExited(own)
    const predecessor = completedPublicationOf(own.local.room, own.workerName)!
    await own.registry.beginRetirement(own.record.id, await own.registry.archiveOf(own.record, { summary: 'collected' }))
    await projectWorkers(own.local, own.registry, own.local.me.name, 'joined')
    await own.bridge.sync()
    own.local.room.doc.getMap('completedPublications').set(predecessor.key, predecessor) // a late old snapshot
    await seedRegistryWorker(own.team.dir, own.record.tag, { name: own.workerName, host: 'codex', mode: 'local',
      room: own.local.roomName, projectedInto: TEAM, lead: own.record.lead, base: t.base, carriedBase: t.base })
    await own.bridge.sync()
    expect(manifestPaths(own.team.room, own.workerName)).toEqual([])
  })

  it('keeps a live projection between the done report and host exit, then retains the final source', async () => {
    const t = await fixture(), own = t.rohan, run = own.record.runs[0]
    await own.registry.writeReport(own.record.id, { run: run.n, nonce: run.nonce, chain: [], joinedAt: own.record.createdAt,
      done: { at: Date.now(), summary: 'reported, process still alive', changed: [PATH] } })
    await projectWorkers(own.local, own.registry, own.local.me.name, 'joined')
    expect(own.local.room.workerViewOf(own.workerName)?.status).toBe('running')
    await own.bridge.sync()
    expect(manifestPaths(own.team.room, own.workerName)).toEqual([PATH])
    await finishExited(own)
    await own.bridge.sync()
    expect(manifestPaths(own.team.room, own.workerName)).toEqual([PATH])
  })

  it('refuses a final source whose holder does not match the admitted run process', async () => {
    const t = await fixture(), own = t.rohan, run = own.record.runs[0]
    await own.registry.writeReport(own.record.id, { run: run.n, nonce: run.nonce, chain: [{ pid: 999, startTime: 'other', executable: 'node' }],
      joinedAt: own.record.createdAt, done: { at: Date.now(), summary: 'done', changed: [PATH] } })
    await finishExited(own)
    await own.bridge.sync()
    expect(manifestPaths(own.team.room, own.workerName)).toEqual([])
  })

  it('restores a finished uncollected projection from the existing cache under a restarted lead fence', async () => {
    const t = await fixture(), own = t.rohan
    await finishExited(own)
    const saved = memorySnapshot(own.local.room.doc)
    const cold = room(); Y.applyUpdate(cold.doc, saved)
    const local = session(cold, own.local.dir, own.local.me.name, t.base, true)
    own.bridge.stop()
    // A new local lead reasserts registry views; the cache never supplies presence or authority.
    await projectWorkers(local, own.registry, local.me.name, 'joined')
    own.team.room.participants.set(`${own.team.me.name}\0holder`, { sessionId: `session-${own.team.me.name}`, epoch: 2 })
    own.team.room.participants.set(`${own.team.me.name}\0git`, { ...participantRecord(own.team.room, own.team.me.name)!.git!, fence: '2' })
    own.team.daemon.fence = '2'
    const bridge = new Bridge(own.team, local, { registry: own.registry, debounceMs: 0 })
    cleanup.push(() => bridge.stop())
    await bridge.sync()
    expect(own.team.room.manifestHead.get(own.workerName)).toMatchObject({ fence: '2', projectedFrom: own.record.id, coverage: { kind: 'all' } })
    expect(manifestPaths(own.team.room, own.workerName)).toEqual([PATH])
    expect(await versionOf(snapshot(cold, own.workerName, participantsView(cold, local.awareness, Date.now())), PATH)).toMatchObject({ kind: 'text', text: ORDERS })
    expect(own.team.room.overlays.has(manifestKey(own.workerName, '2'))).toBe(false)
  })

  it.each(['R+review notes', 'R+' + 'x'.repeat(65)])('warns both families with unrelated ordinary participant %s present', async bystander => {
    const t = await fixture()
    session(t.rohan.team.room, t.rohan.team.dir, bystander, t.base, false)
    await t.sync()
    for (const own of [t.rohan, t.kieran]) expect(conflicts(own.team.room, own.team.me.name)).toHaveLength(1)
  })

  it('bounds registry snapshots for a stable projected conflict reconcile', async () => {
    const t = await fixture()
    await t.sync()
    const reads = vi.spyOn(WorkerRegistry.prototype, 'snapshot')
    try {
      await reconcileProjectedConflicts({ team: t.rohan.team, workers: t.rohan.local, owner: t.rohan.workerName })
      expect(reads.mock.calls.length).toBeLessThanOrEqual(23)
      process.stderr.write(`projected registry snapshots per stable reconcile: ${reads.mock.calls.length}\n`)
    } finally { reads.mockRestore() }
  })



})

async function finishExited(own: Awaited<ReturnType<typeof fixture>>['rohan']) {
  await finishWorker(own.local, own.record.tag, { status: 'done' })
  own.worker.awareness.setLocalState(null)
  const holder = participantRecord(own.local.room, own.workerName)!.holder!
  own.local.room.participants.set(`${own.workerName}\0holder`, { ...holder, ended: 'released' })
}
