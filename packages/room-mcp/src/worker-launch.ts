/** Owns starting a worker process, fresh or resumed. Worktree preparation happens before this boundary. */
import path from 'node:path'
import type { Session } from './session.js'
import { processToken } from './names.js'
import { toolCallAborted } from './registry.js'
import { bindWorkerPortReservation, reserveWorkerPort } from './port-reservations.js'
import { defaultSpawner, probeProcess, stopWorkerWithEscalation, type ProcessInfo, type SpawnedProcess, type Spawner } from './worker-process.js'
import { workerCommand, workerMaxBudget, workerPriority, workerProcessEnv, workerPrompt, type WorkerHost } from './worker-config.js'

export class WorkerLaunchError extends Error {
  constructor(readonly phase: 'port' | 'budget' | 'start' | 'cancelled' | 'stale', message: string, readonly delivered = false, readonly pid?: number, readonly stopped = false) { super(message) }
}

export interface LaunchHost {
  setHandle(id: string, proc: SpawnedProcess): void
  watch(id: string, proc: SpawnedProcess, onExit: (code: number | null) => void): void
  aborted(): boolean
}

interface Policy {
  session: Session; id: string; tag: string; dir: string; lead: string; owner: string
  host: WorkerHost; model?: string; effort?: string; share: string; run: number; nonce: string; registry: string
  budget: { threads: number; memGb: number; nice?: number }
  server: string; isWorker: boolean; token?: string; claudeChannel?: string
  spawner?: Spawner; probe?: (pid: number) => ProcessInfo | undefined; log: (line: string) => void; at?: () => number
  usedPorts?: number[]; preferredPort?: number
}
type Command =
  | { mode: 'fresh'; task: string; links: string[]; carriedPaths?: string[]; sessionId?: string }
  | { mode: 'resume'; sessionId: string; followUp: string; oldPort?: number }

export interface WorkerLaunchResult {
  proc: SpawnedProcess; port: number; env: Record<string, string>; nice: number; logFile: string
  portChanged: boolean; startedAt: number
  processStartTime?: string
}

/**
 * Reserve the worker's name in the room it joins, before the launch, so nobody else takes it meanwhile
 * (registry §15 row 3). Without a reachable hub the worker acquires its name itself when it joins.
 */
async function reserveWorkerName(s: Session, name: string, workerId: string, log: (line: string) => void): Promise<number | undefined> {
  if (!s.hub || !s.lease) return undefined
  const token = processToken(s.lease.sessionId)
  try { return await s.hub.reserve(name, { sessionId: s.lease.sessionId, pid: token.pid, startTime: token.startTime, executable: token.executable, workerId }) }
  catch (e) { log(`could not reserve ${name} for the worker: ${e instanceof Error ? e.message : String(e)}`); return undefined }
}

/** The caller records the launch intent before entering this boundary. */
export async function launchWorkerProcess(policy: Policy, command: Command, host: LaunchHost,
  onLaunched: (pid: number) => Promise<void>, onSpawn: (result: WorkerLaunchResult) => Promise<void>,
  onExit: (code: number | null) => Promise<void>): Promise<WorkerLaunchResult> {
  const { session: s, id, tag } = policy
  let reservation: ReturnType<typeof reserveWorkerPort> | undefined
  let passed = false
  let delivered = false
  let owned = false
  let proc: SpawnedProcess | undefined
  let exited = false
  let watching = false
  let releaseReservation = true
  try {
    try { reservation = reserveWorkerPort(id, policy.usedPorts ?? [], undefined, policy.preferredPort) }
    catch (e) { throw new WorkerLaunchError('port', String(e instanceof Error ? e.message : e)) }
    const port = reservation.port
    const nameEpoch = await reserveWorkerName(s, `${policy.owner}+${tag}`, id, policy.log)
    const portChanged = command.mode === 'resume' && port !== command.oldPort
    const env = workerProcessEnv({ threads: policy.budget.threads, memGb: policy.budget.memGb,
      host: policy.host, model: policy.model, effort: policy.effort, port, server: policy.server,
      room: s.roomName, dir: policy.dir, tag, lead: policy.lead, owner: policy.owner,
      share: policy.share, run: policy.run, nonce: policy.nonce, registry: policy.registry,
      id, token: policy.token, logDir: s.dir, isWorker: policy.isWorker, nameEpoch })
    const niceEnv = command.mode === 'resume'
      ? { ...process.env, ROOM_WORKER_NICE: String(policy.budget.nice) }
      : process.env
    const scheduling = workerPriority({ cmd: policy.host, args: [] }, niceEnv)
    const prompt = command.mode === 'fresh'
      ? workerPrompt(policy.lead, tag, command.task, { threads: policy.budget.threads,
        memGb: Number(env.ROOM_WORKER_MEM_GB), nice: scheduling.nice, effort: policy.effort,
        link: command.links, carriedPaths: command.carriedPaths, port })
      : `${command.followUp}${portChanged ? `\n\nYour dev-server port is ${port} (PORT=${port}).` : ''}`
    let maxBudgetUsd: string | undefined
    try { maxBudgetUsd = workerMaxBudget() }
    catch (e) { throw new WorkerLaunchError('budget', String(e instanceof Error ? e.message : e)) }
    const built = workerCommand(policy.host, policy.model, prompt, policy.claudeChannel,
      policy.effort, { tag, sessionId: command.sessionId, resume: command.mode === 'resume',
        maxBudgetUsd, wakeChannels: process.env.ROOM_WAKE === 'channels' })
    const priority = workerPriority(built, niceEnv)
    const logFile = path.join(s.dir, '.room', 'workers', `${tag}.log`)
    if (host.aborted()) throw new WorkerLaunchError('cancelled', 'tool call cancelled')
    try { proc = (policy.spawner ?? defaultSpawner)({ cmd: priority.cmd, args: priority.args,
      cwd: policy.dir, env, logFile }) }
    catch (e) { throw new WorkerLaunchError('start', String(e instanceof Error ? e.message : e)) }
    // The child is ours from the instant spawn returns. A failed registry write is not
    // evidence that the process failed to start.
    owned = true
    releaseReservation = false
    if (proc.pid > 0) host.setHandle(id, proc)
    bindWorkerPortReservation(proc, reservation)
    host.watch(id, proc, code => { exited = true; void onExit(code).catch(error => policy.log(`worker exit: ${error}`)) })
    watching = true
    if (proc.pid > 0) await onLaunched(proc.pid)
    try { await proc.started }
    catch (e) { throw new WorkerLaunchError('start', String(e instanceof Error ? e.message : e)) }
    delivered = true
    passed = true
    const result = { proc, port, env, nice: priority.nice, logFile, portChanged,
      startedAt: (policy.at ?? Date.now)(), processStartTime: (policy.probe ?? probeProcess)(proc.pid)?.startTime }
    await onSpawn(result)
    if (host.aborted()) throw new WorkerLaunchError('cancelled', 'tool call cancelled', true)
    return result
  } catch (e) {
    let stopped = false
    if (owned && proc) {
      const launchedProc = proc
      // A persistence failure may precede the host's spawn/error event. Observe it
      // before deciding whether the child needs to be stopped.
      let started = false
      try { await launchedProc.started; started = true } catch { /* no host acceptance */ }
      delivered = started || launchedProc.pid > 0
      if (delivered) {
        try {
          if (watching) stopped = await stopWorkerWithEscalation({
            terminate: () => launchedProc.kill(), exited: () => exited,
            force: () => launchedProc.killForce?.() ?? false,
          })
          else launchedProc.kill() // No exit observer was installed; never report a confirmed stop.
        } catch (stopError) { policy.log(`worker launch: could not stop ${tag}: ${stopError}`) }
      }
      if (!delivered || stopped || exited) releaseReservation = true
    }
    if (e instanceof WorkerLaunchError) throw delivered ? new WorkerLaunchError(e.phase, e.message, true, proc?.pid, stopped) : e
    throw new WorkerLaunchError('start', String(e instanceof Error ? e.message : e), delivered, proc?.pid, stopped)
  } finally {
    if (!passed && releaseReservation) reservation?.release()
  }
}
