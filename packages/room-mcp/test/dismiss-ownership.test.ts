import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc, type Worker } from '@room/shared'
import type { Session } from '../src/session.js'
import type { HandlerState } from '../src/tools/context.js'
import { createWorkerRuntime } from '../src/tools/workers.js'
import { syncDocumentWorkers } from './registry-fixture.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

/** No release notices to send here. */
const ignore = () => {}

const terminate = vi.hoisted(() => vi.fn<(_dir: string) => Promise<string[]>>())
vi.mock('../src/worker-process.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/worker-process.js')>(),
  terminateWorktreeProcesses: terminate,
}))

const roots: string[] = []
afterEach(() => { terminate.mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(ownedWorktree: boolean | 'noncanonical' | 'nested') {
  const leadDir = mkdtempSync(join(tmpdir(), 'room-dismiss-'))
  roots.push(leadDir)
  const git = (...args: string[]) => execFileSync('git', ['-C', leadDir, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.test')
  git('config', 'user.name', 'Test')
  writeFileSync(join(leadDir, 'base.txt'), 'base')
  git('add', 'base.txt')
  git('commit', '-qm', 'base')
  const parentDir = join(leadDir, '.room', 'workers', 'parent')
  if (ownedWorktree === 'nested') git('worktree', 'add', '-qb', 'room/parent', parentDir)
  const dir = ownedWorktree === 'nested' ? join(parentDir, '.room', 'workers', 'test') : ownedWorktree === true ? join(leadDir, '.room', 'workers', 'test') : ownedWorktree === 'noncanonical' ? join(leadDir, 'existing-checkout') : leadDir
  if (ownedWorktree === 'nested') execFileSync('git', ['-C', parentDir, 'worktree', 'add', '-qb', 'room/test', dir], { stdio: 'pipe' })
  else if (ownedWorktree) git('worktree', 'add', '-qb', 'room/test', dir)
  const room = new RoomDoc()
  if (ownedWorktree === 'nested') room.workers.set('parent', { id: 'parent-id', tag: 'parent', name: 'lead+parent', lead: 'lead', host: 'codex', task: 'parent', dir: parentDir, branch: 'room/parent', pid: -1, startedAt: Date.now(), status: 'done' } as Worker)
  const w = { id: 'worker-id', tag: 'test', name: 'lead+test', lead: ownedWorktree === 'nested' ? 'lead+parent' : 'lead', host: 'codex', task: 'test', dir, branch: 'room/test', pid: 987654, startedAt: Date.now(), status: 'running' } as Worker
  room.workers.set(w.tag, w)
  const s = { ...hubSeam(room), policyStore: testPolicyStore(), dir: leadDir, roomName: 'local/test/main', room, me: { name: 'lead', kind: 'agent' } } as Session
  const kill = vi.fn(() => true)
  const state = { ctx: {}, rooms: { handle: () => ({ kill }), hasHandle: () => true, all: () => [s] }, now: Date.now, log: vi.fn() } as unknown as HandlerState
  state.dismissWorker = createWorkerRuntime(state).dismissWorker
  return { state, s, w, kill, room, dir, parentDir }
}

async function dismiss(t: ReturnType<typeof fixture>): Promise<string> {
  await syncDocumentWorkers(t.s)
  return t.state.dismissWorker(t.s, t.room.workers.get('test')!, 'stop')
}

describe('dismissWorker ownership', () => {
  it('does not enumerate or signal an unrelated process in the lead checkout, but kills its worker handle', async () => {
    const t = fixture(false)
    const unrelatedSignal = vi.fn()
    terminate.mockImplementation(async dir => { if (dir === t.dir) unrelatedSignal(12345, 'SIGTERM'); return ['editor (pid 12345)'] })
    const reply = await dismiss(t)
    expect(terminate).not.toHaveBeenCalled()
    expect(unrelatedSignal).not.toHaveBeenCalled()
    expect(t.kill).not.toHaveBeenCalled()
    expect(reply).toContain('no local worker capability')
    t.room.doc.destroy()
  })

  it('does not enumerate a supplied worktree outside Room’s canonical worker path', async () => {
    const t = fixture('noncanonical')
    const unrelatedSignal = vi.fn()
    terminate.mockImplementation(async () => { unrelatedSignal(12345, 'SIGTERM'); return ['editor (pid 12345)'] })
    const reply = await dismiss(t)
    expect(terminate).not.toHaveBeenCalled()
    expect(unrelatedSignal).not.toHaveBeenCalled()
    expect(t.kill).not.toHaveBeenCalled()
    expect(reply).toContain('no local worker capability')
    t.room.doc.destroy()
  })

  it('does not enumerate a worker record attributed to another lead', async () => {
    const t = fixture(true)
    t.w.lead = 'other-lead'
    terminate.mockResolvedValue(['editor (pid 12345)'])
    const reply = await dismiss(t)
    expect(terminate).not.toHaveBeenCalled()
    expect(t.kill).not.toHaveBeenCalled()
    expect(reply).toContain('no local worker capability')
    t.room.doc.destroy()
  })

  it('enumerates a grand-worker only through its verified parent worktree', async () => {
    const t = fixture('nested')
    t.s.dir = t.parentDir; t.s.me.name = 'lead+parent'
    terminate.mockResolvedValue([])
    await dismiss(t)
    expect(terminate).toHaveBeenCalledWith(t.dir, expect.objectContaining({ protectedPids: [t.w.pid] }))
    expect(t.kill).toHaveBeenCalledOnce()
    t.room.doc.destroy()
  })

  it('does not enumerate a grand-worker when its recorded parent fails ownership checks', async () => {
    const t = fixture('nested')
    t.room.workers.set('parent', { ...t.room.workers.get('parent')!, dir: t.s.dir })
    terminate.mockResolvedValue([])
    await dismiss(t)
    expect(terminate).not.toHaveBeenCalled()
    expect(t.kill).not.toHaveBeenCalled()
    t.room.doc.destroy()
  })

  it('verifies an archived parent worktree before enumerating its grand-worker', async () => {
    const t = fixture('nested')
    t.s.dir = t.parentDir; t.s.me.name = 'lead+parent'
    const parent = t.room.workers.get('parent')!
    t.room.retireParticipant(parent.name, { name: parent.name, tag: parent.tag, lead: parent.lead, host: parent.host, task: parent.task, summary: 'done', files: [], fileCount: 0, startedAt: parent.startedAt, finishedAt: parent.startedAt + 1, retiredAt: parent.startedAt + 2, outcome: 'dismissed' }, ignore)
    terminate.mockResolvedValue([])
    await dismiss(t)
    expect(terminate).toHaveBeenCalledWith(t.dir, expect.objectContaining({ protectedPids: [t.w.pid] }))
    expect(t.kill).toHaveBeenCalledOnce()
    t.room.doc.destroy()
  })

  it('reports cwd enumeration failure and still kills an owned worker handle', async () => {
    const t = fixture(true)
    terminate.mockRejectedValue(new Error('lsof timed out'))
    const reply = await dismiss(t)
    expect(terminate).toHaveBeenCalledWith(t.dir, expect.objectContaining({ protectedPids: [t.w.pid] }))
    expect(t.kill).toHaveBeenCalledOnce()
    expect(reply).toContain('lsof timed out')
    t.room.doc.destroy()
  })
})
