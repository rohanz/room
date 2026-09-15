import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity, ClaimMsg, PlanMsg, ReleaseMsg } from '@room/shared'
import { Bridge } from '../src/bridge.js'
import type { Session } from '../src/session.js'

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
    room, awareness, me, dir, roomUrl: `ws://x/${encodeURIComponent(roomName)}`, roomName, browserUrl: 'http://x',
    provider: { synced: true, awareness } as unknown as Session['provider'],
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
  it("the lead's team scope is the union of its workers' declared and changed paths", () => {
    const t = setup()
    expect(t.team.a.scope('rohanz')).toBeUndefined()
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/models.py', 'api/handlers.py'] })
    const sc = t.team.b.scope('rohanz')!
    expect(sc.paths).toEqual(['api/handlers.py', 'api/models.py'])
    expect(sc.area).toBe('orders')
    expect(sc.summary).toContain('lead of 1 worker: money')
    t.local.b.setOverlay(worker.name, 'tests/test_money.py', 'x\n')
    expect(t.team.b.scope('rohanz')!.paths).toContain('tests/test_money.py')
    // the team room hears the scope as a message from the lead, never from the worker
    const scopeMsgs = t.team.b.messages().filter(m => m.type === 'scope')
    expect(scopeMsgs.length).toBeGreaterThan(0)
    expect(scopeMsgs.every(m => m.from === 'rohanz')).toBe(true)
    expect(t.team.b.messages().some(m => m.from === worker.name)).toBe(false)
  })

  it("workers' claims are mirrored into the team room under the lead's name and removed with the original", () => {
    const t = setup()
    t.local.b.setOverlay(worker.name, 'app.py', 'x = 2\n')
    const c = t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'bump x' })
    const mirrored = t.team.b.openClaims()
    expect(mirrored).toHaveLength(1)
    expect(mirrored[0]).toMatchObject({ by: 'rohanz', path: 'app.py', from: 1, to: 1, intent: '[money] bump x' })
    t.local.b.removeClaim(c.id)
    expect(t.team.b.openClaims()).toEqual([])
  })

  it('a team message touching a worker path is re-posted to that worker locally: claims at notify, plans as interrupts', () => {
    const t = setup()
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/'] })
    // Kieran, in the team room, claims a file under the worker's scope
    t.team.b.post<ClaimMsg>(kieran, { type: 'claim', claimId: 'c_k', path: 'api/handlers.py', from_line: 1, to_line: 5, intent: 'renaming validate' })
    const relayed = t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)
    expect(relayed).toHaveLength(1)
    expect(relayed[0].priority).toBe('notify')
    expect((relayed[0] as { text: string }).text).toContain('[team room]')
    expect((relayed[0] as { text: string }).text).toContain('renaming validate')
    // unrelated team traffic is not relayed
    t.team.b.post<ClaimMsg>(kieran, { type: 'claim', claimId: 'c_k2', path: 'web/index.ts', from_line: 1, to_line: 5, intent: 'css' })
    expect(t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)).toHaveLength(1)
    // the lead's own team messages are never relayed to its workers
    t.team.a.post<ClaimMsg>(lead, { type: 'claim', claimId: 'c_me', path: 'api/x.py', from_line: 1, to_line: 1, intent: 'mine' })
    expect(t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)).toHaveLength(1)
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
  it('unmirroring a claim posts a release to the team, carrying unfulfilled plans', () => {
    const t = setup()
    t.local.b.setOverlay(worker.name, 'app.py', 'x = 2\n')
    const c = t.local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: worker.name, byKind: 'agent', intent: 'rename x', plans: [{ kind: 'rename', symbol: 'x', detail: 'y' }] })
    const teamId = t.team.b.openClaims()[0].id
    t.local.b.post<ReleaseMsg>(worker, { type: 'release', claimId: c.id, path: 'app.py', summary: 'gave up', unfulfilled: [{ kind: 'rename', symbol: 'x', detail: 'y' }] })
    t.local.b.removeClaim(c.id)
    const rel = t.team.b.messages().filter((m): m is ReleaseMsg => m.type === 'release')
    expect(rel).toHaveLength(1)
    expect(rel[0]).toMatchObject({ from: 'rohanz', claimId: teamId, path: 'app.py', summary: '[money] gave up' })
    expect(rel[0].unfulfilled).toEqual([{ kind: 'rename', symbol: 'x', detail: 'y' }])
  })

  it('plans interrupt, repeated chatter about the same path is delivered once a minute', () => {
    const t = setup()
    t.local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/'] })
    const notes = () => t.local.b.messages().filter(m => m.type === 'note' && m.to === worker.name)
    t.team.b.post<PlanMsg>(kieran, { type: 'plan', status: 'cancelled', claimId: 'c1', path: 'api/handlers.py', plan: { kind: 'rename', symbol: 'validate' }, text: 'plan cancelled' })
    expect(notes()).toHaveLength(1)
    expect(notes()[0].priority).toBe('interrupt')
    t.team.b.post<ClaimMsg>(kieran, { type: 'claim', claimId: 'c2', path: 'api/handlers.py', from_line: 1, to_line: 2, intent: 'a' })
    t.team.b.post<ClaimMsg>(kieran, { type: 'claim', claimId: 'c3', path: 'api/handlers.py', from_line: 3, to_line: 4, intent: 'b' })
    t.team.b.post<ClaimMsg>(kieran, { type: 'claim', claimId: 'c4', path: 'api/handlers.py', from_line: 5, to_line: 6, intent: 'c' })
    expect(notes()).toHaveLength(2) // one claim notice for that path within the window
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
    t.local.b.setOverlay(worker.name, 'app.py', 'x = 2\n')
    expect(t.team.b.scope('rohanz')!.paths).toEqual(['app.py'])
    // nested change to the same overlay text: still covered, no crash, scope unchanged
    t.local.b.setOverlay(worker.name, 'app.py', 'x = 3\n')
    expect(t.team.b.scope('rohanz')!.paths).toEqual(['app.py'])
    // a deletion is a change the team must see
    t.local.b.markDeleted(worker.name, 'old.py')
    expect(t.team.b.scope('rohanz')!.paths).toEqual(['app.py', 'old.py'])
    t.local.b.unmarkDeleted(worker.name, 'old.py')
    expect(t.team.b.scope('rohanz')!.paths).toEqual(['app.py'])
  })
})

/** A `declared` daemon stand-in: publishes the lead's changed files that fall under the paths it was last given
 *  (explicit ones, else the scope record), exactly like roomd's resharePaths. */
function declaredDaemon(room: RoomDoc, name: string, disk: Record<string, string>) {
  const calls: { level: string; paths?: string[] }[] = []
  const d = {
    share: 'declared' as const, calls, touch() {}, async stop() {}, dir, name, roomDoc: room, provider: null as never, branch: 'main', base,
    explicit: undefined as string[] | undefined,
    async setShare(level: string, paths?: string[]) {
      calls.push({ level, paths })
      d.explicit = paths
      d.reshare()
    },
    reshare() {
      const allowed = d.explicit ?? room.scope(name)?.paths ?? []
      for (const [p, text] of Object.entries(disk)) {
        const ok = allowed.some(a => p === a || p.startsWith(a.endsWith('/') ? a : `${a}/`))
        if (ok) room.setOverlay(name, p, text)
        else if (room.overlayText(name, p)) room.clearOverlay(name, p)
      }
    },
  }
  // roomd follows the scope record while no explicit paths are set
  room.scopes.observe(ev => { if (ev.keysChanged.has(name) && !d.explicit) d.reshare() })
  return d
}

describe('Bridge: sharing stays the lead\'s own (B1)', () => {
  it("a worker's paths widen the coordination scope but never what the lead's daemon publishes under declared", async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    const teamLead = fakeSession(team.a, lead, 'github.com/rohanz/x/main', false)
    const localLead = fakeSession(local.a, lead, 'local/x/main', true)
    // the lead has edited two files but declared only api/auth.py: api/secret.py is withheld
    const daemon = declaredDaemon(team.a, lead.name, { 'api/auth.py': 'a\n', 'api/secret.py': 's\n' })
    ;(teamLead as { daemon: unknown }).daemon = daemon
    team.a.setScope({ by: lead.name, byKind: 'agent', area: 'api', summary: 'auth', paths: ['api/auth.py'] })
    expect(team.b.changedPaths('rohanz')).toEqual(['api/auth.py'])
    local.a.setWorker({ tag: 'money', name: worker.name, host: 'claude', task: 'cents', dir, branch: 'room/money', pid: 1, startedAt: 1, status: 'running', lead: lead.name })
    const bridge = new Bridge(teamLead, localLead, { debounceMs: 0 })
    bridge.start()
    expect(bridge.sharePaths()).toBeUndefined()
    // the worker declares the directory holding the withheld file
    local.b.setScope({ by: worker.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/'] })
    await new Promise(r => setTimeout(r, 0))
    expect(team.b.scope('rohanz')!.paths).toEqual(['api/', 'api/auth.py']) // coordination: the union
    expect(bridge.sharePaths()).toEqual(['api/auth.py'])                   // sharing: the lead's own
    expect(daemon.calls.at(-1)).toEqual({ level: 'declared', paths: ['api/auth.py'] })
    expect(team.b.changedPaths('rohanz')).toEqual(['api/auth.py'])
    expect(team.b.overlayText('rohanz', 'api/secret.py')).toBeUndefined()
    // room_share while bridged (no explicit paths) still cannot follow the union
    await teamLead.daemon.setShare('declared')
    expect(daemon.calls.at(-1)).toEqual({ level: 'declared', paths: ['api/auth.py'] })
    expect(team.b.overlayText('rohanz', 'api/secret.py')).toBeUndefined()
    // the lead widens its own scope: that, and only that, shares more
    team.a.setScope({ by: lead.name, byKind: 'agent', area: 'api', summary: 'auth + secret', paths: ['api/auth.py', 'api/secret.py'] })
    await new Promise(r => setTimeout(r, 0))
    expect(team.b.changedPaths('rohanz')).toEqual(['api/auth.py', 'api/secret.py'])
    // worker quiet: the daemon follows the scope record again and the wrapper is gone after stop
    local.a.clearScope(worker.name)
    await new Promise(r => setTimeout(r, 0))
    expect(bridge.sharePaths()).toBeUndefined()
    expect(daemon.calls.at(-1)).toEqual({ level: 'declared', paths: undefined })
    bridge.stop()
    expect(teamLead.daemon.setShare).toBe(daemon.setShare)
  })
})

describe('Bridge: mirrored claims survive the lead\'s own cleanup (B2)', () => {
  it('mirrors carry mirrorOf and are put back when someone other than the bridge removes them', () => {
    const t = setup()
    t.local.b.setOverlay(worker.name, 'app.py', 'x = 2\n')
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
    expect(t.team.b.messages().filter((m): m is ReleaseMsg => m.type === 'release')).toHaveLength(1)
    // a mirror whose local claim is already gone is not resurrected
    t.bridge.stop()
    expect(t.team.b.openClaims()).toEqual([])
  })
})
