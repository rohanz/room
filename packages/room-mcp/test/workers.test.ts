import { describe, it, expect, beforeAll, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, shouldWakeOnMsg } from '@room/shared'
import type { Identity, Msg } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { resolveConfig } from '../src/config.js'
import { GraphIndex } from '../src/graph-index.js'
import { prepareWorktree, workerCommand, workerPrompt, validTag, pidIsOurWorker, workerEnv, type SpawnSpec } from '../src/workers.js'

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
    expect(c.cmd).toBe('claude'); expect(c.args).toContain('--model'); expect(c.args.slice(0, 4)).toEqual(['--dangerously-load-development-channels', 'plugin:room@room', '-p', 'do it'])
    const x = workerCommand('codex', undefined, 'do it')
    expect(x.cmd).toBe('codex'); expect(x.args.slice(0, 3)).toEqual(['exec', '-s', 'workspace-write'])
    expect(workerPrompt('rohanz', 'money', 'switch to cents')).toContain('to "rohanz"')
  })

  it('uses the resolved channel override and supports disabling it', async () => {
    for (const channel of ['plugin:custom@market', '']) {
      const config = await resolveConfig({ dir, env: { ROOM_CLAUDE_CHANNEL: channel } })
      const c = workerCommand('claude', undefined, 'task', config.claudeChannel)
      expect(c.args.slice(0, channel ? 4 : 2)).toEqual(channel ? ['--dangerously-load-development-channels', channel, '-p', 'task'] : ['-p', 'task'])
      expect(workerCommand('codex', undefined, 'task', config.claudeChannel).args).not.toContain('--dangerously-load-development-channels')
    }
  })

  it('creates a worktree on branch room/<tag> and reuses it', async () => {
    const w1 = await prepareWorktree(dir, 'money')
    expect(w1.created).toBe(true); expect(w1.branch).toBe('room/money'); expect(existsSync(join(w1.dir, 'app.py'))).toBe(true)
    const w2 = await prepareWorktree(dir, 'money')
    expect(w2.created).toBe(false); expect(w2.dir).toBe(w1.dir)
  })

  it('prunes a stale registration when a worker directory was deleted', async () => {
    const first = await prepareWorktree(dir, 'deleted')
    rmSync(first.dir, { recursive: true, force: true })
    const recreated = await prepareWorktree(dir, 'deleted')
    expect(recreated).toMatchObject({ dir: first.dir, branch: 'room/deleted', created: true })
    expect(existsSync(join(recreated.dir, 'app.py'))).toBe(true)
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
      spawner: spec => { specs.push(spec); return { pid: 4242 + specs.length, onExit: cb => { exits.push(cb) }, kill: () => { killed.push(1); return true } } },
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    let ws: Session | null = fakeSession(b, workerId)
    const workerTools = createTools({ getSession: () => ws, setSession: s => { ws = s }, cwd: dir })
    return { a, b, leadTools, workerTools, specs, exits, killed }
  }

  it.each(['plugin:custom@market', ''])('passes ROOM_CLAUDE_CHANNEL through room_spawn (%s)', async channel => {
    vi.stubEnv('ROOM_CLAUDE_CHANNEL', channel)
    try {
      const t = setup()
      expect(await t.leadTools.call('room_spawn', { tag: 'channel', task: 'check channels' })).toContain('spawned channel')
      const args = t.specs[0].args
      expect(args[0]).toBe(channel ? '--dangerously-load-development-channels' : '-p')
      if (channel) expect(args[1]).toBe(channel)
      else expect(args).not.toContain('--dangerously-load-development-channels')
      await t.leadTools.shutdown()
    } finally { vi.unstubAllEnvs() }
  })

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
      spawner: spec => { specs.push(spec); return { pid: 99, onExit: () => {}, kill: () => true } },
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

  it.each([{ workerId: 'old-spawn' }, { gen: '0' }])('uses resolved worker identity to protect a newer spawn: %j', async identity => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'switch prices to cents' })
    const s = fakeSession(t.b, workerId)
    const config = { ...await resolveConfig({ dir, env: {} }), ...identity }
    const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, config })
    await tools.call('room_done', { summary: 'old task finished' })
    expect(t.a.workers.get('money')?.status).toBe('running')
    expect(t.a.messages().some(m => m.type === 'done' && m.summary.includes('earlier generation'))).toBe(true)
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
    spawner: spec => { specs.push(spec); return { pid: 4242 + specs.length, onExit: cb => { exits.push(cb) }, kill: () => { killed.push(1); return true } } },
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
    expect(out).toMatch(/^could not dismiss ghost: pid 1 not signalled.*; status stays running;/)
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
      spawner: spec => { specs.push(spec); return { pid: 99, onExit: () => {}, kill: () => true } },
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    await leadTools.call('room_spawn', { tag: 'money', task: 't', where: 'local' })
    expect(specs[0].env.ROOM_OWNER).toBe('rohanz')
    expect(local.a.workers.get('money')!.name).toBe('rohanz+money')
    await leadTools.call('room_leave', { force: true })
  })

  it('a shared-token server reaches the worker as a bare URL plus ROOM_TOKEN, whatever way the lead got the token (fix 10, W1)', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    // the lead joined with where=ws://team.example/?token=abc: only the session knows the token, not the environment
    let ls: Session | null = { ...fakeSession(a, lead, false), roomUrl: 'ws://team.example/local%2Fx%2Fmain', token: 'abc' } as Session
    const specs: SpawnSpec[] = []
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir, spawner: spec => { specs.push(spec); return { pid: 5, onExit: () => {}, kill: () => true } }, worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }) })
    await tools.call('room_spawn', { tag: 'w', task: 't' })
    expect(specs[0].env.ROOM_SERVER).toBe('ws://team.example')
    expect(specs[0].env.ROOM_TOKEN).toBe('abc')
    // the join reply and room_state never print the token
    expect(await tools.call('room_state', {})).not.toContain('abc')
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
      spawner: () => ({ pid: 99, onExit: () => {}, kill: () => true }),
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

describe('workers review: env, keys, sessions, reservation, signals', () => {
  it('W1: a worker gets exactly its own room variables; the lead\'s ROOM_URL/ROOM_NAME/ROOM_DIR and token never leak', async () => {
    const t = setupLead()
    await t.leadTools.call('room_spawn', { tag: 'money', task: 't' })
    const env = t.specs[0].env
    expect(Object.keys(env).filter(k => k.startsWith('ROOM_')).sort()).toEqual(['ROOM_DIR', 'ROOM_GEN', 'ROOM_LEAD', 'ROOM_LOG_FILE', 'ROOM_OWNER', 'ROOM_ROOM', 'ROOM_SERVER', 'ROOM_SHARE', 'ROOM_TAG', 'ROOM_WORKER_ID'])
    expect(env).toMatchObject({ ROOM_SERVER: 'local', ROOM_ROOM: 'local/x/main', ROOM_TAG: 'money', ROOM_LEAD: 'rohanz', ROOM_OWNER: 'rohanz', ROOM_GEN: '1', ROOM_SHARE: 'full' })
    expect(env.ROOM_DIR).toBe(join(dir, '.room', 'workers', 'money'))
    expect(env.ROOM_LOG_FILE).toBe(join(dir, '.room', 'workers', 'money.mcp.log'))
    // the real spawner strips the lead's own room variables from the inherited environment before applying the spec's
    const merged = workerEnv({ PATH: '/bin', ROOM_URL: 'ws://lead/room', ROOM_NAME: 'rohanz', ROOM_DIR: '/lead', ROOM_TOKEN: 'secret', ROOM_TAG: 'lead', ROOM_MAX_WORKERS: '3' }, env)
    expect(merged.ROOM_URL).toBeUndefined(); expect(merged.ROOM_NAME).toBeUndefined(); expect(merged.ROOM_TOKEN).toBeUndefined()
    expect(merged).toMatchObject({ PATH: '/bin', ROOM_MAX_WORKERS: '3', ROOM_DIR: env.ROOM_DIR, ROOM_TAG: 'money' })
    // a second spawn of a reused tag carries the next generation
    t.exits[0](0)
    await t.leadTools.call('room_spawn', { tag: 'money', task: 'again' })
    expect(t.specs[1].env.ROOM_GEN).toBe('2')
  })

  it('W2/W3: the same tag in the lead\'s room and the workers room are two processes; reads and diffs of a local worker come from the workers room', async () => {
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(team.a, lead, false)
    ls!.roomName = 'github.com/rohanz/x/main'; ls!.roomUrl = 'wss://team.example/github.com%2Frohanz%2Fx%2Fmain'
    const killed: string[] = []
    const leadTools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir, conflictDebounceMs: 0,
      join: async () => fakeSession(local.a, lead),
      leave: async () => {},
      spawner: spec => ({ pid: 99, onExit: () => {}, kill: () => { killed.push(spec.env.ROOM_ROOM); return true } }),
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    await leadTools.call('room_spawn', { tag: 'money', task: 'team side' })
    await leadTools.call('room_spawn', { tag: 'money', task: 'local side', where: 'local' })
    expect(team.a.workers.get('money')?.task).toBe('team side')
    expect(local.a.workers.get('money')?.task).toBe('local side')
    // the local worker edits in the workers room; the team-room lead reads and diffs its version
    local.b.setOverlay('rohanz+money', 'app.py', 'x = 100\n')
    local.b.setOverlay('rohanz+tiers', 'tiers.py', 'tier = "gold"\n')
    const read = await leadTools.call('room_read', { path: 'app.py', person: 'rohanz+money' })
    expect(read).toContain('x = 100')
    expect(read).toContain('as rohanz+money sees it')
    expect(await leadTools.call('room_diff', { path: 'app.py', person: 'rohanz+money' })).toContain('+x = 100')
    expect(await leadTools.call('room_who', { path: 'app.py' })).toContain('uncommitted changes by: rohanz+money')
    const pm = await leadTools.call('room_preview_merge', { person: 'rohanz+money' })
    expect(pm).toContain('rohanz+money only')
    const all = await leadTools.call('room_preview_merge', { people: ['rohanz+money', 'rohanz+tiers'], run: 'cat app.py tiers.py' })
    expect(all).toContain('x = 100')
    expect(all).toContain('tier = "gold"')
    expect(all).toContain('exit 0')
    // dismissing the team-room worker signals only the team-room process; the local one is untouched
    await leadTools.call('room_dismiss', { tag: 'money' })
    expect(killed).toEqual(['github.com/rohanz/x/main'])
    expect(local.a.workers.get('money')?.status).toBe('running')
    await leadTools.call('room_leave', { force: true })
    expect(killed).toEqual(['github.com/rohanz/x/main', 'local/x/main'])
  })

  it('W4: two concurrent spawns of one tag cannot both pass the tag check', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const specs: SpawnSpec[] = []
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir,
      spawner: spec => { specs.push(spec); return { pid: 7, onExit: () => {}, kill: () => true } },
      worktree: async (repo, tag) => { await gate; return { dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true } },
    })
    const first = tools.call('room_spawn', { tag: 'money', task: 'one' })
    await new Promise(r => setTimeout(r, 10))
    const second = await tools.call('room_spawn', { tag: 'money', task: 'two' })
    expect(second).toContain('being spawned right now')
    release()
    expect(await first).toContain('spawned money')
    expect(specs).toHaveLength(1)
    expect(a.workers.get('money')?.task).toBe('one')
    // the reservation is released once the spawn has finished (or failed)
    expect(await tools.call('room_spawn', { tag: 'money', task: 'three' })).toContain('already running')
  })

  it('W5: after a lead restart, a done worker whose process is still ours can be stopped by dismiss, leave and shutdown', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    const startedAt = Date.now()
    // a stand-in for the worker process that outlived the lead: its own process group, so the signal cannot reach the test runner
    const child = spawn('sleep', ['100'], { detached: true, stdio: 'ignore' }); child.unref()
    const exited = new Promise<void>(r => child.once('exit', () => r()))
    // a record from before the restart: no entry in procs, but ps says this pid is the worker's claude
    a.setWorker({ tag: 'money', name: 'rohanz+money', host: 'claude', task: 'x', dir: '/repo/.room/workers/money', branch: 'room/money', pid: child.pid!, startedAt, status: 'done', lead: 'rohanz', gen: 1, summary: 'done but alive' })
    let ls: Session | null = fakeSession(a, lead)
    const probe = () => ({ start: startedAt, command: 'claude -p You are worker "money"' })
    const tools = createTools({ getSession: () => ls, setSession: s => { ls = s }, cwd: dir, probe })
    expect(await tools.call('room_leave', {})).toContain('still running: money')
    expect(await tools.call('room_spawn', { tag: 'money', task: 'again' })).toContain('done but its process is still alive')
    const out = await tools.call('room_dismiss', { tag: 'money' })
    expect(out).toContain('stopped the done worker money')
    expect(a.workers.get('money')?.status).toBe('done') // the outcome stands; only the process was stopped
    await exited
  })

  it('W8: dismiss marks a worker dismissed only when the signal was delivered', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'main', base })
    let ls: Session | null = fakeSession(a, lead)
    let deliverable = false
    const tools = createTools({
      getSession: () => ls, setSession: s => { ls = s }, cwd: dir,
      spawner: () => ({ pid: 8, onExit: () => {}, kill: () => deliverable }),
      worktree: async (repo, tag) => ({ dir: join(repo, '.room', 'workers', tag), branch: `room/${tag}`, created: true }),
    })
    await tools.call('room_spawn', { tag: 'money', task: 't' })
    const refused = await tools.call('room_dismiss', { tag: 'money' })
    expect(refused).toMatch(/^could not dismiss money: pid 8 not signalled: .*; status stays running;/)
    expect(a.workers.get('money')?.status).toBe('running')
    expect(a.messages().some(m => m.type === 'note' && /could not dismiss worker money/.test((m as { text: string }).text))).toBe(true)
    deliverable = true
    expect(await tools.call('room_dismiss', { tag: 'money' })).toContain('dismissed money')
    expect(a.workers.get('money')?.status).toBe('dismissed')
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
