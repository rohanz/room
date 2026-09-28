import { clearFixture, deleteFixture, publishFixture } from './fixtures/manifest.js'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, formatMsg } from '@room/shared'
import type { Identity, ClaimMsg, NoteMsg, PlanMsg, ReleaseMsg, ScopeMsg } from '@room/shared'
import { Bridge } from '../src/bridge.js'
import { Ledger } from '../src/ledger.js'
import type { Session } from '../src/session.js'
import { hubAppend } from '@room/shared/testing'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

let dir: string, base: string
const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
const worker: Identity = { name: 'rohanz+money', kind: 'agent', owner: 'rohanz', label: 'money' }
const kieran: Identity = { name: 'kieran', kind: 'agent', owner: 'kieran' }

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
function fakeSession(room: RoomDoc, me: Identity, roomName: string, local: boolean): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  return {
    policyStore: testPolicyStore(),
    room, awareness, me, dir, roomUrl: `ws://x/${encodeURIComponent(roomName)}`, roomName, browserUrl: 'http://x',
    ...hubSeam(room), provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base } as never,
    shareMax: 'full', shareRequested: 'full',
    ...(local ? { local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} } } : {}),
  } as Session
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-bridge-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})

/** Let the bridge's posts reach the in-process hub. */
const settle = () => new Promise(r => setTimeout(r, 5))

function setup() {
  const team = pair(), local = pair()
  team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
  const teamLead = fakeSession(team.a, lead, 'github.com/rohanz/x/main', false)
  const localLead = fakeSession(local.a, lead, 'local/x/main', true)
  local.a.setWorker({ tag: 'money', name: worker.name, host: 'claude', task: 'switch prices to cents', dir, branch: 'room/money', pid: 1, startedAt: 1, status: 'running', lead: lead.name })
  const bridge = new Bridge(teamLead, localLead, { debounceMs: 0 })
  bridge.start()
  return { team, local, teamLead, localLead, bridge }
}

describe('Bridge: a lead in a team room with a local workers room', () => {
  it('keeps an addressed team interrupt relayed between spawn and worker join', async () => {
    const t = setup()
    const old = hubAppend<NoteMsg>(t.local.a, lead, { type: 'note', text: 'before spawn', priority: 'notify' })
    hubAppend<NoteMsg>(t.team.b, kieran, { type: 'note', priority: 'interrupt', text: 'stop now' })
    await settle()
    const relayed = t.local.b.messages().find(m => m.type === 'note' && m.to === worker.name)!
    // The worker's frontier is above the old broadcast; the relayed copy is addressed, so it is owed regardless.
    const workerSession = fakeSession(t.local.b, worker, 'local/x/main', true)
    const owed = new Ledger({ sessionId: () => 'worker-session', route: () => ({}) }).candidates(workerSession).map(m => m.id)
    expect(owed).not.toContain(old.id)
    expect(owed).toContain(relayed.id)
  })
  it("the lead's team scope is the union of its workers' declared and changed paths", async () => {
    const t = setup()
    expect(t.team.a.scope('rohanz')).toBeUndefined()
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/models.py', 'api/handlers.py'] })
    const sc = t.team.b.scope('rohanz')!
    expect(sc.paths).toEqual(['api/handlers.py', 'api/models.py'])
    expect(sc.area).toBe('orders')
    expect(sc.summary).toContain('lead of 1 worker: money')
    publishFixture(t.local.b, worker.name, 'tests/test_money.py', 'x\n')
    expect(t.team.b.scope('rohanz')!.paths).toContain('tests/test_money.py')
    // the team room hears the scope as a message from the lead, never from the worker
    await settle()
    const scopeMsgs = t.team.b.messages().filter(m => m.type === 'scope')
    expect(scopeMsgs.length).toBeGreaterThan(0)
    expect(scopeMsgs.every(m => m.from === 'rohanz')).toBe(true)
    await settle()
    expect(t.team.b.messages().some(m => m.from === worker.name)).toBe(false)
  })

  it('updates the scope map immediately without reposting unchanged area/summary chatter', async () => {
    const t = setup()
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/models.py'] })
    const scopeMessages = () => t.team.b.messages().filter(m => m.type === 'scope')
    await settle()
    expect(scopeMessages()).toHaveLength(1)
    publishFixture(t.local.b, worker.name, 'tests/test_money.py', 'x\n')
    expect(t.team.b.scope('rohanz')!.paths).toContain('tests/test_money.py')
    await settle()
    expect(scopeMessages()).toHaveLength(1)
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'billing', summary: 'cents complete', paths: ['api/models.py'] })
    await settle()
    expect(scopeMessages()).toHaveLength(2)
  })

  it('renders the bridge union as history after restoring the lead scope without a new event', async () => {
    const t = setup()
    const own = { by: lead.name, byKind: lead.kind, area: 'api', summary: 'lead work', paths: ['api/lead.py'] }
    t.team.a.setScope(own)
    hubAppend<ScopeMsg>(t.team.a, lead, { type: 'scope', area: own.area, summary: own.summary, paths: own.paths })
    t.local.b.setScope({ by: worker.name, byKind: worker.kind, area: 'api', summary: 'worker work', paths: ['api/worker.py'] })
    await settle()
    const events = t.team.b.messages().filter((m): m is ScopeMsg => m.type === 'scope')
    expect(events).toHaveLength(2)
    t.bridge.stop()
    await settle()
    const context = { scopes: t.team.b.allScopes(), messages: t.team.b.messages() }
    expect(formatMsg(events[0], context)).toContain('is on api: lead work')
    expect(formatMsg(events[1], context)).toContain('earlier:')
  })

  it("workers' claims are mirrored into the team room under the lead's name and removed with the original", () => {
    const t = setup()
    publishFixture(t.local.b, worker.name, 'app.py', 'x = 2\n')
    const c = t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'bump x' })
    const mirrored = t.team.b.openClaims()
    expect(mirrored).toHaveLength(1)
    expect(mirrored[0]).toMatchObject({ by: 'rohanz', path: 'app.py', from: 1, to: 1, intent: '[money] bump x' })
    t.local.b.removeClaim(c.id)
    expect(t.team.b.openClaims()).toEqual([])
  })

  it('a team message touching a worker path is re-posted to that worker locally: claims at notify, plans as interrupts', async () => {
    const t = setup()
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/'] })
    // Kieran, in the team room, claims a file under the worker's scope
    hubAppend<ClaimMsg>(t.team.b, kieran, { type: 'claim', claimId: 'c_k', path: 'api/handlers.py', from_line: 1, to_line: 5, intent: 'renaming validate' })
    await settle()
    const relayed = t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)
    expect(relayed).toHaveLength(1)
    expect(relayed[0].priority).toBe('notify')
    expect((relayed[0] as { text: string }).text).toContain('[team room]')
    expect((relayed[0] as { text: string }).text).toContain('renaming validate')
    // unrelated team traffic is not relayed
    hubAppend<ClaimMsg>(t.team.b, kieran, { type: 'claim', claimId: 'c_k2', path: 'web/index.ts', from_line: 1, to_line: 5, intent: 'css' })
    await settle()
    expect(t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)).toHaveLength(1)
    // the lead's own team messages are never relayed to its workers
    hubAppend<ClaimMsg>(t.team.a, lead, { type: 'claim', claimId: 'c_me', path: 'api/x.py', from_line: 1, to_line: 1, intent: 'mine' })
    await settle()
    expect(t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)).toHaveLength(1)
  })

  it('relays each team broadcast notify or interrupt to every worker once, without fyi or echoes', async () => {
    const t = setup()
    t.local.b.setWorker({ tag: 'tax', name: 'rohanz+tax', host: 'codex', task: 'tax', dir, branch: 'room/tax', pid: 2, startedAt: 2, status: 'running', lead: lead.name })
    const send = (priority: 'fyi' | 'notify' | 'interrupt') => hubAppend<NoteMsg>(t.team.b, kieran, { type: 'note', priority, text: priority })
    send('fyi'); send('notify'); send('interrupt')
    await settle()
    const notes = t.local.b.messages().filter((m): m is NoteMsg => m.type === 'note')
    expect(notes.map(m => [m.to, m.priority])).toEqual([
      [worker.name, 'notify'], ['rohanz+tax', 'notify'], [worker.name, 'interrupt'], ['rohanz+tax', 'interrupt'],
    ])
    await settle()
    expect(t.team.b.messages().filter(m => m.type === 'note')).toHaveLength(3)
    hubAppend<NoteMsg>(t.team.a, lead, { type: 'note', priority: 'notify', text: 'self' })
    await settle()
    expect(t.local.b.messages().filter(m => m.type === 'note')).toHaveLength(4)
  })

  it('updates the team mirror when the worker claim moves', () => {
    const t = setup()
    const c = t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'move', claimedHash: 'first' })
    const id = t.team.b.openClaims()[0].id
    t.local.b.moveClaim(c.id, 4, 6, undefined, 'second')
    expect(t.team.b.claims.get(id)).toMatchObject({ from: 4, to: 6, claimedHash: 'second' })
    t.local.b.removeClaim(c.id)
    expect(t.team.b.openClaims()).toEqual([])
  })

  it('keeps a moved worker mirror on the worker range when the lead edits its overlay', () => {
    const t = setup()
    publishFixture(t.team.a, lead.name, 'app.py', 'lead one\nlead two\nlead three\n')
    publishFixture(t.local.b, worker.name, 'app.py', 'worker one\nworker two\nworker three\n')
    const c = t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'move' })
    const id = t.team.b.openClaims()[0].id
    t.local.b.moveClaim(c.id, 2, 2)
    expect(t.team.b.claims.get(id)).toMatchObject({ from: 2, to: 2, mirrorOf: 'money' })
    expect(t.team.b.openClaims()[0]).toMatchObject({ from: 2, to: 2 })
    publishFixture(t.team.a, lead.name, 'app.py', 'inserted\nlead one\nlead two\nlead three\n')
    expect(t.team.b.openClaims()[0]).toMatchObject({ from: 2, to: 2 })
    expect(t.team.b.claims.get(id)?.anchor).toBeUndefined()
  })

  it('stop() removes the mirrored claims and stops relaying', () => {
    const t = setup()
    t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'bump x' })
    expect(t.team.b.openClaims()).toHaveLength(1)
    t.bridge.stop()
    expect(t.team.b.openClaims()).toEqual([])
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'late', paths: ['late.py'] })
    expect(t.team.b.scope('rohanz')?.paths ?? []).not.toContain('late.py')
  })
})

describe('Bridge hardening', () => {
  it('unmirroring a claim posts a release to the team, carrying unfulfilled plans', async () => {
    const t = setup()
    publishFixture(t.local.b, worker.name, 'app.py', 'x = 2\n')
    const c = t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'rename x', plans: [{ kind: 'rename', symbol: 'x', detail: 'y' }] })
    const teamId = t.team.b.openClaims()[0].id
    hubAppend<ReleaseMsg>(t.local.b, worker, { type: 'release', claimId: c.id, path: 'app.py', summary: 'gave up', unfulfilled: [{ kind: 'rename', symbol: 'x', detail: 'y' }] })
    t.local.b.removeClaim(c.id)
    await settle()
    const rel = t.team.b.messages().filter((m): m is ReleaseMsg => m.type === 'release')
    expect(rel).toHaveLength(1)
    expect(rel[0]).toMatchObject({ from: 'rohanz', claimId: teamId, path: 'app.py', summary: '[money] gave up' })
    expect(rel[0].unfulfilled).toEqual([{ kind: 'rename', symbol: 'x', detail: 'y' }])
  })

  it('plans interrupt, repeated chatter about the same path is delivered once a minute', async () => {
    const t = setup()
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/'] })
    const notes = () => t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)
    hubAppend<PlanMsg>(t.team.b, kieran, { type: 'plan', status: 'cancelled', claimId: 'c1', path: 'api/handlers.py', plan: { kind: 'rename', symbol: 'validate' }, text: 'plan cancelled' })
    await settle()
    expect(notes()).toHaveLength(1)
    await settle()
    expect(notes()[0].priority).toBe('interrupt')
    hubAppend<ClaimMsg>(t.team.b, kieran, { type: 'claim', claimId: 'c2', path: 'api/handlers.py', from_line: 1, to_line: 2, intent: 'a' })
    hubAppend<ClaimMsg>(t.team.b, kieran, { type: 'claim', claimId: 'c3', path: 'api/handlers.py', from_line: 3, to_line: 4, intent: 'b' })
    hubAppend<ClaimMsg>(t.team.b, kieran, { type: 'claim', claimId: 'c4', path: 'api/handlers.py', from_line: 5, to_line: 6, intent: 'c' })
    await settle()
    expect(notes()).toHaveLength(2) // one claim notice for that path within the window
    await settle()
    expect(notes()[1].priority).toBe('notify')
  })
})

describe('Bridge review fixes', () => {
  it("keeps the lead's own scope underneath the workers' union and restores it when workers go quiet or the bridge stops (fix 11)", () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    const teamLead = fakeSession(team.a, lead, 'github.com/rohanz/x/main', false)
    const localLead = fakeSession(local.a, lead, 'local/x/main', true)
    team.a.setScope({ by: lead.name, byKind: 'agent', area: 'api', summary: 'auth endpoint', paths: ['api/auth.py'] })
    local.a.setWorker({ tag: 'money', name: worker.name, host: 'claude', task: 'cents', dir, branch: 'room/money', pid: 1, startedAt: 1, status: 'running', lead: lead.name })
    const bridge = new Bridge(teamLead, localLead, { debounceMs: 0 })
    bridge.start()
    expect(team.b.scope('rohanz')!.paths).toEqual(['api/auth.py'])
    local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/models.py'] })
    const sc = team.b.scope('rohanz')!
    expect(sc.paths).toEqual(['api/auth.py', 'api/models.py'])
    expect(sc.area).toBe('api')
    expect(sc.summary).toBe('own: auth endpoint · lead of 1 worker: money (cents)')
    // the lead re-declares its own scope while bridged: the union follows
    team.a.setScope({ by: lead.name, byKind: 'agent', area: 'api', summary: 'auth + sessions', paths: ['api/auth.py', 'api/session.py'] })
    expect(team.b.scope('rohanz')!.paths).toEqual(['api/auth.py', 'api/models.py', 'api/session.py'])
    // worker gone: exactly the lead's own scope again
    local.a.clearScope(worker.name)
    expect(team.b.scope('rohanz')).toMatchObject({ summary: 'auth + sessions', paths: ['api/auth.py', 'api/session.py'] })
    local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/models.py'] })
    bridge.stop()
    expect(team.b.scope('rohanz')).toMatchObject({ summary: 'auth + sessions', paths: ['api/auth.py', 'api/session.py'] })
  })

  it("a worker editing an already-shared file or deleting one refreshes the mirrored scope (fix 12)", () => {
    const t = setup()
    publishFixture(t.local.b, worker.name, 'app.py', 'x = 2\n')
    expect(t.team.b.scope('rohanz')!.paths).toEqual(['app.py'])
    // nested change to the same overlay text: still covered, no crash, scope unchanged
    publishFixture(t.local.b, worker.name, 'app.py', 'x = 3\n')
    expect(t.team.b.scope('rohanz')!.paths).toEqual(['app.py'])
    // a deletion is a change the team must see
    deleteFixture(t.local.b, worker.name, 'old.py')
    expect(t.team.b.scope('rohanz')!.paths).toEqual(['app.py', 'old.py'])
    clearFixture(t.local.b, worker.name, 'old.py')
    expect(t.team.b.scope('rohanz')!.paths).toEqual(['app.py'])
  })
})

describe("Bridge: sharing stays the lead's own (B1)", () => {
  it('worker coordination never calls the lead daemon applyInputs', async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    const teamLead = fakeSession(team.a, lead, 'github.com/rohanz/x/main', false)
    const localLead = fakeSession(local.a, lead, 'local/x/main', true)
    const applyInputs = vi.fn()
    ;(teamLead.daemon as unknown as { applyInputs: typeof applyInputs }).applyInputs = applyInputs
    team.a.setScope({ by: lead.name, byKind: 'agent', area: 'api', summary: 'auth', paths: ['api/auth.py'] })
    local.a.setWorker({ tag: 'money', name: worker.name, host: 'claude', task: 'cents', dir, branch: 'room/money', pid: 1, startedAt: 1, status: 'running', lead: lead.name })
    const bridge = new Bridge(teamLead, localLead, { debounceMs: 0 })
    bridge.start()
    local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/'] })
    await new Promise(r => setTimeout(r, 0))
    expect(team.b.scope('rohanz')!.paths).toEqual(['api/', 'api/auth.py'])
    expect(applyInputs).not.toHaveBeenCalled()
    bridge.stop()
  })
})

describe('Bridge: mirrored claims survive the lead\'s own cleanup (B2)', () => {
  it('mirrors carry mirrorOf and are put back when someone other than the bridge removes them', async () => {
    const t = setup()
    publishFixture(t.local.b, worker.name, 'app.py', 'x = 2\n')
    const c = t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'bump x' })
    const first = t.team.b.openClaims()[0]
    expect(first).toMatchObject({ by: 'rohanz', mirrorOf: 'money', intent: '[money] bump x' })
    // the lead's room_done (or any sweep) deletes the mirror without the bridge's origin
    t.team.a.removeClaim(first.id)
    const again = t.team.b.openClaims()
    expect(again).toHaveLength(1)
    expect(again[0].id).not.toBe(first.id)
    expect(again[0]).toMatchObject({ mirrorOf: 'money', path: 'app.py', intent: '[money] bump x' })
    // the worker releasing its claim still removes the mirror for good, with one release notice
    t.local.b.removeClaim(c.id)
    expect(t.team.b.openClaims()).toEqual([])
    await settle()
    expect(t.team.b.messages().filter((m): m is ReleaseMsg => m.type === 'release')).toHaveLength(1)
    // a mirror whose local claim is already gone is not resurrected
    t.bridge.stop()
    expect(t.team.b.openClaims()).toEqual([])
  })
})
