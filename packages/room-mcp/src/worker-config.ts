import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CLAUDE_CHANNEL } from './config.js'

export type WorkerHost = 'claude' | 'codex'

export const WORKER_PORT_START = 4400
export const WORKER_PORT_END = 4499

/** A small, predictable range makes simultaneous worker dev servers independent. */
export function allocateWorkerPort(used: Iterable<number>): number {
  const occupied = new Set(used)
  for (let port = WORKER_PORT_START; port <= WORKER_PORT_END; port++) if (!occupied.has(port)) return port
  throw new Error(`all worker dev-server ports (${WORKER_PORT_START}-${WORKER_PORT_END}) are in use`)
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
  share: string; run: number; nonce: string; registry: string; id: string; token?: string; logDir: string; isWorker: boolean; port?: number
  /** The epoch of the lead's reservation of the worker's name, which the worker takes over (hub §2.3). */
  nameEpoch?: number
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
    ROOM_WORKER_ID: options.id, ROOM_WORKER_RUN: String(options.run), ROOM_LAUNCH_NONCE: options.nonce,
    ROOM_REGISTRY: options.registry,
    ...(options.nameEpoch !== undefined ? { ROOM_NAME_EPOCH: String(options.nameEpoch) } : {}),
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
      ...(context.carriedPaths?.length ? [`Carried edits are the lead's work in progress, already in your worktree for you to build on. Edit around and after them freely; ask the lead before changing or removing the lead's own lines. Carried paths: ${context.carriedPaths.slice(0, 20).join(', ')}${context.carriedPaths.length > 20 ? `, and ${context.carriedPaths.length - 20} more` : ''}.`] : []),
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

/**
 * Room variables the lead's own process may carry that must never reach a worker: the runner's
 * ROOM_URL/ROOM_NAME/ROOM_DIR would send it into the lead's room under the lead's name, and the
 * lead's token, share level, tag or generation are the lead's, not the worker's. room_spawn sets
 * every variable a worker needs explicitly (ROOM_SERVER, ROOM_ROOM, ROOM_DIR, ROOM_TAG, ROOM_LEAD,
 * ROOM_OWNER, ROOM_SHARE, ROOM_LOG_FILE and, when the lead joined with one, ROOM_TOKEN).
 */
const LEAD_ONLY_ENV = ['ROOM_URL', 'ROOM_NAME', 'ROOM_DIR', 'ROOM_SERVER', 'ROOM_ROOM', 'ROOM_TAG', 'ROOM_LEAD', 'ROOM_OWNER', 'ROOM_SHARE', 'ROOM_TOKEN', 'ROOM_WORKER_ID', 'ROOM_WORKER_RUN', 'ROOM_LAUNCH_NONCE', 'ROOM_REGISTRY', 'ROOM_NAME_EPOCH', 'ROOM_WORKER_HOST', 'ROOM_WORKER_MODEL', 'ROOM_WORKER_EFFORT', 'ROOM_LOG_FILE', 'ROOM_KIND', 'PORT'] as const
/** The environment a worker process starts with: the lead's, minus LEAD_ONLY_ENV, plus the spec's variables. */
export function workerEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !(LEAD_ONLY_ENV as readonly string[]).includes(k)) out[k] = v
  return { ...out, ...extra }
}
