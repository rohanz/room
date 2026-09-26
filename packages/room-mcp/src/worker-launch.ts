/** Owns starting a worker process, fresh or resumed. Worktree preparation happens before this boundary. */
import path from 'node:path'
import type { Session } from './session.js'
import type { Rooms } from './registry.js'
import { toolCallAborted } from './registry.js'
import { bindWorkerPortReservation, reserveWorkerPort } from './port-reservations.js'
import { defaultSpawner, workerCommand, workerMaxBudget, workerPriority, workerProcessEnv, workerPrompt, type SpawnedProcess, type Spawner, type WorkerHost } from './workers.js'

export class WorkerLaunchError extends Error {
  constructor(readonly phase: 'port' | 'budget' | 'start' | 'cancelled' | 'stale', message: string) { super(message) }
}

export interface WorkerLaunchLease { release(): void }
/** The lease spans fresh worktree preparation as well as the process start. */
export function reserveWorkerLaunch(rooms: Rooms, max: number, running: number): WorkerLaunchLease | undefined {
  if (!rooms.reserveLaunch(max, running)) return undefined
  let held = true
  return { release() { if (held) { held = false; rooms.releaseLaunch() } } }
}

interface Policy {
  rooms: Rooms; session: Session; id: string; tag: string; dir: string; lead: string; owner: string
  host: WorkerHost; model?: string; effort?: string; share: string; gen: number
  budget: { threads: number; memGb: number; nice?: number }
  server: string; isWorker: boolean; token?: string; claudeChannel?: string
  spawner?: Spawner; log: (line: string) => void; at?: () => number
  usedPorts?: number[]; preferredPort?: number
}
type Command =
  | { mode: 'fresh'; task: string; links: string[]; carriedPaths?: string[]; sessionId?: string }
  | { mode: 'resume'; message: string; sessionId: string; oldPort?: number }

export interface WorkerLaunchResult {
  proc: SpawnedProcess; port: number; env: Record<string, string>; nice: number; logFile: string
  portChanged: boolean; startedAt: number
}

/** The caller owns the room record transition; this routine owns every process resource and callback. */
export function launchWorkerProcess(policy: Policy, command: Command, lease: WorkerLaunchLease,
  onStarted: (result: WorkerLaunchResult) => boolean, onSessionId?: (id: string, proc: SpawnedProcess) => void): WorkerLaunchResult {
  const { rooms, session: s, id, tag } = policy
  let reservation: ReturnType<typeof reserveWorkerPort> | undefined
  let passed = false
  try {
    try { reservation = reserveWorkerPort(id, policy.usedPorts ?? [], undefined, policy.preferredPort) }
    catch (e) { throw new WorkerLaunchError('port', String(e instanceof Error ? e.message : e)) }
    const port = reservation.port
    const portChanged = command.mode === 'resume' && port !== command.oldPort
    const env = workerProcessEnv({ threads: policy.budget.threads, memGb: policy.budget.memGb,
      host: policy.host, model: policy.model, effort: policy.effort, port, server: policy.server,
      room: s.roomName, dir: policy.dir, tag, lead: policy.lead, owner: policy.owner,
      share: policy.share, gen: policy.gen, id, token: policy.token, logDir: s.dir, isWorker: policy.isWorker })
    const niceEnv = command.mode === 'resume'
      ? { ...process.env, ROOM_WORKER_NICE: String(policy.budget.nice) }
      : process.env
    const scheduling = workerPriority({ cmd: policy.host, args: [] }, niceEnv)
    const prompt = command.mode === 'fresh'
      ? workerPrompt(policy.lead, tag, command.task, { threads: policy.budget.threads,
        memGb: Number(env.ROOM_WORKER_MEM_GB), nice: scheduling.nice, effort: policy.effort,
        link: command.links, carriedPaths: command.carriedPaths, port })
      : portChanged ? `${command.message}\n\nYour dev-server port is ${port} (PORT=${port}).` : command.message
    let maxBudgetUsd: string | undefined
    try { maxBudgetUsd = workerMaxBudget() }
    catch (e) { throw new WorkerLaunchError('budget', String(e instanceof Error ? e.message : e)) }
    const built = workerCommand(policy.host, policy.model, prompt, policy.claudeChannel,
      policy.effort, { tag, sessionId: command.sessionId, resume: command.mode === 'resume',
        maxBudgetUsd, wakeChannels: process.env.ROOM_WAKE === 'channels' })
    const priority = workerPriority(built, niceEnv)
    const logFile = path.join(s.dir, '.room', 'workers', `${tag}.log`)
    if (toolCallAborted()) throw new WorkerLaunchError('cancelled', 'tool call cancelled')
    let proc: SpawnedProcess
    try { proc = (policy.spawner ?? defaultSpawner)({ cmd: priority.cmd, args: priority.args,
      cwd: policy.dir, env, logFile, captureCodexSession: policy.host === 'codex' }) }
    catch (e) { throw new WorkerLaunchError('start', String(e instanceof Error ? e.message : e)) }
    bindWorkerPortReservation(proc, reservation)
    passed = true
    rooms.setHandle(s, id, proc)
    const result = { proc, port, env, nice: priority.nice, logFile, portChanged, startedAt: (policy.at ?? Date.now)() }
    if (!onStarted(result)) {
      rooms.dropHandle(s, id, proc)
      try { proc.kill() } catch (e) { policy.log(`worker launch: could not stop stale ${tag}: ${e}`) }
      throw new WorkerLaunchError('stale', `${tag} changed during launch; attempted to stop the new process`)
    }
    if (policy.host === 'codex') proc.onSessionId?.(sessionId => onSessionId?.(sessionId, proc))
    rooms.watchWorkerProcess(s, id, proc, command.mode === 'resume' ? `could not resume ${tag}` : `could not start ${built.cmd}`, policy.log, policy.at)
    lease.release()
    return result
  } finally {
    if (!passed) reservation?.release()
  }
}
