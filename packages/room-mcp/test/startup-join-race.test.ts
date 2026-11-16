/* Independent startup regressions. Actual index/tools/AutoJoin wiring; only
 * stdio, arbitration, presence timer and joined session/socket boundaries are replaced.
 * Adapted from repository-boundaries.test.ts. No real server is contacted. */
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import { currentToolSignal } from '../src/registry.js'
import type { AutoJoin } from '../src/auto-join.js'
import type { JoinOptions, Session } from '../src/session.js'
import type { ToolCtx } from '../src/tools.js'
import { memorySession } from './fixtures/session.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { serializedStore, type IncarnationStore } from '@room/hub-core'

type Request = { params: { name: string; arguments?: Record<string, unknown>; _meta?: unknown } }
type Reply = { content: Array<{ text: string }> }
type Run = (params: { _meta?: unknown }, action: (runtime: Runtime) => Promise<string>) => Promise<{ value?: string; error?: string }>
type Runtime = { call(req: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<string>; shutdown(): Promise<void> }
const capture = vi.hoisted(() => ({
  events: [] as string[],
  recordPublication: false,
  connecting: undefined as undefined | (() => Promise<void>),
  handler: undefined as undefined | ((req: Request, extra: { signal: AbortSignal; requestId: string }) => Promise<Reply>),
  run: undefined as Run | undefined,
  initialize: undefined as undefined | ((dir: string, signal: AbortSignal) => Promise<Runtime>),
  autoJoin: undefined as AutoJoin | undefined,
  ctx: undefined as ToolCtx | undefined,
  joins: [] as JoinOptions[], sessions: [] as Session[],
  store: undefined as IncarnationStore | undefined,
  wakeTexts: [] as string[],
}))

vi.mock('../src/mcp-server.js', () => ({ RoomMcpServer: class { setRequestHandler(_schema: unknown, handler: typeof capture.handler) { capture.handler = handler } async connect() {} } }))
vi.mock('../src/transport.js', () => ({ FlushedStdioTransport: class { expect(_id: unknown, settle: { commit(): void }) { settle.commit() } forget() {} } }))
vi.mock('../src/workspace.js', async original => ({
  ...await original<typeof import('../src/workspace.js')>(),
  createWorkspaceBinding: (options: { initialize: typeof capture.initialize }) => {
    capture.initialize = options.initialize
    // Let each case initialize the real runtime in its own startup directory.
    return { start: async () => {}, close: async () => {}, run: async (params: { _meta?: unknown }, action: (runtime: Runtime) => Promise<string>) => {
      if (capture.run) return capture.run(params, action)
      runtime ??= await capture.initialize!(clone, new AbortController().signal)
      // Admission can await Git after initialization; startup must already be cancelled.
      await capture.autoJoin!.settle()
      return { value: await action(runtime) }
    } }
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
vi.mock('../src/auto-join.js', async original => {
  const actual = await original<typeof import('../src/auto-join.js')>()
  return { ...actual, createSessionAutoJoin: (...args: Parameters<typeof actual.createSessionAutoJoin>) =>
    (capture.autoJoin = actual.createSessionAutoJoin({ ...args[0], delaysMs: [10, 20], deadlineMs: 500 }, args[1], args[2])) }
})
vi.mock('../src/tools.js', async original => {
  const actual = await original<typeof import('../src/tools.js')>()
  return { ...actual, createTools: (ctx: ToolCtx) => {
    capture.ctx = ctx
    return actual.createTools(Object.assign(ctx, { admit: async () => {} }))
  } }
})
vi.mock('../src/session.js', async original => {
  const actual = await original<typeof import('../src/session.js')>()
  return { ...actual, joinSession: async (opts: JoinOptions) => {
    currentToolSignal()?.throwIfAborted()
    capture.events.push(`join:${opts.server}:${opts.room ?? ''}`)
    capture.joins.push(opts)
    const connecting = capture.connecting; capture.connecting = undefined
    await connecting?.()
    currentToolSignal()?.throwIfAborted()
    if (capture.recordPublication) capture.events.push(`publish:${opts.server}:${opts.room ?? ''}`)
    const replica = opts.localReplica ?? actual.createLocalReplica()
    const s = memorySession({ name: opts.name ?? 'Ada', kind: 'agent' }, opts.dir, new RoomDoc(replica.doc), opts.room ?? (opts.server === actual.LOCAL ? 'local/clone' : (await actual.deriveRoomName(opts.dir)).roomName!), capture.store)
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
})
let processNumber = 0
beforeEach(async () => {
  // Each case represents a fresh MCP process: destinationChosen is process state.
  capture.initialize = undefined
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
  process.argv[1] = entry
  try {
    await import(`${entry}?startup-race=${++processNumber}`)
    await vi.waitFor(() => expect(capture.initialize).toBeTypeOf('function'))
  } finally {
    process.argv[1] = originalArgv
    // These simulated processes are shut down by the fixture, never by host signals.
    for (const [i, [target, event]] of watched.entries()) for (const listener of target.listeners(event)) {
      if (!oldListeners[i].has(listener)) target.removeListener(event, listener as never)
    }
  }
})
afterEach(async () => {
  await runtime?.shutdown(); runtime = undefined
  for (const s of capture.sessions.splice(0)) {
    s.awareness.destroy(); s.hub.close(); s.room.doc.destroy()
  }
  capture.joins.length = 0
  capture.events.length = 0
  capture.recordPublication = false
  capture.connecting = undefined
  capture.run = undefined
  vi.restoreAllMocks()
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


const commit = (dir: string) => {
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Ada', '-c', 'user.email=a@a', 'commit', '-qm', 'init', '--allow-empty'])
}
const request = async (params: Request['params']) => (await capture.handler!({ params }, { signal: new AbortController().signal, requestId: 'test' })).content[0].text
const call = (name: string, args: Record<string, unknown> = {}) => request({ name, arguments: args })

// An explicit destination must supersede an unfinished automatic startup join.
it.each(['startup', 'shared-app-server'])('%s contacts team only before, never after, the local choice arrives', async mode => {
  const dir = path.join(root, `inflight-${mode}`); fs.mkdirSync(dir); commit(dir)
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.org/team/repo.git'])
  vi.stubEnv('ROOM_SERVER', 'ws://team.example')
  try {
    // Hold the first join probe: eager startup is already running, while a first
    // deferred choosing request must suppress startup and probe only its explicit join.
    let release!: () => void, entered!: () => void
    const atGate = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const repo = await import('../src/repository.js')
    const original = repo.joinableRoot
    const spy = vi.spyOn(repo, 'joinableRoot').mockImplementationOnce(async dir => { entered(); await held; return original(dir) })
    let pending: Promise<string>
    if (mode === 'shared-app-server') {
      vi.stubEnv('ROOM_HOST', 'codex')
      const { createWorkspaceBinding } = await vi.importActual<typeof import('../src/workspace.js')>('../src/workspace.js')
      const workspace = createWorkspaceBinding({ deferred: true, fallbackDir: () => '/unused', logFallback: () => {},
        initialize: async (dir, signal) => (runtime = await capture.initialize!(dir, signal)) })
      capture.events.push('user:local')
      capture.run = (params, action) => workspace.run(params, action)
      pending = request({ name: 'room_join', arguments: { where: 'local' }, _meta: { 'x-codex-turn-metadata': { workspaces: { [dir]: {} } } } })
      await atGate
    } else {
      runtime = await capture.initialize!(dir, new AbortController().signal)
      await atGate
      capture.events.push('user:local')
      pending = call('room_join', { where: 'local' })
    }
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(capture.joins).toEqual([])
    release()
    const reply = await pending
    spy.mockRestore()
    expect(reply).toContain('joined local/')
    expect(capture.events).toEqual(['user:local', expect.stringMatching(/^join:local:/)])
  } finally { vi.stubEnv('ROOM_HOST', 'claude'); vi.stubEnv('ROOM_SERVER', 'local'); await closeRegistryForDir(dir) }
})


const destinations = [
  { label: 'local', tool: 'room_join', args: { where: 'local' }, server: 'local' },
  { label: 'server', tool: 'room_join', args: { server: 'ws://chosen.example' }, server: 'ws://chosen.example' },
  { label: 'room', tool: 'room_join', args: { room: 'chosen-room' }, server: 'ws://team.example' },
  { label: 'create', tool: 'room_create', args: { server: 'ws://chosen.example', confirm: true }, server: 'ws://chosen.example' },
  { label: 'dir', tool: 'room_join', args: {}, server: 'ws://team.example' },
]

it.each(destinations.flatMap(destination => ['before', 'git', 'connecting', 'completed'].map(phase => ({ ...destination, phase }))))(
  '$label chooses its destination during $phase', async ({ label, tool, args, server, phase }) => {
    const dir = path.join(root, `${label}-${phase}`); fs.mkdirSync(dir); commit(dir)
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.org/team/repo.git'])
    vi.stubEnv('ROOM_SERVER', 'ws://team.example')
    capture.recordPublication = true
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const atGate = new Promise<void>(resolve => { entered = resolve })
    try {
      if (phase === 'before') {
        const { AutoJoin } = await import('../src/auto-join.js')
        vi.spyOn(AutoJoin.prototype, 'ensure').mockImplementationOnce(async () => {})
      } else if (phase === 'git') {
        const repo = await import('../src/repository.js'), original = repo.joinableRoot
        vi.spyOn(repo, 'joinableRoot').mockImplementationOnce(async dir => { entered(); await held; return original(dir) })
      } else if (phase === 'connecting') capture.connecting = async () => { entered(); await held }
      runtime = await capture.initialize!(dir, new AbortController().signal)
      if (phase === 'git' || phase === 'connecting') await atGate
      if (phase === 'completed') await capture.autoJoin!.settle()
      capture.events.push('user:choice')
      const selectedDir = path.join(root, `selected-${label}-${phase}`)
      if (label === 'dir') { fs.mkdirSync(selectedDir); commit(selectedDir); execFileSync('git', ['-C', selectedDir, 'remote', 'add', 'origin', 'https://example.org/chosen/repo.git']) }
      const pending = call(tool, label === 'dir' ? { dir: selectedDir } : args)
      // The call cancels synchronously, before the held automatic attempt continues.
      release()
      const reply = await pending
      expect(reply).toContain('joined ')
      await capture.autoJoin!.settle()
      // A cancelled attempt must have finished its cleanup before the explicit join returns.
      await Promise.resolve()
      const joins = capture.events.filter(event => event.startsWith('join:'))
      const publications = capture.events.filter(event => event.startsWith('publish:'))
      const expectedJoins = phase === 'connecting' || phase === 'completed' ? 2 : 1
      expect(joins).toHaveLength(expectedJoins)
      expect(joins.at(-1)).toMatch(new RegExp(`^join:${server}:`))
      if (label === 'room') expect(joins.at(-1)).toBe('join:ws://team.example:chosen-room')
      expect(publications).toHaveLength(phase === 'completed' ? 2 : 1)
      expect(publications.at(-1)).toBe(joins.at(-1)!.replace('join:', 'publish:'))
      const afterChoice = capture.events.slice(capture.events.indexOf('user:choice') + 1)
      expect(afterChoice).toEqual([joins.at(-1), publications.at(-1)])
      expect(capture.ctx!.getSession()).toBe(capture.sessions.at(-1))
    } finally {
      release()
      vi.stubEnv('ROOM_SERVER', 'local')
      await runtime?.shutdown(); runtime = undefined
      await closeRegistryForDir(dir)
    }
  },
)

it.each(['room_state', 'room_join', 'room_send'])('%s without a destination still waits for startup', async tool => {
  const dir = path.join(root, `ordinary-${tool}`); fs.mkdirSync(dir); commit(dir)
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.org/team/repo.git'])
  vi.stubEnv('ROOM_SERVER', 'ws://team.example')
  capture.recordPublication = true
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const atGate = new Promise<void>(resolve => { entered = resolve })
  capture.connecting = async () => { entered(); await held }
  try {
    runtime = await capture.initialize!(dir, new AbortController().signal)
    await atGate
    let finished = false
    const pending = call(tool).then(reply => { finished = true; return reply })
    await Promise.resolve()
    expect(finished).toBe(false)
    release()
    await pending
    expect(capture.events).toEqual(['join:ws://team.example:', 'publish:ws://team.example:'])
  } finally { release(); vi.stubEnv('ROOM_SERVER', 'local'); await runtime?.shutdown(); runtime = undefined; await closeRegistryForDir(dir) }
})

it('leaving after a superseded startup keeps automatic recovery stopped until a new explicit join', async () => {
  const dir = path.join(root, 'leave-rejoin'); fs.mkdirSync(dir); commit(dir)
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.org/team/repo.git'])
  vi.stubEnv('ROOM_SERVER', 'ws://team.example')
  const { AutoJoin } = await import('../src/auto-join.js')
  vi.spyOn(AutoJoin.prototype, 'ensure').mockImplementationOnce(async () => {})
  try {
    runtime = await capture.initialize!(dir, new AbortController().signal)
    expect(await call('room_join', { where: 'local' })).toContain('joined local/')
    expect(await call('room_leave')).toContain('left local/')
    const count = capture.joins.length
    await capture.autoJoin!.ensure()
    expect(capture.ctx!.getSession()).toBeNull()
    expect(capture.joins).toHaveLength(count)
    expect(await call('room_join', { where: 'local' })).toContain('joined local/')
    const accepted = capture.ctx!.getSession()!
    accepted.stale = { reason: 'test compaction' }
    await capture.autoJoin!.ensure()
    expect(capture.joins).toHaveLength(count + 2)
    expect(capture.joins.at(-1)).toMatchObject({ server: 'local', room: accepted.roomName })
  } finally { vi.stubEnv('ROOM_SERVER', 'local'); await runtime?.shutdown(); runtime = undefined; await closeRegistryForDir(dir) }
})

it('a first choosing request suppresses startup before deferred workspace admission finishes', async () => {
  execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', 'https://example.org/team/repo.git'])
  vi.stubEnv('ROOM_SERVER', 'ws://team.example')
  capture.recordPublication = true
  capture.events.push('user:local')
  try {
    await call('room_join', { where: 'local' })
    expect(capture.events).toEqual(['user:local', expect.stringMatching(/^join:local:/), expect.stringMatching(/^publish:local:/)])
  } finally { vi.stubEnv('ROOM_SERVER', 'local') }
})
