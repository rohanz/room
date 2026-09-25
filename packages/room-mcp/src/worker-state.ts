/** Owns the answer to “what state is this worker really in?” for lifecycle operations. */
import fs from 'node:fs'
import path from 'node:path'
import { type RetiredWorker, type Worker } from '@room/shared'
import { git } from '@room/roomd/git'
import { workerChangedPaths } from '@room/roomd/baseline'
import { isOwnedWorkerWorktree, pidIsOurWorker, type ProcessInfo } from './workers.js'

type OwnershipRecord = Pick<Worker, 'name' | 'tag' | 'lead' | 'dir' | 'branch'> | Pick<RetiredWorker, 'name' | 'tag' | 'lead' | 'keptWorktree'>
export interface WorkerRealState {
  worktree: 'present' | 'vanished'
  owned?: boolean
  branch?: 'present' | 'absent'
  /** Commits on refs/heads/room/<tag> absent from the lead HEAD. */
  branchAhead?: number
  /** Retirement count also considers detached HEAD and excludes the carried base. */
  ahead?: number
  process?: 'ours' | 'gone'
  hostSession: boolean
  finished: boolean
  status: Worker['status']
  exitCode?: number
  dismissed: boolean
  merged?: boolean
  clean?: boolean
  uncommitted?: number
}

export interface WorkerStateProbes {
  exists?: (dir: string) => boolean
  owned?: typeof isOwnedWorkerWorktree
  git?: typeof git
  changedPaths?: typeof workerChangedPaths
  process?: (w: Worker) => boolean
}

/** Select expensive probes at each call site. Git in a vanished checkout is never attempted. */
export async function workerRealState(leadDir: string, w: Worker, options: {
  ownership?: boolean; branch?: boolean; git?: boolean; process?: boolean
  leadName?: string; workers?: Iterable<OwnershipRecord>; hasHandle?: boolean
  probe?: (pid: number) => ProcessInfo | undefined
  probes?: WorkerStateProbes
} = {}): Promise<WorkerRealState> {
  const deps = options.probes ?? {}
  const exists = deps.exists ?? fs.existsSync
  const runGit = deps.git ?? git
  const present = exists(w.dir)
  const state: WorkerRealState = {
    worktree: present ? 'present' : 'vanished', hostSession: !!w.hostSessionId,
    finished: w.exitCode !== undefined || w.finishedAt !== undefined || w.status !== 'running',
    status: w.status, exitCode: w.exitCode, dismissed: w.dismissedAt !== undefined || w.status === 'dismissed',
  }
  if (options.process) state.process = options.hasHandle || (deps.process ?? (worker => pidIsOurWorker(worker.pid, worker, options.probe)))(w) ? 'ours' : 'gone'
  if (options.ownership || options.git) state.owned = present && await (deps.owned ?? isOwnedWorkerWorktree)(leadDir, w, options.leadName, options.workers)
  if (options.branch) {
    const ref = `refs/heads/${w.branch}`
    state.branch = (await runGit(leadDir, ['for-each-ref', '--format=%(refname)', ref])).split('\n').includes(ref) ? 'present' : 'absent'
    if (state.branch === 'present') {
      const count = Number((await runGit(leadDir, ['rev-list', '--count', ref, '^HEAD'])).trim())
      if (!Number.isSafeInteger(count)) throw new Error(`could not count commits on ${w.branch}`)
      state.branchAhead = count
    }
  }
  if (options.git && state.owned) {
    state.merged = false; state.clean = false
    try {
      const owned = new Set(await (deps.changedPaths ?? workerChangedPaths)(w))
      const status = await runGit(w.dir, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', '.'])
      const uncommitted = new Set(status.split('\0').filter(Boolean).map(entry => entry.slice(3)).filter(p => owned.has(p)))
      for (const p of w.carriedUntracked ?? []) if (owned.has(p.path) && !exists(path.join(w.dir, p.path))) uncommitted.add(p.path)
      state.uncommitted = uncommitted.size
      state.clean = state.uncommitted === 0
      const head = (await runGit(leadDir, ['rev-parse', 'HEAD'])).trim()
      const branch = `refs/heads/${w.branch}`
      const exclusions = [`^${head}`, ...(w.base ? [`^${w.base}`] : [])]
      const count = (await runGit(w.dir, ['rev-list', '--count', branch, ...exclusions])).trim()
      const worktreeCount = (await runGit(w.dir, ['rev-list', '--count', 'HEAD', ...exclusions])).trim()
      if (/^\d+$/.test(count) && /^\d+$/.test(worktreeCount)) state.ahead = Math.max(Number(count), Number(worktreeCount))
      if (w.base && state.ahead === 0) {
        const own = (await runGit(w.dir, ['rev-list', '--count', `${w.base}..${branch}`])).trim()
        state.merged = /^\d+$/.test(own) && Number(own) > 0
      }
    } catch { state.ahead = undefined }
  }
  return state
}

export type CollectDecision = 'skip-status' | 'skip-partial' | 'missing' | 'inspect'
export function decideCollect(s: WorkerRealState, explicit: boolean, stopped: boolean): CollectDecision {
  if (s.status !== 'done' && !(stopped && (s.status === 'running' || s.status === 'dismissed'))) return 'skip-status'
  if (!explicit && stopped && s.status !== 'done') return 'skip-partial'
  return s.worktree === 'vanished' ? 'missing' : 'inspect'
}
export type DiscardDecision = 'prune' | 'cleanup' | 'retain-directory'
export function decideDiscard(s: WorkerRealState): DiscardDecision {
  return s.worktree === 'vanished' ? 'prune' : s.owned ? 'cleanup' : 'retain-directory'
}
export function decideStop(s: WorkerRealState): { cwd: boolean; host: 'signal' | 'gone' } {
  return { cwd: s.owned === true, host: s.process === 'ours' ? 'signal' : 'gone' }
}
/** A recorded exit code wins over a process probe that may have outlived it. */
export function processExited(s: Pick<WorkerRealState, 'exitCode' | 'process'>): boolean { return s.exitCode !== undefined || s.process !== 'ours' }
export function decideRetire(s: WorkerRealState): RetiredWorker['outcome'] | undefined {
  if (!processExited(s) || !s.finished) return undefined
  if (s.dismissed) return 'dismissed'
  if (s.status !== 'done') return undefined
  if (s.clean === true && s.ahead === 0) return s.merged ? 'merged' : 'clean'
  return undefined
}
export function decideLeave(s: WorkerRealState): 'stop' | 'leave' { return (s.status !== 'done' && s.status !== 'failed' && s.status !== 'dismissed') || s.process === 'ours' ? 'stop' : 'leave' }
export function decideShutdown(s: WorkerRealState): 'stop' | 'leave' { return decideLeave(s) }
export function decidePreview(s: WorkerRealState, diskEligible: boolean): 'disk' | 'shared' {
  return diskEligible && s.worktree === 'present' ? 'disk' : 'shared'
}
