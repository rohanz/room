import { publishFixture } from './fixtures/manifest.js'
/**
 * A lead's tools with a bridged workers room: room_done keeps the mirrors of running workers (B2),
 * and a worker exiting without room_done still wakes the lead's host (B3).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, gitBlobHash, manifestKey, owed, type ManifestEntry } from '@room/shared'
import type { Identity } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { GraphIndex } from '../src/graph-index.js'
import { hubAppend, epochPublication } from '@room/shared/testing'
import { reconcileProjectedConflicts } from '../src/conflict-set.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'
import { prepareWorktree } from '../src/worker-git.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import { workerByTag } from './registry-fixture.js'
import { rulesFromText } from '@room/roomd/policy'

let dir: string
let base: string
const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
const workerId: Identity = { name: 'rohanz+money', kind: 'agent', owner: 'rohanz', label: 'money' }

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
function fakeSession(room: RoomDoc, me: Identity, local = true): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  const graph = new GraphIndex(room, me.name, dir); graph.start()
  const policyStore = testPolicyStore()
  return {
    graph, room, awareness, me, dir, roomUrl: 'ws://127.0.0.1:1/local%2Fx', roomName: 'local/x', browserUrl: 'http://x',
    ...hubSeam(room), provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base,
      inputs: { policy: policyStore.policy, rules: rulesFromText('', 512 * 1024, 8 * 1024 * 1024), head: base } } as never,
    shareMax: 'full', shareRequested: 'full', policyStore,
    ...(local ? { local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} } } : {}),
  } as Session
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-lead-bridge-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})
afterEach(async () => {
  await closeRegistryForDir(dir)
  const worker = join(dir, '.room', 'workers', 'money')
  if (existsSync(worker)) execFileSync('git', ['-C', dir, 'worktree', 'remove', '--force', worker], { stdio: 'pipe' })
  rmSync(join(dir, '.git', 'room', 'registry'), { recursive: true, force: true })
  try { execFileSync('git', ['-C', dir, 'branch', '-D', 'room/money'], { stdio: 'pipe' }) } catch { /* no branch */ }
})

/** A lead in a team room with a local workers room; the spawned process's exit is under test control. */
function setupBridged(wake?: (id: string, text: string) => Promise<void>) {
  const team = pair(), local = pair()
  team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
  let ls: Session | null = fakeSession(team.a, lead, false)
  ls!.roomName = 'github.com/rohanz/x'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx'
  const exits: ((code: number | null) => void)[] = []
  let workersLead: Session
  const leadTools = createTools({
    getSession: () => ls, setSession: s => { ls = s }, cwd: dir, binding: { bound: () => ({ id: 'thread-lead', host: 'codex' as const }), id: () => 'thread-lead', dir: () => undefined, commonDir: () => undefined }, conflictDebounceMs: 0, probe: () => undefined, listCwdProcesses: () => [],
    // An idle host isolates worker-exit routing from host-state discovery (covered by wake-turn).
    wakeProbe: { busy: async () => false },
    ...(wake ? { wake: async (target: { id: string }, text: string) => { await wake(target.id, text); return 'queue' as const } } : {}),
    join: async () => (workersLead = fakeSession(local.a, lead)),
    leave: async () => {},
    spawner: () => ({ pid: 99, started: Promise.resolve(), onExit: cb => { exits.push(cb) }, kill: () => {} }),
    worktree: async (repo, tag) => prepareWorktree(repo, tag, 'rohanz'),
  })
  let ws: Session | null = fakeSession(local.b, workerId)
  const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
  return { team, local, leadTools, workerTools, exits, lead: () => ls!, workersLead: () => workersLead }
}

async function asWorker<T>(id: string | undefined, work: () => Promise<T>): Promise<T> {
  const previous = process.env.ROOM_WORKER_ID
  if (id) process.env.ROOM_WORKER_ID = id
  else delete process.env.ROOM_WORKER_ID
  try { return await work() }
  finally { if (previous === undefined) delete process.env.ROOM_WORKER_ID; else process.env.ROOM_WORKER_ID = previous }
}

describe("the lead's room_done and its workers' mirrored claims (B2)", () => {
  it('M13 reads and previews the owned local worktree after its team projection appears', async () => {
    const t = setupBridged()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })
    // Give the fake lead the same fenced base its daemon would publish, then let the bridge project.
    ;(t.lead().daemon as unknown as { fence: string }).fence = '1'
    t.team.a.participants.set(`${lead.name}\u0000git`, { branch: 'main', head: base, base, anchored: true, rev: 1, fence: '1' })
    await vi.waitFor(() => expect(t.team.a.manifestHead.has(workerId.name)).toBe(true))
    const record = (await (await registryForDir(dir)).reserved('money'))!
    expect(record.room).toBe('local/x')
    expect(record.room).not.toBe(t.lead().roomName)
    writeFileSync(join(dir, '.room', 'workers', 'money', 'app.py'), 'x = 3\n')
    const read = await t.leadTools.call('room_read', { person: workerId.name, path: 'app.py' })
    expect(read).toContain('x = 3')
    const preview = await t.leadTools.call('room_preview_merge', { person: workerId.name,
      run: `node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('app.py', 'utf8'), 'x = 3\\n'); console.log('1 passed')"` })
    expect(preview).toContain('trusted local worktree')
    expect(preview).toContain('tests: PASSED (exit 0)')
    await t.leadTools.call('room_leave', { force: true })
  })
  it('keeps mirrors of running workers, releases its own claims, and drops a finished worker\'s mirror', async () => {
    const t = setupBridged()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })
    await t.leadTools.call('room_scope', { area: 'api', summary: 'auth', paths: ['api/auth.py'] })
    const own = t.team.a.addClaim({ path: 'api/auth.py', from: 1, to: 1, by: lead.name, byKind: 'agent', intent: 'mine' })
    publishFixture(t.local.b, workerId.name, 'app.py', 'x = 2\n')
    t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: workerId.name, byKind: 'agent', intent: 'bump' })
    expect(t.team.b.openClaims().map(c => c.intent).sort()).toEqual(['[money] bump', 'mine'])
    const out = await asWorker(undefined, () => t.leadTools.call('room_done', { summary: 'auth landed' }))
    expect(out).toContain('released 1 claim(s) (kept 1 mirroring running workers)')
    const left = t.team.b.openClaims()
    expect(left).toHaveLength(1)
    expect(left[0]).toMatchObject({ mirrorOf: 'money', intent: '[money] bump' })
    expect(left.some(c => c.id === own.id)).toBe(false)
    // once the worker is done its mirror is fair game for the lead's next room_done
    const worker = (await workerByTag(dir, 'money'))!
    const registry = await registryForDir(dir), record = (await registry.read(worker.id))!, run = record.runs.at(-1)!
    await registry.admit({ id: record.id, run: run.n, nonce: run.nonce, dir: record.dir, chain: [] })
    const workerDone = await asWorker(worker.id, () => t.workerTools.call('room_done', { summary: 'cents done' }))
    expect(workerDone).toContain('marked done')
    expect(t.team.b.openClaims()).toEqual([]) // the worker's room_done released its claim, so the mirror went with it
    await t.leadTools.call('room_leave', { force: true })
  })
})

describe('a worker exiting without room_done wakes the lead (B3)', () => {
  it("through the host's wake path for the workers room, content-free, without waking on the lead's own posts", async () => {
    const woken: string[] = []
    const t = setupBridged(async (_id, text) => { woken.push(text) })
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })
    hubAppend(t.local.a, lead, { type: 'note', to: 'rohanz+money', text: 'mine', priority: 'interrupt' } as never)
    await new Promise(r => setTimeout(r, 100))
    expect(woken).toEqual([])
    t.exits[0](0)
    await vi.waitFor(() => expect(woken).toHaveLength(1))
    expect(woken[0]).toContain('rohanz+money')
    expect(woken[0]).not.toContain('exited without room_done')
    expect((await workerByTag(dir, 'money'))).toMatchObject({ status: 'done', exitCode: 0 })
    await t.leadTools.call('room_leave', { force: true })
  })
})


it("delivers a projected worker conflict to the lead through the workers-room inbox and host wake path", async () => {
  const woken: string[] = []
  const t = setupBridged(async (_id, text) => { woken.push(text) })
  await t.leadTools.call('room_spawn', { tag: 'money', task: 'cents', where: 'local' })
  const team = t.lead(), workers = t.workersLead()
  const record = (await (await registryForDir(dir)).reserved('money'))!
  team.daemon.fence = '1'; workers.daemon.fence = '1'
  team.lease = { fence: () => '1', paused: () => undefined } as Session['lease']
  workers.lease = { fence: () => '1', paused: () => undefined } as Session['lease']
  const publish = (s: Session, name: string, text: string | undefined, projected = false) => {
    epochPublication(s.room, name, base, 1)
    const entries = new Y.Map<ManifestEntry>()
    if (text) entries.set('app.py', { change: 'M', state: 'shared', hash: gitBlobHash(text), fence: '1', at: 1 })
    s.room.manifest.set(manifestKey(name, '1'), entries)
    if (text) s.room.setOverlay(manifestKey(name, '1'), 'app.py', text)
    s.room.manifestHead.set(name, { base, fence: '1', coverage: { kind: 'all' }, level: 'full', excluded: [],
      complete: true, rev: 1, semRev: 1, scannedAt: Date.now(),
      ...(projected ? { projectedBy: lead.name, projectedFrom: record.id } : {}) })
  }
  publish(team, lead.name, undefined)
  team.awareness.setLocalState({ user: lead, sessionId: `session-${lead.name}` })
  const presence = new Awareness(new Y.Doc())
  presence.setLocalState({ user: workerId, sessionId: `session-${workerId.name}` })
  applyAwarenessUpdate(workers.awareness, encodeAwarenessUpdate(presence, [presence.clientID]), 'test')
  publish(workers, workerId.name, 'x = 3\n')
  workers.room.participants.set(`${workerId.name}\0holder`, { sessionId: `session-${workerId.name}`, epoch: 1, workerId: record.id })
  publish(team, workerId.name, 'x = 3\n', true)
  team.room.participants.set(`${workerId.name}\0proj`, { projectedBy: lead.name, projectedFrom: record.id })
  publish(team, 'Kieran', 'x = 4\n')
  try {
    await reconcileProjectedConflicts({ team, workers, owner: workerId.name })
    await vi.waitFor(() => expect(woken).toHaveLength(1))
    const notices = workers.room.messages().filter(m => m.type === 'merge-conflict')
    expect(notices.map(m => m.to).sort()).toEqual([lead.name, workerId.name].sort())
    expect(notices.every(m => m.priority === 'notify')).toBe(true)
    expect(owed(workers.room, lead, { frontier: 0, routed: new Set() }, {}).some(m => m.type === 'merge-conflict')).toBe(true)
    expect(woken[0]).not.toContain('x = 3')
    const inbox = await t.leadTools.call('room_state', {})
    expect(inbox).toContain('CONFLICT')
    expect(inbox).toContain('[workers room]')
    expect(team.room.messages().filter(m => m.type === 'merge-conflict')).toEqual([])
    const entry = team.room.manifest.get(manifestKey('Kieran', '1'))!.get('app.py')!
    const { hash: _hash, ...hidden } = entry
    team.room.manifest.get(manifestKey('Kieran', '1'))!.set('app.py', { ...hidden, state: 'held', held: 'scope' })
    const head = team.room.manifestHead.get('Kieran')!
    team.room.manifestHead.set('Kieran', { ...head, level: 'declared', textPrefixes: [], rev: 2, semRev: 2 })
    await reconcileProjectedConflicts({ team, workers, owner: workerId.name })
    const possible = workers.room.messages().filter(m => m.type === 'merge-conflict' && m.priority === 'fyi')
    expect(possible.map(m => m.to).sort()).toEqual([lead.name, workerId.name].sort())
    const nextInbox = await t.leadTools.call('room_state', {})
    expect(nextInbox).toContain('possible conflict')
    expect(nextInbox).toContain('[workers room]')
    expect(woken).toHaveLength(1) // Ordinary fyi priority waits for a tool; it does not wake.
  } finally {
    await t.leadTools.call('room_leave', { force: true })
    presence.destroy(); presence.doc.destroy()
  }
})
