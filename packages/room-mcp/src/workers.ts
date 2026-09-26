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
import { isRegenerableBuildPath, type Worker, type RetiredWorker } from '@room/shared'
import { LINK_INPUT_PATH, RECORDED_PATH, carryRecord, carryRecordSync, containedRepoPath, isInsideRoot, realGitCommonDir, validRepoPath } from '@room/roomd'
import { git } from '@room/roomd/git'
import { boundedGitSync, carriedContentHash, carriedUnchangedPaths, workerBaseline } from '@room/roomd/baseline'

import { DEFAULT_CLAUDE_CHANNEL } from './config.js'
import { workerRealState, decideDiscard } from './worker-state.js'

export type WorkerHost = 'claude' | 'codex'

/** Inputs Room installed itself, rather than worker output. */
export function workerOwnedPaths(w?: Pick<Worker, 'link'>) {
  const paths = w?.link ?? []
  return {
    includes: (p: string) => paths.some(l => p === l || p.startsWith(l + '/')),
    exclusions: paths.map(l => ':(exclude,literal)' + l),
  }
}

/** Ignored output that a discard patch cannot recover. */
export async function ignoredWorkerArtifacts(w: Worker): Promise<string[]> {
  const raw = await git(w.dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', '.', ...workerOwnedPaths(w).exclusions])
  return raw.split('\0').filter(Boolean)
    .filter(p => p !== '.room' && p !== '.room/' && !p.startsWith('.room/'))
    .filter(p => !isRegenerableBuildPath(p))
    .sort()
}

/** One worktree cannot be collected, discarded and auto-retired at the same time. */
export function workerOperationKey(w: Pick<Worker, 'dir'>): string { return 'worker:' + path.resolve(w.dir) }

/** A Room worker path is a chain of .room/workers/<name> directories ending on room/<name>. */
function roomWorkerPathMatchesBranch(leadDir: string, workerDir: string, branch: string, nested = false): boolean {
  const relative = path.relative(path.resolve(leadDir), path.resolve(workerDir)).split(path.sep)
  if (relative.length < 3 || relative.length % 3 !== 0 || (!nested && relative.length !== 3)) return false
  return relative.every((part, i) => i % 3 === 0 ? part === '.room' : i % 3 === 1 ? part === 'workers' : validRepoPath(part, RECORDED_PATH))
    && branch === `room/${relative.at(-1)}`
}

/** Prune a vanished Room checkout, preserving any branch commits absent from the lead HEAD. */
export async function pruneMissingWorkerWorktree(leadDir: string, w: Worker, manageBranch = true): Promise<string | undefined> {
  if (!roomWorkerPathMatchesBranch(leadDir, w.dir, w.branch, true)) {
    throw new Error(`worker ${w.dir} is not an owned Room worktree`)
  }
  try { fs.lstatSync(w.dir); throw new Error(`worktree ${w.dir} still exists`) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await git(leadDir, ['worktree', 'prune'])
  if (!manageBranch) return undefined
  const state = await workerRealState(leadDir, w, { branch: true })
  if (state.branch === 'absent') return `branch ${w.branch} was already absent`
  const count = state.branchAhead!
  if (count) return `branch ${w.branch} kept: it has ${count} commit${count === 1 ? '' : 's'} not in your HEAD`
  await git(leadDir, ['branch', '-D', w.branch])
  return `branch ${w.branch} deleted (it has no commits of its own beyond your HEAD)`
}

type WorktreeOwnershipRecord = Pick<Worker, 'name' | 'tag' | 'lead' | 'dir' | 'branch'>
  | Pick<RetiredWorker, 'name' | 'tag' | 'lead' | 'keptWorktree'>

/** Cwd-wide cleanup requires a canonical Room worktree at every level back to this lead. */
export async function isOwnedWorkerWorktree(leadDir: string, w: Pick<Worker, 'name' | 'dir' | 'branch' | 'tag' | 'lead'>, leadName?: string, workers: Iterable<WorktreeOwnershipRecord> = []): Promise<boolean> {
  const byName = new Map([...workers].map(record => [record.name, record]))
  const chain = [w]
  const seen = new Set([w.name])
  let owner = w.lead
  while (leadName && owner !== leadName) {
    const record = byName.get(owner)
    if (!record || seen.has(record.name)) return false
    // An archived lead may still have a live nested worktree. Its child path
    // identifies the candidate parent; the checks below must prove every link.
    const parent = {
      name: record.name, tag: record.tag, lead: record.lead,
      dir: 'dir' in record ? record.dir : record.keptWorktree ?? path.dirname(path.dirname(path.dirname(chain[0].dir))),
      branch: 'branch' in record ? record.branch : `room/${record.tag}`,
    }
    chain.unshift(parent)
    seen.add(parent.name)
    owner = parent.lead
  }
  try {
    let parentDir = leadDir, parentName = leadName
    for (const record of chain) {
      if (parentName && record.lead !== parentName) return false
      if (!fs.existsSync(record.dir)) return false
      const parentRoot = fs.realpathSync(parentDir), workerRoot = fs.realpathSync(record.dir)
      if (workerRoot === parentRoot) return false
      if (!roomWorkerPathMatchesBranch(parentDir, record.dir, record.branch)) return false
      const expected = path.join(parentRoot, '.room', 'workers', path.basename(record.dir))
      if (workerRoot !== fs.realpathSync(expected)) return false
      if (await realGitCommonDir(parentDir) !== await realGitCommonDir(record.dir)) return false
      if ((await git(record.dir, ['branch', '--show-current'])).trim() !== record.branch) return false
      parentDir = record.dir
      parentName = record.name
    }
    return true
  } catch { return false }
}

export interface SpawnSpec {
  cmd: string
  args: string[]
  cwd: string
  env: Record<string, string>
  logFile: string
  captureCodexSession?: boolean
}
export interface SpawnedProcess {
  /** -1 when the process could not be started (see onError). */
  pid: number
  /** Resolves on child_process 'spawn'; rejects on 'error'. */
  started: Promise<void>
  onExit(cb: (code: number | null) => void): void
  /** Fires when the process could not be started at all (e.g. the binary is missing). */
  onError?(cb: (err: Error) => void): void
  /** Codex emits thread.started on JSONL stdout. */
  onSessionId?(cb: (id: string) => void): void
  /** SIGTERM the worker; true when a signal was actually delivered (false: no pid, or the process is gone). */
  kill(): boolean
}
/** Injectable for tests: how a worker process is started. */
export type Spawner = (spec: SpawnSpec) => SpawnedProcess

const WORKERS_DIR = path.join('.room', 'workers')

export const WORKER_PORT_START = 4400
export const WORKER_PORT_END = 4499

/** A small, predictable range makes simultaneous worker dev servers independent. */
export function allocateWorkerPort(used: Iterable<number>): number {
  const occupied = new Set(used)
  for (let port = WORKER_PORT_START; port <= WORKER_PORT_END; port++) if (!occupied.has(port)) return port
  throw new Error(`all worker dev-server ports (${WORKER_PORT_START}-${WORKER_PORT_END}) are in use`)
}

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

const WORKER_THREAD_CAPS = ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'NUMEXPR_NUM_THREADS', 'LOKY_MAX_CPU_COUNT', 'RAYON_NUM_THREADS'] as const

export function workerProcessEnv(options: {
  threads: number; memGb: number; host: WorkerHost; model?: string; effort?: string
  server: string; room: string; dir: string; tag: string; lead: string; owner: string
  share: string; gen: number; id: string; token?: string; logDir: string; isWorker: boolean; port?: number
}, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const caps: Record<string, string> = {}
  for (const key of WORKER_THREAD_CAPS) {
    const cap = Number(inherited[key])
    caps[key] = options.isWorker ? String(Number.isSafeInteger(cap) && cap >= 1 ? Math.min(cap, options.threads) : options.threads) : inherited[key] ?? String(options.threads)
  }
  return {
    ...caps, ROOM_WORKER_THREADS: String(options.threads), ROOM_WORKER_MEM_GB: String(options.memGb),
    ROOM_WORKER_HOST: options.host, ...(options.model ? { ROOM_WORKER_MODEL: options.model } : {}), ...(options.effort ? { ROOM_WORKER_EFFORT: options.effort } : {}),
    ROOM_SERVER: options.server, ROOM_ROOM: options.room, ROOM_DIR: options.dir, PWD: options.dir,
    ...(options.port ? { PORT: String(options.port) } : {}),
    ROOM_TAG: options.tag, ROOM_LEAD: options.lead, ROOM_OWNER: options.owner, ROOM_SHARE: options.share,
    ROOM_GEN: String(options.gen), ROOM_WORKER_ID: options.id,
    ...(options.token ? { ROOM_TOKEN: options.token } : {}),
    ROOM_LOG_FILE: path.join(options.logDir, '.room', 'workers', `${options.tag}.mcp.log`),
  }
}

export function validTag(tag: unknown): string | undefined {
  if (typeof tag !== 'string') return undefined
  const t = tag.trim()
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(t) ? t : undefined
}

/** The fixed preamble every worker gets, then the task. */
export function workerPrompt(lead: string, tag: string, task: string, context?: { threads: number; memGb: number; nice: number; effort?: string; port?: number; link?: string[]; carriedPaths?: string[] }): string {
  return [
    `You are worker "${tag}", dispatched by ${lead} into the room for this repo. Follow the room-etiquette skill:`,
    `room_scope first, claim before editing, ask ${lead} with room_send(type "question", to "${lead}") when unsure,`,
    `if a room_wait for an answer times out, wait again (up to three times) before deciding on your own, and say what you assumed; room_preview_merge before finishing, and room_done with a one-line summary when finished; then finish the headless process. Your lead can resume this session for a later follow-up while the worktree remains.`,
    `Do not commit or push unless the task says so. You are on your own git worktree and branch; the lead merges.`,
    `If you spawn workers, collect them before your own room_done.`,
    `Report progress in room_done; send notes only when the lead must know before you finish.`,
    ...(context ? [
      `Compute budget: ${context.threads} threads, ~${context.memGb} GB RAM; scheduling priority: ${context.nice ? `nice ${context.nice}` : 'normal'}; reasoning effort: ${context.effort ?? 'host default'}. Stay within this budget and stagger heavy jobs.`,
      ...(context.port ? [`Your dev-server port is ${context.port} (PORT=${context.port}).`] : []),
      ...(context.link?.length ? [`Read-only inputs linked from the lead's clone: ${context.link.join(', ')}. Do not modify these paths or their contents; write outputs elsewhere.`] : []),
      ...(context.carriedPaths?.length ? [`Files carried from the lead's uncommitted work belong to the lead; coordinate with the lead before editing these where your task needs to: ${context.carriedPaths.slice(0, 20).join(', ')}${context.carriedPaths.length > 20 ? `, and ${context.carriedPaths.length - 20} more` : ''}.`] : []),
    ] : []),
    '',
    `TASK: ${task}`,
  ].join('\n')
}

export const WORKER_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const
export function hostWorkerEffort(host: WorkerHost, effort?: string): string | undefined { return host === 'claude' && effort === 'minimal' ? 'low' : effort }

export interface WorkerCommandOptions { tag?: string; sessionId?: string; resume?: boolean; maxBudgetUsd?: string; wakeChannels?: boolean }
export function workerCommand(host: WorkerHost, model: string | undefined, prompt: string, claudeChannel = DEFAULT_CLAUDE_CHANNEL, effort?: string, options: WorkerCommandOptions = {}): { cmd: string; args: string[] } {
  if (effort !== undefined && !(WORKER_EFFORTS as readonly string[]).includes(effort)) throw new Error(`effort must be ${WORKER_EFFORTS.join('|')}`)
  effort = hostWorkerEffort(host, effort)
  if (options.resume && !options.sessionId) throw new Error('resuming a worker requires its host session id')
  if (host === 'codex') return { cmd: 'codex', args: options.resume
    ? ['exec', 'resume', options.sessionId!, '-c', 'sandbox_mode="workspace-write"', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), '--json', prompt]
    : ['exec', '-s', 'workspace-write', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), '--json', prompt] }
  return {
    cmd: 'claude',
    args: [...(options.wakeChannels && claudeChannel ? ['--dangerously-load-development-channels', claudeChannel] : []), '-p', ...(options.resume ? ['--resume', options.sessionId!] : []), prompt, '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__room__*,mcp__plugin_room_room__*,Edit,Write,Read,Bash,Glob,Grep', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...(options.tag ? ['--name', options.tag] : []), ...(!options.resume && options.sessionId ? ['--session-id', options.sessionId] : []), ...(options.maxBudgetUsd ? ['--max-budget-usd', options.maxBudgetUsd] : [])],
  }
}

export function workerMaxBudget(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.ROOM_WORKER_MAX_BUDGET_USD?.trim()
  if (!value) return undefined
  if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) <= 0) throw new Error('ROOM_WORKER_MAX_BUDGET_USD must be a positive dollar amount')
  return value
}

export function codexSessionId(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as { type?: string; thread_id?: unknown }
    return event.type === 'thread.started' && typeof event.thread_id === 'string' && /^[0-9a-f-]{36}$/i.test(event.thread_id) ? event.thread_id : undefined
  } catch { return undefined }
}

/** Resolve link paths before creating a worker worktree, so carry can exclude them. */
export function resolveWorkerLinks(repoDir: string, requested?: unknown): string[] {
  let input = requested
  if (input === undefined) {
    try { input = fs.readFileSync(path.join(repoDir, '.roomlinks'), 'utf8').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; input = [] }
  }
  if (!Array.isArray(input) || input.some(p => typeof p !== 'string')) throw new Error('link must be an array of repo-relative paths')
  if (!input.length) return []
  const root = fs.realpathSync(repoDir)
  const paths = (input as string[]).map(raw => {
    const p = raw.trim()
    if (!validRepoPath(p, LINK_INPUT_PATH)) throw new Error(`invalid link path: ${raw}`)
    const source = fs.realpathSync(path.join(root, p))
    if (!isInsideRoot(root, source)) throw new Error(`link source escapes repo: ${p}`)
    const stat = fs.statSync(source)
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`link source must be a file or directory: ${p}`)
    return p
  })
  for (const [i, a] of paths.entries()) for (const b of paths.slice(i + 1)) {
    if (a === b || b.startsWith(a + '/') || a.startsWith(b + '/')) throw new Error(`overlapping link paths: ${a}, ${b}`)
  }
  return paths
}

/** Validate destinations, then install links without modifying any pre-existing worker path. */
export function prepareWorkerLinks(repoDir: string, workerDir: string, requested?: unknown): string[] {
  const input = resolveWorkerLinks(repoDir, requested)
  if (!input.length) return []
  const root = fs.realpathSync(repoDir), destRoot = fs.realpathSync(workerDir)
  const links = input.map(p => {
    const source = fs.realpathSync(path.join(root, p))
    if (!isInsideRoot(root, source)) throw new Error(`link source escapes repo: ${p}`)
    const stat = fs.statSync(source)
    const target = path.join(destRoot, p)
    for (let at = target; at !== destRoot; at = path.dirname(at)) {
      let entry
      try { entry = fs.lstatSync(at) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (entry && (at === target || entry.isSymbolicLink() || !entry.isDirectory())) throw new Error(`link destination already present or traverses a non-directory: ${p}`)
    }
    return { p, source, target, directory: stat.isDirectory() }
  })
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

export interface PreparedWorktree {
  dir: string
  branch: string
  created: boolean
  /** The branch may predate a newly created checkout. */
  branchCreated?: boolean
  /** Ref values to restore if preparation is rolled back; absent refs were created here. */
  previousCarryRefs?: Record<string, string>
  base?: string
  carried?: { count: number; commit: string; paths: string[] }
  carriedBase?: string
  carriedUntracked?: { path: string; sha: string; mode?: number }[]
  skippedCarry?: { path: string; reason: string }[]
  carryFailed?: boolean
  carryError?: string
}

/** Identity of the commit that carries a lead's uncommitted work into a worker's worktree. */
export const ROOM_CARRY_IDENTITY = {
  authorName: 'Room',
  authorEmail: 'room@localhost',
  subjectPrefix: 'room: carried-in uncommitted work from ',
  isRoomCarryCommit(name: string, email: string, subject: string): boolean {
    return name === ROOM_CARRY_IDENTITY.authorName
      && email === ROOM_CARRY_IDENTITY.authorEmail
      && subject.startsWith(ROOM_CARRY_IDENTITY.subjectPrefix)
      && /^.+$/.test(subject.slice(ROOM_CARRY_IDENTITY.subjectPrefix.length))
  },
} as const

const carriedSubject = (leadName: string) => `${ROOM_CARRY_IDENTITY.subjectPrefix}${leadName}`

/** A worktree for the worker, created from the lead's HEAD on branch room/<tag>; reused if it already exists. */
const internalGit = (dir: string, args: string[]) => git(dir, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args])
const carryRef = (tag: string) => `refs/room/carry/${tag}`
const carriedUntrackedRef = (tag: string) => `refs/room/carry-untracked/${tag}`
const pathExcluded = (rel: string, exclusions: string[]) => exclusions.some(p => rel === p || rel.startsWith(p.replace(/\/$/, '') + '/'))
/** Stable, apply-compatible patch policy for both carry and discard. */
function patchArgs(base: string, exclusions: string[], staged = false): string[] {
  return ['diff', ...(staged ? ['--cached'] : []), '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', base, '--', '.', ...exclusions]
}
function retainUntrackedTree(dir: string, tag: string, paths: { path: string; sha: string }[]): string | undefined {
  if (!paths.length) return undefined
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'room-carry-index-'))
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') }
  const run = (args: string[]) => boundedGitSync(dir, ['-c', 'core.hooksPath=/dev/null', ...args], { env }).toString().trim()
  try {
    for (const entry of paths) {
      const stat = fs.lstatSync(path.join(dir, entry.path))
      const mode = stat.isSymbolicLink() ? '120000' : (stat.mode & 0o111) ? '100755' : '100644'
      run(['update-index', '--add', '--cacheinfo', `${mode},${entry.sha},${entry.path}`])
    }
    const tree = run(['write-tree'])
    run(['update-ref', carriedUntrackedRef(tag), tree])
    return tree
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}
type CarryRecord = Pick<PreparedWorktree, 'base' | 'carriedBase' | 'carried' | 'carriedUntracked' | 'skippedCarry'> & { ownerId?: string }

/** The relay can disappear with the lead; keep the intentional stop reason beside the carry record. */
export function persistWorkerStopReason(repoDir: string, tag: string, reason: Worker['stopReason'], workerId?: string): void {
  const recordFile = carryRecordSync(repoDir, tag)
  const record = recordFile.read<CarryRecord & { stopReason?: Worker['stopReason'] }>() ?? {}
  recordFile.write({ ...record, stopReason: reason, stopWorkerId: workerId })
}

export function persistedWorkerStopReason(repoDir: string, tag: string, workerId?: string): Worker['stopReason'] | undefined {
  const record = carryRecordSync(repoDir, tag).read<{ stopReason?: Worker['stopReason']; stopWorkerId?: string }>()
  if (record === undefined || (workerId && record.stopWorkerId && record.stopWorkerId !== workerId)) return undefined
  return record.stopReason === 'lead-session-ended' ? record.stopReason : undefined
}

/** Clear only the stop state for this process generation after resume has started successfully. */
export function clearWorkerStopState(repoDir: string, tag: string, workerId?: string): void {
  const recordFile = carryRecordSync(repoDir, tag)
  const record = recordFile.read<CarryRecord & { stopReason?: Worker['stopReason']; stopWorkerId?: string }>()
  if (record === undefined) return
  if (workerId && record.stopWorkerId && record.stopWorkerId !== workerId) return
  delete record.stopReason
  delete record.stopWorkerId
  recordFile.write(record)
}


/** Roll back only a newly prepared worktree; do not remove reused worker output. */
export async function cleanupPreparedWorktree(repoDir: string, prepared: PreparedWorktree): Promise<void> {
  if (!prepared.created) return
  await internalGit(repoDir, ['worktree', 'remove', '--force', prepared.dir])
  if (!prepared.branchCreated) return
  await internalGit(repoDir, ['branch', '-D', prepared.branch])
  for (const ref of [carryRef(prepared.branch.slice(5)), carriedUntrackedRef(prepared.branch.slice(5))]) {
    const previous = prepared.previousCarryRefs?.[ref]
    if (previous) await internalGit(repoDir, ['update-ref', ref, previous])
    else try { await internalGit(repoDir, ['update-ref', '-d', ref]) } catch { /* no ref was created */ }
  }
  await fs.promises.rm((await carryRecord(repoDir, prepared.branch.slice(5))).file, { force: true })
}

/** A worktree for the worker, with tracked WIP in its base and untracked bytes outside Git. */
export async function prepareWorktree(repoDir: string, tag: string, leadName = 'lead', linkExclusions?: string[], ownerId?: string, retry = 0, carry = true): Promise<PreparedWorktree> {
  const dir = path.join(repoDir, WORKERS_DIR, tag)
  const branch = `room/${tag}`
  const gitDir = (await git(repoDir, ['rev-parse', '--absolute-git-dir'])).trim()
  if (['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].some(p => fs.existsSync(path.join(gitDir, p)))) throw new Error('finish the merge or rebase before spawning workers')
  const record = await (await carryRecord(repoDir, tag)).read<CarryRecord>()
  if (record?.ownerId && ownerId && record.ownerId !== ownerId) throw new Error(`worktree ${tag} is owned by another room or worker`)
  if (fs.existsSync(path.join(dir, '.git'))) {
    if (!carry) throw new Error(`worktree ${tag} already exists; choose a new tag for carry=false`)
    if (ownerId && !record?.ownerId) throw new Error(`worktree ${tag} has unknown ownership; choose another tag`)
    const actualBranch = (await git(dir, ['branch', '--show-current'])).trim()
    if (actualBranch !== branch) throw new Error(`worktree ${tag} is on branch ${actualBranch || '(detached)'}, expected ${branch}; choose another tag`)
    if (await realGitCommonDir(repoDir) !== await realGitCommonDir(dir)) throw new Error(`worktree ${tag} is not a worktree of this repository; choose another tag`)
    return { dir, branch, created: false, ...record }
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  // A worker directory may have been deleted without removing its worktree registration.
  // Prune before add so Git does not reject the same path as already registered.
  await internalGit(repoDir, ['worktree', 'prune'])
  let hasBranch = false
  try { await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); hasBranch = true } catch { /* new branch */ }
  if (hasBranch && ownerId && !record?.ownerId) throw new Error(`branch ${branch} has unknown ownership; choose another tag`)
  if (hasBranch && !carry) throw new Error(`branch ${branch} already exists; choose a new tag for carry=false`)
  const previousCarryRefs: Record<string, string> = {}
  if (!hasBranch) for (const ref of [carryRef(tag), carriedUntrackedRef(tag)]) {
    try { previousCarryRefs[ref] = (await git(repoDir, ['rev-parse', '--verify', ref])).trim() } catch { /* absent */ }
  }
  let base: string | undefined
  if (!hasBranch) {
    try { base = (await git(repoDir, ['rev-parse', '--verify', 'HEAD'])).trim() }
    catch { throw new Error('make a first commit before spawning workers') }
  }
  await internalGit(repoDir, hasBranch ? ['worktree', 'add', '-q', dir, branch] : ['worktree', 'add', '-q', '-b', branch, dir, base!])
  if (!base) return { dir, branch, created: true, branchCreated: false, ...record }
  if (!carry) {
    const result: PreparedWorktree = { dir, branch, created: true, branchCreated: true, previousCarryRefs, base }
    await (await carryRecord(repoDir, tag)).write({ base, ownerId })
    return result
  }
  try {
    const exclusions = [...linkExclusions ?? []]
    if (linkExclusions === undefined) {
      try { exclusions.push(...fs.readFileSync(path.join(repoDir, '.roomlinks'), 'utf8').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean)) }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    const excluded = ['.room', ...exclusions].map(p => `:(exclude,literal)${p.replace(/\/$/, '')}`)
    const patch = await internalGit(repoDir, patchArgs(base, excluded))
    if (patch) {
      // Applied from a file, not stdin: a synchronous child fed a multi-megabyte patch can wait for EOF forever.
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'room-carry-patch-'))
      try {
        const file = path.join(scratch, 'carry.patch')
        fs.writeFileSync(file, patch, { mode: 0o600 })
        boundedGitSync(dir, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', 'apply', '--index', '--binary', file])
      } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
    }
    const untracked = (await git(repoDir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).room'])).split('\0').filter(Boolean)
    const carriedUntracked: { path: string; sha: string; mode?: number }[] = []
    const skippedCarry: { path: string; reason: string }[] = []
    let totalBytes = 0
    const carryRoot = fs.realpathSync(repoDir)
    for (const rel of untracked) {
      if (pathExcluded(rel, exclusions)) { skippedCarry.push({ path: rel, reason: 'linked input' }); continue }
      const source = path.join(repoDir, rel), target = path.join(dir, rel)
      const stat = fs.lstatSync(source)
      if (stat.isDirectory()) { skippedCarry.push({ path: rel, reason: 'nested repository or directory' }); continue }
      if (!stat.isFile() && !stat.isSymbolicLink()) { skippedCarry.push({ path: rel, reason: 'special file' }); continue }
      let containment: ReturnType<typeof containedRepoPath>
      try {
        containment = containedRepoPath(carryRoot, path.join(carryRoot, rel), { leaf: 'read-contained-link' })
      }
      catch { skippedCarry.push({ path: rel, reason: 'unresolvable path' }); continue }
      if (!containment.ok) { skippedCarry.push({ path: rel, reason: 'path leaves repository' }); continue }
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(source)
        if (path.isAbsolute(link)) { skippedCarry.push({ path: rel, reason: 'absolute link' }); continue }
      }
      if (stat.isFile() && (stat.size > 5 * 1024 * 1024 || totalBytes + stat.size > 50 * 1024 * 1024)) { skippedCarry.push({ path: rel, reason: 'size budget' }); continue }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target)
      else {
        await fs.promises.copyFile(source, target)
        fs.chmodSync(target, stat.mode)
        totalBytes += stat.size
      }
      const sha = carriedContentHash(dir, rel, true)
      carriedUntracked.push({ path: rel, sha, mode: stat.mode & 0o777 })
    }
    const snapshotStable = async () => {
      const latestPatch = await internalGit(repoDir, patchArgs(base, excluded))
      const latestUntracked = (await git(repoDir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).room'])).split('\0').filter(Boolean)
      const copiedStable = carriedUntracked.every(({ path: rel, sha }) => {
        try { return carriedContentHash(repoDir, rel) === sha }
        catch (error) { if (error instanceof Error && error.message.includes('timed out')) throw error; return false }
      })
      return (await git(repoDir, ['rev-parse', 'HEAD'])).trim() === base && latestPatch === patch && latestUntracked.join('\0') === untracked.join('\0') && copiedStable
    }
    if (!await snapshotStable()) throw new Error('lead changed during carry; retrying snapshot')
    const staged = (await internalGit(dir, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
    if (staged.length) await git(dir, ['-c', 'core.hooksPath=/dev/null', '-c', `user.name=${ROOM_CARRY_IDENTITY.authorName}`, '-c', `user.email=${ROOM_CARRY_IDENTITY.authorEmail}`, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', carriedSubject(leadName)])
    const commit = (await git(dir, ['rev-parse', 'HEAD'])).trim()
    const paths = [...new Set([...staged, ...carriedUntracked.map(x => x.path)])].sort()
    if (paths.length) await internalGit(repoDir, ['update-ref', carryRef(tag), commit])
    retainUntrackedTree(repoDir, tag, carriedUntracked)
    if (!await snapshotStable()) throw new Error('lead changed during carry; retrying snapshot')
    const result: PreparedWorktree = { dir, branch, created: true, branchCreated: true, previousCarryRefs, base: commit, carriedBase: staged.length ? commit : undefined, carried: paths.length ? { count: paths.length, commit, paths } : undefined, carriedUntracked, skippedCarry }
    await (await carryRecord(repoDir, tag)).write({ base: result.base, carriedBase: result.carriedBase, carried: result.carried, carriedUntracked, skippedCarry, ownerId })
    return result
  } catch (e) {
    if ((e as Error).message === 'lead changed during carry; retrying snapshot') {
      await cleanupPreparedWorktree(repoDir, { dir, branch, created: true, branchCreated: true, previousCarryRefs })
      if (retry >= 2) throw new Error('lead changed repeatedly during carry; try spawning again when HEAD is stable')
      return prepareWorktree(repoDir, tag, leadName, linkExclusions, ownerId, retry + 1, carry)
    }
    try {
      await internalGit(dir, ['reset', '--hard', base])
      await internalGit(dir, ['clean', '-fdx'])
      for (const ref of [carryRef(tag), carriedUntrackedRef(tag)]) {
        if (previousCarryRefs[ref]) await internalGit(repoDir, ['update-ref', ref, previousCarryRefs[ref]])
        else try { await internalGit(repoDir, ['update-ref', '-d', ref]) } catch { /* ref was never written */ }
      }
    } catch {
      await cleanupPreparedWorktree(repoDir, { dir, branch, created: true, branchCreated: true, previousCarryRefs })
      await internalGit(repoDir, ['worktree', 'add', '-q', '-b', branch, dir, base])
    }
    return { dir, branch, created: true, branchCreated: true, previousCarryRefs, base, carryFailed: true, carryError: (e as Error).message }
  }
}

/**
 * Room variables the lead's own process may carry that must never reach a worker: the runner's
 * ROOM_URL/ROOM_NAME/ROOM_DIR would send it into the lead's room under the lead's name, and the
 * lead's token, share level, tag or generation are the lead's, not the worker's. room_spawn sets
 * every variable a worker needs explicitly (ROOM_SERVER, ROOM_ROOM, ROOM_DIR, ROOM_TAG, ROOM_LEAD,
 * ROOM_OWNER, ROOM_SHARE, ROOM_GEN, ROOM_LOG_FILE and, when the lead joined with one, ROOM_TOKEN).
 */
const LEAD_ONLY_ENV = ['ROOM_URL', 'ROOM_NAME', 'ROOM_DIR', 'ROOM_SERVER', 'ROOM_ROOM', 'ROOM_TAG', 'ROOM_LEAD', 'ROOM_OWNER', 'ROOM_SHARE', 'ROOM_TOKEN', 'ROOM_GEN', 'ROOM_WORKER_ID', 'ROOM_WORKER_HOST', 'ROOM_WORKER_MODEL', 'ROOM_WORKER_EFFORT', 'ROOM_LOG_FILE', 'ROOM_KIND', 'PORT'] as const
/** The environment a worker process starts with: the lead's, minus LEAD_ONLY_ENV, plus the spec's variables. */
export function workerEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !(LEAD_ONLY_ENV as readonly string[]).includes(k)) out[k] = v
  return { ...out, ...extra }
}

/** Signal only the worker host pid. Its group may also contain processes outside the worktree. */
export function signalWorker(pid: number, signal: NodeJS.Signals = 'SIGTERM', worktreeDir?: string, list: () => CwdProcess[] = listCwdProcesses, worker?: Parameters<typeof pidIsOurWorker>[1], probe?: (pid: number) => ProcessInfo | undefined): boolean {
  if (!pid || pid <= 0 || pid === process.pid || pid === process.ppid) return false
  if (worker && !pidIsOurWorker(pid, worker, probe)) return false
  if (worktreeDir && !pidHasWorkerCwd(pid, worktreeDir, list)) return false
  try { process.kill(pid, signal); return true } catch { return false }
}

export const defaultSpawner: Spawner = spec => {
  fs.mkdirSync(path.dirname(spec.logFile), { recursive: true })
  const fd = fs.openSync(spec.logFile, 'a')
  let child: ReturnType<typeof spawn>
  try { child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: workerEnv(process.env, spec.env), detached: true, stdio: ['ignore', spec.captureCodexSession ? 'pipe' : fd, fd] }) }
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
  let sessionId: string | undefined
  let sessionIdCallback: ((id: string) => void) | undefined
  if (spec.captureCodexSession && child.stdout) {
    let pending = ''
    child.stdout.on('data', (chunk: Buffer) => {
      try { fs.writeSync(fd, chunk) }
      catch (error) { try { fs.writeSync(2, `room worker: could not write Codex log: ${error instanceof Error ? error.message : String(error)}\n`) } catch { /* event callback must not throw */ } }
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop()!.slice(-64 * 1024)
      for (const line of lines) {
        const id = codexSessionId(line)
        if (id && !sessionId) { sessionId = id; sessionIdCallback?.(id) }
      }
    })
  }
  child.unref()
  return {
    pid: child.pid ?? -1,
    started,
    onExit: cb => { child.once('close', cb) },
    onError: cb => { child.once('error', cb) },
    onSessionId: cb => { sessionIdCallback = cb; if (sessionId) cb(sessionId) },
    kill: () => { try { return child.kill('SIGTERM') } catch { return false } },
  }
}

export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export interface ProcessInfo { startTime?: string; executable?: string }
/** Undefined means the pid is gone; an empty object means it is live but its identity is unreadable. */
export type ProcessProbe = (pid: number) => ProcessInfo | undefined
export interface ProcessReaders {
  platform: NodeJS.Platform
  readFile(file: string): string
  readLink(file: string): string
  exec(file: string, args: string[]): string
}
const systemProcessReaders: ProcessReaders = {
  platform: process.platform,
  readFile: file => fs.readFileSync(file, 'utf8'),
  readLink: file => fs.readlinkSync(file),
  exec: (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    ...(file === 'ps' ? { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } } : {}) }),
}

/** Parse the C-locale `ps` start line as UTC, independent of the MCP process's timezone. */
export function parsePsLstartUtc(line: string): number | undefined {
  const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(line.trim())
  if (!match) return undefined
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[1])
  const seconds = Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000
  return Number.isInteger(seconds) ? seconds : undefined
}

/** Read the kernel's process birth marker and executable, without inspecting argv or environment.
 * macOS gives Node one-second start-time resolution. Reuse of the same pid in that same second is
 * not a practical risk: pids increment and wrap only after about 99,999, and the executable must also match. */
export function probeProcess(pid: number, readers: ProcessReaders = systemProcessReaders): ProcessInfo | undefined {
  if (!pid || pid <= 0) return undefined
  const unreadable = () => pidAlive(pid) ? {} : undefined
  try {
    if (readers.platform === 'linux') {
      const stat = readers.readFile(`/proc/${pid}/stat`)
      const close = stat.lastIndexOf(')')
      if (close < 0) return unreadable()
      const startTicks = stat.slice(close + 1).trim().split(/\s+/)[19]
      if (!/^\d+$/.test(startTicks ?? '')) return unreadable()
      const bootId = readers.readFile('/proc/sys/kernel/random/boot_id').trim()
      if (!bootId) return unreadable()
      let executable: string | undefined
      try { executable = path.basename(readers.readLink(`/proc/${pid}/exe`)) } catch { /* start time is still useful to record */ }
      return { startTime: `linux:${bootId}:${startTicks}`, executable }
    }
    if (readers.platform === 'darwin') {
      const lstart = readers.exec('ps', ['-o', 'lstart=', '-p', String(pid)]).trim()
      const startSeconds = parsePsLstartUtc(lstart)
      if (startSeconds === undefined) return unreadable()
      const boot = readers.exec('sysctl', ['-n', 'kern.boottime']).match(/sec\s*=\s*(\d+)/)?.[1]
      if (!boot) return unreadable()
      let executable: string | undefined
      try { executable = path.basename(readers.exec('ps', ['-o', 'comm=', '-p', String(pid)]).trim()) } catch { /* start time is still useful to record */ }
      return { startTime: `darwin:${boot}:${startSeconds}`, executable }
    }
  } catch { /* process exited or the OS did not allow the read */ }
  return unreadable()
}

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

export interface CwdProcess { pid: number; cwd: string; command: string }

function pidHasWorkerCwd(pid: number, dir: string, list: () => CwdProcess[] = listCwdProcesses): boolean {
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
  list?: () => CwdProcess[]
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

/** Remove only owned Room worktrees; failures require explicit discard. */
export async function cleanupWorker(leadDir: string, w: Worker, collected = false, discarded = false, terminatedProcesses: string[] = [], processOptions: Parameters<typeof terminateWorktreeProcesses>[1] = {}, leadName?: string, workers: Iterable<WorktreeOwnershipRecord> = []): Promise<boolean> {
  if (!discarded && (w.status === 'failed' || w.exitCode !== 0)) return false
  if (decideDiscard(await workerRealState(leadDir, w, { ownership: true, leadName, workers })) !== 'cleanup') return false
  const nested = (await git(leadDir, ['worktree', 'list', '--porcelain'])).split('\n')
    .filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
    .filter(dir => dir !== w.dir && isInsideRoot(fs.realpathSync(w.dir), dir))
  if (nested.length) throw new Error(`nested worker worktrees still present under ${w.tag}: ${nested.join(', ')}`)
  const head = (await git(w.dir, ['rev-parse', 'HEAD'])).trim()
  const recordFile = (await carryRecord(leadDir, w.tag)).file
  const record = await fs.promises.readFile(recordFile).catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e })
  const refs = new Map<string, string>()
  for (const ref of [carryRef(w.tag), carriedUntrackedRef(w.tag)]) {
    try { refs.set(ref, (await git(leadDir, ['rev-parse', '--verify', ref])).trim()) } catch { /* absent on older workers */ }
  }
  terminatedProcesses.push(...await terminateWorktreeProcesses(w.dir, processOptions))
  // A lead may have discarded a child earlier. Its recovery patches must outlive this worktree.
  const nestedPatches = path.join(w.dir, '.room', 'discarded')
  if (fs.existsSync(nestedPatches)) {
    const dest = path.join(leadDir, '.room', 'discarded')
    for (const name of fs.readdirSync(nestedPatches)) {
      const source = path.join(nestedPatches, name)
      if (!name.endsWith('.patch') || !fs.lstatSync(source).isFile()) continue
      fs.mkdirSync(dest, { recursive: true })
      let target = path.join(dest, name), suffix = 1
      while (fs.existsSync(target)) target = path.join(dest, `${w.tag}-${suffix++}-${name}`)
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
      const stat = fs.statSync(source)
      fs.utimesSync(target, stat.atime, stat.mtime)
    }
  }
  try {
    await internalGit(leadDir, ['worktree', 'remove', ...(collected ? ['--force'] : []), w.dir])
    await internalGit(leadDir, ['branch', '-D', w.branch])
    for (const ref of refs.keys()) await internalGit(leadDir, ['update-ref', '-d', ref])
    await fs.promises.rm(recordFile, { force: true })
  } catch (error) {
    const recoveryDir = path.join(leadDir, '.room', 'discarded')
    const recovery = discarded && fs.existsSync(recoveryDir)
      ? fs.readdirSync(recoveryDir).filter(name => name.startsWith(w.tag + '-') && name.endsWith('.patch')).sort().at(-1)
      : undefined
    const recoveryNote = recovery ? `actual worker edits are in ${path.join(recoveryDir, recovery)}` : `collected edits are in ${leadDir}`
    try {
      let branchExists = true
      try { await git(leadDir, ['rev-parse', '--verify', `refs/heads/${w.branch}`]) } catch { branchExists = false }
      if (!branchExists) await internalGit(leadDir, ['branch', w.branch, head])
      if (!fs.existsSync(path.join(w.dir, '.git'))) await internalGit(leadDir, ['worktree', 'add', '-q', w.dir, w.branch])
      for (const [ref, sha] of refs) await internalGit(leadDir, ['update-ref', ref, sha])
      if (record && !fs.existsSync(recordFile)) await fs.promises.writeFile(recordFile, record, { mode: 0o600 })
      for (const entry of w.carriedUntracked ?? []) {
        if (!validRepoPath(entry.path, RECORDED_PATH)) continue
        const file = path.join(w.dir, entry.path)
        if (fs.existsSync(file)) continue
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const mode = (await git(leadDir, ['ls-tree', carriedUntrackedRef(w.tag), '--', entry.path])).split(' ')[0]
        if (mode === '120000') fs.symlinkSync(boundedGitSync(leadDir, ['cat-file', 'blob', entry.sha]).toString(), file)
        else {
          const bytes = boundedGitSync(leadDir, ['cat-file', '--filters', '--path=' + entry.path, entry.sha])
          fs.writeFileSync(file, bytes, { mode: entry.mode ?? 0o644 })
          fs.chmodSync(file, entry.mode ?? 0o644)
        }
      }
    } catch (restore) { throw new Error(`cleanup failed: ${(error as Error).message}; could not restore ${w.dir}: ${(restore as Error).message}; ${recoveryNote}`) }
    throw new Error(`cleanup failed: ${(error as Error).message}; reconstructed base at ${w.dir}; ${recoveryNote}`)
  }
  const parent = path.basename(path.dirname(w.dir)) === 'workers' && path.basename(path.dirname(path.dirname(w.dir))) === '.room'
    ? path.resolve(w.dir, '../../..') : leadDir
  for (const suffix of ['.log', '.mcp.log']) {
    try { fs.rmSync(path.join(parent, WORKERS_DIR, w.tag + suffix), { force: true }) } catch { /* keep the log if the OS locks it */ }
  }
  for (const dir of [path.join(parent, WORKERS_DIR), path.join(parent, '.room')]) {
    try { fs.rmdirSync(dir) } catch { /* another worker or a locked log keeps the directory */ }
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
    const run = (args: string[]) => boundedGitSync(w.dir, args, { env: { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') } })
    const base = w.base ?? (await git(leadDir, ['merge-base', 'HEAD', w.branch])).trim()
    run(['read-tree', 'HEAD'])
    const unchanged = carriedUnchangedPaths(workerBaseline(w))
    const exclusions = [...workerOwnedPaths(w).exclusions, ...[...unchanged].map(p => ':(exclude,literal)' + p)]
    run(['add', '-A', '--', '.', ...exclusions])
    const patch = run(patchArgs(base, exclusions, true))
    if (!patch.length) return undefined
    // The recovery artifact is useful only if it applies to a fresh checkout of this base.
    const verifyDir = path.join(scratch, 'verify')
    const verifyPatch = path.join(scratch, 'verify.patch')
    fs.writeFileSync(verifyPatch, patch, { mode: 0o600 })
    await internalGit(leadDir, ['worktree', 'add', '-q', '--detach', verifyDir, base])
    try { boundedGitSync(verifyDir, ['apply', '--binary', verifyPatch]) }
    finally { await internalGit(leadDir, ['worktree', 'remove', '--force', verifyDir]) }
    fs.mkdirSync(dir, { recursive: true })
    const local = new Date(now)
    const stamp = `${local.getFullYear()}${String(local.getMonth() + 1).padStart(2, '0')}${String(local.getDate()).padStart(2, '0')}-${String(local.getHours()).padStart(2, '0')}${String(local.getMinutes()).padStart(2, '0')}${String(local.getSeconds()).padStart(2, '0')}`
    const file = path.join(dir, `${w.tag}-${stamp}.patch`)
    fs.writeFileSync(file, patch, { flag: 'wx', mode: 0o600 })
    return file
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}
