import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, digestPath, gitBlobHash, manifestKey, participantRecord, participantsView, snapshot, versionOf } from '@room/shared'
import type { Identity, ClaimMsg, ManifestEntry, ManifestHead, NoteMsg, PlanMsg, ReleaseMsg } from '@room/shared'
import { rulesFromText } from '@room/roomd/policy'
import { Bridge } from '../src/bridge.js'
import { PolicyStore } from '../src/policy-store.js'
import { applySessionPolicy } from '../src/session.js'
import { createAreas } from '../src/tools/scope.js'
import { Ledger } from '../src/ledger.js'
import type { Session } from '../src/session.js'
import { closeRegistryForDir, registryForDir, type WorkerRegistry } from '../src/worker-registry.js'
import type { WorkerRecord } from '../src/worker-status.js'
import { hubAppend } from '@room/shared/testing'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'
import { seedRegistryWorker } from './registry-fixture.js'

// Seeding a registry worker takes seconds (lease guards and process probes).
vi.setConfig({ testTimeout: 30_000 })

let dir: string, B: string, C: string
const TEAM = 'github.com/rohanz/x/main', LOCAL = 'local/x/main'
const LEAD_FENCE = '1'
const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
const worker: Identity = { name: 'rohanz+money', kind: 'agent', owner: 'rohanz', label: 'money' }
const kieran: Identity = { name: 'kieran', kind: 'agent', owner: 'kieran' }
const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
function fakeSession(room: RoomDoc, me: Identity, roomName: string, local: boolean, policy = testPolicyStore()): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle', sessionId: LEAD_FENCE })
  return {
    policyStore: policy,
    room, awareness, me, dir, roomUrl: `ws://127.0.0.1:9/${encodeURIComponent(roomName)}`, roomName, browserUrl: 'http://x',
    ...hubSeam(room), provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base: B,
      fence: LEAD_FENCE, inputs: { policy: policy.policy, rules: rulesFromText('secret/\n', 1 << 20, 1 << 24), head: B } } as never,
    shareMax: 'full', shareRequested: 'full',
    ...(local ? { local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} } } : {}),
  } as Session
}
/** A participant whose holder session is present in `s`'s awareness, as the hub and its presence would show it. */
function present(s: Session, who: Identity, sessionId: string): void {
  s.room.participants.set(`${who.name}\u0000holder`, { sessionId, epoch: 1, machine: 'm', pid: 1, startTime: 't', executable: 'e' })
  if (who.name === s.me.name) return
  const other = new Awareness(new Y.Doc())
  other.setLocalState({ user: { ...who, color: '#111' }, status: 'idle', sessionId })
  applyAwarenessUpdate(s.awareness, encodeAwarenessUpdate(other, [other.clientID]), 'test')
}
/** The worker's own workers-room manifest (against C), as its daemon publishes it. */
function publishSource(room: RoomDoc, entries: Record<string, Omit<ManifestEntry, 'fence' | 'at'>>, head: Partial<ManifestHead> = {}): void {
  const fence = '1'
  room.doc.transact(() => {
    const map = new Y.Map<ManifestEntry>()
    room.manifest.set(manifestKey(worker.name, fence), map)
    for (const [p, e] of Object.entries(entries)) map.set(p, { ...e, at: 5, fence })
    room.manifestHead.set(worker.name, { base: C, fence, coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true, ...head })
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-bridge-'))
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  writeFileSync(join(dir, 'gone.py'), 'bye\n')
  git('add', '.'); git('commit', '-qm', 'init')
  B = git('rev-parse', 'HEAD').trim()
  // The carried commit C: the lead's uncommitted work at spawn.
  writeFileSync(join(dir, 'carried.py'), 'lead wip\n')
  git('add', '.'); git('commit', '-qm', 'room: carried-in uncommitted work from rohanz')
  C = git('rev-parse', 'HEAD').trim()
  git('reset', '-q', '--hard', B)
})
afterEach(async () => { await closeRegistryForDir(dir) })

/** Let the bridge's posts and projection passes settle. */
const settle = () => new Promise(r => setTimeout(r, 20))

async function localWorker(registry: WorkerRegistry, tag = 'money', patch: Partial<WorkerRecord> = {}): Promise<WorkerRecord> {
  return (await seedRegistryWorker(dir, tag, { name: `rohanz+${tag}`, mode: 'local', room: LOCAL, projectedInto: TEAM,
    lead: { participant: lead.name, room: LOCAL, instance: registry.instance }, base: C, carriedBase: C, ...patch })).record
}

async function setup(options: { policy?: ReturnType<typeof testPolicyStore>; start?: boolean } = {}) {
  const team = pair(), local = pair()
  team.a.setMeta({ repo: 'x', branch: 'main', base: B }); local.a.setMeta({ repo: 'x', branch: 'main', base: B })
  const teamLead = fakeSession(team.a, lead, TEAM, false, options.policy)
  const localLead = fakeSession(local.a, lead, LOCAL, true)
  const registry = await registryForDir(dir)
  const record = await localWorker(registry)
  team.a.participants.set(`${lead.name}\u0000git`, { branch: 'main', head: B, base: B, anchored: true, rev: 1, fence: LEAD_FENCE })
  present(teamLead, lead, LEAD_FENCE)
  present(localLead, worker, 'worker-session')
  const bridge = new Bridge(teamLead, localLead, { debounceMs: 0, registry })
  if (options.start !== false) { bridge.start(); await bridge.sync() }
  return { team, local, teamLead, localLead, bridge, registry, record }
}

describe('Bridge: a lead in a team room with a local workers room', () => {
  it('keeps an addressed team interrupt relayed between spawn and worker join', async () => {
    const t = await setup()
    const old = hubAppend<NoteMsg>(t.local.a, lead, { type: 'note', text: 'before spawn', priority: 'notify' })
    hubAppend<NoteMsg>(t.team.b, kieran, { type: 'note', priority: 'interrupt', text: 'stop now' })
    await settle()
    const relayed = t.local.b.messages().find(m => m.type === 'note' && m.to === worker.name)!
    // The worker's frontier is above the old broadcast; the relayed copy is addressed, so it is owed regardless.
    const workerSession = fakeSession(t.local.b, worker, LOCAL, true)
    const owed = new Ledger({ sessionId: () => 'worker-session', route: () => ({}) }).candidates(workerSession).map(m => m.id)
    expect(owed).not.toContain(old.id)
    expect(owed).toContain(relayed.id)
  })

  it("coordination[lead] is the union of the workers' declared and changed paths; scopes[lead] is never touched (manifest §5.6)", async () => {
    const t = await setup()
    const own = { by: lead.name, byKind: lead.kind, area: 'api', summary: 'auth', paths: ['api/auth.py'] }
    t.team.a.setScope(own)
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/models.py'] })
    await settle()
    expect(t.team.b.coordination.get(lead.name)).toMatchObject({ paths: ['api/models.py'], workers: [worker.name] })
    publishSource(t.local.b, { 'tests/test_money.py': { change: 'A', state: 'shared', hash: 'h', size: 2 } })
    await t.bridge.sync()
    expect(t.team.b.coordination.get(lead.name)?.paths).toEqual(['api/models.py', 'tests/test_money.py'])
    expect(t.team.b.scope(lead.name)).toMatchObject({ area: 'api', summary: 'auth', paths: ['api/auth.py'] })
    // the team never hears a scope message on the lead's behalf, and never anything from the worker
    expect(t.team.b.messages().some(m => m.type === 'scope' || m.from === worker.name)).toBe(false)
    t.local.a.clearScope(worker.name)
    publishSource(t.local.b, {})
    await settle()
    expect(t.team.b.coordination.has(lead.name)).toBe(false)
    expect(t.team.b.scope(lead.name)?.paths).toEqual(['api/auth.py'])
  })

  it('worker coordination never calls the lead daemon applyInputs (B1)', async () => {
    const t = await setup({ start: false })
    const applyInputs = vi.fn()
    ;(t.teamLead.daemon as unknown as { applyInputs: typeof applyInputs }).applyInputs = applyInputs
    t.bridge.start()
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/'] })
    await settle()
    expect(t.team.b.coordination.get(lead.name)?.paths).toEqual(['api/'])
    expect(applyInputs).not.toHaveBeenCalled()
    t.bridge.stop()
    expect(t.team.b.coordination.has(lead.name)).toBe(false)
  })

  it("workers' claims are mirrored into the team room under the lead's name and removed with the original", async () => {
    const t = await setup()
    const c = t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'bump x' })
    const mirrored = t.team.b.openClaims()
    expect(mirrored).toHaveLength(1)
    expect(mirrored[0]).toMatchObject({ by: 'rohanz', path: 'app.py', from: 1, to: 1, intent: '[money] bump x', mirrorOf: 'money' })
    t.local.b.removeClaim(c.id)
    expect(t.team.b.openClaims()).toEqual([])
  })

  it('omits a worker claim digest outside the lead text grant', async () => {
    const t = await setup({ policy: testPolicyStore('declared') })
    const c = t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'edit', claimedHash: 'f'.repeat(64) })
    expect(c.claimedHash).toBe('f'.repeat(64))
    expect(t.team.b.openClaims()[0]?.claimedHash).toBeUndefined()
  })

  it('does not project complete coverage from a worker manifest on the wrong baseline', async () => {
    const t = await setup()
    publishSource(t.local.b, { 'app.py': { change: 'M', state: 'shared', hash: gitBlobHash('worker\n'), size: 7 } }, { base: B })
    await t.bridge.sync()
    expect(t.team.b.manifestHead.get(worker.name)).toMatchObject({ complete: false, coverage: { kind: 'none', reason: 'starting' } })
  })

  it('a team message touching a worker path is re-posted to that worker locally: claims at notify, plans as interrupts', async () => {
    const t = await setup()
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/'] })
    hubAppend<ClaimMsg>(t.team.b, kieran, { type: 'claim', claimId: 'c_k', path: 'api/handlers.py', from_line: 1, to_line: 5, intent: 'renaming validate' })
    await settle()
    const relayed = t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)
    expect(relayed).toHaveLength(1)
    expect(relayed[0].priority).toBe('notify')
    expect((relayed[0] as { text: string }).text).toContain('[team room]')
    hubAppend<ClaimMsg>(t.team.b, kieran, { type: 'claim', claimId: 'c_k2', path: 'web/index.ts', from_line: 1, to_line: 5, intent: 'css' })
    hubAppend<ClaimMsg>(t.team.a, lead, { type: 'claim', claimId: 'c_me', path: 'api/x.py', from_line: 1, to_line: 1, intent: 'mine' })
    await settle()
    expect(t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)).toHaveLength(1)
    hubAppend<PlanMsg>(t.team.b, kieran, { type: 'plan', status: 'cancelled', claimId: 'c1', path: 'api/handlers.py', plan: { kind: 'rename', symbol: 'validate' }, text: 'plan cancelled' })
    await settle()
    expect(t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name).at(-1)?.priority).toBe('interrupt')
  })

  it('relays each team broadcast notify or interrupt to every worker once, without fyi or echoes', async () => {
    const t = await setup()
    await localWorker(t.registry, 'tax')
    const send = (priority: 'fyi' | 'notify' | 'interrupt') => hubAppend<NoteMsg>(t.team.b, kieran, { type: 'note', priority, text: priority })
    send('fyi'); send('notify'); send('interrupt')
    await settle()
    const notes = t.local.b.messages().filter((m): m is NoteMsg => m.type === 'note')
    expect(notes.map(m => [m.to, m.priority])).toEqual([
      [worker.name, 'notify'], ['rohanz+tax', 'notify'], [worker.name, 'interrupt'], ['rohanz+tax', 'interrupt'],
    ])
  })

  it('unmirroring a claim posts a release to the team, carrying unfulfilled plans; a mirror removed by others is restored', async () => {
    const t = await setup()
    const c = t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'rename x', plans: [{ kind: 'rename', symbol: 'x', detail: 'y' }] })
    const first = t.team.b.openClaims()[0]
    t.team.a.removeClaim(first.id)
    const again = t.team.b.openClaims()
    expect(again).toHaveLength(1)
    expect(again[0].id).not.toBe(first.id)
    hubAppend<ReleaseMsg>(t.local.b, worker, { type: 'release', claimId: c.id, path: 'app.py', summary: 'gave up', unfulfilled: [{ kind: 'rename', symbol: 'x', detail: 'y' }] })
    t.local.b.removeClaim(c.id)
    await settle()
    const rel = t.team.b.messages().filter((m): m is ReleaseMsg => m.type === 'release')
    expect(rel).toHaveLength(1)
    expect(rel[0]).toMatchObject({ from: 'rohanz', claimId: again[0].id, path: 'app.py', summary: '[money] gave up' })
    expect(t.team.b.openClaims()).toEqual([])
  })

  it('stop() removes the mirrored claims and stops relaying', async () => {
    const t = await setup()
    t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'bump x' })
    expect(t.team.b.openClaims()).toHaveLength(1)
    t.bridge.stop()
    expect(t.team.b.openClaims()).toEqual([])
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'late', paths: ['late.py'] })
    await settle()
    expect(t.team.b.coordination.has(lead.name)).toBe(false)
  })
})

describe('Bridge: the team projection of a local worker (manifest §5.5, registry §13)', () => {
  async function withPolicyCallback(t: Awaited<ReturnType<typeof setup>>): Promise<PolicyStore> {
    const daemon = t.teamLead.daemon
    ;(daemon as unknown as { applyInputs: (inputs: typeof daemon.inputs) => void }).applyInputs = inputs => {
      ;(daemon as unknown as { inputs: typeof daemon.inputs }).inputs = inputs
    }
    const store = await PolicyStore.open({ dir, room: TEAM, participant: lead.name, requested: 'full',
      onChange: policy => applySessionPolicy(daemon, policy) })
    t.teamLead.policyStore = store
    return store
  }

  it('withdraws projected metadata and text before a narrowing policy mutation resolves', async () => {
    const t = await setup({ start: false })
    const store = await withPolicyCallback(t)
    await store.declare(['src/'])
    publishSource(t.local.b, {
      'app.py': { change: 'M', state: 'shared', hash: gitBlobHash('x = 2\n'), size: 6, baseHash: gitBlobHash('x = 1\n') },
      'src/allowed.py': { change: 'A', state: 'shared', hash: gitBlobHash('allowed\n'), size: 8 },
    })
    await t.bridge.sync()
    const key = manifestKey(worker.name, LEAD_FENCE)
    const map = t.team.a.manifest.get(key)!
    const overlay = new Y.Map<Y.Text>()
    overlay.set('app.py', new Y.Text('x = 2\n'))
    overlay.set('src/allowed.py', new Y.Text('allowed\n'))
    t.team.a.overlays.set(key, overlay)
    const otherKey = manifestKey('other+worker', LEAD_FENCE)
    const otherEntry = { change: 'M' as const, state: 'held' as const, held: 'worker' as const,
      hash: gitBlobHash('other\n'), size: 6, at: 1, fence: LEAD_FENCE }
    const otherMap = new Y.Map<ManifestEntry>()
    otherMap.set('other.py', otherEntry)
    t.team.a.manifest.set(otherKey, otherMap)
    t.team.a.manifestHead.set('other+worker', { ...t.team.a.manifestHead.get(worker.name)!,
      projectedBy: 'other', projectedFrom: 'other-worker' })
    expect(map.get('app.py')?.hash).toBeDefined()

    await store.setRequested('declared')
    expect(map.get('app.py')).not.toHaveProperty('hash')
    expect(map.get('app.py')).not.toHaveProperty('baseHash')
    expect(map.get('app.py')).not.toHaveProperty('size')
    expect(t.team.a.overlays.get(key)?.has('app.py')).toBe(false)
    expect(map.get('src/allowed.py')?.hash).toBe(gitBlobHash('allowed\n'))
    expect(t.team.a.overlays.get(key)?.has('src/allowed.py')).toBe(true)
    expect(t.team.a.manifestHead.get(worker.name)).toMatchObject({ level: 'declared', textPrefixes: ['src/'] })
    expect(otherMap.get('other.py')).toEqual(otherEntry)

    await store.setRequested('intent')
    expect(map.size).toBe(0)
    expect(t.team.a.manifestHead.get(worker.name)).toMatchObject({ level: 'intent', coverage: { kind: 'none', reason: 'unprojectable' }, complete: false })
    expect(otherMap.get('other.py')).toEqual(otherEntry)
  })

  it('keeps synchronous withdrawal when an older projection prepare completes', async () => {
    const t = await setup({ start: false })
    const store = await withPolicyCallback(t)
    publishSource(t.local.b, { 'app.py': { change: 'M', state: 'shared', hash: gitBlobHash('x = 2\n'), size: 6 } })
    await t.bridge.sync()
    const key = manifestKey(worker.name, LEAD_FENCE)
    const map = t.team.a.manifest.get(key)!
    let entered!: () => void, release!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const target = t.bridge as unknown as { composeFacts: (...args: unknown[]) => Promise<unknown> }
    const original = target.composeFacts.bind(t.bridge)
    vi.spyOn(target, 'composeFacts').mockImplementation(async (...args) => {
      const facts = await original(...args)
      entered()
      await gate
      return facts
    })
    const oldPass = t.bridge.sync()
    await preparing
    await store.setRequested('intent')
    expect(map.size).toBe(0)
    release()
    await oldPass
    expect(map.size).toBe(0)
    expect(t.team.a.manifestHead.get(worker.name)?.level).toBe('intent')
  })
  it('F5 yields while preparing 3,000 B..C paths and does no map reads inside the atomic apply', async () => {
    const t = await setup({ start: false })
    git('checkout', '-q', C)
    for (let i = 0; i < 3000; i++) writeFileSync(join(dir, `many-${String(i).padStart(4, '0')}.py`), 'x\n')
    git('add', '.'); git('commit', '-qm', 'many carried files')
    C = git('rev-parse', 'HEAD').trim()
    git('checkout', '-q', B)
    await t.registry.update(t.record.id, old => ({ ...old, base: C, carriedBase: C, seq: old.seq + 1 }))
    publishSource(t.local.b, {}, { base: C })
    await t.bridge.sync() // create the previous Y map so its reads can be observed

    const key = manifestKey(worker.name, LEAD_FENCE)
    const map = t.team.a.manifest.get(key)!
    let inside = false, readsInside = 0, yielded = false, turnAtApply = false
    const originalGet = map.get.bind(map)
    vi.spyOn(map, 'get').mockImplementation((path: string) => {
      if (inside) readsInside++
      return originalGet(path)
    })
    t.team.a.doc.on('beforeTransaction', () => { inside = true; turnAtApply = yielded })
    t.team.a.doc.on('afterTransaction', () => { inside = false })
    const rules = t.teamLead.daemon.inputs.rules
    const originalIgnores = rules.roomIgnore.ignores.bind(rules.roomIgnore)
    let scheduled = false
    rules.roomIgnore.ignores = (path: string) => {
      if (!scheduled) { scheduled = true; setImmediate(() => { yielded = true }) }
      return originalIgnores(path)
    }
    await t.bridge.sync()
    expect(map.size).toBe(3001) // the earlier carried.py plus the new B..C paths
    expect(turnAtApply).toBe(true)
    expect(readsInside).toBe(0)
    await t.teamLead.policyStore.setRequested('intent')
    await t.bridge.sync()
    expect(map.size).toBe(0)
    expect(t.team.a.manifestHead.get(worker.name)).toMatchObject({ level: 'intent', complete: false })
  })
  it('F5 rechecks a narrowing policy after a preparation yield before writing hashes', async () => {
    const policy = testPolicyStore()
    const t = await setup({ policy, start: false })
    const entries = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`source-${i}.py`,
      { change: 'A' as const, state: 'shared' as const, hash: gitBlobHash('x\n'), size: 2 }]))
    publishSource(t.local.b, entries)
    const rules = t.teamLead.daemon.inputs.rules
    const originalIgnores = rules.roomIgnore.ignores.bind(rules.roomIgnore)
    let scheduled = false
    rules.roomIgnore.ignores = (path: string) => {
      if (!scheduled) {
        scheduled = true
        setImmediate(() => { void policy.setRequested('intent') })
      }
      return originalIgnores(path)
    }
    await t.bridge.sync()
    expect(scheduled).toBe(true)
    expect(t.team.a.manifestHead.get(worker.name)?.level).toBe('intent')
    expect(t.team.a.manifest.get(manifestKey(worker.name, LEAD_FENCE))?.size ?? 0).toBe(0)
  })
  it('N6 renders accepted, stale and ended projected worker status in participant lines', async () => {
    const t = await setup({ start: false })
    await t.bridge.sync()
    expect([...t.team.a.workerViews.values()]).toHaveLength(1)
    expect([...t.team.a.workerViews.values()][0]).toMatchObject({ name: worker.name, mode: 'local' })
    expect(t.teamLead.room.workerViewOf(worker.name)).toBeDefined()
    expect(t.teamLead.room.acceptedWorkerViewOf(worker.name)).toBeDefined()
    const { personLine } = createAreas({ ctx: {}, log: () => {}, base: () => B, presences: () => [],
      others: () => [], shareOf: () => 'full', now: () => Date.now(), isMe: () => false } as never)
    expect(personLine(t.teamLead, worker.name)).toContain('via rohanz (running)')
    const holder = t.team.a.participants.get(`${lead.name}\u0000holder`)!
    t.team.a.participants.set(`${lead.name}\u0000holder`, { ...holder, epoch: 2 })
    expect(personLine(t.teamLead, worker.name)).toContain('projection stale/updating via rohanz')
    t.team.a.participants.set(`${lead.name}\u0000holder`, holder)
    const view = t.team.a.workerViews.get(t.record.id)!
    t.team.a.workerViews.set(t.record.id, { ...view, status: 'done' })
    expect(personLine(t.teamLead, worker.name)).toContain('via rohanz (done)')
  })
  it('N2 leaves a projection untouched during a paused lease, then retires it with authority', async () => {
    const t = await setup({ start: false })
    publishSource(t.local.b, {})
    await t.bridge.sync()
    expect(t.team.b.manifestHead.has(worker.name)).toBe(true)
    ;(t.teamLead.daemon as { fence?: string }).fence = undefined
    await t.bridge.sync()
    expect(t.team.b.manifestHead.has(worker.name)).toBe(true)
    expect(t.team.b.participants.has(`${worker.name}\u0000proj`)).toBe(true)
    ;(t.teamLead.daemon as { fence?: string }).fence = LEAD_FENCE
    await t.registry.beginRetirement(t.record.id, t.registry.archiveOf(t.record, { summary: 'done' }))
    await t.bridge.sync()
    expect(t.team.b.manifestHead.has(worker.name)).toBe(false)
  })

  it('M2 does not resurrect a retired worker after composition fails', async () => {
    const t = await setup({ start: false })
    publishSource(t.local.b, {})
    const target = t.bridge as unknown as { composeFacts: (...args: unknown[]) => Promise<unknown> }
    vi.spyOn(target, 'composeFacts').mockImplementation(async () => {
      await t.registry.beginRetirement(t.record.id, t.registry.archiveOf(t.record, { summary: 'done' }))
      throw new Error('git unavailable')
    })
    await t.bridge.sync()
    expect(t.team.b.manifestHead.has(worker.name)).toBe(false)
    expect(t.team.b.participants.has(`${worker.name}\u0000proj`)).toBe(false)
  })

  it('M3 excludes a carried symlink without publishing its target hash or name', async () => {
    const t = await setup({ start: false })
    symlinkSync('private-target', join(dir, 'link.py'))
    git('add', 'link.py'); git('commit', '-qm', 'carried symlink')
    C = git('rev-parse', 'HEAD').trim()
    await t.registry.update(t.record.id, old => ({ ...old, base: C, seq: old.seq + 1 }))
    publishSource(t.local.b, {})
    await t.bridge.sync()
    const head = t.team.b.manifestHead.get(worker.name)!
    expect(t.team.b.manifest.get(manifestKey(worker.name, LEAD_FENCE))?.has('link.py')).toBe(false)
    expect(head.excluded).toContain(digestPath(t.team.b.ensureRoomSalt(), 'link.py'))
  })
  it('M2 abandons a projection when the lead narrows sharing during composition', async () => {
    const policy = testPolicyStore()
    const t = await setup({ policy, start: false })
    publishSource(t.local.b, { 'app.py': { change: 'M', state: 'shared', hash: gitBlobHash('x = 2\n'), size: 6 } })
    await t.bridge.sync()
    expect(t.team.b.manifest.get(manifestKey(worker.name, LEAD_FENCE))?.has('app.py')).toBe(true)
    const target = t.bridge as unknown as { composeFacts: (...args: unknown[]) => Promise<unknown> }
    const original = target.composeFacts.bind(t.bridge)
    vi.spyOn(target, 'composeFacts').mockImplementation(async (...args) => {
      const facts = await original(...args)
      await policy.setRequested('intent')
      return facts
    })
    await t.bridge.sync()
    expect(t.team.b.manifestHead.get(worker.name)?.level).not.toBe('full')
    expect(t.team.b.manifest.get(manifestKey(worker.name, LEAD_FENCE))?.size ?? 0).toBe(0)
  })

  it('M3 applies the lead ignore and size rules to source and carried paths', async () => {
    const t = await setup({ start: false })
    ;(t.teamLead.daemon.inputs as { rules: ReturnType<typeof rulesFromText> }).rules = rulesFromText('app.py\n', 4, 8)
    publishSource(t.local.b, { 'app.py': { change: 'M', state: 'shared', hash: gitBlobHash('x = 2\n'), size: 6 } })
    await t.bridge.sync()
    const entries = t.team.b.manifest.get(manifestKey(worker.name, LEAD_FENCE))!
    expect(entries.has('app.py')).toBe(false)
    expect(entries.has('carried.py')).toBe(false) // 9-byte carried file exceeds the cap
    expect(t.team.b.manifestHead.get(worker.name)?.excluded).toHaveLength(2)
  })

  it('M3 applies the lead Git ignore and total budget to projected source facts', async () => {
    const t = await setup({ start: false })
    writeFileSync(join(dir, '.gitignore'), 'ignored.py\n')
    ;(t.teamLead.daemon.inputs as { rules: ReturnType<typeof rulesFromText> }).rules = rulesFromText('', 1 << 20, 8)
    publishSource(t.local.b, {
      'a.py': { change: 'A', state: 'shared', hash: gitBlobHash('aaaaaa'), size: 6 },
      'b.py': { change: 'A', state: 'shared', hash: gitBlobHash('bbbbbb'), size: 6 },
      'ignored.py': { change: 'A', state: 'shared', hash: gitBlobHash('x'), size: 1 },
    })
    await t.bridge.sync()
    const entries = t.team.b.manifest.get(manifestKey(worker.name, LEAD_FENCE))!
    expect([...entries.keys()]).toEqual(['a.py'])
    expect(t.team.b.manifestHead.get(worker.name)?.excluded).toHaveLength(3) // b.py, carried.py, ignored.py
  })

  it('S3 refreshes at and scannedAt without changing semantic revisions', async () => {
    const t = await setup({ start: false })
    publishSource(t.local.b, { 'app.py': { change: 'M', state: 'shared', hash: gitBlobHash('x = 2\n'), size: 6 } })
    await t.bridge.sync()
    const first = t.team.b.manifestHead.get(worker.name)!
    const key = manifestKey(worker.name, LEAD_FENCE)
    await new Promise(resolve => setTimeout(resolve, 3))
    t.local.b.manifest.get(manifestKey(worker.name, '1'))!.set('app.py', { change: 'M', state: 'shared', hash: gitBlobHash('x = 2\n'), size: 6, at: 99, fence: '1' })
    await t.bridge.sync()
    expect(t.team.b.manifest.get(key)?.get('app.py')?.at).toBe(99)
    expect(t.team.b.manifestHead.get(worker.name)?.scannedAt).toBeGreaterThan(first.scannedAt)
    expect(t.team.b.manifestHead.get(worker.name)?.semRev).toBe(first.semRev)
    const second = t.team.b.manifestHead.get(worker.name)!
    await new Promise(resolve => setTimeout(resolve, 3))
    await t.bridge.sync()
    expect(t.team.b.manifestHead.get(worker.name)?.scannedAt).toBeGreaterThan(second.scannedAt)
    expect(t.team.b.manifestHead.get(worker.name)?.rev).toBe(first.rev)
    expect(t.team.b.manifestHead.get(worker.name)?.semRev).toBe(first.semRev)
  })
  it("projects the worker against the lead's team base: projectedFrom, the lead's fence, held: 'worker', and everything between B and C", async () => {
    const t = await setup({ start: false })
    const hash = gitBlobHash('x = 2\n')
    publishSource(t.local.b, { 'app.py': { change: 'M', state: 'shared', hash, size: 6 }, 'gone.py': { change: 'D', state: 'shared' } })
    t.bridge.start()
    await t.bridge.sync()
    const head = t.team.b.manifestHead.get(worker.name)!
    expect(head).toMatchObject({ base: B, fence: LEAD_FENCE, projectedFrom: t.record.id, projectedBy: lead.name, complete: true, coverage: { kind: 'all' } })
    const entries = Object.fromEntries(t.team.b.manifest.get(manifestKey(worker.name, LEAD_FENCE))!.entries())
    expect(entries['app.py']).toMatchObject({ change: 'M', state: 'held', held: 'worker', hash, size: 6, fence: LEAD_FENCE })
    expect(entries['gone.py']).toMatchObject({ change: 'D', state: 'shared' })
    // The carried commit's own change, which the worker did not touch: hash = the blob at C.
    expect(entries['carried.py']).toMatchObject({ change: 'A', state: 'held', held: 'worker', hash: gitBlobHash('lead wip\n') })
    const record = participantRecord(t.team.b, worker.name)!
    expect(record.proj).toEqual({ projectedFrom: t.record.id, projectedBy: lead.name })
    expect(record.git).toMatchObject({ base: B, fence: LEAD_FENCE, branch: 'main' })
    // No text reaches the team room, and the lead's own records are untouched.
    expect(t.team.b.overlays.has(worker.name)).toBe(false)
    expect(t.team.b.scope(lead.name)).toBeUndefined()
    // Team readers accept it while the lead's holder is live: held, never base.
    const view = participantsView(t.team.b, t.teamLead.awareness, Date.now())
    expect(await versionOf(snapshot(t.team.b, worker.name, view), 'app.py', { gitAt: async () => 'x = 1\n' })).toMatchObject({ kind: 'held' })
    expect(await versionOf(snapshot(t.team.b, worker.name, view), 'gone.py')).toMatchObject({ kind: 'deleted' })
  })

  it('D1: at declared, only paths inside the lead\'s text area keep hash and size', async () => {
    const policy = testPolicyStore('declared')
    await policy.declare(['src/'])
    const t = await setup({ policy, start: false })
    publishSource(t.local.b, {
      'src/in.py': { change: 'A', state: 'shared', hash: gitBlobHash('in\n'), size: 3 },
      'out.py': { change: 'A', state: 'shared', hash: gitBlobHash('out\n'), size: 4 },
    })
    t.bridge.start()
    await t.bridge.sync()
    const entries = Object.fromEntries(t.team.b.manifest.get(manifestKey(worker.name, LEAD_FENCE))!.entries())
    expect(entries['src/in.py']).toMatchObject({ held: 'worker', hash: gitBlobHash('in\n'), size: 3 })
    expect(entries['out.py']).toMatchObject({ change: 'A', state: 'held', held: 'worker' })
    expect(entries['out.py'].hash).toBeUndefined()
    expect(entries['out.py'].size).toBeUndefined()
    expect(entries['carried.py'].hash).toBeUndefined()
    expect(t.team.b.manifestHead.get(worker.name)).toMatchObject({ level: 'declared', textPrefixes: ['src/'] })
  })

  it('D1 keeps a source hashless held path hashless even when the lead shares full', async () => {
    const t = await setup({ start: false })
    publishSource(t.local.b, { 'app.py': { change: 'M', state: 'held', held: 'scope' } })
    await t.bridge.sync()
    const entry = t.team.b.manifest.get(manifestKey(worker.name, LEAD_FENCE))?.get('app.py')
    expect(entry).toMatchObject({ change: 'M', state: 'held', held: 'worker' })
    expect(entry?.hash).toBeUndefined()
    expect(entry?.size).toBeUndefined()
    expect(entry?.baseHash).toBeUndefined()
  })

  it('N2: coverage is inherited, never upgraded — a source at intent projects nothing', async () => {
    const t = await setup({ start: false })
    publishSource(t.local.b, {}, { coverage: { kind: 'none', reason: 'intent' }, level: 'intent' })
    t.bridge.start()
    await t.bridge.sync()
    expect(t.team.b.manifestHead.get(worker.name)).toMatchObject({ coverage: { kind: 'none', reason: 'intent' }, excluded: [] })
    expect(t.team.b.manifest.get(manifestKey(worker.name, LEAD_FENCE))?.size ?? 0).toBe(0)
    // A source that excluded paths cannot be re-keyed to the team salt: unprojectable.
    publishSource(t.local.b, { 'a.py': { change: 'A', state: 'shared', hash: 'h', size: 1 } }, { excluded: ['ab'.repeat(32)] })
    await t.bridge.sync()
    expect(t.team.b.manifestHead.get(worker.name)?.coverage).toEqual({ kind: 'none', reason: 'unprojectable' })
  })

  it('carried paths excluded by the lead are digested, never named', async () => {
    const t = await setup({ start: false })
    git('checkout', '-q', C)
    writeFileSync(join(dir, 'secret.env'), 'k\n')
    execFileSync('mkdir', ['-p', join(dir, 'secret')]); writeFileSync(join(dir, 'secret', 'key.pem'), 'pem\n')
    git('add', '.'); git('commit', '-qm', 'more carried')
    const C2 = git('rev-parse', 'HEAD').trim()
    git('checkout', '-q', B)
    await t.registry.update(t.record.id, old => ({ ...old, base: C2, carriedBase: C2, seq: old.seq + 1 }))
    publishSource(t.local.b, {}, { base: C2 })
    t.bridge.start()
    await t.bridge.sync()
    const entries = [...t.team.b.manifest.get(manifestKey(worker.name, LEAD_FENCE))!.keys()]
    expect(entries).toContain('secret.env')
    expect(entries.some(p => p.startsWith('secret/'))).toBe(false)
    expect(t.team.b.manifestHead.get(worker.name)!.excluded).toHaveLength(1)
    expect(JSON.stringify(t.team.b.manifestHead.get(worker.name))).not.toContain('key.pem')
  })

  it('only local workers are projected: a here worker writes its own team records (R3b)', async () => {
    const t = await setup()
    await seedRegistryWorker(dir, 'here', { name: 'rohanz+here', mode: 'here', room: TEAM, lead: { participant: lead.name, room: TEAM, instance: t.registry.instance } })
    publishSource(t.local.b, {})
    await t.bridge.sync()
    expect(t.team.b.manifestHead.has('rohanz+here')).toBe(false)
    expect(participantRecord(t.team.b, 'rohanz+here')).toBeUndefined()
    expect([...t.team.b.workerViews.values()].map(v => v.name)).toEqual([worker.name])
    expect(t.team.b.workerViews.get(t.record.id)).toMatchObject({ mode: 'local', lead: lead.name, fence: LEAD_FENCE })
  })

  it('collect retires the projection by worker ID and marks the team cleanup done; a restarted lead replaces stale fences', async () => {
    const t = await setup({ start: false })
    publishSource(t.local.b, { 'app.py': { change: 'M', state: 'shared', hash: gitBlobHash('x = 2\n'), size: 6 } })
    t.bridge.start()
    await t.bridge.sync()
    // A new lead session (fence) replaces the old incarnation's keys.
    ;(t.teamLead.daemon as unknown as { fence: string }).fence = '2'
    t.team.a.participants.set(`${lead.name}\u0000holder`, { sessionId: 'lead-session-2', epoch: 2, machine: 'm', pid: 1, startTime: 't', executable: 'e' })
    t.team.a.participants.set(`${lead.name}\u0000git`, { branch: 'main', head: B, base: B, anchored: true, rev: 2, fence: '2' })
    await t.bridge.sync()
    expect(t.team.b.manifest.has(manifestKey(worker.name, LEAD_FENCE))).toBe(false)
    expect(t.team.b.manifestHead.get(worker.name)?.fence).toBe('2')
    await t.registry.beginRetirement(t.record.id, t.registry.archiveOf(t.record, { summary: 'collected', disposition: 'collected' }))
    await t.bridge.sync()
    expect(t.team.b.manifestHead.has(worker.name)).toBe(false)
    expect(participantRecord(t.team.b, worker.name)).toBeUndefined()
    expect(t.team.b.workerViews.has(t.record.id)).toBe(false)
    expect(t.team.b.retiredWorkers().map(r => r.id)).toEqual([t.record.id])
    expect(t.registry.read(t.record.id)?.cleanup).toEqual({ [LOCAL]: 'pending', [TEAM]: 'done' })
    expect(t.team.b.coordination.has(lead.name)).toBe(false)
  })

  it('calls the conflict reconciler for each projected worker', async () => {
    const t = await setup({ start: false })
    const reconcile = vi.fn(async () => {})
    const bridge = new Bridge(t.teamLead, t.localLead, { debounceMs: 0, registry: t.registry, reconcileConflicts: reconcile })
    publishSource(t.local.b, {})
    bridge.start()
    await bridge.sync()
    expect(reconcile).toHaveBeenCalledWith({ team: t.teamLead, workers: t.localLead, owner: worker.name })
    bridge.stop()
  })
})
