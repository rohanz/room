/** Durable facts, not the room document, determine a local worker's lifecycle. */
import type { RetiredWorker, ShareLevel, WorkerStatus, WorkerStopReason, WorkerView } from '@room/shared'
import type { InstanceToken, Liveness, ProcessIdentity } from './leases.js'

export interface Run {
  n: number; mode: 'fresh' | 'resume'; intentAt: number; nonce: string
  /** The lead's highest hub seq at intent: the worker's ledger frontier seed (ledger "Cursor"). */
  busFrontier: number
  promptMsgIds: string[]
  launcher: InstanceToken; logStart: number
  launch?: { outcome: 'launched'; pid: number; process?: ProcessIdentity } | { outcome: 'never'; error: string }
    | { outcome: 'ambiguous'; at: number } | { outcome: 'imported' }
  posted?: string
}
export interface ExitObservation { run: number; code: number | null; signal?: string; at: number; witnessed: boolean }
export interface RunReport {
  run: number; nonce: string; chain: ProcessIdentity[]; joinedAt: number; hostSessionId?: string
  /** Parent host captured at admission; null means it could not be verified (the first chain member is the MCP). */
  hostProcess?: ProcessIdentity | null
  done?: { at: number; summary: string; changed: string[] }; posted?: string
}
export type PrepStep = 'plan' | 'worktree' | 'branch' | 'carry-commit' | 'carry-refs' | 'untracked' | 'prepared'
export interface PrepJournal {
  step: PrepStep; worktreeExisted?: boolean; branchExisted?: boolean
  previousCarryRefs?: Record<string, string | null>; untrackedTree?: string
  created?: boolean; branchCreated?: boolean
}
interface DiscardPlan {
  force: boolean; children: string[]; steps: Partial<Record<'children' | 'stop' | 'patch' | 'cleanup' | 'prune', boolean>>
  patch?: { path: string; sha256: string }
}
export interface WorkerRecord {
  v: 1; id: string; tag: string; name: string; mode: 'here' | 'local'; room: string
  lead: { participant: string; room: string; instance: InstanceToken }
  host: 'claude' | 'codex'; model?: string; effort?: string
  budget: { threads: number; memGb: number; nice: number }; share: ShareLevel; link?: string[]; task: string
  dir: string; outside: boolean; branch: string; prep: PrepJournal
  /** The host's log, `<lead>/.room/workers/<tag>.log`; records before 0.17.0-rc8 lack it (see workerLogFile). */
  logFile?: string
  /** A dir= worker borrows another worker's checkout and must never remove it. */
  sharedWith?: string
  base?: string; carriedBase?: string; carriedUntracked?: { path: string; sha: string; mode?: number }[]
  skippedCarry?: { path: string; reason: string }[]; port?: number; hostSessionId?: string
  capabilities: { resume: boolean; signal: boolean; collect: 'delta' | 'copy' | 'none' }
  phase: 'intent' | 'preparing' | 'prepared' | 'active' | 'collecting' | 'discarding' | 'retiring' | 'retired' | 'abandoned'
  runs: Run[]; stop?: { reason: WorkerStopReason; at: number; run: number }
  discard?: DiscardPlan; interrupted?: { op: 'collect' | 'discard'; at: number; detail: string }
  cleanup?: Record<string, 'pending' | 'done'>; keptWorktree?: string
  /** A `local` worker's team room, where the lead's bridge projects it (registry §13). */
  projectedInto?: string
  /** The archive entry each room's projector appends when it retires the worker (§12), written with `retiring`. */
  archive?: RetiredWorker
  legacy?: { id: string; source: string; said?: string; unowned?: boolean }; createdAt: number; seq: number
}
export interface WorkerStatusResult { status: WorkerStatus; run?: Run; note?: string; exitCode?: number; finishedAt?: number; summary?: string; followUp?: string; noReport?: boolean }
export type LivenessProbe = (identity: ProcessIdentity) => Liveness
const IDLE_CLAIM_RELEASE_MS = 8 * 60 * 60 * 1000
/** Only the session's own monotonic clock is comparable with its activity marker. */
export function idleClaimsDue(input: { host: 'shared-app-server' | 'interactive'; lastActivityMs: number; nowMs: number; heldClaims: number; hasScope?: boolean }): boolean {
  return input.host === 'shared-app-server' && (input.heldClaims > 0 || input.hasScope === true)
    && Number.isFinite(input.lastActivityMs) && Number.isFinite(input.nowMs)
    && input.nowMs - input.lastActivityMs >= IDLE_CLAIM_RELEASE_MS
}
const result = (status: WorkerStatus, run?: Run, note?: string, extra: Partial<WorkerStatusResult> = {}): WorkerStatusResult => ({ status, run, ...(note ? { note } : {}), ...extra })

/** First matching row of registry §6. Inputs may be missing/corrupt; this function remains total. */
export function statusOf(record: WorkerRecord, runs: Run[] = record.runs, reports: RunReport[] = [], exits: ExitObservation[] = [], liveness: LivenessProbe, nowMs = Date.now()): WorkerStatusResult {
  if (record.phase === 'retired') return result('retired')
  if (record.phase === 'abandoned') return result('abandoned')
  if (['collecting', 'discarding', 'retiring'].includes(record.phase)) return result('collecting', undefined, record.interrupted?.detail)
  const ordered = [...runs].sort((a, b) => a.n - b.n)
  let index = ordered.length - 1
  let current = ordered[index]
  let neverResume = false
  while (current?.mode === 'resume' && current.launch?.outcome === 'never') {
    neverResume = true
    current = ordered[--index]
  }
  if (!current) return result('starting', undefined, neverResume ? 'follow-up not delivered' : undefined)
  const note = neverResume ? 'follow-up not delivered' : undefined
  const launch = current.launch
  if (launch?.outcome === 'ambiguous') return result('ambiguous', current, 'launch may or may not have started; resume or discard')
  if (launch?.outcome === 'never') return result('failed', current, `never started: ${launch.error}`)
  if (launch?.outcome === 'imported') return result('imported', current, 'a 0.16 worker; Room cannot check whether its process still runs')
  if (!launch) return result(liveness(current.launcher) === 'dead' ? 'ambiguous' : 'starting', current, note)
  const report = reports.find(r => r.run === current.n && r.nonce === current.nonce)
  const exit = exits.find(e => e.run === current.n)
  const live = launch.process ? liveness(launch.process) : undefined
  const waitingForJoin = !report && nowMs - current.intentAt >= 60_000
    ? `has not joined the room: its host's Room plugin may be older than 0.17 (host ${record.host})` : note
  // A run that reported while its host still lives is running, and its report's summary is already known.
  const reported = report?.done ? { summary: report.done.summary } : {}
  if (launch.process && live === 'alive') return result('running', current, record.stop?.run === current.n ? 'stopping' : waitingForJoin, reported)
  if (!exit && liveness(current.launcher) === 'alive') return result('running', current, record.stop?.run === current.n ? 'stopping' : waitingForJoin, reported)
  if (launch.process && live === 'unknown' && !exit) return result('unknown', current, `cannot verify pid ${launch.pid}`)
  if (report?.done) return result('done', current, exit?.code && exit.code !== 0 ? `exited ${exit.code} after reporting` : note,
    { summary: report.done.summary, finishedAt: report.done.at, ...(exit?.code != null ? { exitCode: exit.code } : {}) })
  if (record.stop?.run === current.n) return result('stopped', current, record.stop.reason, { finishedAt: record.stop.at })
  const earlierDone = [...ordered].reverse().filter(r => r.n < current.n)
    .map(r => reports.find(p => p.run === r.n && p.nonce === r.nonce && p.done)).find(Boolean)
  if (exit?.witnessed && exit.code === 0 && current.mode === 'resume' && earlierDone)
    return result('done', current, note, { finishedAt: exit.at, exitCode: 0,
      summary: earlierDone.done!.summary })
  if (exit?.witnessed && exit.code === 0 && current.mode === 'fresh')
    return result('done', current, undefined, { finishedAt: exit.at, exitCode: 0, noReport: true, summary: 'ended without a report' })
  if (exit?.witnessed && exit.code === 0) return result('failed', current, 'exited without room_done', { finishedAt: exit.at, exitCode: 0 })
  if (exit?.witnessed) return result('failed', current, exit.signal ?? `exit ${exit.code ?? 'unknown'}`, { finishedAt: exit.at, ...(exit.code != null ? { exitCode: exit.code } : {}) })
  if (exit && current.mode === 'resume' && earlierDone) return result('done', current, 'follow-up outcome unknown: ended while no session of yours was running', { finishedAt: exit.at })
  if (exit) return result('failed', current, 'stopped while no session of yours was running', { finishedAt: exit.at })
  return result('running', current, 'exit being recorded')
}

/**
 * The decision input of the lifecycle helpers (worker-state, worker-git, collect). Only `realStateInput`
 * builds it, from the local registry record; nothing in the room document yields one (registry §1).
 */
export interface LocalWorker {
  id: string; tag: string; name: string; lead: string; host: 'claude' | 'codex'; model?: string; effort?: string
  hostSessionId?: string; budget: WorkerRecord['budget']; port?: number; share: ShareLevel; link?: string[]
  task: string; dir: string; branch: string; sharedWith?: string; base?: string; carriedBase?: string; carriedUntracked?: WorkerRecord['carriedUntracked']
  /** Zero unless the signal capability names a launched process. */
  pid: number; processStartTime?: string; startedAt: number
  status: 'running' | 'done' | 'failed' | 'dismissed'
  summary?: string; exitCode?: number; finishedAt?: number
  stopReason?: Exclude<WorkerStopReason, 'discarded'>
}

/** Supplies the lifecycle decision helpers without granting unproven signal/resume capabilities. */
export function realStateInput(record: WorkerRecord, status: WorkerStatusResult): LocalWorker {
  const map: Record<WorkerStatus, LocalWorker['status']> = {
    starting: 'running', running: 'running', unknown: 'running', ambiguous: 'running', done: 'done', failed: 'failed',
    stopped: 'dismissed', imported: 'dismissed', collecting: 'dismissed', retired: 'dismissed', abandoned: 'dismissed',
  }
  const launch = status.run?.launch
  const signal = record.capabilities.signal && launch?.outcome === 'launched' && !!launch.process
  return {
    id: record.id, tag: record.tag, name: record.name, lead: record.lead.participant, host: record.host,
    model: record.model, effort: record.effort, budget: record.budget, share: record.share, link: record.link,
    task: record.task, dir: record.dir, branch: record.branch, sharedWith: record.sharedWith, base: record.base, carriedBase: record.carriedBase,
    carriedUntracked: record.carriedUntracked, port: record.port, startedAt: record.createdAt,
    pid: signal ? launch.pid : 0, processStartTime: signal ? launch.process!.startTime : undefined,
    hostSessionId: record.capabilities.resume ? record.hostSessionId : undefined,
    status: map[status.status], summary: status.summary ?? record.legacy?.said, exitCode: status.exitCode,
    finishedAt: status.finishedAt,
    stopReason: record.stop?.reason === 'discarded' ? undefined : record.stop?.reason,
  }
}

/** The room's view of one worker (registry §14), fenced by the writing lead session. */
export function workerView(record: WorkerRecord, status: WorkerStatusResult, fence: string): WorkerView {
  return {
    id: record.id, tag: record.tag, name: record.name, lead: record.lead.participant, mode: record.mode, host: record.host,
    ...(record.model ? { model: record.model } : {}), ...(record.effort ? { effort: record.effort } : {}),
    task: record.task.slice(0, 200), branch: record.branch, status: status.status,
    ...(status.summary ?? record.legacy?.said ? { summary: status.summary ?? record.legacy?.said } : {}),
    ...(status.noReport ? { noReport: true } : {}),
    ...(status.note ? { note: status.note } : {}), run: status.run?.n ?? record.runs.at(-1)?.n ?? 0, startedAt: record.createdAt,
    ...(status.followUp ? { followUp: status.followUp } : {}),
    ...(status.finishedAt !== undefined ? { finishedAt: status.finishedAt } : {}),
    ...(status.exitCode !== undefined ? { exitCode: status.exitCode } : {}),
    ...(record.stop ? { stopReason: record.stop.reason } : {}), fence,
  }
}
