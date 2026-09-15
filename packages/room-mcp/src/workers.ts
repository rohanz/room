/**
 * Workers: agents a lead dispatches into its own room (room_spawn). Each worker runs in a
 * git worktree of the lead's repo (`<repo>/.room/workers/<tag>`, branch `room/<tag>`), joins
 * the lead's room as `<owner>+<tag>`, and reports back with room_done, which reaches the lead
 * as an addressed `done` message. The doc's `workers` map is the ledger of who was spawned.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Worker } from '@room/shared'
import { git } from '@room/roomd/git'

export type WorkerHost = 'claude' | 'codex'

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
  onExit(cb: (code: number | null) => void): void
  /** Fires when the process could not be started at all (e.g. the binary is missing). */
  onError?(cb: (err: Error) => void): void
  /** SIGTERM the worker; true when a signal was actually delivered (false: no pid, or the process is gone). */
  kill(): boolean
}
/** Injectable for tests: how a worker process is started. */
export type Spawner = (spec: SpawnSpec) => SpawnedProcess

export const WORKERS_DIR = path.join('.room', 'workers')
export const DEFAULT_MAX_WORKERS = 8

export function validTag(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined
  const t = tag.trim()
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(t) ? t : undefined
}

/** The fixed preamble every worker gets, then the task. */
export function workerPrompt(lead: string, tag: string, task: string): string {
  return [
    `You are worker "${tag}", dispatched by ${lead} into the room for this repo. Follow the room-etiquette skill:`,
    `room_scope first, claim before editing, ask ${lead} with room_send(type "question", to "${lead}") when unsure,`,
    `if a room_wait for an answer times out, wait again (up to three times) before deciding on your own, and say what you assumed; room_preview_merge before finishing, and room_done with a one-paragraph summary when finished.`,
    `Do not commit or push unless the task says so. You are on your own git worktree and branch; the lead merges.`,
    '',
    `TASK: ${task}`,
  ].join('\n')
}

export function workerCommand(host: WorkerHost, model: string | undefined, prompt: string): { cmd: string; args: string[] } {
  if (host === 'codex') return { cmd: 'codex', args: ['exec', '-s', 'workspace-write', ...(model ? ['-m', model] : []), prompt] }
  return {
    cmd: 'claude',
    args: ['-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__room__*,mcp__plugin_room_room__*,Edit,Write,Read,Bash,Glob,Grep', ...(model ? ['--model', model] : [])],
  }
}

/** A worktree for the worker, created from the lead's HEAD on branch room/<tag>; reused if it already exists. */
export async function prepareWorktree(repoDir: string, tag: string): Promise<{ dir: string; branch: string; created: boolean }> {
  const dir = path.join(repoDir, WORKERS_DIR, tag)
  const branch = `room/${tag}`
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, branch, created: false }
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  let hasBranch = false
  try { await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); hasBranch = true } catch { /* new branch */ }
  await git(repoDir, hasBranch ? ['worktree', 'add', '-q', dir, branch] : ['worktree', 'add', '-q', '-b', branch, dir, 'HEAD'])
  return { dir, branch, created: true }
}

/**
 * Room variables the lead's own process may carry that must never reach a worker: the runner's
 * ROOM_URL/ROOM_NAME/ROOM_DIR would send it into the lead's room under the lead's name, and the
 * lead's token, share level, tag or generation are the lead's, not the worker's. room_spawn sets
 * every variable a worker needs explicitly (ROOM_SERVER, ROOM_ROOM, ROOM_DIR, ROOM_TAG, ROOM_LEAD,
 * ROOM_OWNER, ROOM_SHARE, ROOM_GEN, ROOM_LOG_FILE and, when the lead joined with one, ROOM_TOKEN).
 */
export const LEAD_ONLY_ENV = ['ROOM_URL', 'ROOM_NAME', 'ROOM_DIR', 'ROOM_SERVER', 'ROOM_ROOM', 'ROOM_TAG', 'ROOM_LEAD', 'ROOM_OWNER', 'ROOM_SHARE', 'ROOM_TOKEN', 'ROOM_GEN', 'ROOM_WORKER_ID', 'ROOM_LOG_FILE', 'ROOM_KIND'] as const
/** The environment a worker process starts with: the lead's, minus LEAD_ONLY_ENV, plus the spec's variables. */
export function workerEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !(LEAD_ONLY_ENV as readonly string[]).includes(k)) out[k] = v
  return { ...out, ...extra }
}

/** SIGTERM a pid's process group, else the pid itself; true when either signal was delivered. */
export function signalWorker(pid: number): boolean {
  // Only ever signal a real pid: kill(-0) would hit our own process group.
  if (!pid || pid <= 0) return false
  try { process.kill(-pid, 'SIGTERM'); return true } catch { /* not a group leader, or gone */ }
  try { process.kill(pid, 'SIGTERM'); return true } catch { return false }
}

export const defaultSpawner: Spawner = spec => {
  fs.mkdirSync(path.dirname(spec.logFile), { recursive: true })
  const fd = fs.openSync(spec.logFile, 'a')
  const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: workerEnv(process.env, spec.env), detached: true, stdio: ['ignore', fd, fd] })
  child.unref()
  return {
    pid: child.pid ?? -1,
    onExit: cb => { child.once('exit', code => { try { fs.closeSync(fd) } catch { /* closed */ } cb(code) }) },
    onError: cb => { child.once('error', err => { try { fs.closeSync(fd) } catch { /* closed */ } cb(err) }) },
    kill: () => signalWorker(child.pid ?? -1),
  }
}

export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export interface ProcessInfo { start?: number; command?: string }
/** What `ps` knows about a pid: start time (ms since epoch) and command line; undefined when unknown. */
export function probeProcess(pid: number): ProcessInfo | undefined {
  if (!pid || pid <= 0) return undefined
  try {
    const start = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim()
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim()
    const t = Date.parse(start)
    return { ...(Number.isFinite(t) ? { start: t } : {}), ...(command ? { command } : {}) }
  } catch { return undefined }
}

/**
 * May this session signal `pid` as this worker? Only when it is alive, started within 5 s of the recorded
 * spawn, and its command line is a claude/codex invocation mentioning the worker's tag or worktree.
 * A recycled pid after a lead restart fails at least one of these.
 */
export function pidIsOurWorker(pid: number, w: { startedAt: number; tag: string; dir: string }, probe: (pid: number) => ProcessInfo | undefined = probeProcess): boolean {
  if (!pidAlive(pid)) return false
  const info = probe(pid)
  if (!info?.start || !info.command) return false
  if (Math.abs(info.start - w.startedAt) > 5000) return false
  if (!/(^|[\s/])(claude|codex)(\s|$)/.test(info.command)) return false
  return info.command.includes(w.tag) || info.command.includes(w.dir)
}

/** One line per worker of this lead, for room_state. */
export function workerLines(workers: Worker[], lastLineFrom: (name: string) => string | undefined, changedCount: (name: string) => number, now = Date.now()): string[] {
  if (!workers.length) return []
  const out = [`workers (${workers.length}):`]
  for (const w of workers.sort((a, b) => a.startedAt - b.startedAt)) {
    const age = Math.max(0, Math.round((now - w.startedAt) / 60000))
    const alive = w.status === 'running' ? (pidAlive(w.pid) ? '' : ' (process gone)') : ''
    const last = lastLineFrom(w.name)
    out.push(`  - ${w.tag} (${w.host}${w.model ? ` ${w.model}` : ''}, ${w.status}${alive}, ${age}m): ${w.task.slice(0, 80)}${w.task.length > 80 ? '…' : ''}`)
    out.push(`      ${changedCount(w.name)} changed file(s) · branch ${w.branch}${w.summary ? ` · ${w.summary.slice(0, 120)}` : ''}${last ? ` · last: ${last.slice(0, 100)}` : ''}`)
  }
  return out
}
