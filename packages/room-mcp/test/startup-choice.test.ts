/* Independent startup regressions. Actual index/tools/AutoJoin wiring; only
 * stdio, arbitration, presence timer and joined session/socket boundaries are replaced.
 * Adapted from repository-boundaries.test.ts. No real server is contacted. */
import { EventEmitter } from 'node:events'
import { mcpEntrypoint } from './fixtures/entrypoint.js'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { RoomDoc, type NoteMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { presentPeer } from './fixtures/visible.js'
import type { AutoJoin } from '../src/auto-join.js'
import type { JoinOptions, Session } from '../src/session.js'
import type { ToolCtx } from '../src/tools.js'
import { memorySession } from './fixtures/session.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { serializedStore, type IncarnationStore } from '@room/hub-core'

type Runtime = { call(req: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<string>; shutdown(): Promise<void> }
const capture = vi.hoisted(() => ({
  initialGitFailures: 0,
  initialize: undefined as undefined | ((dir: string, signal: AbortSignal) => Promise<Runtime>),
  autoJoin: undefined as AutoJoin | undefined,
  ctx: undefined as ToolCtx | undefined,
  joins: [] as JoinOptions[], sessions: [] as Session[],
  store: undefined as IncarnationStore | undefined,
  wakeTexts: [] as string[],
}))

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFile: (...args: any[]) => {
    if (capture.initialGitFailures > 0 && args[0] === 'git' && args[1]?.includes('--is-bare-repository')) {
      capture.initialGitFailures--
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
    return actual.createTools(ctx)
  } }
})
vi.mock('../src/session.js', async original => {
  const actual = await original<typeof import('../src/session.js')>()
  return { ...actual, joinSession: async (opts: JoinOptions) => {
    capture.joins.push(opts)
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
  capture.initialGitFailures = 0
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

// One short resource-exhaustion period, covering both startup probes; all later Git calls succeed.
it('automatically retries a transient startup Git failure without requiring a Room tool call', async () => {
  capture.initialGitFailures = 2
  runtime = await capture.initialize!(clone, new AbortController().signal)
  await capture.autoJoin!.settle()
  expect(capture.ctx!.getSession()?.dir).toBe(clone)
  expect(capture.autoJoin!.failure).toBeUndefined()
})

it.each([false, true])('honors explicit local first join after late git init (origin=%s)', async origin => {
  const late = path.join(root, `late-repository-${origin}`)
  fs.mkdirSync(late)
  vi.stubEnv('ROOM_SERVER', 'ws://team.example')
  try {
    runtime = await capture.initialize!(late, new AbortController().signal)
    await capture.autoJoin!.settle()
    expect(capture.joins).toHaveLength(0)
    execFileSync('git', ['init', '-q', '-b', 'main', late])
    execFileSync('git', ['-C', late, '-c', 'user.name=Ada', '-c', 'user.email=a@a', 'commit', '-qm', 'init', '--allow-empty'])
    if (origin) execFileSync('git', ['-C', late, 'remote', 'add', 'origin', 'https://example.org/team/repo.git'])
    fs.writeFileSync(path.join(late, 'private-notes.txt'), 'keep this local\n')
    const reply = await runtime.call({ params: { name: 'room_join', arguments: { where: 'local' } } })
    expect(reply).toContain('joined local/')
    expect(capture.joins.map(join => join.server)).toEqual(['local'])
  } finally {
    vi.stubEnv('ROOM_SERVER', 'local')
    await closeRegistryForDir(late)
  }
})

const choices = [
  { command: 'room_join', args: { where: 'local' }, server: 'local', origin: false },
  { command: 'room_join', args: { where: 'local' }, server: 'local', origin: true },
  { command: 'room_join', args: { server: 'ws://chosen.example', room: 'custom/server' }, server: 'ws://chosen.example' },
  { command: 'room_join', args: { room: 'custom/room' }, server: 'ws://team.example' },
  { command: 'room_create', args: { where: 'ws://created.example', room: 'custom/created', confirm: true }, server: 'ws://created.example' },
]
const commit = (dir: string) => {
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Ada', '-c', 'user.email=a@a', 'commit', '-qm', 'init', '--allow-empty'])
}

it.each(['unset', 'set'])('only the explicit destination joins from a %s process', async state => {
  for (const [i, choice] of choices.entries()) {
    const dir = path.join(root, `choices-${state}-${i}`)
    fs.mkdirSync(dir)
    vi.stubEnv('ROOM_SERVER', 'ws://team.example')
    try {
      if (state === 'set') commit(dir)
      // No origin: a set process is positively identified, but startup joins nowhere.
      runtime = await capture.initialize!(dir, new AbortController().signal)
      await capture.autoJoin!.settle()
      expect(capture.joins).toHaveLength(0)
      if (state === 'unset') commit(dir)
      if (choice.origin !== false) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://example.org/team/repo.git'])
      Object.assign(capture.ctx!, { admit: async () => {} })
      const automatic = vi.spyOn(capture.autoJoin!, 'ensure')
      const reply = await runtime.call({ params: { name: choice.command, arguments: choice.args } })
      expect(reply).toContain('joined')
      expect(automatic).not.toHaveBeenCalled()
      expect(capture.joins.map(join => join.server)).toEqual([choice.server])
      if (choice.args.room) expect(capture.joins[0].room).toBe(choice.args.room)
      expect(capture.ctx!.cwd).toBe(dir)
      automatic.mockRestore()
    } finally {
      await runtime?.shutdown(); runtime = undefined
      capture.joins.length = 0
      await closeRegistryForDir(dir)
      vi.stubEnv('ROOM_SERVER', 'local')
    }
  }
})

it('an inconclusive explicit-choice probe is retryable and never runs the automatic join', async () => {
  const dir = path.join(root, 'choice-probe-failure')
  fs.mkdirSync(dir)
  try {
    runtime = await capture.initialize!(dir, new AbortController().signal)
    await capture.autoJoin!.settle()
    commit(dir)
    capture.initialGitFailures = 1
    const automatic = vi.spyOn(capture.autoJoin!, 'ensure')
    const call = () => runtime!.call({ params: { name: 'room_join', arguments: { where: 'local' } } })
    expect(await call()).toContain('could not verify the repository; retry')
    expect(capture.joins).toEqual([])
    expect(capture.ctx!.cwd).toBeUndefined()
    expect(await call()).toContain('joined local/')
    expect(automatic).not.toHaveBeenCalled()
    automatic.mockRestore()
  } finally { await closeRegistryForDir(dir) }
})

it('automatically joins a late initialized checkout and binds and wakes once it has a commit', async () => {
  const late = path.join(root, 'late-automatic')
  fs.mkdirSync(late)
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'late-host')
  vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/fixture/late-inbox.sock')
  try {
    runtime = await capture.initialize!(late, new AbortController().signal)
    await capture.autoJoin!.settle()
    expect(capture.ctx!.binding!.bound()).toBeUndefined()
    execFileSync('git', ['init', '-q', '-b', 'main', late])
    const state = () => runtime!.call({ params: { name: 'room_state' } })
    expect(await state()).toContain('Room needs a first commit')
    expect(capture.joins).toEqual([])
    expect(capture.ctx!.getSession()).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 1100)) // baseline binding rechecks a Git miss after 1 s
    // UNBORN_STATE: current process repository stays unset until a successful join.
    expect(capture.ctx!.cwd).toBeUndefined()
    expect(capture.ctx!.binding!.bound()).toBeUndefined()
    capture.ctx!.log!('UNBORN-LOG-PROBE')
    expect(fs.existsSync(path.join(late, '.git', 'room-mcp.log'))).toBe(false)
    expect(capture.wakeTexts).toEqual([])
    execFileSync('git', ['-C', late, '-c', 'user.name=Ada', '-c', 'user.email=a@a', 'commit', '-qm', 'first', '--allow-empty'])
    expect(await state()).toContain('room: local/')
    expect(capture.joins.map(join => join.server)).toEqual(['local'])
    expect(capture.ctx!.cwd).toBe(late)
    expect(capture.ctx!.binding!.bound()).toEqual({ id: 'late-host', host: 'claude' })
    const s = capture.ctx!.getSession()!, endPeer = presentPeer(s.room, s.awareness, 'Bea')
    try {
      const message = hubAppend<NoteMsg>(s.room, { name: 'Bea', kind: 'agent' }, { type: 'note', to: s.me.name, text: 'late-init private body', priority: 'notify' })
      await vi.waitFor(() => expect(capture.wakeTexts).toHaveLength(1), { timeout: 8000 })
      expect(capture.wakeTexts[0]).not.toContain(message.text)
      expect(fs.existsSync(path.join(capture.ctx!.binding!.dir()!, 'wakes.json'))).toBe(true)
    } finally { endPeer() }
  } finally {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined); vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', undefined)
    await closeRegistryForDir(late)
  }
})
