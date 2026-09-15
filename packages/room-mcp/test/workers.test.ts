import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, shouldWakeOnMsg } from '@room/shared'
import type { Identity, Msg } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { GraphIndex } from '../src/graph-index.js'
import { prepareWorktree, workerCommand, workerPrompt, validTag, pidIsOurWorker, type SpawnSpec } from '../src/workers.js'

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
  return {
    graph, room, awareness, me, dir, roomUrl: 'ws://127.0.0.1:1/local%2Fx%2Fmain', roomName: 'local/x/main', browserUrl: 'http://x',
    provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base } as never,
    shareMax: 'full', shareRequested: 'full',
    ...(local ? { local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} } } : {}),
  } as Session
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-workers-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})

describe('worker plumbing', () => {
  it('validates tags and builds host commands', () => {
    expect(validTag('money')).toBe('money'); expect(validTag('a b')).toBeUndefined(); expect(validTag('')).toBeUndefined()
    const c = workerCommand('claude', 'claude-sonnet-5', 'do it')
    expect(c.cmd).toBe('claude'); expect(c.args).toContain('--model'); expect(c.args[1]).toBe('do it')
    const x = workerCommand('codex', undefined, 'do it')
    expect(x.cmd).toBe('codex'); expect(x.args.slice(0, 3)).toEqual(['exec', '-s', 'workspace-write'])
    expect(workerPrompt('rohanz', 'money', 'switch to cents')).toContain('to "rohanz"')
  })

  it('creates a worktree on branch room/<tag> and reuses it', async () => {
    const w1 = await prepareWorktree(dir, 'money')
    expect(w1.created).toBe(true); expect(w1.branch).toBe('room/money'); expect(existsSync(join(w1.dir, 'app.py'))).toBe(true)
    const w2 = await prepareWorktree(dir, 'money')
    expect(w2.created).toBe(false); expect(w2.dir).toBe(w1.dir)
  })
})

describe('room_spawn / room_done / room_dismiss', () => {
  function setup() {
    const { a, b } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    const specs: SpawnSpec[] = []
    const exits: ((code: number | null) => void)[] = []
    const killed: number[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, maxWorkers: 2,
      spawner: spec => { specs.push(spec); return { pid: 4242 + specs.length, onExit: cb => { exits.push(cb) }, kill: () => { killed.push(1) } } },
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    let ws: Session | null = fakeSession(b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    return { a, b, leadTools, workerTools, specs, exits, killed }
  }

  it('spawns a worker with the room passed through the environment, records it, and shows it in room_state', async () => {
    const t = setup()
    const out = await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents', host: 'codex', model: 'gpt-5.6' })
    expect(out).toContain('spawned money: rohanz+money (codex gpt-5.6, pid 4243)')
    expect(t.specs[0].cmd).toBe('codex')
    expect(t.specs[0].env).toMatchObject({ ROOM_TAG: 'money', ROOM_SERVER: 'local', ROOM_ROOM: 'local/x/main', ROOM_LEAD: 'rohanz' })
    expect(t.specs[0].cwd).toBe(join(dir, '.room', 'workers', 'money'))
    const w = t.a.workers.get('money')
    expect(w).toMatchObject({ name: 'rohanz+money', status: 'running', lead: 'rohanz', branch: 'room/money', host: 'codex', model: 'gpt-5.6' })
    const st = await t.leadTools.call('room_state', { all: true })
    expect(st).toContain('workers (1):')
    expect(st).toContain('money (codex gpt-5.6, running')
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'again' })).toContain('already running')
    expect(await t.leadTools.call('room_spawn', { tag: 'bad tag', task: 'x' })).toContain('error: tag')
  })

  it('room_spawn where=local from a team room opens a local workers room, bridges it, and tears it down on leave', async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(team.a, lead, false)
    ls!.roomName = 'github.com/rohanz/x/main'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx%2Fmain'
    const specs: SpawnSpec[] = []
    const joins: { server?: string; name?: string }[] = []
    const left: string[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0,
      join: async o => { joins.push({ server: o.server, name: o.name }); return fakeSession(local.a, lead) },
      leave: async s => { left.push(s.roomName) },
      spawner: spec => { specs.push(spec); return { pid: 99, onExit: () => {}, kill: () => {} } },
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    const out = await leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents', where: 'local' })
    expect(joins).toEqual([{ server: 'local', name: 'rohanz' }])
    expect(out).toContain('local workers room local/x/main')
    expect(specs[0].env).toMatchObject({ ROOM_SERVER: 'local', ROOM_ROOM: 'local/x/main', ROOM_LEAD: 'rohanz' })
    expect(local.a.workers.get('money')).toMatchObject({ status: 'running', lead: 'rohanz' })
    expect(team.a.workers.get('money')).toBeUndefined()
    // the worker declares a scope and claims in the local room; the team room sees both as the lead's
    local.b.setScope({ by: workerId.name, byKind: 'agent', area: 'orders', summary: 'cents', paths: ['api/models.py'] })
    local.b.addClaim({ path: 'app.py', from: 1, to: 1, by: workerId.name, byKind: 'agent', intent: 'bump' })
    expect(team.b.scope('rohanz')?.paths).toEqual(['api/models.py'])
    expect(team.b.openClaims().map(c => c.intent)).toEqual(['[money] bump'])
    expect(team.b.scopes.has(workerId.name)).toBe(false)
    const st = await leadTools.call('room_state', { all: true })
    expect(st).toContain('workers room: local (local/x/main')
    expect(st).toContain('money (claude, running')
    // a worker's done message reaches the lead through the workers room inbox
    let ws: Session | null = fakeSession(local.b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    await workerTools.call('room_done', { summary: 'cents done' })
    expect(await leadTools.call('room_state', {})).toContain('finished: cents done')
    // its process (never exited in this test) is still alive: a plain leave refuses, force dismisses it
    expect(await leadTools.call('room_leave', {})).toContain('still running: money')
    expect(await leadTools.call('room_leave', { force: true })).toContain('left github.com/rohanz/x/main')
    expect(left).toEqual(['local/x/main', 'github.com/rohanz/x/main'])
    expect(team.b.openClaims()).toEqual([])
  })

  it("the lead's room_wait also returns on a question addressed to it", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const waiting = t.leadTools.call('room_wait', { timeoutMs: 3000 })
    await new Promise(r => setTimeout(r, 50))
    await t.workerTools.call('room_send', { type: 'question', text: 'which field carries the price?', to: 'rohanz' })
    const out = await waiting
    expect(out).toContain('question for you')
    expect(out).toContain('which field carries the price?')
  })

  it("a worker that exits without room_done still ends the lead's wait, as a done message", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const waiting = t.leadTools.call('room_wait', { timeoutMs: 3000 })
    await new Promise(r => setTimeout(r, 50))
    t.exits[0](0)
    const out = await waiting
    expect(out).toContain('worker done:')
    expect(out).toContain('exited without room_done')
    expect(t.a.workers.get('money')).toMatchObject({ status: 'done', exitCode: 0 })
  })

  it('refuses beyond the worker budget', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    await t.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    expect(await t.leadTools.call('room_spawn', { tag: 'c', task: 'z' })).toContain('max 2')
  })

  it("the lead's room_wait returns as soon as a worker's done message arrives", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const waiting = t.leadTools.call('room_wait', { timeoutMs: 3000 })
    await new Promise(r => setTimeout(r, 50))
    await t.workerTools.call('room_done', { summary: 'done in cents' })
    const out = await waiting
    expect(out).toContain('worker done:')
    expect(out).toContain('done in cents')
  })

  it("a worker's room_done reaches its lead as an addressed done message that wakes it, and marks the worker done", async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    t.b.setOverlay('rohanz+money', 'app.py', 'x = 100\n')
    const out = await t.workerTools.call('room_done', { summary: 'Money type in cents, 7 tests pass' })
    expect(out).toContain('Your lead rohanz has been told (worker money)')
    const done = t.a.messages().find(m => m.type === 'done') as Msg & { type: 'done' }
    expect(done).toBeTruthy()
    expect(done.to).toBe('rohanz'); expect(done.tag).toBe('money'); expect(done.changed).toEqual(['app.py'])
    expect(shouldWakeOnMsg(lead, done).wake).toBe(true)
    expect(shouldWakeOnMsg({ name: 'someone', kind: 'agent' }, done).wake).toBe(false)
    expect(t.a.workers.get('money')).toMatchObject({ status: 'done', summary: 'Money type in cents, 7 tests pass' })
    // The lead's next tool call shows the done line in its inbox.
    const st = await t.leadTools.call('room_state', {})
    expect(st).toContain('finished: Money type in cents')
    // A later process exit keeps the done status and records the code.
    t.exits[0](0)
    expect(t.a.workers.get('money')).toMatchObject({ status: 'done', exitCode: 0 })
  })

  it('a worker that exits without room_done is marked failed or done by exit code; dismiss kills a running one', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    await t.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    t.exits[0](1)
    expect(t.a.workers.get('a')).toMatchObject({ status: 'failed', exitCode: 1 })
    expect(t.a.messages().some(m => m.type === 'note' && m.to === 'rohanz' && /worker a .*exited with code 1/.test(m.text))).toBe(true)
    const d = await t.leadTools.call('room_dismiss', { tag: 'b' })
    expect(d).toContain('dismissed b')
    expect(t.killed).toHaveLength(1)
    expect(t.a.workers.get('b')?.status).toBe('dismissed')
    expect(await t.leadTools.call('room_dismiss', { tag: 'b' })).toContain('already dismissed')
  })
})

describe('pinned rooms', () => {
  it('a local or explicitly named room does not follow the clone branch; a derived one does', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    const pinned = { ...fakeSession(a, lead), roomName: 'local/x/other', pinnedRoom: true } as Session
    let s1: Session | null = pinned
    const t1 = createTools({ getSession: () => s1, setSession: x => { s1 = x }, cwd: dir })
    expect(await t1.call('room_state', { all: true })).not.toContain('switched to branch')
    const derived = { ...fakeSession(a, lead, false), roomName: 'github.com/o/x/other' } as Session
    let s2: Session | null = derived
    const t2 = createTools({ getSession: () => s2, setSession: x => { s2 = x }, cwd: dir, join: async o => ({ ...fakeSession(a, lead, false), roomName: o.room ?? '?' }), leave: async () => {} })
    expect(await t2.call('room_state', { all: true })).toContain('switched to branch main')
  })
})

function setupLead() {
  const { a, b } = pair()
  a.setMeta({ repo: 'x', branch: 'main', base })
  let ls: Session | null = fakeSession(a, lead)
  const specs: SpawnSpec[] = []
  const exits: ((code: number | null) => void)[] = []
  const killed: number[] = []
  const leadTools = createTools({
    getSession: () => ls, setSession: s => { ls = s }, cwd: dir, maxWorkers: 2,
    spawner: spec => { specs.push(spec); return { pid: 4242 + specs.length, onExit: cb => { exits.push(cb) }, kill: () => { killed.push(1) } } },
    worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
  })
  return { a, b, leadTools, specs, exits, killed }
}

describe('worker safety', () => {
  it('a pid this session did not spawn is signalled only if it started with the worker record and runs a worker command', () => {
    const rec = { startedAt: 1_000_000, tag: 'money', dir: '/repo/.room/workers/money' }
    const me = process.pid // alive; the probe decides the rest
    expect(pidIsOurWorker(-1, rec)).toBe(false)
    expect(pidIsOurWorker(0, rec)).toBe(false)
    expect(pidIsOurWorker(me, rec, () => ({ start: 1_002_000, command: 'claude -p You are worker "money", dispatched by rohanz' }))).toBe(true)
    expect(pidIsOurWorker(me, rec, () => ({ start: 1_002_000, command: '/usr/local/bin/codex exec -s workspace-write worker money' }))).toBe(true)
    // recycled pid: right command line, wrong start time
    expect(pidIsOurWorker(me, rec, () => ({ start: 1_020_000, command: 'claude -p worker money' }))).toBe(false)
    // right time, unrelated process
    expect(pidIsOurWorker(me, rec, () => ({ start: 1_001_000, command: 'vim README.md' }))).toBe(false)
    // a worker command that does not mention this worker
    expect(pidIsOurWorker(me, rec, () => ({ start: 1_001_000, command: 'claude -p something else' }))).toBe(false)
    expect(pidIsOurWorker(me, rec, () => undefined)).toBe(false)
    // pid 1 is alive but a real probe will never match a worker record
    expect(pidIsOurWorker(1, rec)).toBe(false)
  })

  it('dismissing a worker whose process is unknown and old leaves the pid alone and keeps its status', async () => {
    const { a, b } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    // a worker record left by a lead that has since restarted: pid 1 is alive but not ours
    a.setWorker({ tag: 'ghost', name: 'rohanz+ghost', host: 'claude', task: 'x', dir, branch: 'room/ghost', pid: 1, startedAt: Date.now(), status: 'running', lead: 'rohanz' })
    let ls: Session | null = fakeSession(b, lead)
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir })
    const out = await tools.call('room_dismiss', { tag: 'ghost' })
    expect(out).toContain('not signalled')
    expect(a.workers.get('ghost')?.status).toBe('running') // nothing was signalled, so nothing changed
  })

  it('room_leave refuses while workers run, force dismisses them; shutdown dismisses too', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    const refused = await t.leadTools.call('room_leave', {})
    expect(refused).toContain('error: 1 worker(s) still running: a')
    expect(t.a.workers.get('a')?.status).toBe('running')
    const left = await t.leadTools.call('room_leave', { force: true })
    expect(left).toContain('left local/x/main')
    expect(t.killed).toHaveLength(1)
    expect(t.a.workers.get('a')?.status).toBe('dismissed')
    expect(t.a.messages().some(m => m.type === 'note' && /dismissed worker a .*the lead left/.test((m as { text: string }).text))).toBe(true)
    // shutdown path
    const t2 = setupLead()
    await t2.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    await t2.leadTools.shutdown()
    expect(t2.killed).toHaveLength(1)
    expect(t2.a.workers.get('b')?.status).toBe('dismissed')
  })

  it('a worker that cannot start is marked failed', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    let onErr: ((e: Error) => void) | undefined
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir,
      spawner: () => ({ pid: -1, onExit: () => {}, onError: cb => { onErr = cb }, kill: () => { throw new Error('must not signal') } }),
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    await tools.call('room_spawn', { tag: 'nope', task: 'x', host: 'codex' })
    onErr!(new Error('spawn codex ENOENT'))
    expect(a.workers.get('nope')).toMatchObject({ status: 'failed', exitCode: -1 })
    expect(a.messages().some(m => m.type === 'note' && /could not start: spawn codex ENOENT/.test((m as { text: string }).text))).toBe(true)
    // dismissing it never signals anything
    expect(await tools.call('room_dismiss', { tag: 'nope' })).toContain('already failed')
  })

  it('room_spawn refuses a dir outside the repo unless allowOutside, and then skips worktree bookkeeping', async () => {
    const t = setupLead()
    const outside = mkdtempSync(join(tmpdir(), 'room-outside-'))
    execFileSync('git', ['-C', outside, 'init', '-q', '-b', 'elsewhere'], { stdio: 'pipe' })
    writeFileSync(join(outside, 'f.txt'), 'x\n')
    execFileSync('git', ['-C', outside, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { stdio: 'pipe' })
    execFileSync('git', ['-C', outside, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { stdio: 'pipe' })
    const refused = await t.leadTools.call('room_spawn', { tag: 'far', task: 'x', dir: outside })
    expect(refused).toContain('outside this repo')
    expect(t.specs).toHaveLength(0)
    const ok = await t.leadTools.call('room_spawn', { tag: 'far', task: 'x', dir: outside, allowOutside: true })
    expect(ok).toContain('outside this repo, so no worktree was made')
    expect(t.a.workers.get('far')).toMatchObject({ dir: outside, branch: 'elsewhere' })
  })
})

describe('review fixes: workers', () => {
  it('a worker is named after the lead\'s owner and told so through ROOM_OWNER (fix 5)', async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    const teamLead: Identity = { name: 'rohanz+lead', kind: 'agent', owner: 'rohanz', label: 'lead' }
    let ls: Session | null = fakeSession(team.a, teamLead, false)
    ls!.roomName = 'github.com/rohanz/x/main'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx%2Fmain'
    const specs: SpawnSpec[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0,
      join: async () => fakeSession(local.a, teamLead),
      leave: async () => {},
      spawner: spec => { specs.push(spec); return { pid: 99, onExit: () => {}, kill: () => {} } },
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    await leadTools.call('room_spawn', { tag: 'money', task: 't', where: 'local' })
    expect(specs[0].env.ROOM_OWNER).toBe('rohanz')
    expect(local.a.workers.get('money')!.name).toBe('rohanz+money')
    await leadTools.call('room_leave', { force: true })
  })

  it('a shared-token server URL and ROOM_TOKEN reach the worker unchanged (fix 10)', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead, false)
    ls!.roomUrl = 'ws://team.example/local%2Fx%2Fmain'
    const specs: SpawnSpec[] = []
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir, spawner: spec => { specs.push(spec); return { pid: 5, onExit: () => {}, kill: () => {} } }, worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }) })
    const prev = { server: process.env.ROOM_SERVER, token: process.env.ROOM_TOKEN }
    process.env.ROOM_SERVER = 'ws://team.example/?token=abc'; process.env.ROOM_TOKEN = 'abc'
    try {
      await tools.call('room_spawn', { tag: 'w', task: 't' })
      expect(specs[0].env.ROOM_SERVER).toBe('ws://team.example/?token=abc')
      expect(specs[0].env.ROOM_TOKEN).toBe('abc')
    } finally {
      if (prev.server === undefined) delete process.env.ROOM_SERVER; else process.env.ROOM_SERVER = prev.server
      if (prev.token === undefined) delete process.env.ROOM_TOKEN; else process.env.ROOM_TOKEN = prev.token
    }
  })

  it('a finished worker whose process is alive can still be stopped; leave and shutdown stop it too (fix 8)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't' })
    let ws: Session | null = fakeSession(t.b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    await workerTools.call('room_done', { summary: 'done but still running' })
    expect(t.a.workers.get('money')!.status).toBe('done')
    expect(await t.leadTools.call('room_dismiss', { tag: 'money' })).toContain('stopped the done worker money')
    expect(t.killed).toHaveLength(1)
    expect(t.a.workers.get('money')!.status).toBe('done') // the outcome stands; only the process was stopped
    // shutdown with a live process behind a done record signals it as well
    await t.leadTools.call('room_spawn', { tag: 'tiers', task: 't' })
    let ws2: Session | null = fakeSession(t.b, { name: 'rohanz+tiers', kind: 'agent', owner: 'rohanz', label: 'tiers' })
    const tiersTools = createTools({ getSession: () => ws2, setSession: s => { ws2 = s }, cwd: dir })
    await tiersTools.call('room_done', { summary: 'x' })
    await t.leadTools.shutdown()
    expect(t.killed).toHaveLength(2)
  })

  it('a reused tag refuses while the old process lives, and a stale exit callback cannot touch the new record (fix 9)', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'first' })
    expect(t.a.workers.get('money')!.gen).toBe(1)
    // dismissed (process signalled) but the exit callback has not fired yet
    await t.leadTools.call('room_dismiss', { tag: 'money' })
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'second' })
    const second = t.a.workers.get('money')!
    expect(second).toMatchObject({ status: 'running', task: 'second', gen: 2 })
    t.exits[0](1) // the first process finally dies
    expect(t.a.workers.get('money')).toMatchObject({ status: 'running', task: 'second', gen: 2 })
    t.exits[1](0)
    expect(t.a.workers.get('money')).toMatchObject({ status: 'done', gen: 2 })
    // and while a process is alive the tag cannot be reused
    await t.leadTools.call('room_spawn', { tag: 'x', task: 't' })
    expect(await t.leadTools.call('room_spawn', { tag: 'x', task: 'again' })).toContain('already running')
  })
})

describe('review fixes: the workers room', () => {
  function setupBridged(queue?: (id: string, text: string) => Promise<void>) {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(team.a, lead, false)
    ls!.roomName = 'github.com/rohanz/x/main'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx%2Fmain'
    const attached: string[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0, queue,
      attachChannel: s => { attached.push(s.roomName) },
      join: async () => fakeSession(local.a, lead),
      leave: async () => {},
      spawner: () => ({ pid: 99, onExit: () => {}, kill: () => {} }),
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    let ws: Session | null = fakeSession(local.b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    return { team, local, leadTools, workerTools, attached }
  }

  it("the lead's answer to a worker's question lands in the workers room, and room_wait finds the answer there (fix 6)", async () => {
    const t = setupBridged()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't', where: 'local' })
    const asked = await t.workerTools.call('room_send', { type: 'question', text: 'which field?', to: 'rohanz' })
    const qid = asked.match(/questionId=(m_\w+)/)![1]
    const sent = await t.leadTools.call('room_send', { type: 'answer', inReplyTo: qid, text: 'price_cents' })
    expect(sent).toContain('(in the workers room)')
    expect(t.local.b.messages().some(m => m.type === 'answer' && m.inReplyTo === qid)).toBe(true)
    expect(t.team.b.messages().some(m => m.type === 'answer')).toBe(false)
    // a plain note addressed to the worker goes there too
    await t.leadTools.call('room_send', { type: 'note', text: 'keep going', to: 'rohanz+money' })
    expect(t.local.b.messages().at(-1)).toMatchObject({ type: 'note', to: 'rohanz+money' })
    // the worker's wait on its question resolves with the answer
    expect(await t.workerTools.call('room_wait', { questionId: qid, timeoutMs: 1000 })).toContain('answered: ')
    await t.leadTools.call('room_leave', { force: true })
  })

  it("questions and done messages from the workers room wake the lead through its host (fix 7)", async () => {
    const woken: string[] = []
    const t = setupBridged(async (_id, text) => { woken.push(text) })
    writeFileSync(join(dir, '.git', 'room-session.json'), JSON.stringify({ session_id: 'thread-lead', at: Date.now(), cwd: dir, host: 'codex' }))
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't', where: 'local' })
    expect(t.attached).toEqual(['local/x/main'])
    await t.workerTools.call('room_send', { type: 'question', text: 'which field?', to: 'rohanz' })
    await new Promise(r => setTimeout(r, 200))
    expect(woken.some(x => x.includes('which field?'))).toBe(true)
    await t.workerTools.call('room_done', { summary: 'all in cents' })
    await new Promise(r => setTimeout(r, 200))
    expect(woken.some(x => x.includes('all in cents'))).toBe(true)
    await t.leadTools.call('room_leave', { force: true })
  })
})

describe('review round 3', () => {
  it("a tag held by another lead's running worker is refused, and its record is never touched", async () => {
    const t = setupLead()
    t.a.setWorker({ tag: 'money', name: 'kieran+money', host: 'claude', task: 'theirs', dir: '/x', branch: 'room/money', pid: 4242, startedAt: Date.now(), status: 'running', lead: 'kieran', gen: 1 })
    expect(await t.leadTools.call('room_spawn', { tag: 'money', task: 'mine' })).toContain("in use by kieran's worker")
    expect(t.a.workers.get('money')).toMatchObject({ lead: 'kieran', status: 'running' })
  })
})
