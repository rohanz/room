/** Worker host processes, logs, identity, and termination. */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { Worker } from '@room/shared'
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

/** Read a bounded suffix even for multi-GB logs, then take five non-empty, ANSI-free lines. */
export function workerLogTail(logFile: string): string {
  let fd: number | undefined
  try {
    fd = fs.openSync(logFile, 'r')
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 64 * 1024)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    const text = stripVTControlCharacters(buffer.toString('utf8'))
    return text.split(/\r?\n|\r/).map(l => {
      const line = l.trim()
      if (!line.startsWith('{')) return line
      try {
        const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: unknown }; error?: { message?: unknown }; message?: unknown }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') return event.item.text.trim()
        if (typeof event.error?.message === 'string') return event.error.message.trim()
        return typeof event.message === 'string' ? event.message.trim() : ''
      } catch { return line }
    }).filter(Boolean).slice(-5).join('\n').slice(-600)
  } catch { return '(log unavailable)' }
  finally { if (fd !== undefined) fs.closeSync(fd) }
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

export { pidAlive, parsePsLstartUtc, probeProcess, type ProcessInfo, type ProcessProbe, type ProcessReaders } from '@room/relay/process'
import { pidAlive, probeProcess, type ProcessInfo, type ProcessProbe } from '@room/relay/process'

export function pidPresent(pid: number, probe: ProcessProbe = probeProcess): boolean {
  return pid > 0 && probe(pid) !== undefined
}

type WorkerIdentity = Pick<Worker, 'processStartTime' | 'host'>
export type ProcessOwnership = 'ours' | 'not-ours' | 'unknown'

export function workerProcessOwnership(pid: number, w: WorkerIdentity, probe: ProcessProbe = probeProcess): ProcessOwnership {
  if (!pid || pid <= 0) return 'not-ours'
  const info = probe(pid)
  if (!info) return 'not-ours'
  if (!w.processStartTime) return 'unknown'
  if (!info?.startTime || !info.executable) return 'unknown'
  if (info.startTime !== w.processStartTime) return 'not-ours'
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
