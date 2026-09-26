import { describe, expect, it, vi } from 'vitest'
import type { Worker } from '@room/shared'
import { decideCollect, decideDiscard, decideLeave, decidePreview, decideRetire, decideShutdown, decideStop, processExited, workerRealState, type WorkerRealState } from '../src/worker-state.js'

const worker: Worker = { id: 'lead/w#1', name: 'lead+w', lead: 'lead', tag: 'w', host: 'codex', task: 'task', dir: '/missing/.room/workers/w', branch: 'room/w', pid: 123, startedAt: 1, status: 'done', exitCode: 0, hostSessionId: 'session' }
const base: WorkerRealState = { worktree: 'present', owned: true, branch: 'present', ahead: 0, process: 'not-ours', hostSession: true, finished: true, status: 'done', exitCode: 0, dismissed: false, clean: true, merged: false, uncommitted: 0 }

describe('workerRealState probes', () => {
  it('probes a vanished checkout only through the lead, retaining unmerged commits', async () => {
    const git = vi.fn(async (dir: string, args: string[]) => {
      expect(dir).toBe('/lead')
      if (args[0] === 'for-each-ref') return 'refs/heads/room/w\n'
      if (args[0] === 'rev-list') return `${'a'.repeat(40)}\n${'b'.repeat(40)}\n`
      throw new Error('no carry ref')
    })
    const owned = vi.fn(async () => true)
    const state = await workerRealState('/lead', worker, { ownership: true, branch: true, git: true, process: true,
      probes: { exists: () => false, owned, git, process: () => 'not-ours', changedPaths: vi.fn() } })
    expect(state).toMatchObject({ worktree: 'vanished', owned: false, branch: 'present', branchAhead: 2, process: 'not-ours', hostSession: true, finished: true })
    expect(owned).not.toHaveBeenCalled()
    expect(git).toHaveBeenCalledTimes(3)
  })
  it('does not exclude a base commit without positive carry provenance', async () => {
    const git = vi.fn(async (dir: string, args: string[]) => {
      expect(dir).toBe('/lead')
      if (args[0] === 'for-each-ref') return 'refs/heads/room/w\n'
      if (args[0] === 'rev-list') {
        expect(args).toEqual(['rev-list', 'refs/heads/room/w', '^HEAD'])
        return `${'a'.repeat(40)}\n`
      }
      throw new Error('no carry ref')
    })
    const state = await workerRealState('/lead', { ...worker, base: 'carry-base' }, {
      branch: true, probes: { exists: () => false, git },
    })
    expect(state.branchAhead).toBe(1)
  })
  it('counts a recorded carry-looking commit when its author is not Room', async () => {
    const commit = 'a'.repeat(40)
    const git = vi.fn(async (_dir: string, args: string[]) => {
      if (args[0] === 'for-each-ref') return 'refs/heads/room/w\n'
      if (args[0] === 'rev-list') return `${commit}\n`
      if (args[0] === 'rev-parse') return `${commit}\n`
      if (args[0] === 'show') return 'Lead\0lead@example.test\0room: carried-in uncommitted work from lead\n'
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })
    const state = await workerRealState('/lead', { ...worker, base: commit, carriedBase: commit }, {
      branch: true, probes: { exists: () => false, git },
    })
    expect(state.branchAhead).toBe(1)
  })
  it('does not query branch, ownership, or process when those facts are unnecessary', async () => {
    const git = vi.fn(), owned = vi.fn(), process = vi.fn()
    const state = await workerRealState('/lead', worker, { probes: { exists: () => true, git, owned, process } })
    expect(state.worktree).toBe('present')
    expect(state.branch).toBeUndefined()
    expect(state.owned).toBeUndefined()
    expect(state.process).toBeUndefined()
    expect(git).not.toHaveBeenCalled(); expect(owned).not.toHaveBeenCalled(); expect(process).not.toHaveBeenCalled()
  })
  it('asks the ownership rule with the lead and records, and skips worktree git when not owned', async () => {
    const git = vi.fn(), owned = vi.fn(async () => false), records = [worker]
    const state = await workerRealState('/lead', worker, { git: true, leadName: 'lead', workers: records, probes: { exists: () => true, git, owned } })
    expect(owned).toHaveBeenCalledWith('/lead', worker, 'lead', records)
    expect(state).toMatchObject({ worktree: 'present', owned: false })
    expect(state.clean).toBeUndefined(); expect(state.ahead).toBeUndefined()
    expect(git).not.toHaveBeenCalled()
  })
  it('reports unknown git state as not clean and not counted', async () => {
    const git = vi.fn(async () => { throw new Error('git failed') })
    const state = await workerRealState('/lead', worker, { git: true, probes: { exists: () => true, git, owned: async () => true, changedPaths: async () => [] } })
    expect(state).toMatchObject({ owned: true, clean: false, merged: false })
    expect(state.ahead).toBeUndefined()
  })
  it('treats a live spawn handle as our process without probing the pid', async () => {
    const process = vi.fn(() => false)
    expect((await workerRealState('/lead', worker, { process: true, hasHandle: true, probes: { exists: () => true, process } })).process).toBe('ours')
    expect(process).not.toHaveBeenCalled()
  })
  it('reports an absent branch without counting commits or touching a vanished checkout', async () => {
    const git = vi.fn(async () => '')
    const state = await workerRealState('/lead', worker, { branch: true, probes: { exists: () => false, git } })
    expect(state).toMatchObject({ worktree: 'vanished', branch: 'absent' })
    expect(state.branchAhead).toBeUndefined()
    expect(git).toHaveBeenCalledOnce()
  })
})

describe('worker lifecycle decisions', () => {
  it.each([
    [{ status: 'running' }, true, false, 'skip-status'],
    [{ status: 'failed' }, true, true, 'skip-status'],
    [{ status: 'dismissed' }, false, true, 'skip-partial'],
    [{ status: 'dismissed' }, true, true, 'inspect'],
    [{ status: 'running' }, false, true, 'skip-partial'],
    [{ status: 'running' }, true, true, 'inspect'],
    [{ status: 'failed' }, false, false, 'skip-status'],
    [{ worktree: 'vanished' }, true, false, 'missing'],
    [{ worktree: 'vanished' }, false, false, 'missing'],
    [{ status: 'dismissed', worktree: 'vanished' }, false, true, 'skip-partial'],
    [{ status: 'done' }, false, false, 'inspect'],
  ] as [Partial<WorkerRealState>, boolean, boolean, string][])('collect %j, explicit=%s, stopped=%s -> %s', (patch, explicit, stopped, action) => {
    expect(decideCollect({ ...base, ...patch }, explicit, stopped)).toBe(action)
  })
  it.each([
    [{ worktree: 'vanished', owned: false }, 'prune'],
    [{ owned: true }, 'cleanup'],
    [{ owned: false }, 'retain-directory'],
    [{ owned: undefined }, 'retain-directory'],
  ] as [Partial<WorkerRealState>, string][])('discard %j -> %s', (patch, action) => {
    expect(decideDiscard({ ...base, ...patch })).toBe(action)
  })
  it.each([
    [{ owned: true, process: 'ours' }, { cwd: true, host: 'signal' }],
    [{ owned: false, process: 'ours' }, { cwd: false, host: 'signal' }],
    [{ owned: true, process: 'not-ours' }, { cwd: true, host: 'not-ours' }],
    [{ owned: undefined, process: undefined }, { cwd: false, host: 'not-ours' }],
  ] as [Partial<WorkerRealState>, ReturnType<typeof decideStop>][])('stop %j', (patch, action) => {
    expect(decideStop({ ...base, ...patch })).toEqual(action)
  })
  it.each([
    [{ process: 'ours', exitCode: undefined, dismissed: true }, undefined],
    [{ process: 'ours', exitCode: 0, dismissed: true }, undefined],
    [{ status: 'running', finished: false, dismissed: true }, undefined],
    [{ status: 'failed', dismissed: true }, 'dismissed'],
    [{ status: 'failed', clean: true, ahead: 0 }, undefined],
    [{ clean: undefined, ahead: 0 }, undefined],
    [{ clean: true, ahead: 0, merged: true }, 'merged'],
    [{ clean: true, ahead: 0, merged: false }, 'clean'],
    [{ clean: false, ahead: 0 }, undefined],
    [{ clean: true, ahead: 1 }, undefined],
  ] as [Partial<WorkerRealState>, string | undefined][])('retire %j', (patch, outcome) => {
    expect(decideRetire({ ...base, ...patch })).toBe(outcome)
  })
  it.each([
    [{ status: 'running', process: 'not-ours' }, 'stop'],
    [{ status: 'done', process: 'ours' }, 'stop'],
    [{ status: 'done', process: 'not-ours' }, 'leave'],
    [{ status: 'failed', process: 'not-ours' }, 'leave'],
    [{ status: 'dismissed', process: 'not-ours' }, 'leave'],
    [{ status: 'dismissed', process: 'ours' }, 'stop'],
  ] as [Partial<WorkerRealState>, string][])('leave and shutdown %j', (patch, action) => {
    expect(decideLeave({ ...base, ...patch })).toBe(action)
    expect(decideShutdown({ ...base, ...patch })).toBe(action)
  })
  it.each([
    [{ exitCode: undefined, process: 'ours' }, false],
    [{ exitCode: 0, process: 'ours' }, false],
    [{ exitCode: undefined, process: 'not-ours' }, true],
  ] as [Partial<WorkerRealState>, boolean][])('process exited %j -> %s', (patch, exited) => {
    expect(processExited({ ...base, ...patch })).toBe(exited)
  })
  it.each([
    [{ worktree: 'present' }, true, 'disk'],
    [{ worktree: 'vanished' }, true, 'shared'],
    [{ worktree: 'present' }, false, 'shared'],
  ] as [Partial<WorkerRealState>, boolean, string][])('preview %j, eligible=%s -> %s', (patch, eligible, action) => {
    expect(decidePreview({ ...base, ...patch }, eligible)).toBe(action)
  })
})
