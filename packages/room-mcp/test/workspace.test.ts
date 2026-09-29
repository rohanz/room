import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AutoJoin } from '../src/auto-join.js'
import { deriveRoomName } from '../src/session.js'
import type { Session } from '../src/session.js'
import { codexWorkspace, createWorkspaceBinding, deferForSharedCodex, fallbackWorkspace } from '../src/workspace.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function repo(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `room-workspace-${name}-`))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Room Test', '-c', 'user.email=room@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'])
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/example/${name}.git`])
  return dir
}
const call = (dir?: string) => dir ? { _meta: { 'x-codex-turn-metadata': { workspaces: { [dir]: { has_changes: false } } } } } : {}

it('defers for a shared or unknown Codex parent, but not Claude, workers or ordinary Codex', () => {
  const codex = { ROOM_HOST: 'codex', PWD: '/wrong/repo' }
  expect(deferForSharedCodex(codex, () => 'codex app-server --listen unix:// --managed-daemon', 'darwin')).toBe(true)
  expect(deferForSharedCodex(codex, () => { throw new Error('ps failed') }, 'darwin')).toBe(true)
  expect(deferForSharedCodex(codex, () => 'codex', 'win32')).toBe(true)
  expect(deferForSharedCodex(codex, () => 'codex exec', 'darwin')).toBe(false)
  expect(deferForSharedCodex({ ...codex, ROOM_DIR: '/worker' }, () => 'codex app-server', 'darwin')).toBe(false)
  expect(deferForSharedCodex({ ROOM_HOST: 'claude' }, () => 'codex app-server', 'darwin')).toBe(false)
})

it('selects one real worktree, deduplicating aliases and nested paths', () => {
  const target = repo('target')
  const nested = path.join(target, 'nested')
  fs.mkdirSync(nested)
  const alias = path.join(os.tmpdir(), `room-workspace-alias-${process.pid}-${Date.now()}`)
  fs.symlinkSync(target, alias)
  dirs.push(alias)
  const realTarget = fs.realpathSync(target)
  const rootOf = (dir: string) => dir === realTarget || dir === fs.realpathSync(nested) ? realTarget : undefined
  expect(codexWorkspace(call(target), rootOf)).toBe(realTarget)
  expect(codexWorkspace({ _meta: { 'x-codex-turn-metadata': { workspaces: { [alias]: {}, [nested]: {} } } } }, rootOf)).toBe(realTarget)
  expect(codexWorkspace(call())).toBeUndefined()
})

it('refuses multiple distinct valid worktrees', () => {
  const first = repo('first')
  const second = repo('second')
  const params = { _meta: { 'x-codex-turn-metadata': { workspaces: { [first]: {}, [second]: {} } } } }
  expect(codexWorkspace(params, dir => dir)).toBeUndefined()
})

it('preserves the directory fallback order when Codex sends no metadata', () => {
  expect(fallbackWorkspace({ ROOM_DIR: '/worker', PWD: '/pwd', INIT_CWD: '/init' }, '/process')).toBe('/worker')
  expect(fallbackWorkspace({ PWD: '/pwd', INIT_CWD: '/init' }, '/process')).toBe('/pwd')
  expect(fallbackWorkspace({ INIT_CWD: '/init' }, '/process')).toBe('/init')
  expect(fallbackWorkspace({}, '/process')).toBe('/process')
})

it('starts no join under shared hosting and first binds and joins the metadata repository, ignoring PWD', async () => {
  const wrong = repo('wrong')
  const target = repo('target')
  const joins: string[] = []
  const binding = createWorkspaceBinding({
    deferred: deferForSharedCodex({ ROOM_HOST: 'codex', PWD: wrong }, () => 'codex app-server --managed-daemon', 'darwin'),
    fallbackDir: () => wrong, logFallback: () => { throw new Error('unexpected fallback') },
    initialize: async dir => {
      const auto = new AutoJoin({ local: false, log: () => {}, report: () => {}, joined: () => joins.length > 0,
        attempt: async () => { const roomName = (await deriveRoomName(dir)).roomName; if (!roomName) throw new Error('no room'); return { roomName } as Session },
        adopt: async session => { joins.push(session.roomName) }, discard: async () => {},
      })
      void auto.ensure()
      return { dir, auto }
    },
  })
  await binding.start()
  expect(joins).toEqual([])
  expect(binding.current()).toBeUndefined()
  const { runtime } = await binding.forCall(call(target))
  if (!runtime) throw new Error('expected runtime')
  await runtime.auto.settle()
  expect(runtime.dir).toBe(fs.realpathSync(target))
  expect(joins).toEqual(['github.com/example/target'])
})

it('keeps startup binding for non-shared Codex, Claude and workers with ROOM_DIR', async () => {
  for (const host of ['codex', 'claude', 'worker']) {
    const dir = repo(host)
    const joins: string[] = []
    const binding = createWorkspaceBinding({
      deferred: deferForSharedCodex({ ROOM_HOST: host === 'worker' ? 'codex' : host, ...(host === 'worker' ? { ROOM_DIR: dir } : {}) }, () => host === 'worker' ? 'codex app-server' : 'codex exec', 'darwin'),
      fallbackDir: () => dir, logFallback: () => {},
      initialize: async target => { joins.push(target); return target },
    })
    if (host === 'worker') await binding.forCall(call(dir)) // a call can beat non-deferred startup
    await binding.start()
    await binding.start()
    expect(joins).toEqual([dir])
    expect((await binding.forCall(call(dir))).runtime).toBe(dir)
  }
})

it('rejects a mismatched call that beats non-deferred startup', async () => {
  const first = repo('fallback')
  const second = repo('caller')
  let calls = 0
  const binding = createWorkspaceBinding({ deferred: false, fallbackDir: () => first,
    logFallback: () => {}, initialize: async dir => ({ dir, call: () => { calls++; return dir } }) })
  const result = await binding.run(call(second), runtime => Promise.resolve(runtime.call()))
  expect(result.error).toBe(`This Codex session's workspace is ${fs.realpathSync(second)}, but Room is attached to ${first}; restart the session to switch.`)
  expect(calls).toBe(0)
  expect((await binding.forCall(call(first))).runtime?.dir).toBe(first)
})

it('uses fallback without metadata for a non-deferred host', async () => {
  const fallback = repo('fallback')
  const other = repo('other')
  const logs: string[] = []
  const binding = createWorkspaceBinding({ deferred: false, fallbackDir: () => fallback,
    logFallback: () => logs.push('fallback'), initialize: async dir => dir })
  expect((await binding.forCall({ _meta: { 'x-codex-turn-metadata': { workspaces: { [fallback]: {}, [other]: {} } } } })).runtime).toBe(fallback)
  expect(logs).toEqual(['fallback'])
  expect((await binding.forCall(call())).runtime).toBe(fallback)
})

it('refuses missing or ambiguous metadata in a deferred session, then accepts a valid call', async () => {
  const first = repo('first')
  const second = repo('second')
  const started: string[] = []
  const binding = createWorkspaceBinding({ deferred: true, fallbackDir: () => second,
    logFallback: () => { throw new Error('unsafe fallback') }, initialize: async dir => { started.push(dir); return dir } })
  const missing = await binding.forCall(call())
  expect(missing.error).toBe('Room could not tell which folder this Codex session is in (no workspace in the call). Update Codex, or start it with ROOM_DIR=<repo>.')
  expect(binding.current()).toBeUndefined()
  const ambiguous = await binding.forCall({ _meta: { 'x-codex-turn-metadata': { workspaces: { [first]: {}, [second]: {} } } } })
  expect(ambiguous.error).toBe(missing.error)
  expect(binding.current()).toBeUndefined()
  expect((await binding.forCall(call(first))).runtime).toBe(fs.realpathSync(first))
  expect((await binding.forCall(call())).error).toBe(missing.error)
  expect(started).toEqual([fs.realpathSync(first)])
})

it('rejects a mismatched call without invoking the runtime', async () => {
  const first = repo('first')
  const second = repo('second')
  let calls = 0
  const binding = createWorkspaceBinding({ deferred: true, fallbackDir: () => second,
    logFallback: () => {}, initialize: async () => ({ call: async () => { calls++; return 'posted' } }) })
  expect((await binding.run(call(first), runtime => runtime.call())).value).toBe('posted')
  const result = await binding.run(call(second), runtime => runtime.call())
  expect(result.error).toBe(`This Codex session's workspace is ${fs.realpathSync(second)}, but Room is attached to ${fs.realpathSync(first)}; restart the session to switch.`)
  expect(calls).toBe(1)
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it('shares one initialization across concurrent first calls', async () => {
  const dir = repo('shared')
  const ready = gate()
  let starts = 0
  const binding = createWorkspaceBinding({ deferred: true, fallbackDir: () => dir,
    logFallback: () => {}, initialize: async () => { starts++; await ready.promise; return 'ready' } })
  const a = binding.forCall(call(dir))
  const b = binding.forCall(call(dir))
  await Promise.resolve()
  expect(starts).toBe(1)
  ready.resolve()
  expect((await a).runtime).toBe('ready')
  expect((await b).runtime).toBe('ready')
})

it('retries after a rejected initialization and logs once per attempt', async () => {
  const dir = repo('retry')
  const failed = gate()
  const errors: unknown[] = []
  let starts = 0
  const binding = createWorkspaceBinding({ deferred: true, fallbackDir: () => dir, matches: async () => true,
    logFallback: () => {}, logFailure: error => errors.push(error),
    initialize: async () => { if (++starts === 1) { await failed.promise; throw new Error('failed') } return 'ready' } })
  const first = binding.forCall(call(dir))
  const concurrent = binding.forCall(call(dir))
  await new Promise<void>(resolve => setImmediate(resolve))
  failed.resolve()
  expect((await first).error).toContain('failed')
  expect((await concurrent).error).toContain('failed')
  expect(errors).toHaveLength(1)
  expect((await binding.forCall(call(dir))).runtime).toBe('ready')
  expect(starts).toBe(2)
})

it('does not dispatch into a replacement attempt after validation awaited the failed one', async () => {
  const first = repo('failed')
  const second = repo('replacement')
  const started = gate(), failed = gate(), comparing = gate(), releaseComparison = gate()
  let firstComparisons = 0
  const binding = createWorkspaceBinding({ deferred: true, fallbackDir: () => first, logFallback: () => {},
    matches: async (workspace, bound) => {
      if (workspace === fs.realpathSync(first) && bound === fs.realpathSync(first) && ++firstComparisons === 2) {
        comparing.resolve()
        await releaseComparison.promise
      }
      return workspace === bound
    },
    initialize: async dir => {
      if (dir === fs.realpathSync(first)) { started.resolve(); await failed.promise; throw new Error('failed') }
      return dir
    },
  })
  const firstCall = binding.forCall(call(first))
  await started.promise
  const validating = binding.forCall(call(first))
  await comparing.promise
  failed.resolve()
  expect((await firstCall).error).toContain('failed')
  expect((await binding.forCall(call(second))).runtime).toBe(fs.realpathSync(second))
  releaseComparison.resolve()
  expect((await validating).error).toContain(`Room is attached to ${fs.realpathSync(second)}`)
})

it('closes during initialization without joining or dispatching afterwards', async () => {
  const dir = repo('closing')
  const ready = gate()
  let joins = 0
  let calls = 0
  let shutdowns = 0
  const binding = createWorkspaceBinding({ deferred: true, fallbackDir: () => dir, logFallback: () => {},
    initialize: async (_dir, signal) => { await ready.promise; if (!signal.aborted) joins++; return { call: async () => { calls++ }, shutdown: async () => { shutdowns++ } } } })
  const request = binding.run(call(dir), runtime => runtime.call())
  await Promise.resolve()
  const stopping = binding.close()
  ready.resolve()
  await (await stopping)?.shutdown()
  expect((await request).error).toContain('shutting down')
  expect((await binding.run(call(dir), runtime => runtime.call())).error).toContain('shutting down')
  expect([joins, calls, shutdowns]).toEqual([0, 0, 1])
})

it('a call from the worktree root matches a session bound in its subfolder', async () => {
  const root = repo('sub')
  const sub = path.join(root, 'pkg')
  fs.mkdirSync(sub)
  const binding = createWorkspaceBinding({ deferred: false, fallbackDir: () => sub, initialize: async dir => dir, logFallback: () => {} })
  await binding.start()
  const result = await binding.forCall({ _meta: { 'x-codex-turn-metadata': { workspaces: { [root]: {} } } } })
  expect(result.error).toBeUndefined()
  expect(result.runtime).toBe(sub)
})

it('distinguishes sibling worktrees and a nested repository using real Git roots', async () => {
  const root = repo('root')
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'room-workspace-sibling-'))
  fs.rmSync(sibling, { recursive: true })
  dirs.push(sibling)
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'sibling', sibling])
  const nested = path.join(root, 'nested')
  fs.mkdirSync(nested)
  execFileSync('git', ['init', '-q', nested])
  expect(codexWorkspace(call(sibling))).toBe(fs.realpathSync(sibling))
  expect(codexWorkspace(call(nested))).toBe(fs.realpathSync(nested))
  const binding = createWorkspaceBinding({ deferred: false, fallbackDir: () => root, logFallback: () => {}, initialize: async dir => dir })
  await binding.start()
  expect((await binding.forCall(call(sibling))).error).toContain(`Room is attached to ${root}`)
  expect((await binding.forCall(call(nested))).error).toContain(`Room is attached to ${root}`)
  expect((await binding.forCall(call(root))).runtime).toBe(root)
})

it('an initialization that fails while the first call is validating returns an error once and retries on the next call', async () => {
  const workspace = repo('fail')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const initialize = vi.fn(async () => { throw new Error('bad config') })
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  try {
    const binding = createWorkspaceBinding({ deferred: true, fallbackDir: () => '/unused', initialize, logFallback: () => {},
      matches: async () => { await gate; return true } })
    const first = binding.forCall(call(workspace))
    await new Promise(resolve => setTimeout(resolve, 0))
    release()
    expect(await first).toEqual({ error: expect.stringContaining('bad config') })
    expect(initialize).toHaveBeenCalledOnce()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(unhandled).not.toHaveBeenCalled()
    expect(await binding.forCall(call(workspace))).toEqual({ error: expect.stringContaining('bad config') })
    expect(initialize).toHaveBeenCalledTimes(2)
  } finally { process.off('unhandledRejection', unhandled) }
})
