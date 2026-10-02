/** Worker host processes, logs, identity, and termination. */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { LocalWorker } from './worker-status.js'
import { workerEnv } from './worker-config.js'

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
  onExit(cb: (code: number | null) => void): void
  /** Fires when the process could not be started at all (e.g. the binary is missing). */
  onError?(cb: (err: Error) => void): void
  /** SIGTERM the worker; true when a signal was actually delivered (false: no pid, or the process is gone). */
  kill(): boolean
  /** SIGKILL the same child after SIGTERM's grace period. */
  killForce?(): boolean
}
/** Injectable for tests: how a worker process is started. */
export type Spawner = (spec: SpawnSpec) => SpawnedProcess

interface HostEvent {
  type?: string; subtype?: string; session_id?: string; thread_id?: string
  result?: unknown; message?: { content?: unknown } | string; item?: { type?: string; text?: unknown }
  /** Codex: `{ message }` on turn.failed (null on tool items). Claude: an assistant message's API error category. */
  error?: { message?: unknown } | string | null; is_error?: boolean
  is_api_error_message?: boolean; api_error_status?: unknown; errors?: unknown
  num_turns?: number
  task_id?: unknown; task_type?: unknown; is_backgrounded?: unknown; patch?: { status?: unknown }
  tool_use_result?: { backgroundTaskId?: unknown }
}

/** Read complete JSON lines from one run, starting at its byte offset in the shared log. */
function* hostEvents(file: string, start = 0): Generator<HostEvent> {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    let offset = Math.max(0, Math.min(start, size)), pending = ''
    const chunk = Buffer.alloc(64 * 1024)
    while (offset < size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset)
      if (!count) break
      offset += count
      pending += chunk.toString('utf8', 0, count)
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        if (!line.startsWith('{')) continue
        try { yield JSON.parse(line) as HostEvent } catch { /* stderr or a partial line */ }
      }
      if (pending.length > 1024 * 1024) pending = ''
    }
  } catch { /* unavailable logs provide no acceptance evidence */ }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

function assistantText(event: HostEvent): string {
  const content = typeof event.message === 'object' ? event.message?.content : undefined
  if (!Array.isArray(content)) return ''
  return content.filter((part): part is { type: string; text: string } => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n').trim()
}

/** A prompt receipt requires model activity in this retained session's resume run. */
export function resumeAccepted(file: string, host: 'claude' | 'codex', hostSessionId: string, logStart: number): boolean {
  let codexThread: string | undefined
  for (const event of hostEvents(file, logStart)) {
    if (host === 'claude' && event.type === 'assistant' && event.session_id === hostSessionId) return true
    if (host === 'codex') {
      if (event.type === 'thread.started') codexThread = event.thread_id
      if (event.type === 'turn.started' && (event.thread_id ?? codexThread) === hostSessionId) return true
    }
  }
  return false
}

export function missingClaudeSession(file: string, hostSessionId: string, logStart: number): boolean {
  let missing = false
  for (const event of hostEvents(file, logStart)) {
    if (event.type === 'assistant' && event.session_id === hostSessionId) return false
    if (event.type === 'result' && event.session_id === hostSessionId
      && event.subtype === 'error_during_execution' && event.is_error === true && event.num_turns === 0) missing = true
  }
  return missing
}

/** Final answer from this run; Claude result wins over interim assistant text. */
export function followUpAnswer(file: string, host: 'claude' | 'codex', logStart: number): string {
  let assistant = '', result = ''
  for (const event of hostEvents(file, logStart)) {
    if (host === 'claude') {
      if (event.type === 'assistant') assistant = assistantText(event) || assistant
      if (event.type === 'result' && typeof event.result === 'string') result = event.result.trim()
    } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      assistant = event.item.text.trim()
    }
  }
  return result || assistant
}

/** The run's last 64 KB at most, ANSI-free, even for multi-GB logs; throws when the log is unreadable. */
function runLogSuffix(logFile: string, logStart: number): string[] {
  const fd = fs.openSync(logFile, 'r')
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(Math.min(size, logStart), size - 64 * 1024, 0)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    return stripVTControlCharacters(buffer.toString('utf8')).split(/\r?\n|\r/)
  } finally { fs.closeSync(fd) }
}

const errorMessage = (event: HostEvent): string | undefined =>
  event.error && typeof event.error === 'object' && typeof event.error.message === 'string' ? event.error.message : undefined

/** Five non-empty lines of the run's log suffix, host events reduced to their text. */
export function workerLogTail(logFile: string, logStart = 0): string {
  try {
    return runLogSuffix(logFile, logStart).map(l => {
      const line = l.trim()
      if (!line.startsWith('{')) return line
      try {
        const event = JSON.parse(line) as HostEvent
        if (event.type === 'assistant') return assistantText(event)
        if (event.type === 'result') return typeof event.result === 'string' ? event.result.trim() : ''
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') return event.item.text.trim()
        if (errorMessage(event)) return errorMessage(event)!.trim()
        return typeof event.message === 'string' ? event.message.trim() : ''
      } catch { return '' }
    }).filter(Boolean).slice(-5).join('\n').slice(-600)
  } catch { return '(log unavailable)' }
}

/** The host's own account of why a run failed; `transient` when a retry later can succeed. */
export interface HostFailure { text: string; transient?: 'model capacity' | 'rate limit' }

// Codex: "Selected model is at capacity"; Claude: 529 overloaded, "experiencing high load" (errors.md).
const CAPACITY = /at capacity|overloaded|\b529\b|high load/i
const RATE_LIMIT = /rate.?limit|\b429\b|too many requests|temporarily limiting/i
// A spend or plan limit also arrives as a 429 but does not clear on a retry.
const LIMIT_REACHED = /spend limit|usage limit|credit balance|hit your .*limit|insufficient.?quota/i

function transience(text: string, status: unknown, category: unknown): HostFailure['transient'] {
  if (LIMIT_REACHED.test(text)) return undefined
  if (category === 'overloaded' || status === 529 || CAPACITY.test(text)) return 'model capacity'
  if (category === 'rate_limit' || status === 429 || RATE_LIMIT.test(text)) return 'rate limit'
  return undefined
}

/**
 * The run's last host error: Codex `turn.failed` (else its last `error` event), Claude's `is_error` result
 * (else its last API error message). Undefined when the host reported none; stderr lines are never read as one.
 */
export function hostFailure(logFile: string, host: 'claude' | 'codex', logStart = 0): HostFailure | undefined {
  let lines: string[]
  try { lines = runLogSuffix(logFile, logStart) } catch { return undefined }
  let failed: string | undefined, error: string | undefined, status: unknown, category: unknown
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let event: HostEvent
    try { event = JSON.parse(line) as HostEvent } catch { continue }
    if (host === 'codex') {
      if (event.type === 'turn.failed' && errorMessage(event)) failed = errorMessage(event)
      else if (event.type === 'error' && typeof event.message === 'string') error = event.message
      else if (event.type === 'turn.completed') failed = error = undefined
    } else if (event.type === 'assistant' && (event.is_api_error_message === true || typeof event.error === 'string')) {
      error = assistantText(event) || (typeof event.error === 'string' ? event.error : undefined)
      category = event.error
    } else if (event.type === 'result') {
      if (event.is_error !== true) { failed = error = undefined; continue }
      const errors = Array.isArray(event.errors) ? event.errors.filter((e): e is string => typeof e === 'string' && !!e.trim()) : []
      failed = (typeof event.result === 'string' && event.result.trim()) || errors.join('; ') || event.subtype || 'error result'
      status = event.api_error_status
    }
  }
  const text = (failed ?? error)?.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  const transient = transience(text, status, category)
  return transient ? { text, transient } : { text }
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

const UNFINISHED_TASK_STATUSES = new Set(['running', 'pending'])

/**
 * Background shell tasks this run started and never awaited: `claude -p` kills them when the turn
 * ends. A backgrounded `local_bash` task counts when it had no terminal event before the run's last
 * result, or none at all. Foreground tasks, subagents and monitors (the host awaits those) and tasks
 * stopped before the result do not. Reads at most the last 16 MB of the run. Codex logs carry no
 * task events, so they count nothing.
 */
export function unawaitedBackgroundTasks(logFile: string, logStart: number, host: 'claude' | 'codex'): number {
  if (host !== 'claude') return 0
  let size: number
  try { size = fs.statSync(logFile).size } catch { return 0 }
  const kinds = new Map<string, unknown>(), backgrounded = new Set<string>(), open = new Set<string>()
  let atResult: Set<string> | undefined
  for (const event of hostEvents(logFile, Math.max(logStart, size - 16 * 1024 * 1024))) {
    const id = typeof event.task_id === 'string' ? event.task_id : undefined
    if (event.type === 'result') atResult = new Set(open)
    else if (event.type === 'user' && typeof event.tool_use_result?.backgroundTaskId === 'string') {
      backgrounded.add(event.tool_use_result.backgroundTaskId)
    } else if (event.type === 'system' && id) {
      if (event.subtype === 'task_started') {
        kinds.set(id, event.task_type)
        if (event.is_backgrounded === true) backgrounded.add(id)
        open.add(id)
      } else if (event.subtype === 'task_notification'
        || event.subtype === 'task_updated' && typeof event.patch?.status === 'string' && !UNFINISHED_TASK_STATUSES.has(event.patch.status)) {
        open.delete(id)
      }
    }
  }
  const killed = new Set([...atResult ?? [], ...open])
  return [...killed].filter(id => backgrounded.has(id) && kinds.get(id) === 'local_bash').length
}

/** Signal only the worker host pid. Its group may also contain processes outside the worktree. */
export function signalWorker(pid: number, signal: NodeJS.Signals = 'SIGTERM', worktreeDir?: string, list: CwdProcessLister = listCwdProcesses, worker?: Parameters<typeof pidIsOurWorker>[1], probe?: (pid: number) => ProcessInfo | undefined): boolean {
  if (!pid || pid <= 0 || pid === process.pid || pid === process.ppid) return false
  if (worker && !pidIsOurWorker(pid, worker, probe)) return false
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

export { pidAlive, parsePsLstartUtc, probeProcess, type ProcessInfo, type ProcessProbe } from '@room/relay/process'
import { pidAlive, probeProcess, sameStartTime, type ProcessInfo, type ProcessProbe } from '@room/relay/process'

export function pidPresent(pid: number, probe: ProcessProbe = probeProcess): boolean {
  return pid > 0 && probe(pid) !== undefined
}

type WorkerIdentity = Pick<LocalWorker, 'processStartTime' | 'host'>
export type ProcessOwnership = 'ours' | 'not-ours' | 'unknown'

export function workerProcessOwnership(pid: number, w: WorkerIdentity, probe: ProcessProbe = probeProcess): ProcessOwnership {
  if (!pid || pid <= 0) return 'not-ours'
  const info = probe(pid)
  if (!info) return 'not-ours'
  if (!w.processStartTime) return 'unknown'
  if (!info?.startTime || !info.executable) return 'unknown'
  if (!sameStartTime(info.startTime, w.processStartTime)) return 'not-ours'
  const executable = path.basename(info.executable)
  return executable === w.host || executable === 'node' ? 'ours' : 'not-ours'
}

export function pidIsOurWorker(pid: number, w: WorkerIdentity, probe: ProcessProbe = probeProcess): boolean {
  return workerProcessOwnership(pid, w, probe) === 'ours'
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
export async function quiesceWorktreeProcesses(dir: string): Promise<boolean> {
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
