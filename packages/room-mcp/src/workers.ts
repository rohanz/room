/**
 * Workers: agents a lead dispatches into its own room (room_spawn). Each worker runs in a
 * git worktree of the lead's repo (`<repo>/.room/workers/<tag>`, branch `room/<tag>`), joins
 * the lead's room as `<owner>+<tag>`, and reports back with room_done, which reaches the lead
 * as an addressed `done` message. The doc's `workers` map is the ledger of who was spawned.
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { Worker, RetiredWorker } from '@room/shared'
import { git } from '@room/roomd/git'

import { DEFAULT_CLAUDE_CHANNEL } from './config.js'

export type WorkerHost = 'claude' | 'codex'

/** Inputs Room installed itself, rather than worker output. */
export function workerOwnedPaths(w?: Pick<Worker, 'link'>) {
  const paths = w?.link ?? []
  return {
    includes: (p: string) => paths.some(l => p === l || p.startsWith(l + '/')),
    exclusions: paths.map(l => ':(exclude,literal)' + l),
  }
}

const IGNORED_DEPENDENCY_DIRS = new Set(['node_modules', '.venv', 'venv', 'vendor', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.gradle', 'target'])

/** Ignored output that a discard patch cannot recover, excluding reproducible dependency/cache trees. */
export async function ignoredWorkerArtifacts(w: Worker): Promise<string[]> {
  const raw = await git(w.dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', '.', ...workerOwnedPaths(w).exclusions])
  return raw.split('\0').filter(Boolean)
    .filter(p => !p.split('/').some(part => IGNORED_DEPENDENCY_DIRS.has(part)))
    .sort()
}

export interface RetirementFacts {
  exited: boolean
  done: boolean
  dismissed: boolean
  merged: boolean
  clean: boolean
  ahead: number | undefined
  uncommitted?: number
}

/** One worktree cannot be collected, discarded and auto-retired at the same time. */
export function workerOperationKey(w: Pick<Worker, 'dir'>): string { return 'worker:' + path.resolve(w.dir) }

/** Explicit dismissal also retires failures, but never a process that is still running. */
export function shouldRetire(facts: RetirementFacts): RetiredWorker['outcome'] | undefined {
  if (!facts.exited) return undefined
  if (facts.dismissed) return 'dismissed'
  if (!facts.done) return undefined
  if (facts.clean === true && facts.ahead === 0) return facts.merged ? 'merged' : 'clean'
  return undefined
}

/** Unknown git state must never be mistaken for clean work. */
export async function workerGitFacts(leadDir: string, w: Worker): Promise<Pick<RetirementFacts, 'merged' | 'clean' | 'ahead' | 'uncommitted'>> {
  const facts: Pick<RetirementFacts, 'merged' | 'clean' | 'ahead' | 'uncommitted'> = { merged: false, clean: false, ahead: undefined }
  try {
    const status = await git(w.dir, ['status', '--porcelain', '--untracked-files=all', '--', '.', ...workerOwnedPaths(w).exclusions])
    facts.uncommitted = status.split('\n').filter(Boolean).length
    facts.clean = facts.uncommitted === 0
    const head = (await git(leadDir, ['rev-parse', 'HEAD'])).trim()
    const branch = `refs/heads/${w.branch}`
    const exclusions = [`^${head}`, ...(w.base ? [`^${w.base}`] : [])]
    const count = (await git(w.dir, ['rev-list', '--count', branch, ...exclusions])).trim()
    // Also retain detached worktree commits that are not on the recorded branch.
    const worktreeCount = (await git(w.dir, ['rev-list', '--count', 'HEAD', ...exclusions])).trim()
    if (/^\d+$/.test(count) && /^\d+$/.test(worktreeCount)) facts.ahead = Math.max(Number(count), Number(worktreeCount))
    if (w.base && facts.ahead === 0) {
      const own = (await git(w.dir, ['rev-list', '--count', `${w.base}..${branch}`])).trim()
      facts.merged = /^\d+$/.test(own) && Number(own) > 0
    }
  } catch { facts.ahead = undefined /* missing worktree, commit or git: retain the worker */ }
  return facts
}

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

/** Porcelain entries missing from a fresh worktree; Room's own directory is excluded. */
export async function uncommittedCount(dir: string): Promise<number> {
  const out = await git(dir, ['status', '--porcelain', '--untracked-files=normal'])
  return out.split('\n').filter(line => line.trim() && !/^..\s+"?\.room\//.test(line)).length
}

let warnedMissingNice = false
/** nice execs the command, preserving the pid used for liveness and dismissal. */
export function workerPriority(command: { cmd: string; args: string[] }, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[]; nice: number } {
  const raw = env.ROOM_WORKER_NICE?.trim()
  const value = raw ? Number(raw) : 10
  const nice = Number.isFinite(value) ? Math.max(0, Math.min(19, Math.trunc(value))) : 10
  if (platform === 'win32' || nice === 0) return { ...command, nice: 0 }
  for (const dir of (env.PATH ?? '/usr/bin:/bin').split(path.delimiter)) {
    const executable = path.resolve(dir, 'nice')
    try {
      fs.accessSync(executable, fs.constants.X_OK)
      if (fs.statSync(executable).isFile()) return { cmd: executable, args: ['-n', String(nice), command.cmd, ...command.args], nice }
    } catch { /* try the next PATH entry */ }
  }
  if (!warnedMissingNice) {
    warnedMissingNice = true
    process.stderr.write('room workers: nice is unavailable; starting workers at normal priority\n')
  }
  return { ...command, nice: 0 }
}

/** Reserve for at least four intended workers (bounded by maxWorkers), even on the first spawn.
 * Also cap by actual concurrency when it exceeds that reservation; one thread is the floor.
 */
export function workerBudget({ cores, memBytes, maxWorkers, running }: { cores: number; memBytes: number; maxWorkers: number; running: number }): { threads: number; memGb: number } {
  const workers = running + 1
  const divisor = Math.max(1, Math.min(maxWorkers, Math.max(workers, 4)), workers)
  return { threads: Math.max(1, Math.floor(cores / divisor)), memGb: Math.max(1, Math.floor(memBytes / divisor / 1024 ** 3)) }
}

export function validTag(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined
  const t = tag.trim()
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(t) ? t : undefined
}

/** The fixed preamble every worker gets, then the task. */
export function workerPrompt(lead: string, tag: string, task: string, context?: { threads: number; memGb: number; nice: number; effort?: string; link?: string[]; carriedPaths?: string[] }): string {
  return [
    `You are worker "${tag}", dispatched by ${lead} into the room for this repo. Follow the room-etiquette skill:`,
    `room_scope first, claim before editing, ask ${lead} with room_send(type "question", to "${lead}") when unsure,`,
    `if a room_wait for an answer times out, wait again (up to three times) before deciding on your own, and say what you assumed; room_preview_merge before finishing, and room_done with a one-line summary when finished; then finish the headless process (you cannot answer afterwards).`,
    `Do not commit or push unless the task says so. You are on your own git worktree and branch; the lead merges.`,
    ...(context ? [
      `Compute budget: ${context.threads} threads, ~${context.memGb} GB RAM; scheduling priority: ${context.nice ? `nice ${context.nice}` : 'normal'}; reasoning effort: ${context.effort ?? 'host default'}. Stay within this budget and stagger heavy jobs.`,
      ...(context.link?.length ? [`Read-only inputs linked from the lead's clone: ${context.link.join(', ')}. Do not modify these paths or their contents; write outputs elsewhere.`] : []),
      ...(context.carriedPaths?.length ? [`Files carried from the lead's uncommitted work belong to the lead; do not edit them unless the task says so: ${context.carriedPaths.slice(0, 20).join(', ')}${context.carriedPaths.length > 20 ? `, and ${context.carriedPaths.length - 20} more` : ''}.`] : []),
    ] : []),
    '',
    `TASK: ${task}`,
  ].join('\n')
}

export const WORKER_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const

// Claude effort is communicated in the prompt; no unverified host flag is passed.
export function workerCommand(host: WorkerHost, model: string | undefined, prompt: string, claudeChannel = DEFAULT_CLAUDE_CHANNEL, effort?: string): { cmd: string; args: string[] } {
  if (effort !== undefined && !(WORKER_EFFORTS as readonly string[]).includes(effort)) throw new Error(`effort must be ${WORKER_EFFORTS.join('|')}`)
  if (host === 'codex') return { cmd: 'codex', args: ['exec', '-s', 'workspace-write', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), prompt] }
  return {
    cmd: 'claude',
    args: [...(claudeChannel ? ['--dangerously-load-development-channels', claudeChannel] : []), '-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__room__*,mcp__plugin_room_room__*,Edit,Write,Read,Bash,Glob,Grep', ...(model ? ['--model', model] : [])],
  }
}

/** Validate the entire list before making links; neither source nor destination may escape its root. */
export function prepareWorkerLinks(repoDir: string, workerDir: string, requested?: unknown): string[] {
  let input = requested
  if (input === undefined) {
    try { input = fs.readFileSync(path.join(repoDir, '.roomlinks'), 'utf8').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; input = [] }
  }
  if (!Array.isArray(input) || input.some(p => typeof p !== 'string')) throw new Error('link must be an array of repo-relative paths')
  if (!input.length) return []
  const root = fs.realpathSync(repoDir), destRoot = fs.realpathSync(workerDir)
  const inside = (base: string, target: string): boolean => {
    const rel = path.relative(base, target)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  }
  const links = (input as string[]).map(raw => {
    const p = raw.trim(), parts = p.split(/[\\/]/)
    if (!p || path.isAbsolute(p) || parts.some(x => !x || x === '.' || x === '..') || parts[0] === '.git' || parts[0] === '.room') throw new Error(`invalid link path: ${raw}`)
    const source = fs.realpathSync(path.join(root, p))
    if (!inside(root, source)) throw new Error(`link source escapes repo: ${p}`)
    const stat = fs.statSync(source)
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`link source must be a file or directory: ${p}`)
    const target = path.join(destRoot, p)
    for (let at = target; at !== destRoot; at = path.dirname(at)) {
      let entry
      try { entry = fs.lstatSync(at) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (entry && (at === target || entry.isSymbolicLink() || !entry.isDirectory())) throw new Error(`link destination already present or traverses a non-directory: ${p}`)
    }
    return { p, source, target, directory: stat.isDirectory() }
  })
  for (const [i, a] of links.entries()) for (const b of links.slice(i + 1)) {
    if (a.target === b.target || inside(a.target, b.target) || inside(b.target, a.target)) throw new Error(`overlapping link paths: ${a.p}, ${b.p}`)
  }
  const made: string[] = []
  try {
    for (const link of links) {
      fs.mkdirSync(path.dirname(link.target), { recursive: true })
      fs.symlinkSync(link.source, link.target, link.directory ? 'dir' : 'file')
      made.push(link.target)
    }
  } catch (e) { for (const target of made.reverse()) fs.unlinkSync(target); throw e }
  return links.map(l => l.p)
}

/** Read a bounded suffix even for multi-GB logs, then take five non-empty, ANSI-free lines. */
export function workerLogTail(logFile: string): string {
  let fd: number | undefined
  try {
    fd = fs.openSync(logFile, 'r')
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 64 * 1024)
    const buffer = Buffer.alloc(size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    const text = stripVTControlCharacters(buffer.toString('utf8'))
    return text.split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean).slice(-5).join('\n').slice(-600)
  } catch { return '(log unavailable)' }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

export interface PreparedWorktree {
  dir: string
  branch: string
  created: boolean
  base?: string
  carried?: { count: number; commit: string; paths: string[] }
  carryFailed?: boolean
}

/** Subject of the commit that carries a lead's uncommitted work into a new worker's worktree. */
export const carriedSubject = (leadName: string) => `room: carried-in uncommitted work from ${leadName}`

/** A worktree for the worker, created from the lead's HEAD on branch room/<tag>; reused if it already exists. */
export async function prepareWorktree(repoDir: string, tag: string, leadName = 'lead'): Promise<PreparedWorktree> {
  const dir = path.join(repoDir, WORKERS_DIR, tag)
  const branch = `room/${tag}`
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, branch, created: false }
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  // A worker directory may have been deleted without removing its worktree registration.
  // Prune before add so Git does not reject the same path as already registered.
  await git(repoDir, ['worktree', 'prune'])
  let hasBranch = false
  try { await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); hasBranch = true } catch { /* new branch */ }
  const base = hasBranch ? undefined : (await git(repoDir, ['rev-parse', 'HEAD'])).trim()
  await git(repoDir, hasBranch ? ['worktree', 'add', '-q', dir, branch] : ['worktree', 'add', '-q', '-b', branch, dir, base!])
  if (!base) return { dir, branch, created: true }
  try {
    const count = await uncommittedCount(repoDir)
    if (!count) return { dir, branch, created: true, base }
    const patch = await git(repoDir, ['diff', '--binary', 'HEAD', '--', '.', ':(exclude).room'])
    if (patch) execFileSync('git', ['apply', '--index', '--binary'], { cwd: dir, input: patch, maxBuffer: 64 * 1024 * 1024 })
    const untracked = (await git(repoDir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).room'])).split('\0').filter(Boolean)
    for (const rel of untracked) {
      const source = path.join(repoDir, rel), target = path.join(dir, rel)
      const stat = fs.lstatSync(source)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target)
      else {
        fs.copyFileSync(source, target)
        fs.chmodSync(target, stat.mode)
      }
    }
    await git(dir, ['add', '-A', '--', '.', ':(exclude).room'])
    await git(dir, ['-c', 'user.name=Room', '-c', 'user.email=room@localhost', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', carriedSubject(leadName)])
    const commit = (await git(dir, ['rev-parse', 'HEAD'])).trim()
    const paths = (await git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit])).split('\0').filter(Boolean).sort()
    return { dir, branch, created: true, base: commit, carried: { count, commit, paths } }
  } catch {
    try {
      await git(dir, ['reset', '--hard', base])
      await git(dir, ['clean', '-fdx'])
    } catch {
      await git(repoDir, ['worktree', 'remove', '--force', dir])
      await git(repoDir, ['branch', '-D', branch])
      await git(repoDir, ['worktree', 'add', '-q', '-b', branch, dir, base])
    }
    return { dir, branch, created: true, base, carryFailed: true }
  }
}

/**
 * Room variables the lead's own process may carry that must never reach a worker: the runner's
 * ROOM_URL/ROOM_NAME/ROOM_DIR would send it into the lead's room under the lead's name, and the
 * lead's token, share level, tag or generation are the lead's, not the worker's. room_spawn sets
 * every variable a worker needs explicitly (ROOM_SERVER, ROOM_ROOM, ROOM_DIR, ROOM_TAG, ROOM_LEAD,
 * ROOM_OWNER, ROOM_SHARE, ROOM_GEN, ROOM_LOG_FILE and, when the lead joined with one, ROOM_TOKEN).
 */
export const LEAD_ONLY_ENV = ['ROOM_URL', 'ROOM_NAME', 'ROOM_DIR', 'ROOM_SERVER', 'ROOM_ROOM', 'ROOM_TAG', 'ROOM_LEAD', 'ROOM_OWNER', 'ROOM_SHARE', 'ROOM_TOKEN', 'ROOM_GEN', 'ROOM_WORKER_ID', 'ROOM_WORKER_HOST', 'ROOM_WORKER_MODEL', 'ROOM_WORKER_EFFORT', 'ROOM_LOG_FILE', 'ROOM_KIND'] as const
/** The environment a worker process starts with: the lead's, minus LEAD_ONLY_ENV, plus the spec's variables. */
export function workerEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !(LEAD_ONLY_ENV as readonly string[]).includes(k)) out[k] = v
  return { ...out, ...extra }
}

/** Signal a pid's process group, else the pid itself; true when either signal was delivered. */
export function signalWorker(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  // Only ever signal a real pid: kill(-0) would hit our own process group.
  if (!pid || pid <= 0) return false
  try { process.kill(-pid, signal); return true } catch { /* not a group leader, or gone */ }
  try { process.kill(pid, signal); return true } catch { return false }
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

/** Remove only owned Room worktrees; failures require explicit discard. */
export async function cleanupWorker(leadDir: string, w: Worker, collected = false, discarded = false): Promise<boolean> {
  if (w.branch !== 'room/' + w.tag || (!discarded && (w.status === 'failed' || w.exitCode !== 0))) return false
  const common = async (dir: string) => fs.realpathSync(path.resolve(dir, (await git(dir, ['rev-parse', '--git-common-dir'])).trim()))
  if (await common(leadDir) !== await common(w.dir) || fs.realpathSync(leadDir) === fs.realpathSync(w.dir)) return false
  if ((await git(w.dir, ['branch', '--show-current'])).trim() !== w.branch) return false
  await git(leadDir, ['worktree', 'remove', ...(collected ? ['--force'] : []), w.dir])
  await git(leadDir, ['branch', '-D', w.branch])
  for (const suffix of ['.log', '.mcp.log']) fs.rmSync(path.join(leadDir, WORKERS_DIR, w.tag + suffix), { force: true })
  for (const dir of [path.join(leadDir, WORKERS_DIR), path.join(leadDir, '.room')]) {
    try { fs.rmdirSync(dir) } catch (e) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e
    }
  }
  return true
}

/** One binary-capable snapshot against the fork, without modifying the worker's index. */
export async function saveDiscardPatch(leadDir: string, w: Worker): Promise<string | undefined> {
  const dir = path.join(leadDir, '.room', 'discarded'), now = Date.now()
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), stat = fs.lstatSync(file)
      if (name.endsWith('.patch') && stat.isFile() && stat.mtimeMs < now - 7 * 86400_000) fs.unlinkSync(file)
    }
    try { fs.rmdirSync(dir) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw e }
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'room-discard-'))
  try {
    const run = (args: string[]) => execFileSync('git', args, { cwd: w.dir, env: { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') }, maxBuffer: 64 * 1024 * 1024 })
    const base = w.base ?? (await git(leadDir, ['merge-base', 'HEAD', w.branch])).trim()
    run(['read-tree', 'HEAD'])
    run(['add', '-A', '--', '.', ...workerOwnedPaths(w).exclusions])
    const patch = run(['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', base, '--', '.', ...workerOwnedPaths(w).exclusions])
    if (!patch.length) return undefined
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const file = path.join(dir, `${w.tag}-${stamp}.patch`)
    fs.writeFileSync(file, patch, { flag: 'wx', mode: 0o600 })
    return file
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}
