/**
 * Review harness based on unsynced-explicit-dir-repro.test.ts.
 * Live 0.17.54 incident: an MCP started above the clone, joined with dir=, and never
 * returned after compaction. Run the actual index.ts initialization/auto-join/logging
 * wiring, replacing only the stdio/socket/process-lifetime boundaries. The provider's
 * 4409 is the same boundary exercised by relay/test/daemon-compaction.test.ts; no
 * listener is needed here.
 */
import { EventEmitter } from 'node:events'
import { mcpEntrypoint } from './fixtures/entrypoint.js'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { docGeneration, generationGate, RoomDoc, STALE_REPLICA_REASON, type NoteMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { presentPeer } from './fixtures/visible.js'
import { loadMemory, RoomMemory } from '../../relay/src/memory.js'
import type { AutoJoin } from '../src/auto-join.js'
import type { JoinOptions, Session } from '../src/session.js'
import type { ToolCtx, Tools } from '../src/tools.js'
import { memorySession } from './fixtures/session.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { finishWorker, registerWorkers, workerByTag } from './registry-fixture.js'
import { RoomdError } from '@room/roomd'
import { serializedStore, type IncarnationStore } from '@room/hub-core'

type Runtime = { call(req: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<string>; shutdown(): Promise<void> }
const capture = vi.hoisted(() => ({
  initialize: undefined as undefined | ((dir: string, signal: AbortSignal) => Promise<Runtime>),
  autoJoin: undefined as AutoJoin | undefined,
  ctx: undefined as ToolCtx | undefined,
  tools: undefined as Tools | undefined,
  joins: [] as JoinOptions[], sessions: [] as Session[],
  restartedSnapshot: undefined as Uint8Array | undefined,
  binding: undefined as import('../src/binding.js').SessionBinding | undefined,
  offline: false,
  failDir: undefined as string | undefined,
  store: undefined as IncarnationStore | undefined,
  wakeTexts: [] as string[],
  wakeGate: undefined as undefined | (() => Promise<void>),
}))

vi.mock('../src/mcp-server.js', () => ({ RoomMcpServer: class { setRequestHandler() {} async connect() {} } }))
vi.mock('../src/transport.js', () => ({ FlushedStdioTransport: class {} }))
vi.mock('../src/workspace.js', async original => ({
  ...await original<typeof import('../src/workspace.js')>(),
  createWorkspaceBinding: (options: { initialize: typeof capture.initialize }) => {
    capture.initialize = options.initialize
    // Let each case initialize the real runtime in its own startup directory.
    return { start: async () => {}, close: async () => {} }
  },
}))
vi.mock('../src/arbitration.js', () => ({ startArbitration: async () => ({ close: async () => {} }) }))
vi.mock('../src/hosts/wake.js', async original => {
  const actual = await original<typeof import('../src/hosts/wake.js')>()
  return { ...actual, createWakeSender: (options: Parameters<typeof actual.createWakeSender>[0]) =>
    actual.createWakeSender({ ...options, post: async (_socket, _token, text) => { capture.wakeTexts.push(text); await capture.wakeGate?.() } }) }
})
vi.mock('../src/presence-end.js', async original => ({
  ...await original<typeof import('../src/presence-end.js')>(),
  PresenceEnd: class { activity() { return 0 } idleMs() { return 0 } stop() {} },
}))
vi.mock('../src/timing.js', async original => ({
  ...await original<typeof import('../src/timing.js')>(), startEventLoopWatchdog: () => ({ stop() {} }),
}))
vi.mock('../src/binding.js', async original => {
  const actual = await original<typeof import('../src/binding.js')>()
  return { ...actual, createSessionBinding: (...args: Parameters<typeof actual.createSessionBinding>) =>
    (capture.binding = actual.createSessionBinding(...args)) }
})
vi.mock('../src/auto-join.js', async original => {
  const actual = await original<typeof import('../src/auto-join.js')>()
  return { ...actual, createSessionAutoJoin: (...args: Parameters<typeof actual.createSessionAutoJoin>) =>
    (capture.autoJoin = actual.createSessionAutoJoin({ ...args[0], delaysMs: [10, 20], deadlineMs: 500 }, args[1], args[2])) }
})
vi.mock('../src/tools.js', async original => {
  const actual = await original<typeof import('../src/tools.js')>()
  return { ...actual, createTools: (ctx: ToolCtx) => {
    capture.ctx = ctx
    return capture.tools = actual.createTools(ctx)
  } }
})
vi.mock('../src/session.js', async original => {
  const actual = await original<typeof import('../src/session.js')>()
  return { ...actual, joinSession: async (opts: JoinOptions) => {
    capture.joins.push(opts)
    if (capture.offline) throw new RoomdError('fixture daemon temporarily unreachable', 1)
    if (opts.dir === capture.failDir) throw new RoomdError('fixture rejected destination', 2)
    const replica = opts.localReplica ?? actual.createLocalReplica()
    if (capture.restartedSnapshot) Y.applyUpdate(replica.doc, capture.restartedSnapshot)
    const s = memorySession({ name: opts.name ?? 'Ada', kind: 'agent' }, opts.dir, new RoomDoc(replica.doc), opts.room ?? 'local/clone', capture.store)
    const provider = Object.assign(new EventEmitter(), {
      awareness: s.awareness, synced: true, wsconnected: true,
      disconnect() { this.synced = false; this.wsconnected = false },
    })
    Object.assign(s, { provider, localReplica: replica, roomUrl: `${opts.server === actual.LOCAL ? 'ws://127.0.0.1:9' : opts.server}/${encodeURIComponent(s.roomName)}`,
      ...(opts.server === actual.LOCAL ? { local: { url: 'ws://127.0.0.1:9', stop: async () => {} } } : {}),
      // A live, uncontested name and synthetic host id: recovery must not require
      // a host inbox binding, nor wait until this lease expires.
      lease: { sessionId: opts.sessionId ?? actual.boundSession({ cwd: opts.dir })?.id ?? 'mcp:synthetic', state: 'held', fence: () => 1, paused: () => undefined, check() {}, end: async () => {} },
    })
    actual.watchClosed(s, opts.log)
    capture.sessions.push(s)
    return s
  } }
})

let root: string, clone: string, runtime: Runtime | undefined
let generation = 0, busy = false
const originalArgv = process.argv[1]
const watched: readonly (readonly [EventEmitter, string])[] = [[process, 'SIGINT'], [process, 'SIGTERM'], [process, 'uncaughtException'],
  [process, 'unhandledRejection'], [process.stdin, 'end']]
const oldListeners = watched.map(([target, event]) => new Set(target.listeners(event)))

beforeAll(async () => {
  let max: number | undefined
  capture.store = serializedStore({ read: async () => max, write: async value => { max = value } })
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-explicit-dir-repro-')))
  clone = path.join(root, 'clone'); fs.mkdirSync(clone)
  execFileSync('git', ['init', '-q', '-b', 'main', clone])
  execFileSync('git', ['-C', clone, '-c', 'user.name=Ada', '-c', 'user.email=a@a', 'commit', '-qm', 'init', '--allow-empty'])
  vi.stubEnv('ROOM_HOST', 'claude')
  vi.stubEnv('ROOM_NAME', 'Ada')
  vi.stubEnv('ROOM_SERVER', 'local')
  // Execute main(), with its actual closures; suppress only its transport/listener boundary.
  process.argv[1] = mcpEntrypoint
  await import('../src/index.js')
  await vi.waitFor(() => expect(capture.initialize).toBeTypeOf('function'))
  process.argv[1] = originalArgv
  // Keep failures owned by Vitest, rather than the executable's fatal exit path.
  for (const i of [2, 3]) {
    const [target, event] = watched[i]
    for (const listener of target.listeners(event)) if (!oldListeners[i].has(listener)) target.removeListener(event, listener as never)
  }
})
afterEach(async () => {
  if (busy) { await finishWorker(capture.ctx!.getSession() ?? capture.sessions.at(-1)!, 'busy', { status: 'done' }); busy = false }
  await runtime?.shutdown(); runtime = undefined
  for (const s of capture.sessions.splice(0)) {
    s.awareness.destroy(); s.hub.close(); s.room.doc.destroy()
  }
  capture.joins.length = 0
  capture.restartedSnapshot = undefined
  capture.offline = false
  capture.failDir = undefined
  capture.wakeTexts.length = 0
  capture.wakeGate = undefined
  await closeRegistryForDir(clone)
  fs.rmSync(path.join(clone, '.git', 'room'), { recursive: true, force: true })
})
afterAll(() => {
  process.argv[1] = originalArgv
  for (const [i, [target, event]] of watched.entries()) for (const listener of target.listeners(event)) {
    if (!oldListeners[i].has(listener)) target.removeListener(event, listener as never)
  }
  fs.rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function start(startupDir: string) {
  runtime = await capture.initialize!(startupDir, new AbortController().signal)
  await capture.autoJoin!.settle()
  const call = (name: string, args: Record<string, unknown> = {}) => runtime!.call({ params: { name, arguments: args } })
  if (!capture.ctx!.getSession()) expect(await call('room_join', { dir: clone, where: 'local' })).toContain('joined local/')
  return call
}
async function refuseReplica() {
  const old = capture.ctx!.getSession()!
  expect(old.provider.synced).toBe(true)
  // Same save/reload boundary as relay/test/daemon-compaction.test.ts, without
  // a socket. The client keeps its old doc while the daemon changes generation.
  const common = fs.mkdtempSync(path.join(root, 'daemon-'))
  const memory = new RoomMemory(common, old.roomName)
  Y.applyUpdate(memory.doc, Y.encodeStateAsUpdate(old.room.doc))
  const previous = docGeneration(old.room.doc) ?? '0'
  expect(memory.save((++generation).toString(16).padStart(32, '0'))).toBeUndefined()
  memory.detach(); memory.doc.destroy()
  const restarted = loadMemory(common, old.roomName)
  try {
    expect(docGeneration(restarted)).not.toBe(previous)
    expect(generationGate(previous, docGeneration(restarted))).toBe('stale')
    capture.restartedSnapshot = Y.encodeStateAsUpdate(restarted)
  } finally { restarted.destroy() }
  // Deliver the generation gate's refusal to the actual watchClosed callback.
  ;(old.provider as unknown as EventEmitter).emit('connection-close', { code: 4409, reason: STALE_REPLICA_REASON })
  await vi.waitFor(() => expect(old.stale).toBeDefined())
  // rejoinWhenStale schedules ensure after settle, as in production.
  await new Promise<void>(resolve => setImmediate(resolve))
  await capture.autoJoin!.settle()
  return old
}


async function registerBusy(s: Session) {
  await registerWorkers(s, [{ tag: 'busy', name: `${s.me.name}+busy`, lead: s.me.name, host: 'claude', task: 'still working',
    dir: s.dir, branch: 'main', pid: 987654321, startedAt: Date.now(), status: 'running' }])
  busy = true
}

it.each(['room_leave', 'room_close'])('a refused %s during failed replacement must retain recovery and the worker move guard', async command => {
  const call = await start(root)
  const old = capture.ctx!.getSession()!
  await registerBusy(old)
  capture.offline = true
  await refuseReplica()
  expect(capture.ctx!.getSession()).toBeNull()
  expect(capture.autoJoin!.recoveryTarget).toBe(old)
  const failure = capture.autoJoin!.failure
  const leaveReply = await call(command, { confirm: true })
  expect(leaveReply).toContain(command === 'room_leave' ? 'error: 1 worker(s) still running' : 'dismiss running workers')
  expect(capture.autoJoin!.failure).toBe(failure)
  expect(capture.autoJoin!.recoveryTarget).toBe(old)
  capture.offline = false
  const moveReply = await call('room_join', { dir: clone, where: 'local', room: 'elsewhere' })
  expect.soft(moveReply).toContain('error: room not synced yet, retry')
  expect(capture.autoJoin!.recoveryTarget).toBe(old)
  expect(await call('room_join', { room: old.roomName })).not.toMatch(/^error:/)
  expect(await call('room_join', { room: 'elsewhere' })).toContain('Collect or discard them first')
  expect.soft(capture.ctx!.getSession()?.roomName).not.toBe('local/elsewhere')
  expect((await workerByTag(clone, 'busy'))?.status).toBe('running')
})

// Known pre-existing clone-move defect, reproduced on 9c4f8ac1: the process's
// first-repository notice receipt can suppress the same disclosure in clone B.
it.fails('clone move must show sharing disclosure before marking the second clone disclosed', async () => {
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'host-notices')
  const other = path.join(root, 'notice-other')
  execFileSync('git', ['clone', '-q', clone, other])
  try {
    const call = await start(clone)
    Object.assign(capture.ctx!, { admit: async () => {} })
    const destination = { where: 'ws://team.example', room: 'example/repo' }
    const first = await call('room_join', { dir: clone, ...destination })
    expect(first).toContain('this clone now shares')
    const moved = await call('room_join', { dir: other, ...destination })
    expect(moved).toContain('moved from')
    expect(capture.ctx!.cwd).toBe(clone)
    expect(capture.binding!.commonDir()).toBe(path.join(clone, '.git'))
    expect(moved).toContain('this clone now shares')
  } finally { vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined); await closeRegistryForDir(other) }
})

it.each(['inside', 'outside'])('a pending wake across a real clone move keeps its receipt and log in A (started %s A)', async location => {
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'host-wake-move')
  vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/fixture/claude-inbox.sock')
  const other = path.join(root, `wake-other-${location}`)
  execFileSync('git', ['clone', '-q', clone, other])
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  capture.wakeGate = () => pending
  try {
    const call = await start(location === 'inside' ? clone : root), first = capture.ctx!.getSession()!
    const endPeer = presentPeer(first.room, first.awareness, 'Bea')
    try {
      const message = hubAppend<NoteMsg>(first.room, { name: 'Bea', kind: 'agent' }, { type: 'note', to: first.me.name, text: 'pending before move', priority: 'notify' })
      await vi.waitFor(() => expect(capture.wakeTexts).toHaveLength(1), { timeout: 8000 })
      expect(await call('room_join', { dir: other, where: 'local' })).toContain('moved from')
      expect(capture.ctx!.cwd).toBe(clone)
      expect(capture.binding!.commonDir()).toBe(path.join(clone, '.git'))
      finish()
      const file = path.join(capture.binding!.dir()!, 'wakes.json')
      await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(file, 'utf8'))[first.roomName]?.[message.id]?.via).toBe('socket'))
      expect(fs.existsSync(path.join(other, '.git', 'room', 'sessions'))).toBe(false)
      expect(fs.readFileSync(path.join(clone, '.git', 'room-mcp.log'), 'utf8')).toContain(message.id)
      expect(fs.existsSync(path.join(other, '.git', 'room-mcp.log'))).toBe(false)
    } finally { finish(); endPeer() }
  } finally {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined); vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', undefined)
    await closeRegistryForDir(other)
  }
})

it('a failed first join leaves the repository unset and no room notice or wake work in flight', async () => {
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'host-first-join')
  vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/fixture/claude-inbox.sock')
  try {
    runtime = await capture.initialize!(root, new AbortController().signal)
    await capture.autoJoin!.settle()
    const call = (dir: string) => runtime!.call({ params: { name: 'room_join', arguments: { dir, where: 'local' } } })
    expect(capture.ctx!.cwd).toBeUndefined()
    expect(capture.binding!.commonDir()).toBeUndefined()
    capture.failDir = clone
    expect(await call(clone)).toContain('fixture rejected destination')
    expect(capture.ctx!.cwd).toBeUndefined()
    // A fallback folder gaining Git is not a successful primary-session join.
    // It must not publish a binding/capability before the real repository is filled.
    execFileSync('git', ['init', '-q', root])
    expect(capture.binding!.commonDir()).toBeUndefined()
    expect(capture.binding!.bound()).toBeUndefined()
    expect(fs.existsSync(path.join(root, '.git', 'room', 'sessions'))).toBe(false)
    expect(capture.ctx!.getSession()).toBeNull()
    expect(capture.tools!.joinedSessions()).toEqual([])
    expect(capture.tools!.ledger.noticeCount()).toBe(0)
    expect(capture.wakeTexts).toEqual([])
    // Notice preparation requires an adopted Session, and wakes require its attachment.
    // Both primary adoption paths fill the repository before starting either service.
    capture.failDir = undefined
    expect(await call(clone)).toContain('joined local/')
    expect(capture.ctx!.cwd).toBe(clone)
    expect(capture.binding!.commonDir()).toBe(path.join(clone, '.git'))
  } finally {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined); vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', undefined)
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true })
  }
})

it.each([{ share: 'intent' }, { name: 'Other' }, { takeover: true }, { room: 'other/repo' },
  { where: 'local' }, { server: 'ws://other.example' }, { dir: '/different' }, { create: true }])('room_join %j must not bypass the sync gate during an ordinary team disconnect', async args => {
  const call = await start(clone)
  Object.assign(capture.ctx!, { admit: async () => {} })
  expect(await call('room_join', { where: 'ws://team.example', room: 'example/repo' })).toContain('joined')
  const s = capture.ctx!.getSession()!
  const joinsBefore = capture.joins.length
  Object.assign(s.provider, { synced: false, wsconnected: false })
  const requested = vi.spyOn(s.policyStore, 'setRequested')
  expect(await call('room_share', { level: 'intent' })).toBe('error: room not synced yet, retry')
  expect(requested).not.toHaveBeenCalled()
  const reply = await call('room_join', args)
  expect.soft(requested).not.toHaveBeenCalled()
  expect.soft(reply).toContain('error: room not synced yet, retry')
  expect(capture.joins).toHaveLength(joinsBefore)
  expect(capture.ctx!.getSession()).toBe(s)
})

it('an already autojoined unbound Claude session receives the missing-identity warning on room_join', async () => {
  const call = await start(clone)
  expect(capture.binding!.bound()).toBeUndefined()
  const reply = await call('room_join')
  expect(reply).toContain('This session cannot be woken because Claude has not supplied its session identity in this repository')
})
it('an unbound Claude worker is not told to restart Claude inside its repository', async () => {
  vi.stubEnv('ROOM_WORKER_ID', 'review-worker')
  vi.stubEnv('ROOM_WORKER_HOST', 'claude')
  try {
    runtime = await capture.initialize!(root, new AbortController().signal)
    await capture.autoJoin!.settle()
    const reply = await runtime.call({ params: { name: 'room_join', arguments: { dir: clone, where: 'local' } } })
    expect(reply).toContain('joined')
    expect(reply).not.toContain('This session cannot be woken')
  } finally { vi.stubEnv('ROOM_WORKER_ID', undefined); vi.stubEnv('ROOM_WORKER_HOST', undefined) }
})

it.each(['bound Claude', 'Codex'])('the missing-identity warning is absent for %s', async kind => {
  if (kind === 'bound Claude') vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'known-host')
  else vi.stubEnv('ROOM_HOST', 'codex')
  try {
    const call = await start(clone)
    expect(await call('room_join')).not.toContain('This session cannot be woken')
  } finally { vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined); vi.stubEnv('ROOM_HOST', 'claude') }
})
