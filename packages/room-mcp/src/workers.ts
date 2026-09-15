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
  kill(): void
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

export const defaultSpawner: Spawner = spec => {
  fs.mkdirSync(path.dirname(spec.logFile), { recursive: true })
  const fd = fs.openSync(spec.logFile, 'a')
  const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, detached: true, stdio: ['ignore', fd, fd] })
  child.unref()
  return {
    pid: child.pid ?? -1,
    onExit: cb => { child.once('exit', code => { try { fs.closeSync(fd) } catch { /* closed */ } cb(code) }) },
    onError: cb => { child.once('error', err => { try { fs.closeSync(fd) } catch { /* closed */ } cb(err) }) },
    // Only ever signal a real pid: kill(-0) would hit our own process group.
    kill: () => { const pid = child.pid; if (!pid || pid <= 0) return; try { process.kill(-pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* gone */ } } },
  }
}

export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** When a process started (ms since epoch), from `ps -o lstart=`; undefined when unknown. */
export function processStartTime(pid: number): number | undefined {
  if (!pid || pid <= 0) return undefined
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim()
    if (!out) return undefined
    const t = Date.parse(out)
    return Number.isFinite(t) ? t : undefined
  } catch { return undefined }
}

/** May this session signal `pid` as worker `startedAt`? Only when it is alive and started no earlier than the worker record (allowing clock slop). */
export function pidIsOurWorker(pid: number, startedAt: number): boolean {
  if (!pidAlive(pid)) return false
  const began = processStartTime(pid)
  if (began === undefined) return false
  return began >= startedAt - 5000
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
