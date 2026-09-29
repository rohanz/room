import { publishFixture } from './fixtures/manifest.js'
import { createHandlerState } from '../src/tools/state.js'
import { finishSignalShutdown } from '../src/index.js'
import { describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allocateWorkerPort, workerEnv, workerProcessEnv, workerPrompt } from '../src/worker-config.js'
import { cleanupWorker } from '../src/worker-git.js'
import { signalWorker, terminateWorktreeProcesses } from '../src/worker-process.js'
import { RoomDoc } from '@room/shared'
import type { Session } from '../src/session.js'
import { handlers as joinHandlers } from '../src/tools/join.js'
import { createWorkerRuntime } from '../src/tools/workers.js'
import { type HandlerState } from '../src/tools/context.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import type { LocalWorker } from '../src/worker-status.js'
import { finishWorker, registerWorkers, workerByTag } from './registry-fixture.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

/** A finished worker as the lifecycle helpers see it. */
const done = (tag: string, dir: string): LocalWorker => ({ id: `w_${tag}`, tag, name: `lead+${tag}`, lead: 'lead', host: 'codex', task: 'task', dir, branch: `room/${tag}`,
  pid: 0, startedAt: 1, status: 'done', exitCode: 0, budget: { threads: 1, memGb: 1, nice: 10 }, share: 'full' })

describe('worker lifecycle cleanup', () => {
  it('signals only processes whose resolved cwd is inside the worktree, then escalates survivors', async () => {
    const signal = vi.fn()
    let afterTerm = false
    const killed = await terminateWorktreeProcesses('/repo/.room/workers/a', {
      list: () => [
        { pid: 101, cwd: '/repo/.room/workers/a', command: 'astro dev' },
        { pid: 102, cwd: '/repo/.room/workers/a/sub', command: 'vite' },
        { pid: 103, cwd: '/repo/.room/workers/ab', command: 'outside' },
        { pid: process.pid, cwd: '/repo/.room/workers/a', command: 'room' },
      ],
      signal,
      probe: pid => !afterTerm || pid === 102 ? {} : undefined,
      sleep: async () => { afterTerm = true },
    })
    expect(killed).toEqual(['astro dev (pid 101)', 'vite (pid 102)'])
    expect(signal.mock.calls).toEqual([[101, 'SIGTERM'], [102, 'SIGTERM'], [102, 'SIGKILL']])
  })

  it('signals the worker pid without signalling its whole process group', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      expect(signalWorker(12345)).toBe(true)
      expect(kill).toHaveBeenCalledWith(12345, 'SIGTERM')
      expect(kill).not.toHaveBeenCalledWith(-12345, 'SIGTERM')
    } finally { kill.mockRestore() }
  })

  it('does not signal a worker host after its cwd moves outside the worktree', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      expect(signalWorker(12345, 'SIGTERM', '/repo/.room/workers/a', () => [{ pid: 12345, cwd: '/repo/other', command: 'codex' }])).toBe(false)
      expect(kill).not.toHaveBeenCalled()
    } finally { kill.mockRestore() }
  })

  it('rechecks cwd before KILL so a moved process is left alone', async () => {
    const signal = vi.fn()
    let calls = 0
    await terminateWorktreeProcesses('/repo/.room/workers/a', {
      list: () => [{ pid: 102, cwd: ++calls <= 2 ? '/repo/.room/workers/a' : '/repo/other', command: 'vite' }],
      signal,
      probe: () => ({}),
      sleep: async () => {},
    })
    expect(signal.mock.calls).toEqual([[102, 'SIGTERM']])
  })

  it('cleanupWorker uses its injected cwd lister before removing the worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'room-cwd-cleanup-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
    try {
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'test@test')
      git('config', 'user.name', 'test')
      writeFileSync(join(root, 'a'), 'base')
      git('add', 'a')
      git('commit', '-qm', 'base')
      const dir = join(root, '.room', 'workers', 'a')
      git('worktree', 'add', '-qb', 'room/a', dir)
      const names: string[] = []
      const signal = vi.fn()
      expect(await cleanupWorker(root, done('a', dir), true, false, names, {
        list: () => [{ pid: 12345, cwd: dir, command: 'astro dev' }], signal, probe: () => ({}), sleep: async () => {},
      })).toBe(true)
      expect(names).toEqual(['astro dev (pid 12345)'])
      expect(signal).toHaveBeenCalledWith(12345, 'SIGTERM')
      const explicit = join(root, 'existing-checkout')
      git('worktree', 'add', '-qb', 'room/explicit', explicit)
      signal.mockClear()
      expect(await cleanupWorker(root, done('explicit', explicit), true, false, [], {
        list: () => [{ pid: 12345, cwd: explicit, command: 'editor' }], signal, sleep: async () => {},
      }, 'lead')).toBe(false)
      expect(signal).not.toHaveBeenCalled()
      expect(existsSync(explicit)).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('dismissWorker names a worktree server before signalling its host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'room-stop-order-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@test')
    git('config', 'user.name', 'test')
    writeFileSync(join(root, 'base'), 'base')
    git('add', 'base')
    git('commit', '-qm', 'base')
    const dir = join(root, '.room', 'workers', 'a')
    git('worktree', 'add', '-qb', 'room/a', dir)
    const ready = join(tmpdir(), `room-stop-ready-${process.pid}-${Date.now()}`)
    const child = spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1000)', ready], { cwd: dir, stdio: 'ignore' })
    try {
      for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(existsSync(ready)).toBe(true)
      const room = new RoomDoc()
      const s = { ...hubSeam(room), policyStore: testPolicyStore(), room, dir: root, roomName: 'local/repo/main', me: { name: 'lead', kind: 'agent' }, daemon: {} } as Session
      await registerWorkers(s, [{ tag: 'a', name: 'lead+a', lead: 'lead', host: 'codex', task: 'task', dir, branch: 'room/a', id: 'id', pid: 999999, startedAt: Date.now(), status: 'running' }])
      const kill = vi.fn(() => { child.kill('SIGTERM'); return true })
      const state = { ctx: { listCwdProcesses: () => [{ pid: child.pid!, cwd: dir, command: 'node' }] }, rooms: { handle: () => ({ kill }), hasHandle: () => true, all: () => [s] }, now: Date.now, log: vi.fn() } as unknown as HandlerState
      const { dismissWorker } = createWorkerRuntime(state)
      const reply = await dismissWorker(s, workerByTag(root, 'a')!, 'stop')
      expect(reply).toMatch(new RegExp(`stopped processes: [^\\n]+ \\(pid ${child.pid}\\)`))
      expect(kill).toHaveBeenCalledOnce()
      room.doc.destroy()
    } finally { child.kill('SIGKILL'); await closeRegistryForDir(root); rmSync(root, { recursive: true, force: true }); rmSync(ready, { force: true }) }
  })

  it('allocates a distinct port from the bounded worker range', () => {
    expect(allocateWorkerPort([4400, 4401])).toBe(4402)
    expect(allocateWorkerPort([4499])).toBe(4400)
    expect(workerEnv({ PORT: '3000' }, { PORT: '4402' }).PORT).toBe('4402')
    expect(workerEnv({ PORT: '3000' }, {}).PORT).toBeUndefined()
    expect(workerProcessEnv({ threads: 1, memGb: 1, host: 'codex', server: 'local', room: 'room', dir: '/tmp/a', tag: 'a', lead: 'lead', owner: 'lead', share: 'intent', gen: 1, id: 'id', logDir: '/tmp', isWorker: false, port: 4402 }).PORT).toBe('4402')
    const prompt = workerPrompt('lead', 'a', 'task', { threads: 1, memGb: 1, nice: 10, port: 4402 })
    expect(prompt).toContain('Your dev-server port is 4402')
    expect(prompt).toContain('Report progress in room_done; send notes only when the lead must know before you finish.')
  })

  it('room_leave waits for cwd cleanup and names stopped processes', async () => {
    const room = new RoomDoc()
    const s = { ...hubSeam(room), policyStore: testPolicyStore(), room, dir: '/repo', roomName: 'local/repo/main' } as Session
    const worker = { tag: 'a', dir: '/repo/.room/workers/a' }
    const dismissWorker = vi.fn(async () => 'pid 123 signalled; stopped processes: node (pid 123)')
    const state = {
      S: () => s, runningWorkers: () => [{ s, w: worker }], dismissWorker,
      closeWorkersRoom: async () => {}, cleanupMine: () => 1,
      rooms: { remove: vi.fn() }, doLeave: async () => {},
    } as unknown as HandlerState
    const result = await joinHandlers(state).room_leave({ force: true })
    expect(dismissWorker).toHaveBeenCalledOnce()
    expect(result).toContain('stopped processes: node (pid 123)')
    room.doc.destroy()
  })

  it('shutdown times out a stalled dismissal without changing the worker record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'room-stalled-'))
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { stdio: 'pipe' })
    const room = new RoomDoc()
    const s = { ...hubSeam(room), policyStore: testPolicyStore(), room, dir: root, me: { name: 'lead', kind: 'agent' }, roomName: 'local/repo/main', daemon: {} } as Session
    await registerWorkers(s, [{ id: 'stalled-id', tag: 'stalled', name: 'lead+stalled', lead: 'lead', host: 'codex',
      task: 'x', dir: join(root, '.room', 'workers', 'stalled'), branch: 'room/stalled', pid: process.pid, processStartTime: 'test:start', startedAt: 1, status: 'running' }])
    const worker = workerByTag(root, 'stalled')!
    const before = { ...worker }
    const log = vi.fn()
    const state = createHandlerState({ getSession: () => s, setSession: () => {}, cwd: root, leave: async () => {},
      probe: () => ({ startTime: 'test:start', executable: 'codex' }), log })
    let release!: () => void
    const stalled = new Promise<void>(resolve => { release = resolve })
    state.runningWorkers = () => [{ s, w: worker }]
    state.dismissWorker = async (_s, w, _why, reason, cancelled) => {
      await stalled
      if (!cancelled?.aborted) await finishWorker(s, w.tag, { status: 'dismissed', stopReason: reason })
      return 'late dismissal'
    }
    state.closeWorkersRoom = async () => {}
    state.cleanupMine = () => 0
    try {
      await state.shutdown()
      release()
      await stalled
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(workerByTag(root, 'stalled')).toEqual(before)
      expect(log).toHaveBeenCalledWith('shutdown dismissal timed out for stalled; worker record kept for restart')
    } finally { release(); room.doc.destroy(); await closeRegistryForDir(root); rmSync(root, { recursive: true, force: true }) }
  })

  it.each(['SIGINT', 'SIGTERM'])('%s shutdown ends lease and presence before dismissing a running worker', async reason => {
    const root = mkdtempSync(join(tmpdir(), 'room-signal-order-'))
    execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { stdio: 'pipe' })
    const room = new RoomDoc()
    const events: string[] = []
    const s = { ...hubSeam(room), policyStore: testPolicyStore(), room, dir: root,
      me: { name: 'lead', kind: 'agent' }, roomName: 'local/repo/main', daemon: {},
      awareness: { setLocalState: (value: unknown) => { if (value === null) events.push('presence ended') } },
      lease: { end: async () => { events.push('lease ended') } },
    } as unknown as Session
    await registerWorkers(s, [{ id: 'running-id', tag: 'running', name: 'lead+running', lead: 'lead', host: 'codex',
      task: 'x', dir: join(root, '.room', 'workers', 'running'), branch: 'room/running', pid: process.pid,
      processStartTime: 'test:start', startedAt: 1, status: 'running' }])
    const worker = workerByTag(root, 'running')!
    const state = createHandlerState({ getSession: () => s, setSession: () => {}, cwd: root,
      leave: async () => { events.push('session left') },
      probe: () => ({ startTime: 'test:start', executable: 'codex' }), log: () => {} })
    const workersRoom = { roomName: 'local/repo/workers',
      awareness: { setLocalState: (value: unknown) => { if (value === null) events.push('workers presence ended') } },
      lease: { end: async () => { events.push('workers lease ended') } },
    } as unknown as Session
    state.rooms.all = () => [s, workersRoom]
    state.runningWorkers = () => [{ s, w: worker }]
    state.dismissWorker = async () => { events.push('worker dismissed'); await finishWorker(s, worker.tag, { status: 'dismissed', stopReason: 'lead-session-ended' }); return 'signalled' }
    state.closeWorkersRoom = async () => { events.push('workers room closed') }
    try {
      await finishSignalShutdown(reason, () => state.shutdown(), line => events.push(line), () => events.push('exit'))
      expect(events).toEqual([`stopping: ${reason}`, 'lease ended', 'presence ended', 'workers lease ended', 'workers presence ended', 'worker dismissed', 'workers room closed', 'session left', `stopped: ${reason}`, 'exit'])
      expect(workerByTag(root, 'running')).toMatchObject({ status: 'dismissed', stopReason: 'lead-session-ended' })
    } finally { room.doc.destroy(); await closeRegistryForDir(root); rmSync(root, { recursive: true, force: true }) }
  })
})
