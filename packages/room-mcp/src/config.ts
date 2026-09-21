/**
 * Resolve every Room client setting in one place.
 *
 * Precedence is always: tool/caller argument > environment > remembered clone choice
 * (`<git common dir>/room-choice.json`, for `where` only) > default.
 */
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { gitCommonDir } from '@room/roomd/local'
import type { ShareLevel } from '@room/roomd'

export const DEFAULT_SERVER = 'wss://room-rohanz.fly.dev'
export const LOCAL = 'local'
export const DEFAULT_CLAUDE_CHANNEL = 'plugin:room@room'
export const DEFAULT_MAX_WORKERS = 8
export const DEFAULT_STALE_DAYS = 7

export type ConfigRule = 'argument' | 'env' | 'remembered' | 'default'
export interface ConfigArgs {
  server?: string; where?: string; name?: string; owner?: string; tag?: string; kind?: string
  share?: string; credentialsPath?: string; credentials?: string; token?: string; logFile?: string
  claudeChannel?: string; maxWorkers?: number | string; staleDays?: number | string; room?: string; web?: string; roomUrl?: string
}
export interface ResolvedConfig {
  dir: string; server: string; where: string; whereRule: ConfigRule
  name?: string; owner?: string; tag?: string; kind: 'agent' | 'bot' | 'ci'; share: ShareLevel
  credentialsPath: string; token?: string; logFile?: string; maxWorkers: number; staleDays: number
  room?: string; web?: string; roomUrl?: string
  claudeChannel: string; workerId?: string; gen?: string
}

const value = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined
const positive = (v: unknown, fallback: number): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback }
export function normaliseWhere(where?: string): string | undefined {
  const w = value(where)
  if (!w) return undefined
  if (['team', 'hosted', 'web', 'shared'].includes(w)) return 'team'
  return w
}
export function resolveServer(raw?: string): string {
  const w = normaliseWhere(raw)
  if (!w || w === LOCAL) return LOCAL
  return w === 'team' ? DEFAULT_SERVER : w
}

async function rememberedWhere(dir: string): Promise<string | undefined> {
  try {
    const file = path.join(await gitCommonDir(dir), 'room-choice.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { where?: unknown }
    return value(parsed.where)
  } catch { return undefined }
}

export function resolveCredentialsPath(args: ConfigArgs = {}, e: NodeJS.ProcessEnv = process.env): string {
  return value(args.credentialsPath ?? args.credentials) ?? value(e.ROOM_CREDENTIALS)
    ?? path.join(value(e.XDG_CONFIG_HOME) ?? path.join(os.homedir(), '.config'), 'room', 'credentials.json')
}

export async function resolveConfig({ env, args = {}, dir }: { env?: NodeJS.ProcessEnv | Record<string, string | undefined>; args?: ConfigArgs; dir: string }): Promise<ResolvedConfig> {
  const e = env ?? process.env
  const argWhere = normaliseWhere(args.where ?? args.server)
  const envWhere = normaliseWhere(e.ROOM_SERVER)
  const remembered = !argWhere && !envWhere ? normaliseWhere(await rememberedWhere(dir)) : undefined
  const where = argWhere ?? envWhere ?? remembered ?? LOCAL
  const whereRule: ConfigRule = argWhere ? 'argument' : envWhere ? 'env' : remembered ? 'remembered' : 'default'
  // A full runner URL is a fallback destination, not an override of a selected server.
  // Explicit roomUrl wins; an argument/server environment/remembered choice suppresses legacy ROOM_URL.
  const roomUrl = value(args.roomUrl) ?? (!argWhere && !envWhere && !remembered ? value(e.ROOM_URL) : undefined)
  const rawKind = value(args.kind) ?? value(e.ROOM_KIND) ?? 'agent'
  const kind = rawKind === 'bot' || rawKind === 'ci' ? rawKind : 'agent'
  const rawShare = value(args.share) ?? value(e.ROOM_SHARE) ?? 'full'
  const share: ShareLevel = rawShare === 'intent' || rawShare === 'declared' ? rawShare : 'full'
  const credentialsPath = resolveCredentialsPath(args, e)
  return {
    // Empty explicitly disables development channels; do not discard it with value().
    claudeChannel: (args.claudeChannel ?? e.ROOM_CLAUDE_CHANNEL ?? DEFAULT_CLAUDE_CHANNEL).trim(),
    workerId: value(e.ROOM_WORKER_ID), gen: value(e.ROOM_GEN),
    roomUrl, dir: path.resolve(dir), server: resolveServer(where), where, whereRule,
    name: value(args.name) ?? value(e.ROOM_NAME), owner: value(args.owner) ?? value(e.ROOM_OWNER),
    tag: value(args.tag) ?? value(e.ROOM_TAG), kind, share, credentialsPath,
    token: value(args.token) ?? value(e.ROOM_TOKEN), logFile: value(args.logFile) ?? value(e.ROOM_LOG_FILE),
    maxWorkers: positive(args.maxWorkers ?? e.ROOM_MAX_WORKERS, DEFAULT_MAX_WORKERS),
    staleDays: positive(args.staleDays ?? e.ROOM_STALE_DAYS, DEFAULT_STALE_DAYS),
    room: value(args.room) ?? value(e.ROOM_ROOM), web: value(args.web) ?? value(e.ROOM_WEB),
  }
}

/** Explicit worker host wins, then static plugin env, parent process and the SessionStart hint. */
export function resolveSessionHost(dir: string, env: NodeJS.ProcessEnv = process.env, parentCommand: () => string = () => execFileSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] })): string {
  const host = (v: unknown) => v === 'claude' || v === 'codex' ? v : undefined
  if (host(env.ROOM_WORKER_HOST)) return env.ROOM_WORKER_HOST!
  if (host(env.ROOM_HOST)) return env.ROOM_HOST!
  try {
    const command = path.basename(parentCommand().trim()).toLowerCase()
    if (/^codex(?:[.-]|$)/.test(command)) return 'codex'
    if (/^claude(?:[.-]|$)/.test(command)) return 'claude'
  } catch { /* ps unavailable: try the session file */ }
  try {
    return host(JSON.parse(fs.readFileSync(sessionMetadataPath(dir), 'utf8')).host) ?? 'agent'
  } catch { return 'agent' }
}

/** Per-worktree hook file, also used when the session changes under a live MCP process. */
export function sessionMetadataPath(dir: string): string {
  let gitDir = path.join(dir, '.git')
  try {
    if (fs.statSync(gitDir).isFile()) {
      const target = fs.readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/)?.[1].trim()
      if (target) gitDir = path.resolve(dir, target)
    }
  } catch { /* the hook may not have run yet */ }
  return path.join(gitDir, 'room-session.json')
}

/** Never infer model/effort from ambient host configuration or inherited host-specific variables. */
export function resolveSessionRuntime(dir: string, env: NodeJS.ProcessEnv = process.env): { model?: string; effort?: string } {
  const clean = (v: unknown) => typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80) || undefined : undefined
  let model: string | undefined
  try { model = clean(JSON.parse(fs.readFileSync(sessionMetadataPath(dir), 'utf8')).model) } catch { /* unknown */ }
  return { model: model ?? clean(env.ROOM_WORKER_MODEL), effort: clean(env.ROOM_WORKER_EFFORT) }
}
