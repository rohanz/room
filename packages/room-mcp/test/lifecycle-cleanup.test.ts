import { describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allocateWorkerPort, cleanupWorker, signalWorker, terminateWorktreeProcesses, workerEnv, workerProcessEnv, workerPrompt } from '../src/workers.js'
import { Rooms } from '../src/registry.js'
import { RoomDoc, type RetiredWorker } from '@room/shared'
import type { Session } from '../src/session.js'
import { handlers as joinHandlers } from '../src/tools/join.js'
import { install as installWorkerHandlers } from '../src/tools/workers.js'
import { createHandlerState, type HandlerState } from '../src/tools/context.js'

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
      expect(await cleanupWorker(root, { tag: 'a', name: 'lead+a', lead: 'lead', host: 'codex', task: 'task', dir, branch: 'room/a', pid: -1, startedAt: 1, status: 'done', exitCode: 0 }, true, false, names, {
        list: () => [{ pid: 12345, cwd: dir, command: 'astro dev' }], signal, probe: () => ({}), sleep: async () => {},
      })).toBe(true)
      expect(names).toEqual(['astro dev (pid 12345)'])
      expect(signal).toHaveBeenCalledWith(12345, 'SIGTERM')
      const explicit = join(root, 'existing-checkout')
      git('worktree', 'add', '-qb', 'room/explicit', explicit)
      signal.mockClear()
      expect(await cleanupWorker(root, { tag: 'explicit', name: 'lead+explicit', lead: 'lead', host: 'codex', task: 'task', dir: explicit, branch: 'room/explicit', pid: -1, startedAt: 1, status: 'done', exitCode: 0 }, true, false, [], {
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
      const worker = { tag: 'a', name: 'lead+a', lead: 'lead', host: 'codex', task: 'task', dir, branch: 'room/a', id: 'id', pid: 999999, startedAt: Date.now(), status: 'running' } as const
      room.workers.set('a', worker as never)
      const s = { room, dir: root, me: { name: 'lead', kind: 'agent' } } as Session
      const kill = vi.fn(() => { child.kill('SIGTERM'); return true })
      const state = { ctx: {}, rooms: { handle: () => ({ kill }), hasHandle: () => true, all: () => [s] }, now: Date.now, log: vi.fn() } as unknown as HandlerState
      installWorkerHandlers(state)
      const reply = await state.dismissWorker(s, worker as never, 'stop')
      expect(reply).toMatch(new RegExp(`stopped processes: [^\\n]+ \\(pid ${child.pid}\\)`))
      expect(kill).toHaveBeenCalledOnce()
      room.doc.destroy()
    } finally { child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); rmSync(ready, { force: true }) }
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

  it('sweeps an archived worker record left by an older collection', async () => {
    const room = new RoomDoc()
    const record: RetiredWorker = { name: 'lead+old', tag: 'old', lead: 'lead', host: 'codex', task: 'task', summary: '', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'clean' }
    room.retireParticipant(record.name, record)
    room.workers.set(record.tag, { tag: record.tag, name: record.name, lead: record.lead, host: record.host, task: record.task, dir: '/missing', branch: 'room/old', pid: -1, startedAt: record.startedAt, status: 'done' })
    room.setOverlay(record.name, 'old.ts', 'ghost')
    const s = { room, dir: '/missing', me: { name: 'lead' }, roomName: 'local/repo/main' } as Session
    let current: Session | null = s
    const rooms = new Rooms({ primary: () => current, setPrimary: next => { current = next }, observeClaims() {}, attach: () => ({ stop() {} }) })
    rooms.track(s)
    await rooms.retireWorkers(s)
    expect(room.workers.has(record.tag)).toBe(false)
    expect(room.changedPaths(record.name)).toEqual([])
    rooms.remove(s)
    room.doc.destroy()
  })

  it('room_leave waits for cwd cleanup and names stopped processes', async () => {
    const room = new RoomDoc()
    const s = { room, dir: '/repo', roomName: 'local/repo/main' } as Session
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
    const room = new RoomDoc()
    const worker = { id: 'stalled-id', tag: 'stalled', name: 'lead+stalled', lead: 'lead', host: 'codex' as const,
      task: 'x', dir: '/missing', branch: 'room/stalled', pid: process.pid, processStartTime: 'test:start', startedAt: 1, status: 'running' as const }
    room.setWorker(worker)
    const before = { ...room.workers.get(worker.tag)! }
    const s = { room, dir: '/missing', me: { name: 'lead', kind: 'agent' }, roomName: 'local/repo/main' } as Session
    const log = vi.fn()
    const state = createHandlerState({ getSession: () => s, setSession: () => {}, cwd: '/missing', leave: async () => {},
      probe: () => ({ startTime: 'test:start', executable: 'codex' }), log })
    let release!: () => void
    const stalled = new Promise<void>(resolve => { release = resolve })
    state.runningWorkers = () => [{ s, w: worker }]
    state.dismissWorker = async (_s, w, _why, _reason, cancelled) => {
      await stalled
      if (!cancelled?.aborted) room.updateWorker(w.tag, { status: 'dismissed', stopReason: 'lead-session-ended' }, w.id)
      return 'late dismissal'
    }
    state.closeWorkersRoom = async () => {}
    state.cleanupMine = () => 0
    try {
      await state.shutdown()
      release()
      await stalled
      expect(room.workers.get(worker.tag)).toEqual(before)
      expect(log).toHaveBeenCalledWith('shutdown dismissal timed out for stalled; worker record kept for restart')
    } finally { release(); room.doc.destroy() }
  })
})
