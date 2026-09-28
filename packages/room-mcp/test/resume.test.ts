import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type Worker } from '@room/shared'
import { createTools } from '../src/tools.js'
import { Rooms } from '../src/registry.js'
import { decideResume, type WorkerRealState } from '../src/worker-state.js'
import { prepareWorktree } from '../src/worker-git.js'
import { HooksBridge } from '../src/hooks-bridge.js'
import { markHistorySeenOnJoin } from '../src/tools/join.js'
import type { Session } from '../src/session.js'
import type { PreparedWorktree } from '../src/worker-git.js'
import type { SpawnSpec } from '../src/worker-process.js'
import { syncDocumentWorkers } from './registry-fixture.js'

const scratch: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }) })

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
    provider: { synced: true, awareness },
    daemon: { touch() {}, async stop() {}, share: 'full', dir, name: me.name, roomDoc: room, branch: 'main' },
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
  const rawTools = createTools({
    getSession: () => current, setSession: s => { current = s }, cwd: dir, maxWorkers, log: line => logs.push(line), probe, listCwdProcesses: () => [],
    spawner: spec => { if (failStart) throw new Error('host unavailable'); specs.push(spec); notifySpawn(); return { pid: 6000 + specs.length, started, onExit: cb => { if (failWatch) throw new Error('could not watch exit'); exits.push(cb) }, onError: cb => { errors.push(cb) }, kill: () => { kills.push(1); if (stop.exitOnTerm) queueMicrotask(() => exits.at(-1)?.(0)); return stop.term ?? true }, killForce: () => { kills.push(9); if (stop.exitOnForce) queueMicrotask(() => exits.at(-1)?.(null)); return true } } },
    worktree: worktree ?? ((repo, tag) => prepareWorktree(repo, tag, 'rohanz')),
  })
  const tools = { ...rawTools, call: async (...args: Parameters<typeof rawTools.call>) => {
    if (current?.room.workers.size && args[0] !== 'room_spawn') await syncDocumentWorkers(current)
    return rawTools.call(...args)
  } }
  const seed = (tag: string, patch: Partial<Worker> = {}) => {
    const workerDir = join(dir, '.room', 'workers', tag)
    mkdirSync(join(dir, '.room', 'workers'), { recursive: true })
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', `room/${tag}`, workerDir, 'HEAD'])
    room.setWorker({
      id: `rohanz/${tag}#1`, tag, name: `rohanz+${tag}`, lead: 'rohanz', host: 'claude',
      hostSessionId: '550e8400-e29b-41d4-a716-446655440000',
      budget: { threads: 1, memGb: 1, nice: 0 }, task: 'test', dir: workerDir,
      branch: `room/${tag}`, pid: -1, startedAt: 1, status: 'done', exitCode: 0, gen: 1, ...patch,
    })
  }
  return { dir, room, session, tools, specs, spawned, exits, errors, kills, logs, seed, portFile: (port: number) => join(dir, 'room', 'ports', String(port)) }
}

describe('resumed worker boundaries', () => {
  it('still fails a fresh worker that exits zero without room_done', async () => {
    const t = setup()
    expect(await t.tools.call('room_spawn', { tag: 'fresh', task: 'test', host: 'codex' })).toContain('spawned fresh')
    expect(t.room.workers.get('fresh')?.resumeLogStart).toBeUndefined()
    t.exits[0](0)
    await vi.waitFor(() => expect(t.room.workers.get('fresh')?.status).toBe('failed'))
    await vi.waitFor(() => expect(t.room.messages().filter(m => m.priority === 'interrupt')).toHaveLength(1))
  })

  it('fails a resumed nonzero exit with the death note', async () => {
    const t = setup()
    t.seed('broken', { host: 'codex', summary: 'initial work done' })
    expect(await t.tools.call('room_send', { type: 'note', to: 'broken', text: 'check cleanup' })).toContain('resumed broken')
    t.exits[0](1)
    await vi.waitFor(() => expect(t.room.workers.get('broken')).toMatchObject({ status: 'failed', exitCode: 1 }))
    await vi.waitFor(() => expect(t.room.messages().filter(m => m.priority === 'interrupt')).toMatchObject([{ to: 'rohanz', text: expect.stringContaining('worker broken failed: exit 1') }]))
    expect(t.room.messages().filter(m => m.type === 'done')).toEqual([])
  })

  it('records the newest bus message as the worker spawn marker', async () => {
    const t = setup()
    const before = t.room.post(t.session.me, { type: 'note', text: 'earlier work', priority: 'fyi' })
    expect(await t.tools.call('room_spawn', { tag: 'briefed', task: 'review', host: 'claude' })).toContain('spawned briefed')
    expect(t.room.workers.get('briefed')?.spawnedAfter).toBe(before.id)
  })

  it('advances the briefing boundary when a finished worker resumes', async () => {
    const t = setup()
    t.seed('briefed')
    const between = t.room.post(t.session.me, { type: 'note', text: 'before resume', priority: 'notify' })
    expect(await t.tools.call('room_send', { type: 'note', to: 'briefed', text: 'continue' })).toContain('resumed briefed')
    const worker = t.room.workers.get('briefed')!
    expect(worker.spawnedAfter).toBe(between.id)
    const after = t.room.post(t.session.me, { type: 'note', text: 'after resume', priority: 'notify' })
    const joined = { ...t.session, me: { name: worker.name, kind: 'agent' as const } } as Session
    const seen = new Set<string>()
    markHistorySeenOnJoin(joined, seen)
    expect(seen.has(between.id)).toBe(true)
    expect(seen.has(after.id)).toBe(false)
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
    const initial = t.room.workers.get('narrow')!
    expect(initial.share).toBe('intent')
    t.room.updateWorker('narrow', { status: 'done', summary: 'done' }, initial.id)
    t.exits[0](0)
    await vi.waitFor(() => expect(t.room.workers.get('narrow')?.exitCode).toBe(0))
    expect(await t.tools.call('room_send', { type: 'note', to: 'narrow', text: 'again' })).toContain('resumed narrow')
    expect(t.specs[1].env.ROOM_SHARE).toBe('intent')
  })

  it('keeps a previous run stop fact from dismissing the resumed run', async () => {
    const t = setup()
    t.seed('stopped', { status: 'dismissed', stopReason: 'lead-session-ended' })
    const registry = await syncDocumentWorkers(t.session)
    const id = t.room.workers.get('stopped')!.id!
    expect(registry.read(id)?.stop).toMatchObject({ reason: 'lead-session-ended', run: 1 })
    expect(await t.tools.call('room_send', { type: 'note', to: 'stopped', text: 'again' })).toContain('resumed stopped')
    expect(registry.read(id)?.runs.at(-1)?.n).toBe(2)
    expect(registry.status(id)?.status).toBe('running')
  })

  it('refuses resume at capacity', async () => {
    const t = setup(1)
    t.seed('busy', { status: 'running' })
    t.seed('waiting')
    const reply = await t.tools.call('room_send', { type: 'note', to: 'waiting', text: 'again' })
    expect(reply).toContain('worker capacity reached')
    expect(t.specs).toHaveLength(0)
  })

  it('counts an unresolved worker against both spawn and resume capacity', async () => {
    const t = setup(1, undefined, pid => pid === 7001 ? {} : undefined)
    t.seed('occupied', { status: 'running', pid: 7001, processStartTime: 'fixed-start' })
    t.seed('waiting')
    await syncDocumentWorkers(t.session)
    expect(await t.tools.call('room_spawn', { tag: 'new', task: 'test', host: 'claude' })).toContain('worker capacity reached')
    expect(await t.tools.call('room_send', { type: 'note', to: 'waiting', text: 'again' })).toContain('worker capacity reached')
    expect(t.specs).toHaveLength(0)
  })

  it('starts exactly one of two concurrent resumes with one free slot', async () => {
    const t = setup(1)
    t.seed('first')
    t.seed('second')
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
    t.seed('waiting')
    await syncDocumentWorkers(t.session)
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
    t.seed('retry')
    await syncDocumentWorkers(t.session)
    const rooms = new Rooms({ primary: () => t.session, setPrimary: () => {}, observeClaims: () => {}, attach: () => ({ stop() {} }) })
    const w = t.room.workers.get('retry')!
    expect(await rooms.resumeWorker(t.session, w, 'again', () => { throw new Error('unavailable') }, undefined, 1)).toContain('could not resume retry')
    const second = await rooms.resumeWorker(t.session, w, 'again', () => ({ pid: 9001, started: Promise.resolve(), onExit: () => {}, kill: () => true }), undefined, 1)
    expect(second).toContain('resumed retry')
  })

  it('records a resumed process exit through the shared exit callback', async () => {
    const t = setup()
    t.seed('crash')
    expect(await t.tools.call('room_send', { type: 'note', to: 'crash', text: 'again' })).toContain('resumed crash')
    t.exits[0](-1)
    await vi.waitFor(() => expect(t.room.workers.get('crash')).toMatchObject({ status: 'failed', exitCode: -1 }))
    await vi.waitFor(() => expect(t.room.messages().some(m => m.type === 'note' && m.text.includes('worker crash failed: exit -1'))).toBe(true))
  })

  it('refuses a vanished worktree before posting a message or starting a host', async () => {
    const t = setup()
    t.seed('vanished')
    rmSync(t.room.workers.get('vanished')!.dir, { recursive: true, force: true })
    const before = t.room.messages().length
    expect(await t.tools.call('room_send', { type: 'note', to: 'vanished', text: 'again' })).toBe('error: cannot resume vanished: its worktree no longer exists')
    expect(t.specs).toHaveLength(0)
    expect(t.room.messages()).toHaveLength(before)
  })

  it('does not post a message when resume cannot reserve a launch slot', async () => {
    const t = setup(1)
    t.seed('busy', { status: 'running' })
    t.seed('waiting')
    const before = t.room.messages().length
    expect(await t.tools.call('room_send', { type: 'note', to: 'waiting', text: 'again' })).toMatch(/^error: worker capacity reached/)
    expect(t.room.messages()).toHaveLength(before)
  })

  it('does not launch or post when cancelled before spawn', async () => {
    const t = setup()
    t.seed('before-spawn')
    const controller = new AbortController()
    controller.abort()
    expect(await t.tools.call('room_send', { type: 'note', to: 'before-spawn', text: 'not delivered' }, controller.signal)).toBe('error: tool call cancelled')
    expect(t.specs).toHaveLength(0)
    expect(t.room.messages()).toHaveLength(0)
  })

})
