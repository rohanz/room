/** Owns the answer to “what state is this worker really in?” for lifecycle operations. */
import fs from 'node:fs'
import path from 'node:path'
import { type RetiredWorker, type Worker } from '@room/shared'
import { git } from '@room/roomd/git'
import { workerChangedPaths } from '@room/roomd/baseline'
import { RECORDED_PATH, realGitCommonDir, validRepoPath } from '@room/roomd'
import { workerProcessOwnership, type ProcessInfo, type ProcessOwnership } from './worker-process.js'

export function roomWorkerPathMatchesBranch(leadDir: string, workerDir: string, branch: string, nested = false): boolean {
  const relative = path.relative(path.resolve(leadDir), path.resolve(workerDir)).split(path.sep)
  if (relative.length < 3 || relative.length % 3 !== 0 || (!nested && relative.length !== 3)) return false
  return relative.every((part, i) => i % 3 === 0 ? part === '.room' : i % 3 === 1 ? part === 'workers' : validRepoPath(part, RECORDED_PATH))
    && branch === `room/${relative.at(-1)}`
}

export type WorktreeOwnershipRecord = Pick<Worker, 'name' | 'tag' | 'lead' | 'dir' | 'branch'>
  | Pick<RetiredWorker, 'name' | 'tag' | 'lead' | 'keptWorktree'>

/** Cwd-wide cleanup requires a canonical Room worktree at every level back to this lead. */
export async function isOwnedWorkerWorktree(leadDir: string, w: Pick<Worker, 'name' | 'dir' | 'branch' | 'tag' | 'lead'>, leadName?: string, workers: Iterable<WorktreeOwnershipRecord> = []): Promise<boolean> {
  const byName = new Map([...workers].map(record => [record.name, record]))
  const chain = [w]
  const seen = new Set([w.name])
  let owner = w.lead
  while (leadName && owner !== leadName) {
    const record = byName.get(owner)
    if (!record || seen.has(record.name)) return false
    // An archived lead may still have a live nested worktree. Its child path
    // identifies the candidate parent; the checks below must prove every link.
    const parent = {
      name: record.name, tag: record.tag, lead: record.lead,
      dir: 'dir' in record ? record.dir : record.keptWorktree ?? path.dirname(path.dirname(path.dirname(chain[0].dir))),
      branch: 'branch' in record ? record.branch : `room/${record.tag}`,
    }
    chain.unshift(parent)
    seen.add(parent.name)
    owner = parent.lead
  }
  try {
    let parentDir = leadDir, parentName = leadName
    for (const record of chain) {
      if (parentName && record.lead !== parentName) return false
      if (!fs.existsSync(record.dir)) return false
      const parentRoot = fs.realpathSync(parentDir), workerRoot = fs.realpathSync(record.dir)
      if (workerRoot === parentRoot) return false
      if (!roomWorkerPathMatchesBranch(parentDir, record.dir, record.branch)) return false
      const expected = path.join(parentRoot, '.room', 'workers', path.basename(record.dir))
      if (workerRoot !== fs.realpathSync(expected)) return false
      if (await realGitCommonDir(parentDir) !== await realGitCommonDir(record.dir)) return false
      if ((await git(record.dir, ['branch', '--show-current'])).trim() !== record.branch) return false
      parentDir = record.dir
      parentName = record.name
    }
    return true
  } catch { return false }
}


/** Identity of the commit that carries a lead's uncommitted work into a worker's worktree. */
export const ROOM_CARRY_IDENTITY = {
  authorName: 'Room',
  authorEmail: 'room@localhost',
  subjectPrefix: 'room: carried-in uncommitted work from ',
  isRoomCarryCommit(name: string, email: string, subject: string): boolean {
    return name === ROOM_CARRY_IDENTITY.authorName
      && email === ROOM_CARRY_IDENTITY.authorEmail
      && subject.startsWith(ROOM_CARRY_IDENTITY.subjectPrefix)
      && /^.+$/.test(subject.slice(ROOM_CARRY_IDENTITY.subjectPrefix.length))
  },
} as const

type OwnershipRecord = Pick<Worker, 'name' | 'tag' | 'lead' | 'dir' | 'branch'> | Pick<RetiredWorker, 'name' | 'tag' | 'lead' | 'keptWorktree'>
export interface WorkerRealState {
  worktree: 'present' | 'vanished'
  owned?: boolean
  branch?: 'present' | 'absent'
  /** Commits on refs/heads/room/<tag> absent from the lead HEAD, excluding verified Room carry. */
  branchAhead?: number
  /** Retirement count also considers detached HEAD and excludes verified Room carry. */
  ahead?: number
  process?: ProcessOwnership
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
  process?: (w: Worker) => ProcessOwnership
}

/** A base may be a user commit. Only a recorded commit with Room's carry identity is excluded. */
async function workerCommitCount(runGit: typeof git, dir: string, ref: string, leadHead: string,
  w: Pick<Worker, 'tag' | 'carriedBase'>): Promise<number> {
  const commits = (await runGit(dir, ['rev-list', ref, `^${leadHead}`])).trim().split('\n').filter(Boolean)
  if (!commits.length) return 0
  const recorded = new Set<string>()
  if (w.carriedBase) recorded.add(w.carriedBase)
  try {
    recorded.add((await runGit(dir, ['rev-parse', '--verify', `refs/room/carry/${w.tag}`])).trim())
  } catch { /* Older workers may not have a carry ref. */ }
  const present = new Set(commits)
  for (const commit of recorded) {
    if (!/^[0-9a-f]{40,64}$/.test(commit) || !present.has(commit)) continue
    try {
      const identity = (await runGit(dir, ['show', '-s', '--format=%an%x00%ae%x00%s', commit])).trim()
      const [name, email, subject] = identity.split('\0')
      if (ROOM_CARRY_IDENTITY.isRoomCarryCommit(name, email, subject)) present.delete(commit)
    } catch { /* Unverifiable commits remain user work. */ }
  }
  return present.size
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
  if (options.process) state.process = options.hasHandle ? 'ours' : (deps.process ?? (worker => workerProcessOwnership(worker.pid, worker, options.probe)))(w)
  if (options.ownership || options.git) state.owned = present && await (deps.owned ?? isOwnedWorkerWorktree)(leadDir, w, options.leadName, options.workers)
  if (options.branch) {
    const ref = `refs/heads/${w.branch}`
    state.branch = (await runGit(leadDir, ['for-each-ref', '--format=%(refname)', ref])).split('\n').includes(ref) ? 'present' : 'absent'
    if (state.branch === 'present') {
      const count = await workerCommitCount(runGit, leadDir, ref, 'HEAD', w)
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
      state.ahead = Math.max(
        await workerCommitCount(runGit, w.dir, branch, head, w),
        await workerCommitCount(runGit, w.dir, 'HEAD', head, w),
      )
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
export function decideStop(s: WorkerRealState): { cwd: boolean; host: 'signal' | 'not-ours' | 'unknown' } {
  return { cwd: s.owned === true, host: s.process === 'ours' ? 'signal' : s.process === 'unknown' ? 'unknown' : 'not-ours' }
}
/** A current process probe wins over a stale exit code when deciding whether cleanup is safe. */
export function processExited(s: Pick<WorkerRealState, 'exitCode' | 'process'>): boolean { return s.process === 'not-ours' }
export function decideRetire(s: WorkerRealState): RetiredWorker['outcome'] | undefined {
  if (!processExited(s) || !s.finished) return undefined
  if (s.dismissed) return 'dismissed'
  if (s.status !== 'done') return undefined
  if (s.clean === true && s.ahead === 0) return s.merged ? 'merged' : 'clean'
  return undefined
}
export function decideLeave(s: WorkerRealState): 'stop' | 'leave' { return (s.status !== 'done' && s.status !== 'failed' && s.status !== 'dismissed') || s.process === 'ours' || s.process === 'unknown' ? 'stop' : 'leave' }
export function decideShutdown(s: WorkerRealState): 'stop' | 'leave' { return decideLeave(s) }
export function decidePreview(s: WorkerRealState, diskEligible: boolean): 'disk' | 'shared' {
  return diskEligible && s.worktree === 'present' ? 'disk' : 'shared'
}
export type ResumeDecision = 'missing' | 'no-session' | 'wait-exit' | 'unknown' | 'ready'
export function decideResume(s: WorkerRealState): ResumeDecision {
  if (s.worktree === 'vanished') return 'missing'
  if (!s.hostSession) return 'no-session'
  return s.process === 'ours' ? 'wait-exit' : s.process === 'unknown' ? 'unknown' : 'ready'
}
