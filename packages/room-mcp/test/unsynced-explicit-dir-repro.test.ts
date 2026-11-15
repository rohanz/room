/**
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
import { loadMemory, RoomMemory } from '../../relay/src/memory.js'
import type { AutoJoin } from '../src/auto-join.js'
import type { JoinOptions, Session } from '../src/session.js'
import type { ToolCtx, Tools } from '../src/tools.js'
import { memorySession } from './fixtures/session.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { finishWorker, registerWorkers, workerByTag } from './registry-fixture.js'
import { RoomdError } from '@room/roomd'
import { serializedStore, type IncarnationStore } from '@room/hub-core'
import { hubAppend } from '@room/shared/testing'
import { presentPeer } from './fixtures/visible.js'

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
    actual.createWakeSender({ ...options, post: async (_socket, _token, text) => { capture.wakeTexts.push(text) } }) }
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
    Object.assign(s, { provider, localReplica: replica,
      local: { url: 'ws://127.0.0.1:9', stop: async () => {} },
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

it('control: a session started inside the clone replaces a 4409 replica while its host inbox is unbound', async () => {
  await start(clone)
  expect(capture.binding!.bound()).toBeUndefined()
  const old = await refuseReplica()
  const fresh = capture.ctx!.getSession()!
  expect(fresh).not.toBe(old)
  expect(fresh.provider.synced).toBe(true)
  expect(capture.joins).toHaveLength(2)
  expect(capture.joins[1]).toMatchObject({ dir: clone, name: old.me.name, room: old.roomName, sessionId: old.lease!.sessionId })
  expect(fresh.room.doc).not.toBe(old.room.doc)
  expect(docGeneration(fresh.room.doc)).toBe(generation.toString(16).padStart(32, '0'))
  const file = path.join(clone, '.git', 'room-mcp.log')
  capture.joins[1].log!('IN-CLONE-LOG-CONTROL')
  expect(fs.readFileSync(file, 'utf8')).toContain('IN-CLONE-LOG-CONTROL')
})

it('a session explicitly joined from a non-repository parent replaces its 4409 replica twice, keeping its name, claims and running worker', async () => {
  const call = await start(root)
  expect(capture.binding!.bound()).toBeUndefined()
  const original = capture.ctx!.getSession()!
  const claim = original.room.addClaim({ path: 'a.py', from: 1, to: 2, by: original.me.name, byKind: 'agent', intent: 'keep' })
  await registerBusy(original)
  for (let i = 0; i < 2; i++) {
    const old = await refuseReplica()
    const fresh = capture.ctx!.getSession()!
    expect(fresh).not.toBe(old)
    expect(fresh.provider.synced).toBe(true)
    expect(fresh.me.name).toBe(original.me.name)
    expect(fresh.lease!.sessionId).toBe(original.lease!.sessionId)
    expect(fresh.room.openClaims()).toContainEqual(claim)
    expect((await workerByTag(clone, 'busy'))?.status).toBe('running')
  }
  expect(capture.autoJoin!.failure).toBeUndefined()
  expect(await call('room_join', { dir: clone, room: original.roomName, where: 'local' })).not.toMatch(/^error/)
})

it('after explicit dir= join, runtime events reach that clone\'s room-mcp.log', async () => {
  const file = path.join(clone, '.git', 'room-mcp.log')
  fs.rmSync(file, { force: true })
  await start(root)
  expect(capture.ctx!.getSession()!.dir).toBe(clone)
  expect(capture.binding!.commonDir()).toBe(path.join(clone, '.git'))
  // This is the logger actually passed to joinSession, not a duplicate of log().
  capture.joins[0].log!('EXPLICIT-DIR-LOG-PROBE')
  expect(fs.existsSync(file), 'runtime logger must follow the accepted clone').toBe(true)
  expect(fs.readFileSync(file, 'utf8')).toContain('EXPLICIT-DIR-LOG-PROBE')
})

async function registerBusy(s: Session) {
  await registerWorkers(s, [{ tag: 'busy', name: `${s.me.name}+busy`, lead: s.me.name, host: 'claude', task: 'still working',
    dir: s.dir, branch: 'main', pid: 987654321, startedAt: Date.now(), status: 'running' }])
  busy = true
}

it('same-room room_join manually triggers the existing stale replacement without dismissing a worker', async () => {
  const call = await start(root)
  const old = capture.ctx!.getSession()!
  await registerBusy(old)
  capture.autoJoin!.cancel({ explicitLeave: false }) // leave the automatic trigger pending
  await refuseReplica()
  expect(capture.ctx!.getSession()).toBe(old)
  const reply = await call('room_join', { room: old.roomName })
  expect(reply).not.toMatch(/^error/)
  expect(capture.ctx!.getSession()).not.toBe(old)
  expect(capture.ctx!.getSession()!.provider.synced).toBe(true)
  expect((await workerByTag(clone, 'busy'))?.status).toBe('running')
})

it('keeps recovery and worker guards through a failed replacement until the daemon returns', async () => {
  const call = await start(root)
  const old = capture.ctx!.getSession()!
  await registerBusy(old)
  capture.offline = true
  await refuseReplica()
  expect(capture.ctx!.getSession()).toBeNull()
  expect(capture.autoJoin!.failure).toContain('Room could not join the local room')
  expect(capture.joins.length).toBeGreaterThan(1)
  expect(await call('room_join', { dir: clone, where: 'local', room: 'different' })).toContain('error: room not synced yet, retry')
  capture.offline = false
  expect(await call('room_join', { room: old.roomName })).not.toMatch(/^error/)
  expect(capture.ctx!.getSession()!.provider.synced).toBe(true)
  expect(capture.ctx!.getSession()!.me.name).toBe(old.me.name)
  expect((await workerByTag(clone, 'busy'))?.status).toBe('running')
})

it.each(['inside', 'outside'])('a process started %s A moves and rejoins B while its repository stays A', async location => {
  const other = path.join(root, `other-${location}`)
  execFileSync('git', ['clone', '-q', clone, other])
  try {
    const call = await start(location === 'inside' ? clone : root)
    expect(await call('room_join', { dir: other, where: 'local' })).toContain('moved from')
    expect(capture.ctx!.cwd).toBe(clone)
    expect(capture.binding!.commonDir()).toBe(path.join(clone, '.git'))
    capture.joins.at(-1)!.log!('MOVED-CLONE-PROBE')
    expect(fs.readFileSync(path.join(clone, '.git', 'room-mcp.log'), 'utf8')).toContain('MOVED-CLONE-PROBE')
    expect(fs.existsSync(path.join(other, '.git', 'room-mcp.log'))).toBe(false)
    const old = await refuseReplica()
    expect(capture.ctx!.getSession()!.dir).toBe(other)
    expect(capture.ctx!.getSession()).not.toBe(old)
    expect(capture.ctx!.getSession()!.me.name).toBe(old.me.name)
    expect(capture.joins.at(-1)!.dir).toBe(other)
    expect(await call('room_join', { dir: root, where: 'local' })).toContain("isn't one")
    expect(capture.ctx!.cwd).toBe(clone)
    capture.failDir = clone
    expect(await call('room_join', { dir: clone, where: 'local' })).toContain(`back in local/other-${location}`)
    expect(capture.ctx!.cwd).toBe(clone)
  } finally { await closeRegistryForDir(other) }
})

it('adoption discovers a Claude session identity supplied by the host without a new wake mechanism', async () => {
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'host-session')
  try {
    await start(root)
    expect(capture.binding!.bound()).toEqual({ id: 'host-session', host: 'claude' })
    expect(capture.binding!.dir()).toContain(path.join(clone, '.git', 'room', 'sessions'))
    const old = await refuseReplica()
    expect(capture.ctx!.getSession()!.lease!.sessionId).toBe(old.lease!.sessionId)
  } finally { vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined) }
})

it.each(['inside', 'outside'])('a bound Claude session started %s the clone wakes before and after a generation change', async location => {
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'wake-host')
  vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/fixture/claude-inbox.sock')
  try {
    await start(location === 'inside' ? clone : root)
    for (let i = 0; i < 2; i++) {
      if (i) await refuseReplica()
      const s = capture.ctx!.getSession()!
      const endPeer = presentPeer(s.room, s.awareness, 'Bea')
      try {
        hubAppend<NoteMsg>(s.room, { name: 'Bea', kind: 'agent' }, { type: 'note', to: s.me.name, text: `WAKE-PROBE-${i}`, priority: 'notify' })
        await vi.waitFor(() => expect(capture.wakeTexts.length).toBeGreaterThan(i), { timeout: 8000 })
        expect(capture.wakeTexts[i]).toContain('Bea')
        expect(capture.binding!.bound()).toEqual({ id: 'wake-host', host: 'claude' })
        expect(fs.existsSync(path.join(capture.binding!.dir()!, 'wakes.json'))).toBe(true)
      } finally { endPeer() }
    }
  } finally {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined)
    vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', undefined)
  }
})

it('joining alone tells an unbound Claude session immediately why it cannot be woken', async () => {
  runtime = await capture.initialize!(root, new AbortController().signal)
  await capture.autoJoin!.settle()
  const reply = await runtime.call({ params: { name: 'room_join', arguments: { dir: clone, where: 'local' } } })
  expect(reply).toContain('This session cannot be woken because Claude has not supplied its session identity in this repository')
})
