/** Repository boundaries: actual index wiring with process/socket boundaries replaced.
 * The stopped provider becomes unsynced, matching Roomd.stop -> WebsocketProvider.destroy.
 * Covers repository evidence, intentional session ends and every join reply path. */
import { EventEmitter } from 'node:events'
import { mcpEntrypoint } from './fixtures/entrypoint.js'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import type { AutoJoin } from '../src/auto-join.js'
import type { JoinOptions, Session } from '../src/session.js'
import type { ToolCtx, Tools, Settle } from '../src/tools.js'
import { memorySession } from './fixtures/session.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { RoomdError } from '@room/roomd'
import type { PresenceEndOptions } from '../src/presence-end.js'
import { serializedStore, type IncarnationStore } from '@room/hub-core'

type Runtime = { call(req: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<string>; shutdown(): Promise<void> }
const capture = vi.hoisted(() => ({
  presence: undefined as PresenceEndOptions | undefined,
  initialGitFailure: false,
  sharedPresence: false,
  initialize: undefined as undefined | ((dir: string, signal: AbortSignal) => Promise<Runtime>),
  autoJoin: undefined as AutoJoin | undefined,
  ctx: undefined as ToolCtx | undefined,
  tools: undefined as Tools | undefined,
  joins: [] as JoinOptions[], sessions: [] as Session[],
  binding: undefined as import('../src/binding.js').SessionBinding | undefined,
  failDir: undefined as string | undefined,
  store: undefined as IncarnationStore | undefined,
}))

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFile: (...args: any[]) => {
    if (capture.initialGitFailure && args[0] === 'git' && args[1]?.includes('--is-bare-repository')) {
      capture.initialGitFailure = false
      queueMicrotask(() => args.at(-1)(Object.assign(new Error('fixture transient EAGAIN'), { code: 'EAGAIN' }), '', ''))
      return undefined
    }
    return (actual.execFile as any)(...args)
  } }
})
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
vi.mock('../src/hosts/selection.js', async original => {
  const actual = await original<typeof import('../src/hosts/selection.js')>()
  return { ...actual, presenceKind: (...args: Parameters<typeof actual.presenceKind>) => capture.sharedPresence ? 'shared-app-server' : actual.presenceKind(...args) }
})
vi.mock('../src/presence-end.js', async original => ({
  ...await original<typeof import('../src/presence-end.js')>(),
  PresenceEnd: class { constructor(options: PresenceEndOptions) { capture.presence = options } activity() { return 0 } idleMs() { return 0 } stop() {} },
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
    ctx.close = async () => ['example/repo']
    return capture.tools = actual.createTools(ctx)
  } }
})
vi.mock('../src/session.js', async original => {
  const actual = await original<typeof import('../src/session.js')>()
  return { ...actual, joinSession: async (opts: JoinOptions) => {
    capture.joins.push(opts)
    if (opts.dir === capture.failDir) throw new RoomdError('fixture rejected destination', 2)
    const replica = opts.localReplica ?? actual.createLocalReplica()
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
  await runtime?.shutdown(); runtime = undefined
  for (const s of capture.sessions.splice(0)) {
    s.awareness.destroy(); s.hub.close(); s.room.doc.destroy()
  }
  capture.joins.length = 0
  capture.failDir = undefined
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
it.each(['room_leave', 'room_close'])('a successful %s permits a later explicit join to a different local room', async command => {
  const call = await start(clone)
  const old = capture.ctx!.getSession()!
  old.local!.forget = async () => {}
  old.daemon.stop = async () => { (old.provider as unknown as { disconnect(): void }).disconnect() }
  expect(await call(command, { confirm: true })).toContain(command === 'room_close' ? 'left the room' : 'left local/')
  expect(capture.ctx!.getSession()).toBeNull()
  expect(capture.autoJoin!.recoveryTarget).toBeUndefined()
  expect(await call('room_join', { where: 'local', room: 'next' })).toContain('joined local/next')
})

it.each(['room_leave', 'room_close'])('a successful team %s also permits room_create', async command => {
  const call = await start(clone)
  Object.assign(capture.ctx!, { admit: async () => {} })
  expect(await call('room_join', { where: 'ws://team.example', room: 'example/repo' })).toContain('joined example/repo')
  const old = capture.ctx!.getSession()!
  old.daemon.stop = async () => { (old.provider as unknown as { disconnect(): void }).disconnect() }
  expect(await call(command, { confirm: true })).toContain(command === 'room_close' ? 'closed example/repo' : 'left example/repo')
  expect(capture.autoJoin!.recoveryTarget).toBeUndefined()
  expect(await call('room_create', { where: 'ws://team.example', room: 'example/next', confirm: true })).toContain('joined example/next')
})

it.each(['room_leave', 'room_close'])('a failed %s keeps its recovery target for retry', async command => {
  const call = await start(clone), old = capture.ctx!.getSession()!
  old.local!.forget = async () => {}
  old.daemon.stop = async () => { throw new Error('fixture stop failed') }
  expect(await call(command, { confirm: true })).toContain('fixture stop failed')
  expect(capture.autoJoin!.recoveryTarget).toBe(old)
  old.daemon.stop = async () => { Object.assign(old.provider, { synced: false, wsconnected: false }) }
  expect(await call(command, { confirm: true })).toContain(command === 'room_close' ? 'left the room' : 'left local/')
  expect(capture.autoJoin!.recoveryTarget).toBeUndefined()
})

it('a rolled-back clone move still explains why an unbound Claude cannot be woken', async () => {
  const call = await start(root)
  const other = path.join(root, 'rollback-other')
  execFileSync('git', ['clone', '-q', clone, other])
  try {
    capture.failDir = other
    const reply = await call('room_join', { dir: other, where: 'local' })
    expect(reply).toContain('back in local/clone')
    expect(reply).toContain('This session cannot be woken')
  } finally { await closeRegistryForDir(other) }
})

it('a startup Git execution failure must not fix a nonrepository as the process repository', async () => {
  capture.initialGitFailure = true
  try {
    runtime = await capture.initialize!(root, new AbortController().signal)
    await capture.autoJoin!.settle()
  } finally { capture.initialGitFailure = false }
  expect(capture.ctx!.getSession()).toBeNull()
  expect(capture.joins).toHaveLength(0)
  expect(await runtime!.call({ params: { name: 'room_join', arguments: { dir: clone, where: 'local' } } })).toContain('joined local/')
  expect(capture.ctx!.cwd).toBe(clone)
  expect(capture.binding!.commonDir()).toBe(path.join(clone, '.git'))
})

it('a delayed first idle tick must not allocate and cache an episode in the unset fallback repository', async () => {
  capture.sharedPresence = true
  const actual = await vi.importActual<typeof import('../src/presence-end.js')>('../src/presence-end.js')
  let presence: import('../src/presence-end.js').PresenceEnd | undefined
  try {
    runtime = await capture.initialize!(root, new AbortController().signal)
    await capture.autoJoin!.settle()
    expect(capture.ctx!.getSession()).toBeNull()
    const options = capture.presence!
    expect(options.episodeId).toBeTypeOf('function')
    // The fallback becomes a repository, but no primary join has accepted it.
    execFileSync('git', ['init', '-q', root])
    expect(capture.binding!.commonDir()).toBeUndefined()
    let at = 0
    presence = new actual.PresenceEnd({ ...options, mono: () => at, tickMs: 0, hostAlive: () => true })
    // Process suspension can delay the first scheduled tick past both lease thresholds.
    at = actual.IDLE_CLAIMS_MS
    await presence.tick()
    expect.soft(fs.existsSync(path.join(root, '.git/room/sessions/idle-episode.json'))).toBe(false)
    expect(await runtime.call({ params: { name: 'room_join', arguments: { dir: clone, where: 'local' } } })).toContain('joined local/')
    expect(capture.ctx!.cwd).toBe(clone)
    await (options.episodeId as () => Promise<string>)()
    expect(fs.existsSync(path.join(clone, '.git/room/sessions/idle-episode.json'))).toBe(true)
  } finally {
    presence?.stop(); capture.sharedPresence = false
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true })
  }
})

it('serializes two concurrent first joins and fixes the repository before either attachment', async () => {
  runtime = await capture.initialize!(root, new AbortController().signal)
  await capture.autoJoin!.settle()
  const other = path.join(root, 'concurrent-other')
  execFileSync('git', ['clone', '-q', clone, other])
  try {
    const replies = await Promise.all([clone, other].map(dir => runtime!.call({ params: { name: 'room_join', arguments: { dir, where: 'local' } } })))
    expect(replies[0]).toContain('joined local/clone')
    expect(replies[1]).toContain('moved from')
    expect(capture.ctx!.cwd).toBe(clone)
    expect(capture.binding!.commonDir()).toBe(path.join(clone, '.git'))
    expect(capture.ctx!.getSession()!.dir).toBe(other)
  } finally { await closeRegistryForDir(other) }
})

it.each(['unbound', 'bound', 'codex', 'worker'])('finishes every join reply path with the correct warning for %s', async identity => {
  vi.stubEnv('ROOM_HOST', identity === 'codex' ? 'codex' : 'claude')
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', identity === 'bound' ? 'host-bound' : undefined)
  vi.stubEnv('ROOM_WORKER_ID', identity === 'worker' ? 'reply-worker' : undefined)
  vi.stubEnv('ROOM_WORKER_HOST', identity === 'worker' ? 'claude' : undefined)
  const other = path.join(root, `reply-paths-${identity}`)
  execFileSync('git', ['clone', '-q', clone, other])
  const check = async (args: Record<string, unknown>, expected: string) => {
    let handed: Settle | undefined
    const reply = await capture.tools!.call('room_join', args, undefined, settle => { handed = settle })
    expect(reply).toContain(expected)
    expect(reply.includes('This session cannot be woken')).toBe(identity === 'unbound')
    expect(reply.match(/This session cannot be woken/g)?.length ?? 0).toBe(identity === 'unbound' ? 1 : 0)
    if (handed) { expect(handed.text).toBe(reply); handed.commit() }
    return reply
  }
  try {
    runtime = await capture.initialize!(root, new AbortController().signal)
    await capture.autoJoin!.settle()
    await check({ dir: clone, where: 'local' }, 'joined local/') // new
    await check({}, 'local: nothing leaves') // same-room
    const first = capture.ctx!.getSession()!
    Object.assign(first.provider, { synced: false, wsconnected: false })
    first.recoverLocal = async () => { Object.assign(first.provider, { synced: true, wsconnected: true }) }
    await check({ share: 'intent' }, 'error: room not synced yet') // refusal
    await check({}, 'local: nothing leaves') // recovery
    await check({ dir: '' }, 'error: dir was empty') // validation before handler
    capture.failDir = other
    await check({ dir: other, where: 'local' }, 'back in local/clone') // rollback
    capture.failDir = undefined
    await check({ dir: other, where: 'local' }, 'moved from') // move
  } finally {
    await closeRegistryForDir(other)
    vi.stubEnv('ROOM_HOST', 'claude'); vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined)
    vi.stubEnv('ROOM_WORKER_ID', undefined); vi.stubEnv('ROOM_WORKER_HOST', undefined)
  }
})
