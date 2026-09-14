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
import { prepareWorktree, workerCommand, workerPrompt, validTag, type SpawnSpec } from '../src/workers.js'

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

  it('refuses beyond the worker budget', async () => {
    const t = setup()
    await t.leadTools.call('room_spawn', { tag: 'a', task: 'x' })
    await t.leadTools.call('room_spawn', { tag: 'b', task: 'y' })
    expect(await t.leadTools.call('room_spawn', { tag: 'c', task: 'z' })).toContain('max 2')
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
    expect(t.a.workers.get('b')?.status).toBe('dismissed')
    expect(await t.leadTools.call('room_dismiss', { tag: 'b' })).toContain('already dismissed')
  })
})
