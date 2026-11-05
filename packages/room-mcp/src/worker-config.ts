import fs from 'node:fs'
import { CURRENT_COMPAT, selectContract } from '@room/hub-core'
import { WORKER_RECORD_SCHEMA } from '@room/shared'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { leadClaudePluginDir as adapterLeadClaudePluginDir } from './hosts/claude-install.js'
import { installedCodexRoomContract as adapterInstalledCodexRoomContract, type WorkerContract } from './hosts/codex-install.js'
export type { WorkerContract } from './hosts/codex-install.js'
import pluginManifest from '../../../plugins/room/.claude-plugin/plugin.json' with { type: 'json' }
import { DEFAULT_CLAUDE_CHANNEL } from './config.js'
import { normalizeExplicitRoomName } from './room-name.js'
import { workerAdapter } from './hosts/index.js'
import type { HostId as WorkerHost } from './hosts/types.js'
import { workerRuntimeForHost } from './hosts/selection.js'

export type { HostId as WorkerHost } from './hosts/types.js'

export function workerRuntime(host: WorkerHost, model?: string, effort?: string, env: NodeJS.ProcessEnv = process.env): { model?: string; effort?: string } {
  return workerRuntimeForHost(host, { model, effort }, env)
}

/** Read only public model settings; neither host's credential files are inspected. */
export function hostDefaultRuntime(host: WorkerHost, dir: string, env: NodeJS.ProcessEnv = process.env): { model?: string; effort?: string } {
  return workerAdapter(host, env).defaults(dir)
}

export const WORKER_PORT_START = 4400
export const WORKER_PORT_END = 4499

/** Ports held by this checkout's live workers; a retired or abandoned record's port is free again. */
export function workerPortsInUse(records: Iterable<{ port?: number; phase: string }>): number[] {
  const ports: number[] = []
  for (const record of records) if (typeof record.port === 'number' && record.phase !== 'retired' && record.phase !== 'abandoned') ports.push(record.port)
  return ports
}

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

/**
 * A virtualenv activated from the lead's checkout would run the lead's editable installs; point it, and its
 * PATH entry, at the same place in the worker's worktree, where `uv sync` creates the worker's own.
 */
function workerVirtualEnv(leadDir: string, workerDir: string, inherited: NodeJS.ProcessEnv): Record<string, string> {
  const venv = inherited.VIRTUAL_ENV
  if (!venv) return {}
  const rel = path.relative(leadDir, venv), mine = path.relative(workerDir, venv)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !(mine.startsWith('..') || path.isAbsolute(mine))) return {}
  const own = path.join(workerDir, rel), bin = process.platform === 'win32' ? 'Scripts' : 'bin'
  const PATH = inherited.PATH?.split(path.delimiter).map(p => p && path.resolve(p) === path.join(venv, bin) ? path.join(own, bin) : p).join(path.delimiter)
  return { VIRTUAL_ENV: own, ...(PATH === undefined ? {} : { PATH }) }
}

export function workerProcessEnv(options: {
  threads: number; memGb: number; host: WorkerHost; model?: string; effort?: string
  server: string; room: string; dir: string; tag: string; lead: string; owner: string
  share: string; run: number; nonce: string; registry: string; id: string; token?: string; logDir: string; isWorker: boolean; port?: number; leadClone?: string
  /** The epoch of the lead's reservation of the worker's name, which the worker takes over (hub §2.3). */
  nameEpoch?: number
  /** A Claude worker's CLAUDE_ENV_FILE, which keeps the ROOM_ variables below from its shell commands (worker-shell-env.ts). */
  shellEnvFile?: string
}, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const caps: Record<string, string> = {}
  for (const key of WORKER_THREAD_CAPS) {
    const cap = Number(inherited[key])
    caps[key] = options.isWorker ? String(Number.isSafeInteger(cap) && cap >= 1 ? Math.min(cap, options.threads) : options.threads) : inherited[key] ?? String(options.threads)
  }
  return {
    ...caps, ...workerVirtualEnv(options.logDir, options.dir, inherited), ROOM_WORKER_THREADS: String(options.threads), ROOM_WORKER_MEM_GB: String(options.memGb),
    ROOM_WORKER_HOST: options.host, ...(options.model ? { ROOM_WORKER_MODEL: options.model } : {}), ...(options.effort ? { ROOM_WORKER_EFFORT: options.effort } : {}),
    ROOM_SERVER: options.server, ROOM_ROOM: options.server === 'local' ? options.room : normalizeExplicitRoomName(options.room), ROOM_DIR: options.dir, PWD: options.dir,
    ...(options.port ? { PORT: String(options.port) } : {}),
    ...(options.host === 'claude' && options.shellEnvFile ? { CLAUDE_ENV_FILE: options.shellEnvFile } : {}),
    ROOM_TAG: options.tag, ROOM_LEAD: options.lead, ROOM_OWNER: options.owner, ROOM_SHARE: options.share,
    ROOM_WORKER_ID: options.id, ROOM_WORKER_RUN: String(options.run), ROOM_LAUNCH_NONCE: options.nonce,
    ROOM_REGISTRY: options.registry,
    ...(options.leadClone ? { ROOM_LEAD_CLONE: options.leadClone } : {}),
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
export function workerPrompt(lead: string, tag: string, task: string, context?: { threads: number; memGb: number; nice: number; effort?: string; port?: number; link?: string[]; carriedPaths?: string[]; deps?: string }): string {
  return [
    `You are worker "${tag}", dispatched by ${lead} into the room for this repo. Follow the room-etiquette skill:`,
    `room_scope first, claim before editing. Ask the peer responsible for a dependency directly with room_send(type "question", to "<returned peer name>"); ask ${lead} for scope decisions or unresolved ownership.`,
    `Continue independent work while an answer is pending. If blocked, use room_wait(questionId) for that answer or room_wait(claimId) for the blocking claim; a timeout is not an answer or approval. Permission decisions stay with the human.`,
    `Choose task-appropriate validation: focused checks for your changes and, when needed, room_preview_merge with named peers for affected interfaces; send failures to their owner. Preview current overlapping work before finishing, then room_done with a one-line summary and finish the headless process. Your lead can resume this session for a later follow-up while the worktree remains.`,
    `Do not commit or push unless the task says so. You are on your own git worktree and branch; write only inside it, never into the lead's checkout or another worker's worktree: outputs the lead needs come back through collection. The lead merges.`,
    `If you spawn workers, collect them before your own room_done.`,
    `Report progress in room_done; send dependency findings to their owning peer. Send a lead note only when it must know before you finish.`,
    `On Claude Code with documented background-command lifetime and completion delivery (verified on 2.1.300), use host-managed background commands when responsiveness matters; await completion and inspect the actual result before room_done. On unverified hosts, including Codex, use foreground commands until background lifetime and completion delivery are verified. See room-etiquette for host limits; process exit can terminate unmanaged jobs.`,
    `Room workers run as plain \`codex exec\` / \`claude -p\` processes too (ROOM_WORKER_ID in their environment marks them): stop jobs you started by their own pid, never by a pattern such as \`pkill -f codex\`.`,
    ...(context ? [
      `Compute budget: ${context.threads} threads, ~${context.memGb} GB RAM; scheduling priority: ${context.nice ? `nice ${context.nice}` : 'normal'}; reasoning effort: ${context.effort ?? 'host default'}. Stay within this budget and stagger heavy jobs.`,
      ...(context.port ? [`Your dev-server port is ${context.port} (PORT=${context.port}).`] : []),
      ...(context.link?.length ? [`Read-only inputs linked from the lead's clone: ${context.link.join(', ')}. Do not modify these paths or their contents; write outputs elsewhere.`] : []),
      ...(context.carriedPaths?.length ? [`Carried edits are the lead's work in progress, already in your worktree for you to build on. Edit around and after them freely; ask the lead before changing or removing the lead's own lines. Carried paths: ${context.carriedPaths.slice(0, 20).join(', ')}${context.carriedPaths.length > 20 ? `, and ${context.carriedPaths.length - 20} more` : ''}.`] : []),
      ...(context.deps ? [context.deps] : []),
    ] : []),
    '',
    `TASK: ${task}`,
  ].join('\n')
}

export const WORKER_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const
export function hostWorkerEffort(host: WorkerHost, effort?: string): string | undefined { return workerAdapter(host).normalizeRuntime({ effort }).effort }

export interface WorkerCommandOptions { tag?: string; sessionId?: string; resume?: boolean; maxBudgetUsd?: string; wakeChannels?: boolean; pluginDir?: string; shellEnvHook?: boolean }

/** The bundle path identifies the plugin Claude actually loaded, even when its root env is absent. */
export function leadClaudePluginDir(env: NodeJS.ProcessEnv = process.env, modulePath = fileURLToPath(import.meta.url), installedPath?: string): string | undefined {
  return adapterLeadClaudePluginDir(env, modulePath, installedPath)
}

/** Resolve the installed entry selected by Codex, then authenticate its descriptor against its executable. */
export function installedCodexRoomContract(env: NodeJS.ProcessEnv = process.env): WorkerContract | undefined {
  return adapterInstalledCodexRoomContract(env)
}

export function codexRoomCompatibilityMismatch(
  lead: WorkerContract = { release: pluginManifest.version, compat: CURRENT_COMPAT, workerRecordSchema: WORKER_RECORD_SCHEMA },
  installed: WorkerContract | undefined = undefined,
  diagnostic?: (line: string) => void,
): string | undefined {
  if (arguments.length < 2) installed = installedCodexRoomContract()
  if (!installed) return "Codex's installed Room executable contract is unverified; update Room for Codex, then reconnect Room with /mcp or restart the session before spawning a worker"
  const selected = selectContract(installed.compat, lead.compat, { activeSchema: 2 })
  if (selected.ok && installed.workerRecordSchema === lead.workerRecordSchema) {
    if (installed.release !== lead.release) diagnostic?.(`Codex Room ${installed.release} and lead Room ${lead.release} have compatible protocol and worker record contracts`)
    return undefined
  }
  const newer = installed.release.localeCompare(lead.release, undefined, { numeric: true }) > 0
  const reason = installed.workerRecordSchema !== lead.workerRecordSchema
    ? `worker record schemas differ (lead ${lead.workerRecordSchema}, Codex ${installed.workerRecordSchema})`
    : selected.ok ? '' : selected.error.text
  return `Codex has Room ${installed.release}, but this lead runs Room ${lead.release}: ${reason}; ${newer ? 'reconnect Room with /mcp or restart the session to load the installed Room contract' : 'update Room for Codex to a compatible protocol and worker record schema'}`
}
export function workerCommand(host: WorkerHost, model: string | undefined, prompt: string, claudeChannel = DEFAULT_CLAUDE_CHANNEL, effort?: string, options: WorkerCommandOptions = {}): { cmd: string; args: string[] } {
  if (effort !== undefined && !(WORKER_EFFORTS as readonly string[]).includes(effort)) throw new Error(`effort must be ${WORKER_EFFORTS.join('|')}`)
  effort = hostWorkerEffort(host, effort)
  if (options.resume && !options.sessionId) throw new Error('resuming a worker requires its host session id')
  return workerAdapter(host).command({ ...options, mode: options.resume ? 'resume' : 'fresh',
    runtime: { model, effort }, prompt, claudeChannel, tag: options.tag ?? '',
    shellEnvHook: options.shellEnvHook ?? false, wakeChannels: options.wakeChannels ?? false })
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
const LEAD_ONLY_ENV = ['ROOM_URL', 'ROOM_NAME', 'ROOM_DIR', 'ROOM_SERVER', 'ROOM_ROOM', 'ROOM_TAG', 'ROOM_LEAD', 'ROOM_LEAD_CLONE', 'ROOM_OWNER', 'ROOM_SHARE', 'ROOM_TOKEN', 'ROOM_WORKER_ID', 'ROOM_WORKER_RUN', 'ROOM_LAUNCH_NONCE', 'ROOM_REGISTRY', 'ROOM_NAME_EPOCH', 'ROOM_WORKER_HOST', 'ROOM_WORKER_MODEL', 'ROOM_WORKER_EFFORT', 'ROOM_CODEX_WORKER_MODEL', 'ROOM_CODEX_WORKER_EFFORT', 'ROOM_CLAUDE_WORKER_MODEL', 'ROOM_CLAUDE_WORKER_EFFORT', 'ROOM_LOG_FILE', 'ROOM_KIND', 'PORT'] as const
/** The environment a worker process starts with: the lead's, minus LEAD_ONLY_ENV, plus the spec's variables. */
export function workerEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !(LEAD_ONLY_ENV as readonly string[]).includes(k)) out[k] = v
  return { ...out, ...extra }
}
