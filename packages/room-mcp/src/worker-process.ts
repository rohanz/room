/** Worker host processes, logs, identity, and termination. */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { LocalWorker } from './worker-status.js'
import { workerEnv, type WorkerHost } from './worker-config.js'
import { readBackgroundTasks, readLogFailure, readLogTail, runLogFacts, runLogSuffix, type RunLogIdentity } from './run-log-facts.js'
import { missingClaudeLogSession as missingLogSession } from './hosts/lifecycle.js'
import type { NormalizedHostFailure } from './hosts/types.js'

export interface SpawnSpec {
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string>
  logFile: string
}
export interface SpawnedProcess {
  /** -1 when the process could not be started (see onError). */
  pid: number
  /** Resolves on child_process 'spawn'; rejects on 'error'. */
  started: Promise<void>
  /**
   * Node's 'close' arguments: the exit code, or the signal that ended the child. The callback may return the
   * promise of its exit handling; a spawner that can wait for it (tests) awaits that.
   */
  onExit(cb: (code: number | null, signal?: NodeJS.Signals | null) => void | Promise<void>): void
  /** Fires when the process could not be started at all (e.g. the binary is missing). */
  onError?(cb: (err: Error) => void): void
  /** SIGTERM the worker; true when a signal was actually delivered (false: no pid, or the process is gone). */
  kill(): boolean
  /** SIGKILL the same child after SIGTERM's grace period. */
  killForce?(): boolean
  /** Check the retained child handle, not a newly looked-up PID (important for Windows PID reuse). */
  isRunning?(): boolean
}
/** Injectable for tests: how a worker process is started. */
export type Spawner = (spec: SpawnSpec) => SpawnedProcess

/** A prompt receipt requires model activity in this retained session's resume run. */
export function resumeAccepted(file: string, host: WorkerHost, hostSessionId: string, logStart: number, identity?: RunLogIdentity): boolean {
  const facts = runLogFacts(file, logStart, identity)
  return facts.get(host)!.acceptedSessions.has(hostSessionId)
}

export function missingClaudeSession(file: string, hostSessionId: string, logStart: number): boolean {
  return missingLogSession(file, hostSessionId, logStart)
}

/** Final answer from this run; Claude result wins over interim assistant text. */
export function followUpAnswer(file: string, host: WorkerHost, logStart: number, identity?: RunLogIdentity): string {
  const facts = runLogFacts(file, logStart, identity).get(host)!
  return facts.preferredText || facts.fallbackText
}

/**
 * Why the worker's own Room MCP stopped ("stdin closed", "SIGTERM", …), from its last `stopping:` line in its
 * ROOM_LOG_FILE that is no older than `since`. Room writes that log itself; undefined when it has no such line.
 */
export function mcpStopReason(mcpLogFile: string, since: number): string | undefined {
  let lines: string[]
  try { lines = runLogSuffix(mcpLogFile, 0) } catch { return undefined }
  for (const line of lines.reverse()) {
    const match = /^(\S+) stopping: (.+)$/.exec(line.trim())
    if (match && Date.parse(match[1]) >= since) return match[2]
  }
  return undefined
}

/**
 * The model's last words in this run: up to five non-empty texts from parsed host events (Claude `assistant` and
 * `result`, Codex `agent_message` items), capped at 600 characters. Plain lines are never returned: the log also
 * holds stderr and command output, and this text can reach room messages through a no-report summary.
 * '' when the run has no such event or the log cannot be read.
 */
export function workerLogTail(logFile: string, logStart = 0, identity?: RunLogIdentity): string {
  return readLogTail(logFile, logStart, identity)
}

/** The host's own account of why a run failed; `transient` when a retry later can succeed. */
export type HostFailure = NormalizedHostFailure

/**
 * The run's last host error: Codex `turn.failed` (else its last `error` event), Claude's `is_error` result
 * (else its last API error message). Undefined when the host reported none; stderr lines are never read as one.
 */
export function hostFailure(logFile: string, host: WorkerHost, logStart = 0, identity?: RunLogIdentity): HostFailure | undefined {
  return readLogFailure(logFile, host, logStart, identity)
}

const FAILURE_TEXT_MAX = 300

/** One line for the lead: the host's error and, when transient, how to retry it. */
export function hostFailureLine(failure: HostFailure, host: 'claude' | 'codex', resumable: boolean): string {
  const text = failure.text.replace(/\s+/g, ' ').trim()
  const clipped = text.length > FAILURE_TEXT_MAX ? `${text.slice(0, FAILURE_TEXT_MAX - 1)}…` : text
  if (!failure.transient) return `${host}: ${clipped}`
  const retry = resumable ? 'room_send it to resume, or respawn it, to retry' : 'respawn it with dir= its worktree to retry and keep its edits'
  return `${host}: ${clipped} (transient ${failure.transient}: ${retry})`
}

/**
 * Background shell tasks this run started and never awaited: `claude -p` kills them when the turn
 * ends. A backgrounded `local_bash` task counts when it had no terminal event before the run's last
 * result, or none at all. Foreground tasks, subagents and monitors (the host awaits those) and tasks
 * stopped before the result do not. Reads at most the last 16 MB of the run. Codex logs carry no
 * task events, so they count nothing.
 */
export function unawaitedBackgroundTasks(logFile: string, logStart: number, host: WorkerHost, identity?: RunLogIdentity): number {
  const evidence = readBackgroundTasks(logFile, logStart, host, identity)
  return evidence.kind === 'observed' ? evidence.count : 0
}

/**
 * Signal only the worker host pid. Its group may also contain processes outside the worktree. Ownership is read
 * afresh: the shared probe may hold an exited worker's identity for a pid already reused.
 */
export function signalWorker(pid: number, signal: NodeJS.Signals = 'SIGTERM', worktreeDir?: string, list: CwdProcessLister = listCwdProcesses, worker?: Parameters<typeof pidIsOurWorker>[1], probe?: (pid: number) => ProcessInfo | undefined): boolean {
  if (!pid || pid <= 0 || pid === process.pid || pid === process.ppid) return false
  if (worker && !pidIsOurWorker(pid, worker, probe && probe !== probeProcess ? probe : probeProcessNow)) return false
  if (worktreeDir && !pidHasWorkerCwd(pid, worktreeDir, list)) return false
  try { process.kill(pid, signal); return true } catch { return false }
}

export const defaultSpawner: Spawner = spec => {
  fs.mkdirSync(path.dirname(spec.logFile), { recursive: true })
  const fd = fs.openSync(spec.logFile, 'a')
  let child: ReturnType<typeof spawn>
  try { child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: workerEnv(process.env, spec.env), detached: true, stdio: ['ignore', fd, fd] }) }
  catch (error) { fs.closeSync(fd); throw error }
  const closeLog = () => { try { fs.closeSync(fd) } catch { /* closed */ } }
  child.once('close', closeLog)
  child.once('error', closeLog)
  // Node emits exactly one of 'spawn' or 'error' for every child, so no timer is needed; a timer
  // would kill a healthy worker whenever this event loop is busy for longer than its bound.
  const started = new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      child.off('spawn', onSpawn)
      child.off('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onSpawn = () => done()
    const onError = (error: Error) => done(error)
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
  child.unref()
  return {
    pid: child.pid ?? -1,
    started,
    onExit: cb => { child.once('close', cb) },
    onError: cb => { child.once('error', cb) },
    kill: () => { try { return child.kill('SIGTERM') } catch { return false } },
    killForce: () => { try { return child.kill('SIGKILL') } catch { return false } },
    isRunning: () => {
      if (process.platform !== 'win32') return child.exitCode === null && child.signalCode === null
      // libuv's Windows signal 0 checks the retained HANDLE, even while JS exit
      // callbacks are queued behind a synchronous CIM query. Do not use child.killed.
      try { return child.kill(0) } catch { return false }
    },
  }
}

/** Shared bounded host stop: TERM, five seconds to exit, KILL, five seconds to exit. */
export async function stopWorkerWithEscalation(options: {
  terminate(): boolean | Promise<boolean>
  exited(): boolean
  force(): boolean | Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<boolean> {
  if (!await options.terminate()) return false
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const wait = async () => {
    const deadline = now() + 5_000
    while (!options.exited() && now() < deadline) await sleep(50)
    return options.exited()
  }
  if (await wait()) return true
  await options.force()
  return wait()
}

export { pidAlive, parsePsLstartUtc, probeOwnProcess, probeProcess, probeProcessNow, type ProcessInfo, type ProcessProbe } from '@room/local-state/process'
import { pidAlive, probeProcess, probeProcessConfirm, probeProcessNow, sameStartTime, windowsProcessName, type ProcessInfo, type ProcessProbe } from '@room/local-state/process'

export function pidPresent(pid: number, probe: ProcessProbe = probeProcess): boolean {
  return pid > 0 && probe(pid) !== undefined
}

type WorkerIdentity = Pick<LocalWorker, 'processStartTime' | 'host'>
export type ProcessOwnership = 'ours' | 'not-ours' | 'unknown'

/**
 * "Not ours" from the shared probe on a live pid is confirmed afresh (once per worker start, see
 * CachedProcessProbe.confirm): the cache may hold a predecessor's identity for a reused pid. A vanished pid needs no
 * confirmation.
 */
export function workerProcessOwnership(pid: number, w: WorkerIdentity, probe: ProcessProbe = probeProcess): ProcessOwnership {
  const verdict = ownershipBy(pid, w, probe)
  return verdict === 'not-ours' && probe === probeProcess && pidAlive(pid)
    ? ownershipBy(pid, w, p => probeProcessConfirm(p, { startTime: w.processStartTime })) : verdict
}

function ownershipBy(pid: number, w: WorkerIdentity, probe: ProcessProbe): ProcessOwnership {
  if (!pid || pid <= 0) return 'not-ours'
  const info = probe(pid)
  if (!info) return 'not-ours'
  if (!w.processStartTime) return 'unknown'
  if (!info?.startTime || !info.executable) return 'unknown'
  if (!sameStartTime(info.startTime, w.processStartTime)) return 'not-ours'
  const executable = info.startTime.startsWith('windows:') ? windowsProcessName(info.executable) : path.basename(info.executable)
  return executable === w.host || executable === 'node' ? 'ours' : 'not-ours'
}

export function pidIsOurWorker(pid: number, w: WorkerIdentity, probe: ProcessProbe = probeProcess): boolean {
  return workerProcessOwnership(pid, w, probe) === 'ours'
}

/** Ours, or a live pid whose identity the shared probe is still reading (Windows): an unread identity is not an exit. */
export function workerProcessLive(pid: number, w: WorkerIdentity, probe: ProcessProbe = probeProcess): boolean {
  return pidIsOurWorker(pid, w, probe) || probe(pid)?.pending === true
}

interface CwdProcess { pid: number; cwd: string; command: string }
export type CwdProcessLister = () => CwdProcess[]

function pidHasWorkerCwd(pid: number, dir: string, list: CwdProcessLister = listCwdProcesses): boolean {
  const resolved = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
  const root = resolved(dir)
  return list().some(p => p.pid === pid && (resolved(p.cwd) === root || resolved(p.cwd).startsWith(root + path.sep)))
}

function processName(pid: number): string {
  try { return path.basename(execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000,
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } }).trim()) || 'process' }
  catch { return 'process' }
}

/** List processes by cwd. No process group is inferred: a dev server may have reparented itself. */
function listCwdProcesses(platform: NodeJS.Platform = process.platform): CwdProcess[] {
  const result: CwdProcess[] = []
  if (platform === 'linux') {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      const pid = Number(entry)
      try {
        const cwd = fs.realpathSync(`/proc/${pid}/cwd`)
        result.push({ pid, cwd, command: '' })
      } catch { /* process exited or is inaccessible */ }
    }
  } else if (platform === 'darwin') {
    const output = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    let pid = 0
    for (const line of output.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1))
      else if (line.startsWith('n') && pid > 0) result.push({ pid, cwd: line.slice(1), command: '' })
    }
  } else {
    throw new Error(`worktree process inspection is unsupported on ${platform}; worktree retained`)
  }
  return result
}

/** Signal only a process with a cwd at or below the resolved worktree root. */
export async function terminateWorktreeProcesses(dir: string, options: {
  list?: CwdProcessLister
  signal?: (pid: number, signal: NodeJS.Signals) => void
  probe?: ProcessProbe
  sleep?: (ms: number) => Promise<void>
  protectedPids?: number[]
} = {}): Promise<string[]> {
  const root = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir)
  const protectedPids = new Set([process.pid, process.ppid, ...(options.protectedPids ?? [])])
  const signal = options.signal ?? ((pid, sig) => process.kill(pid, sig))
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const resolved = (cwd: string) => { try { return fs.realpathSync(cwd) } catch { return path.resolve(cwd) } }
  const list = options.list ?? listCwdProcesses
  const insideWorktree = (p: CwdProcess) => {
    const cwd = resolved(p.cwd)
    return p.pid > 0 && !protectedPids.has(p.pid) && (cwd === root || cwd.startsWith(root + path.sep))
  }
  const targets = list().filter(insideWorktree)
  if (!targets.length) return []
  const beforeTerm = new Set(list().filter(insideWorktree).map(p => p.pid))
  const named: string[] = []
  for (const p of targets) {
    if (!beforeTerm.has(p.pid) || !pidPresent(p.pid, options.probe)) continue
    const name = p.command || processName(p.pid)
    try { signal(p.pid, 'SIGTERM'); named.push(`${name} (pid ${p.pid})`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  if (!named.length) return []
  await sleep(300)
  const stillInside = new Set(list().filter(insideWorktree).map(p => p.pid))
  for (const p of targets) if (stillInside.has(p.pid) && pidPresent(p.pid, options.probe)) {
    try { signal(p.pid, 'SIGKILL') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  return named
}

/** A discard snapshot is safe only after no process can keep writing in this worktree. */
export async function quiesceWorktreeProcesses(dir: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  // Windows has no supported cwd enumeration here. An empty table cannot establish quiescence.
  if (platform !== 'linux' && platform !== 'darwin') return false
  try {
    await terminateWorktreeProcesses(dir)
    const root = fs.realpathSync(dir)
    const inside = () => listCwdProcesses().some(p => {
      if (p.pid === process.pid || p.pid === process.ppid) return false
      let cwd: string
      try { cwd = fs.realpathSync(p.cwd) } catch { cwd = path.resolve(p.cwd) }
      return cwd === root || cwd.startsWith(root + path.sep)
    })
    const deadline = Date.now() + 5_000
    let quietSince: number | undefined
    while (Date.now() < deadline) {
      if (inside()) quietSince = undefined
      else if (quietSince === undefined) quietSince = Date.now()
      else if (Date.now() - quietSince >= 100) return true
      await new Promise<void>(resolve => setTimeout(resolve, 50))
    }
    return false
  } catch { return false }
}
