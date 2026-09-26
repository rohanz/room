import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type Worker } from '@room/shared'
import { createTools } from '../src/tools.js'
import { Rooms } from '../src/registry.js'
import { decideResume, type WorkerRealState } from '../src/worker-state.js'
import { persistWorkerStopReason } from '../src/workers.js'
import type { Session } from '../src/session.js'
import type { PreparedWorktree, SpawnSpec } from '../src/workers.js'

const scratch: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup(maxWorkers = 2, worktree?: (repo: string, tag: string) => Promise<PreparedWorktree>) {
  const dir = mkdtempSync(join(tmpdir(), 'room-resume-'))
  scratch.push(dir)
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
    daemon: { touch() {}, share: 'full', dir, name: me.name, roomDoc: room, branch: 'main' },
    shareMax: 'full', shareRequested: 'full',
    local: { url: 'ws://127.0.0.1:1', port: 1, owned: true, async stop() {} },
  } as unknown as Session
  let current: Session | null = session
  const specs: SpawnSpec[] = []
  const logs: string[] = []
  const exits: ((code: number | null) => void)[] = []
  const errors: ((error: Error) => void)[] = []
  const tools = createTools({
    getSession: () => current, setSession: s => { current = s }, cwd: dir, maxWorkers, log: line => logs.push(line),
    spawner: spec => { specs.push(spec); return { pid: 6000 + specs.length, onExit: cb => { exits.push(cb) }, onError: cb => { errors.push(cb) }, kill: () => true } },
    worktree: worktree ?? (async (repo, tag) => {
      const workerDir = join(repo, '.room', 'workers', tag)
      mkdirSync(workerDir, { recursive: true })
      return { dir: workerDir, branch: `room/${tag}`, created: true }
    }),
  })
  const seed = (tag: string, patch: Partial<Worker> = {}) => {
    const workerDir = join(dir, '.room', 'workers', tag)
    mkdirSync(workerDir, { recursive: true })
    room.setWorker({
      id: `rohanz/${tag}#1`, tag, name: `rohanz+${tag}`, lead: 'rohanz', host: 'claude',
      hostSessionId: '550e8400-e29b-41d4-a716-446655440000',
      budget: { threads: 1, memGb: 1, nice: 0 }, task: 'test', dir: workerDir,
      branch: `room/${tag}`, pid: -1, startedAt: 1, status: 'done', exitCode: 0, gen: 1, ...patch,
    })
  }
  return { dir, room, session, tools, specs, exits, errors, logs, seed }
}

describe('resumed worker boundaries', () => {
  it.each([
    ['vanished', false, 'gone', 'missing'],
    ['present', false, 'gone', 'no-session'],
    ['present', true, 'ours', 'wait-exit'],
    ['present', true, 'gone', 'ready'],
  ] as const)('resume decision: worktree %s, host session %s, process %s -> %s', (worktree, hostSession, process, expected) => {
    expect(decideResume({ worktree, hostSession, process } as WorkerRealState)).toBe(expected)
  })
  it('characterizes fresh and resumed launch policy, handle lifetime, and replies', async () => {
    vi.stubEnv('ROOM_WORKER_NICE', '0')
    const t = setup(1)
    const spawned = await t.tools.call('room_spawn', { tag: 'policy', task: 'first', host: 'claude', share: 'intent' })
    const first = t.room.workers.get('policy')!
    expect(spawned).toContain('spawned policy:')
    expect(t.specs[0]).toMatchObject({ cwd: first.dir, logFile: join(t.dir, '.room', 'workers', 'policy.log'), env: {
      ROOM_SHARE: 'intent', ROOM_WORKER_ID: first.id, ROOM_TAG: 'policy', ROOM_DIR: first.dir,
      ROOM_LOG_FILE: join(t.dir, '.room', 'workers', 'policy.mcp.log'), PORT: String(first.port),
    } })
    expect(t.specs[0].cmd).toBe('claude')
    expect(first.budget?.nice).toBe(0)
    t.room.updateWorker('policy', { status: 'done', summary: 'done', finishedAt: Date.now() }, first.id)
    t.exits[0](0)
    await vi.waitFor(() => expect(t.room.workers.get('policy')?.exitCode).toBe(0))
    const reply = await t.tools.call('room_send', { type: 'note', to: 'policy', text: 'again' })
    expect(reply).toContain('resumed policy with your message; policy had finished and was restarted')
    expect(t.specs[1]).toMatchObject({ cwd: first.dir, logFile: t.specs[0].logFile, env: t.specs[0].env })
    expect(t.specs[1].cmd).toBe('claude')
    expect(t.specs[1].args).toContain('--resume')
    expect(t.room.workers.get('policy')).toMatchObject({ status: 'running', pid: 6002 })
    t.errors[1](new Error('host failed'))
    await vi.waitFor(() => expect(t.room.workers.get('policy')).toMatchObject({ status: 'failed', exitCode: -1 }))
    await vi.waitFor(() => expect(t.room.messages().some(m => m.type === 'note' && m.text.includes('could not resume policy: host failed'))).toBe(true))
    expect(t.logs).toEqual([])
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

  it('resumes legacy records at intent and says so', async () => {
    const t = setup()
    t.seed('legacy')
    const reply = await t.tools.call('room_send', { type: 'note', to: 'legacy', text: 'again' })
    expect(reply).toMatch(/resumed legacy.*intent/s)
    expect(t.specs[0].env.ROOM_SHARE).toBe('intent')
  })

  it('clears disk stop state after resume so a new registry does not dismiss it', async () => {
    const t = setup()
    t.seed('stopped', { status: 'dismissed', stopReason: 'lead-session-ended' })
    persistWorkerStopReason(t.dir, 'stopped', 'lead-session-ended', t.room.workers.get('stopped')!.id)
    expect(await t.tools.call('room_send', { type: 'note', to: 'stopped', text: 'again' })).toContain('resumed stopped')
    const restarted = new Rooms({ primary: () => t.session, setPrimary: () => {}, observeClaims: () => {}, attach: () => ({ stop() {} }) })
    restarted.track(t.session)
    expect(t.room.workers.get('stopped')).toMatchObject({ status: 'running', stopReason: undefined })
    restarted.remove(t.session)
  })

  it('refuses resume at capacity', async () => {
    const t = setup(1)
    t.seed('busy', { status: 'running' })
    t.seed('waiting')
    const reply = await t.tools.call('room_send', { type: 'note', to: 'waiting', text: 'again' })
    expect(reply).toContain('max 1')
    expect(t.specs).toHaveLength(0)
  })

  it('starts exactly one of two concurrent resumes with one free slot', async () => {
    const t = setup(1)
    t.seed('first')
    t.seed('second')
    const replies = await Promise.all(['first', 'second'].map(to => t.tools.call('room_send', { type: 'note', to, text: 'again' })))
    expect(replies.filter(reply => reply.includes('resumed '))).toHaveLength(1)
    expect(replies.filter(reply => reply.includes('max 1'))).toHaveLength(1)
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
    const spawn = t.tools.call('room_spawn', { tag: 'starting', task: 'test', host: 'claude' })
    await preparing
    expect(await t.tools.call('room_send', { type: 'note', to: 'waiting', text: 'again' })).toContain('max 1')
    expect(t.specs).toHaveLength(0)
    release()
    expect(await spawn).toContain('spawned starting')
    expect(t.specs).toHaveLength(1)
  })

  it('releases the launch slot when a resume spawner fails', async () => {
    const t = setup()
    t.seed('retry')
    const rooms = new Rooms({ primary: () => t.session, setPrimary: () => {}, observeClaims: () => {}, attach: () => ({ stop() {} }) })
    const w = t.room.workers.get('retry')!
    expect(await rooms.resumeWorker(t.session, w, 'again', () => { throw new Error('unavailable') }, undefined, 1)).toContain('could not resume retry')
    const second = await rooms.resumeWorker(t.session, w, 'again', () => ({ pid: 9001, onExit: () => {}, kill: () => true }), undefined, 1)
    expect(second).toContain('resumed retry')
  })

  it('records a resumed process error through the shared exit callback', async () => {
    const t = setup()
    t.seed('crash')
    expect(await t.tools.call('room_send', { type: 'note', to: 'crash', text: 'again' })).toContain('resumed crash')
    t.errors[0](new Error('host unavailable'))
    await vi.waitFor(() => expect(t.room.workers.get('crash')).toMatchObject({ status: 'failed', exitCode: -1 }))
    await vi.waitFor(() => expect(t.room.messages().some(m => m.type === 'note' && m.text.includes('could not resume crash: host unavailable'))).toBe(true))
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

  it('queues one follow-up through a slow previous process exit and does not warn that the restarted worker will not answer', async () => {
    const t = setup()
    expect(await t.tools.call('room_spawn', { tag: 'slow', task: 'first', host: 'claude' })).toContain('spawned slow')
    const w = t.room.workers.get('slow')!
    t.room.updateWorker('slow', { status: 'done', summary: 'done', finishedAt: Date.now() }, w.id)
    const sending = t.tools.call('room_send', { type: 'note', to: 'slow', text: 'one follow-up' })
    setTimeout(() => t.exits[0](0), 5_200)
    const reply = await sending
    expect(reply).toContain('resumed slow with your message; slow had finished and was restarted')
    expect(reply).not.toContain('will not answer')
    expect(t.specs).toHaveLength(2)
    expect(t.room.messages().filter(m => m.type === 'note' && m.to === w.name && m.text === 'one follow-up')).toHaveLength(1)
  }, 8_000)

  it('does not post a message when resume cannot reserve a launch slot', async () => {
    const t = setup(1)
    t.seed('busy', { status: 'running' })
    t.seed('waiting')
    const before = t.room.messages().length
    expect(await t.tools.call('room_send', { type: 'note', to: 'waiting', text: 'again' })).toMatch(/^error: .*max 1/)
    expect(t.room.messages()).toHaveLength(before)
  })

  it('bounds an old process exit wait and says neither delivery nor restart happened', async () => {
    const t = setup()
    t.seed('stuck')
    const rooms = new Rooms({ primary: () => t.session, setPrimary: () => {}, observeClaims: () => {}, attach: () => ({ stop() {} }) })
    const w = t.room.workers.get('stuck')!
    rooms.setHandle(t.session, w.id!, { pid: 9001, onExit: () => {}, kill: () => true })
    const reply = await rooms.resumeWorker(t.session, w, 'again', () => { throw new Error('must not start') }, undefined, undefined, () => {}, Date.now(), 20)
    expect(reply).toBe('error: could not resume stuck: previous process did not exit within 1 second; message was not delivered and worker was not resumed')
    expect(t.specs).toHaveLength(0)
    expect(t.room.workers.get('stuck')?.status).toBe('done')
  })

  it('cancels a queued follow-up without leaving a bus copy', async () => {
    const t = setup()
    await t.tools.call('room_spawn', { tag: 'cancel', task: 'first', host: 'claude' })
    const w = t.room.workers.get('cancel')!
    t.room.updateWorker('cancel', { status: 'done', summary: 'done', finishedAt: Date.now() }, w.id)
    const before = t.room.messages().length
    const controller = new AbortController()
    const sending = t.tools.call('room_send', { type: 'note', to: 'cancel', text: 'never sent' }, controller.signal)
    setTimeout(() => controller.abort(), 20)
    expect(await sending).toBe('error: tool call cancelled')
    expect(t.specs).toHaveLength(1)
    expect(t.room.messages()).toHaveLength(before)
  })
})
