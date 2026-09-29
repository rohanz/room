import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { createTools } from '../src/tools.js'
import { Rooms } from '../src/registry.js'
import { decideResume, type WorkerRealState } from '../src/worker-state.js'
import { prepareWorktree } from '../src/worker-git.js'
import { HooksBridge } from '../src/hooks-bridge.js'
import { Ledger } from '../src/ledger.js'
import { projectWorkers } from '../src/worker-projector.js'
import type { Session } from '../src/session.js'
import type { PreparedWorktree } from '../src/worker-git.js'
import type { SpawnSpec } from '../src/worker-process.js'
import { registerWorkers, workerByTag, type FixtureWorker } from './registry-fixture.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'
import { hubAppend } from '@room/shared/testing'

const scratch: string[] = []
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  for (const dir of scratch.splice(0)) { await closeRegistryForDir(dir); rmSync(dir, { recursive: true, force: true }) }
})

function setup(maxWorkers = 2, worktree?: (repo: string, tag: string) => Promise<PreparedWorktree>, probe: (pid: number) => { startTime?: string; executable?: string } | undefined = () => undefined, failStart = false, started: Promise<void> = Promise.resolve(), failWatch = false, stop: { term?: boolean; exitOnTerm?: boolean; exitOnForce?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'room-resume-'))
  scratch.push(dir)
  vi.stubEnv('XDG_CONFIG_HOME', dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@test')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.')
  git('commit', '-qm', 'initial')
  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ repo: 'x', branch: 'main', base: git('rev-parse', 'HEAD') })
  const me = { name: 'rohanz', kind: 'agent' as const, owner: 'rohanz' }
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  const session = {
    room, awareness, me, dir, roomName: 'local/x/main', roomUrl: 'ws://127.0.0.1:1/local%2Fx%2Fmain', browserUrl: 'http://x',
    ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true, awareness },
    daemon: { touch() {}, async stop() {}, share: 'full', dir, name: me.name, roomDoc: room, branch: 'main', fence: 'test-fence' },
    shareMax: 'full', shareRequested: 'full',
    local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} },
  } as unknown as Session
  let current: Session | null = session
  const specs: SpawnSpec[] = []
  const logs: string[] = []
  const exits: ((code: number | null) => void)[] = []
  const errors: ((error: Error) => void)[] = []
  const kills: number[] = []
  let notifySpawn!: () => void
  const spawned = new Promise<void>(resolve => { notifySpawn = resolve })
  const tools = createTools({
    getSession: () => current, setSession: s => { current = s }, cwd: dir, maxWorkers, log: line => logs.push(line), probe, listCwdProcesses: () => [],
    spawner: spec => { if (failStart) throw new Error('host unavailable'); specs.push(spec); notifySpawn(); return { pid: 6000 + specs.length, started, onExit: cb => { if (failWatch) throw new Error('could not watch exit'); exits.push(cb) }, onError: cb => { errors.push(cb) }, kill: () => { kills.push(1); if (stop.exitOnTerm) queueMicrotask(() => exits.at(-1)?.(0)); return stop.term ?? true }, killForce: () => { kills.push(9); if (stop.exitOnForce) queueMicrotask(() => exits.at(-1)?.(null)); return true } } },
    worktree: worktree ?? ((repo, tag) => prepareWorktree(repo, tag, 'rohanz')),
  })
  const seed = async (tag: string, patch: Partial<FixtureWorker> = {}) => {
    const workerDir = join(dir, '.room', 'workers', tag)
    mkdirSync(join(dir, '.room', 'workers'), { recursive: true })
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', `room/${tag}`, workerDir, 'HEAD'])
    await registerWorkers(session, [{
      id: `rohanz/${tag}#1`, tag, name: `rohanz+${tag}`, lead: 'rohanz', host: 'claude',
      hostSessionId: '550e8400-e29b-41d4-a716-446655440000',
      budget: { threads: 1, memGb: 1, nice: 0 }, task: 'test', dir: workerDir,
      branch: `room/${tag}`, pid: -1, startedAt: 1, status: 'done', exitCode: 0, ...patch,
    }])
  }
  /** The worker's registry record under a tag (spawned or seeded), for run facts the lifecycle view does not carry. */
  const record = async (tag: string) => (await registryForDir(dir)).list().find(r => r.tag === tag)
  return { dir, room, session, tools, record, specs, spawned, exits, errors, kills, logs, seed, portFile: (port: number) => join(dir, 'room', 'ports', String(port)) }
}

describe('resumed worker boundaries', () => {
  it('keeps a posted follow-up owed until the resumed turn is accepted', async () => {
    const t = setup()
    await t.seed('owed')
    expect(await t.tools.call('room_send', { type: 'note', to: 'owed', text: 'continue' })).toContain('resumed owed')
    const msg = t.room.messages().find(m => m.to === 'rohanz+owed')!
    const run = (await t.record('owed'))!.runs.at(-1)!
    expect(run.promptMsgIds).toContain(msg.id)
    expect(t.room.seen('rohanz+owed').has(msg.id)).toBe(false)
  })

  it('receipts the prompt on the admitted worker MCP first Room action', async () => {
    const t = setup()
    await t.seed('action')
    await t.tools.call('room_send', { type: 'note', to: 'action', text: 'continue' })
    const record = (await t.record('action'))!, run = record.runs.at(-1)!
    const worker = { ...t.session, me: { name: record.name, kind: 'agent' as const } } as Session
    vi.stubEnv('ROOM_WORKER_ID', record.id); vi.stubEnv('ROOM_WORKER_RUN', String(run.n)); vi.stubEnv('ROOM_LAUNCH_NONCE', run.nonce)
    const ledger = new Ledger({ sessionId: () => record.hostSessionId!, route: () => ({}) })
    expect(ledger.candidates(worker).map(m => m.id)).not.toContain(run.promptMsgIds[0])
    ledger.acceptPrompt(worker)
    expect(t.room.seen(record.name).get(run.promptMsgIds[0])).toMatchObject({ via: 'prompt', s: record.hostSessionId })
  })

  it('projector receipts only a matching Claude assistant event after a no-call resume', async () => {
    const t = setup()
    await t.seed('silent')
    await t.tools.call('room_send', { type: 'note', to: 'silent', text: 'continue' })
    const record = (await t.record('silent'))!, run = record.runs.at(-1)!
    const log = join(t.dir, '.room', 'workers', 'silent.log')
    const append = (event: object) => writeFileSync(log, JSON.stringify(event) + '\n', { flag: 'a' })
    append({ type: 'system', subtype: 'init', session_id: record.hostSessionId })
    append({ type: 'assistant', session_id: 'another-session', message: { content: [{ type: 'text', text: 'wrong' }] } })
    t.exits[0](0)
    const registry = await registryForDir(t.dir)
    await vi.waitFor(() => expect(registry.status(record.id)?.status).toBe('failed'))
    await projectWorkers(t.session, registry, 'rohanz', 'joined')
    expect(t.room.seen(record.name).has(run.promptMsgIds[0])).toBe(false)
    append({ type: 'assistant', session_id: record.hostSessionId, message: { content: [{ type: 'text', text: 'accepted' }] } })
    await projectWorkers(t.session, registry, 'rohanz', 'joined')
    expect(t.room.seen(record.name).get(run.promptMsgIds[0])).toMatchObject({ via: 'prompt', s: record.hostSessionId })
  })

  it('shows a missing Claude session while leaving its follow-up owed', async () => {
    const t = setup()
    await t.seed('missing')
    await t.tools.call('room_send', { type: 'note', to: 'missing', text: 'continue' })
    const record = (await t.record('missing'))!, run = record.runs.at(-1)!
    writeFileSync(join(t.dir, '.room', 'workers', 'missing.log'), JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0,
      session_id: record.hostSessionId, result: 'No conversation found',
    }) + '\n')
    t.exits[0](1)
    const registry = await registryForDir(t.dir)
    await vi.waitFor(() => expect(registry.status(record.id)?.status).toBe('failed'))
    await vi.waitFor(() => expect(t.room.messages().some(m => m.type === 'note' && m.text.includes('no longer exists'))).toBe(true))
    await projectWorkers(t.session, registry, 'rohanz', 'joined')
    expect(t.room.workerViewOf(record.name)?.note).toContain('no longer exists; the message stays owed')
    expect(t.room.seen(record.name).has(run.promptMsgIds[0])).toBe(false)
  })

  it('still fails a fresh worker that exits zero without room_done', async () => {
    const t = setup()
    expect(await t.tools.call('room_spawn', { tag: 'fresh', task: 'test', host: 'codex' })).toContain('spawned fresh')
    expect((await t.record('fresh'))?.runs.map(run => run.mode)).toEqual(['fresh'])
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(t.dir, 'fresh')?.status).toBe('failed'))
    await vi.waitFor(() => expect(t.room.messages().filter(m => m.priority === 'interrupt')).toHaveLength(1))
  })

  it('fails a resumed nonzero exit with the death note', async () => {
    const t = setup()
    await t.seed('broken', { host: 'codex', summary: 'initial work done' })
    expect(await t.tools.call('room_send', { type: 'note', to: 'broken', text: 'check cleanup' })).toContain('resumed broken')
    t.exits[0](1)
    await vi.waitFor(() => expect(workerByTag(t.dir, 'broken')).toMatchObject({ status: 'failed', exitCode: 1 }))
    await vi.waitFor(() => expect(t.room.messages().filter(m => m.priority === 'interrupt')).toMatchObject([{ to: 'rohanz', text: expect.stringContaining('worker broken failed: exit 1') }]))
    const record = (await t.record('broken'))!, run = record.runs.at(-1)!
    expect(t.room.messages().filter(m => m.type === 'done' && m.id === `wk:${record.id}:${run.n}`)).toEqual([])
  })

  it("records the lead's highest seq at intent as the run's busFrontier", async () => {
    const t = setup()
    const before = hubAppend(t.room, t.session.me, { type: 'note', text: 'earlier work', priority: 'fyi' })
    expect(await t.tools.call('room_spawn', { tag: 'briefed', task: 'review', host: 'claude' })).toContain('spawned briefed')
    const record = (await registryForDir(t.dir)).list().find(r => r.tag === 'briefed')!
    expect(record.runs[0].busFrontier).toBe(before.seq)
  })

  it('advances the briefing boundary when a finished worker resumes', async () => {
    const t = setup()
    await t.seed('briefed')
    const between = hubAppend(t.room, t.session.me, { type: 'note', text: 'before resume', priority: 'notify' })
    const resumed = t.room.messages().at(-1)!
    expect(await t.tools.call('room_send', { type: 'note', to: 'briefed', text: 'continue' })).toContain('resumed briefed')
    const record = (await registryForDir(t.dir)).list().find(r => r.tag === 'briefed')!
    expect(record.runs.at(-1)).toMatchObject({ n: 2, busFrontier: expect.any(Number) })
    expect(record.runs.at(-1)!.busFrontier).toBeGreaterThanOrEqual(resumed.seq!)
    const after = hubAppend(t.room, t.session.me, { type: 'note', text: 'after resume', priority: 'notify' })
    const joined = { ...t.session, me: { name: record.name, kind: 'agent' as const } } as Session
    // A resumed run whose session lost its cursor seeds from the new run's busFrontier: later broadcasts are owed, earlier ones are not.
    vi.stubEnv('ROOM_WORKER_ID', record.id)
    vi.stubEnv('ROOM_WORKER_RUN', '2')
    const owed = new Ledger({ sessionId: () => 'worker-session', route: () => ({}) }).candidates(joined).map(m => m.id)
    expect(owed).not.toContain(between.id)
    expect(owed).toContain(after.id)
  })

  it.each([
    ['vanished', false, 'gone', 'missing'],
    ['present', false, 'gone', 'no-session'],
    ['present', true, 'ours', 'wait-exit'],
    ['present', true, 'gone', 'ready'],
  ] as const)('resume decision: worktree %s, host session %s, process %s -> %s', (worktree, hostSession, process, expected) => {
    expect(decideResume({ worktree, hostSession, process } as WorkerRealState)).toBe(expected)
  })
  it('keeps an intent worker at intent when its lead shares full', async () => {
    vi.stubEnv('ROOM_WORKER_NICE', '0')
    const t = setup()
    expect(await t.tools.call('room_spawn', { tag: 'narrow', task: 'test', share: 'intent', host: 'claude' })).toContain('spawned narrow')
    const initial = workerByTag(t.dir, 'narrow')!
    expect(initial.share).toBe('intent')
    // The worker reports done (room_done), then its process exits.
    const registry = await registryForDir(t.dir), run = registry.read(initial.id)!.runs.at(-1)!
    await registry.writeReport(initial.id, { run: run.n, nonce: run.nonce, chain: [], joinedAt: Date.now(), done: { at: Date.now(), summary: 'done', changed: [] } })
    t.exits[0](0)
    await vi.waitFor(() => expect(workerByTag(t.dir, 'narrow')).toMatchObject({ status: 'done', exitCode: 0 }))
    expect(await t.tools.call('room_send', { type: 'note', to: 'narrow', text: 'again' })).toContain('resumed narrow')
    expect(t.specs[1].env.ROOM_SHARE).toBe('intent')
  })

  it('keeps a previous run stop fact from dismissing the resumed run', async () => {
    const t = setup()
    await t.seed('stopped', { status: 'dismissed', stopReason: 'lead-session-ended' })
    const registry = await registryForDir(t.dir)
    const id = workerByTag(t.dir, 'stopped')!.id
    expect(registry.read(id)?.stop).toMatchObject({ reason: 'lead-session-ended', run: 1 })
    expect(await t.tools.call('room_send', { type: 'note', to: 'stopped', text: 'again' })).toContain('resumed stopped')
    expect(registry.read(id)?.runs.at(-1)?.n).toBe(2)
    expect(registry.status(id)?.status).toBe('running')
  })

  it('refuses resume at capacity', async () => {
    const t = setup(1)
    await t.seed('busy', { status: 'running' })
    await t.seed('waiting')
    const reply = await t.tools.call('room_send', { type: 'note', to: 'waiting', text: 'again' })
    expect(reply).toContain('worker capacity reached')
    expect(t.specs).toHaveLength(0)
  })

  it('counts an unresolved worker against both spawn and resume capacity', async () => {
    const t = setup(1, undefined, pid => pid === 7001 ? {} : undefined)
    await t.seed('occupied', { status: 'running', pid: 7001, processStartTime: 'fixed-start' })
    await t.seed('waiting')
    expect(await t.tools.call('room_spawn', { tag: 'new', task: 'test', host: 'claude' })).toContain('worker capacity reached')
    expect(await t.tools.call('room_send', { type: 'note', to: 'waiting', text: 'again' })).toContain('worker capacity reached')
    expect(t.specs).toHaveLength(0)
  })

  it('starts exactly one of two concurrent resumes with one free slot', async () => {
    const t = setup(1)
    await t.seed('first')
    await t.seed('second')
    const replies = await Promise.all(['first', 'second'].map(to => t.tools.call('room_send', { type: 'note', to, text: 'again' })))
    expect(replies.filter(reply => reply.includes('resumed '))).toHaveLength(1)
    expect(replies.filter(reply => reply.includes('worker capacity reached'))).toHaveLength(1)
    expect(t.specs).toHaveLength(1)
  })

  it('counts an in-flight spawn against resume capacity', async () => {
    let entered!: () => void, release!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const prepared = new Promise<void>(resolve => { release = resolve })
    const t = setup(1, async (repo, tag) => {
      entered()
      await prepared
      const workerDir = join(repo, '.room', 'workers', tag)
      mkdirSync(workerDir, { recursive: true })
      return { dir: workerDir, branch: `room/${tag}`, created: true }
    })
    await t.seed('waiting')
    const spawn = t.tools.call('room_spawn', { tag: 'starting', task: 'test', host: 'claude' })
    await preparing
    expect(await t.tools.call('room_send', { type: 'note', to: 'waiting', text: 'again' })).toContain('worker capacity reached')
    expect(t.specs).toHaveLength(0)
    release()
    expect(await spawn).toContain('spawned starting')
    expect(t.specs).toHaveLength(1)
  })

  it('releases the launch slot when a resume spawner fails', async () => {
    const t = setup()
    await t.seed('retry')
    const rooms = new Rooms({ primary: () => t.session, setPrimary: () => {}, attach: () => ({ stop() {} }) })
    const w = workerByTag(t.dir, 'retry')!
    expect(await rooms.resumeWorker(t.session, w, 'again', () => { throw new Error('unavailable') }, undefined, 1)).toContain('could not resume retry')
    const second = await rooms.resumeWorker(t.session, w, 'again', () => ({ pid: 9001, started: Promise.resolve(), onExit: () => {}, kill: () => true }), undefined, 1)
    expect(second).toContain('resumed retry')
  })

  it('records a resumed process exit through the shared exit callback', async () => {
    const t = setup()
    await t.seed('crash')
    expect(await t.tools.call('room_send', { type: 'note', to: 'crash', text: 'again' })).toContain('resumed crash')
    t.exits[0](-1)
    await vi.waitFor(() => expect(workerByTag(t.dir, 'crash')).toMatchObject({ status: 'failed', exitCode: -1 }))
    await vi.waitFor(() => expect(t.room.messages().some(m => m.type === 'note' && m.text.includes('worker crash failed: exit -1'))).toBe(true))
  })

  it('refuses a vanished worktree before posting a message or starting a host', async () => {
    const t = setup()
    await t.seed('vanished')
    rmSync(workerByTag(t.dir, 'vanished')!.dir, { recursive: true, force: true })
    const before = t.room.messages().length
    expect(await t.tools.call('room_send', { type: 'note', to: 'vanished', text: 'again' })).toMatch(/error: cannot resume vanished: its worktree no longer exists$/)
    expect(t.specs).toHaveLength(0)
    expect(t.room.messages()).toHaveLength(before)
  })

  it('does not post a message when resume cannot reserve a launch slot', async () => {
    const t = setup(1)
    await t.seed('busy', { status: 'running' })
    await t.seed('waiting')
    const before = t.room.messages().length
    expect(await t.tools.call('room_send', { type: 'note', to: 'waiting', text: 'again' })).toMatch(/error: worker capacity reached[^\n]*$/)
    expect(t.room.messages()).toHaveLength(before)
  })

  it('does not launch or post when cancelled before spawn', async () => {
    const t = setup()
    await t.seed('before-spawn')
    const before = t.room.messages().length
    const controller = new AbortController()
    controller.abort()
    expect(await t.tools.call('room_send', { type: 'note', to: 'before-spawn', text: 'not delivered' }, controller.signal)).toBe('error: tool call cancelled')
    expect(t.specs).toHaveLength(0)
    expect(t.room.messages()).toHaveLength(before)
  })

})
