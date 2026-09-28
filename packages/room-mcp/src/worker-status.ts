/** Durable facts, not the room document, determine a local worker's lifecycle. */
import type { ShareLevel, Worker } from '@room/shared'
import type { InstanceToken, Liveness, ProcessIdentity } from './leases.js'

export type WorkerStatus2 = 'starting' | 'running' | 'unknown' | 'ambiguous' | 'done' | 'failed' | 'stopped' | 'imported' | 'collecting' | 'retired' | 'abandoned'
export type StopReason = 'lead-session-ended' | 'discarded' | 'message-delivered-cancelled' | 'message-delivered-failed'
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
  done?: { at: number; summary: string; changed: string[] }; posted?: string
}
export type PrepStep = 'plan' | 'worktree' | 'branch' | 'carry-commit' | 'carry-refs' | 'untracked' | 'prepared'
export interface PrepJournal {
  step: PrepStep; worktreeExisted?: boolean; branchExisted?: boolean
  previousCarryRefs?: Record<string, string | null>; untrackedTree?: string
  created?: boolean; branchCreated?: boolean
}
export interface DiscardPlan {
  force: boolean; children: string[]; steps: Partial<Record<'children' | 'stop' | 'patch' | 'cleanup' | 'prune', boolean>>
  patch?: { path: string; sha256: string }
}
export interface WorkerRecord {
  v: 1; id: string; tag: string; name: string; mode: 'here' | 'local'; room: string
  lead: { participant: string; room: string; instance: InstanceToken }
  host: 'claude' | 'codex'; model?: string; effort?: string
  budget: { threads: number; memGb: number; nice: number }; share: ShareLevel; link?: string[]; task: string
  dir: string; outside: boolean; branch: string; prep: PrepJournal
  base?: string; carriedBase?: string; carriedUntracked?: { path: string; sha: string; mode?: number }[]
  skippedCarry?: { path: string; reason: string }[]; port?: number; hostSessionId?: string
  capabilities: { resume: boolean; signal: boolean; collect: 'delta' | 'copy' | 'none' }
  phase: 'intent' | 'preparing' | 'prepared' | 'active' | 'collecting' | 'discarding' | 'retiring' | 'retired' | 'abandoned'
  runs: Run[]; stop?: { reason: StopReason; at: number; run: number }
  discard?: DiscardPlan; interrupted?: { op: 'collect' | 'discard'; at: number; detail: string }
  cleanup?: Record<string, 'pending' | 'done'>; keptWorktree?: string
  legacy?: { id: string; source: string; said?: string; unowned?: boolean }; createdAt: number; seq: number
}
export interface WorkerStatusResult { status: WorkerStatus2; run?: Run; note?: string; exitCode?: number; finishedAt?: number; summary?: string }
export type LivenessProbe = (identity: ProcessIdentity) => Liveness
export const IDLE_CLAIM_RELEASE_MS = 8 * 60 * 60 * 1000
/** Only the session's own monotonic clock is comparable with its activity marker. */
export function idleClaimsDue(input: { host: 'shared-app-server' | 'interactive'; lastActivityMs: number; nowMs: number; heldClaims: number; hasScope?: boolean }): boolean {
  return input.host === 'shared-app-server' && (input.heldClaims > 0 || input.hasScope === true)
    && Number.isFinite(input.lastActivityMs) && Number.isFinite(input.nowMs)
    && input.nowMs - input.lastActivityMs >= IDLE_CLAIM_RELEASE_MS
}
const result = (status: WorkerStatus2, run?: Run, note?: string, extra: Partial<WorkerStatusResult> = {}): WorkerStatusResult => ({ status, run, ...(note ? { note } : {}), ...extra })

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
  if (launch.process && live === 'alive') return result('running', current, record.stop?.run === current.n ? 'stopping' : waitingForJoin)
  if (!exit && liveness(current.launcher) === 'alive') return result('running', current, record.stop?.run === current.n ? 'stopping' : waitingForJoin)
  if (launch.process && live === 'unknown' && !exit) return result('unknown', current, `cannot verify pid ${launch.pid}`)
  if (report?.done) return result('done', current, exit?.code && exit.code !== 0 ? `exited ${exit.code} after reporting` : note,
    { summary: report.done.summary, finishedAt: report.done.at, ...(exit?.code != null ? { exitCode: exit.code } : {}) })
  if (record.stop?.run === current.n) return result('stopped', current, record.stop.reason, { finishedAt: record.stop.at })
  const earlierDone = ordered.some(r => r.n < current.n && reports.some(p => p.run === r.n && p.nonce === r.nonce && p.done))
  if (exit?.witnessed && exit.code === 0 && earlierDone) return result('done', current, note, { finishedAt: exit.at, exitCode: 0 })
  if (exit?.witnessed && exit.code === 0) return result('failed', current, 'exited without room_done', { finishedAt: exit.at, exitCode: 0 })
  if (exit?.witnessed) return result('failed', current, exit.signal ?? `exit ${exit.code ?? 'unknown'}`, { finishedAt: exit.at, ...(exit.code != null ? { exitCode: exit.code } : {}) })
  if (exit && current.mode === 'resume' && earlierDone) return result('done', current, 'follow-up outcome unknown: ended while no session of yours was running', { finishedAt: exit.at })
  if (exit) return result('failed', current, 'stopped while no session of yours was running', { finishedAt: exit.at })
  return result('running', current, 'exit being recorded')
}

/** Supplies the old lifecycle decision helpers without granting unproven signal/resume capabilities. */
export function realStateInput(record: WorkerRecord, status: WorkerStatusResult): Worker {
  const map: Record<WorkerStatus2, Worker['status']> = {
    starting: 'running', running: 'running', unknown: 'running', ambiguous: 'running', done: 'done', failed: 'failed',
    stopped: 'dismissed', imported: 'dismissed', collecting: 'dismissed', retired: 'dismissed', abandoned: 'dismissed',
  }
  const launch = status.run?.launch
  const signal = record.capabilities.signal && launch?.outcome === 'launched' && !!launch.process
  return {
    id: record.id, tag: record.tag, name: record.name, lead: record.lead.participant, host: record.host,
    model: record.model, effort: record.effort, budget: record.budget, share: record.share, link: record.link,
    task: record.task, dir: record.dir, branch: record.branch, base: record.base, carriedBase: record.carriedBase,
    carriedUntracked: record.carriedUntracked, port: record.port, startedAt: record.createdAt,
    pid: signal ? launch.pid : 0, processStartTime: signal ? launch.process!.startTime : undefined,
    hostSessionId: record.capabilities.resume ? record.hostSessionId : undefined,
    status: map[status.status], summary: status.summary ?? record.legacy?.said, exitCode: status.exitCode,
    finishedAt: status.finishedAt, dismissedAt: status.status === 'stopped' || status.status === 'imported' ? record.stop?.at ?? record.createdAt : undefined,
    stopReason: record.stop?.reason === 'discarded' ? undefined : record.stop?.reason,
  }
}
