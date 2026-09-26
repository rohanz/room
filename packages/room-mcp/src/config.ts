/**
 * Resolve every Room client setting in one place.
 *
 * Precedence is always: tool/caller argument > environment > remembered clone choice
 * (`<git common dir>/room-choice.json`) > default.
 */
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { gitCommonDir, worktreeGitDirFromDotGit } from '@room/roomd'
import { parseShare, type ShareLevel } from '@room/roomd'
import { newestModelInTranscriptTail } from '../../../plugins/room/hooks/common.mjs'

export const DEFAULT_SERVER = 'wss://room-rohanz.fly.dev'
export const LOCAL = 'local'
export const DEFAULT_CLAUDE_CHANNEL = 'plugin:room@room'
const DEFAULT_MAX_WORKERS = 8
const DEFAULT_STALE_DAYS = 7

export type ConfigRule = 'argument' | 'env' | 'remembered' | 'default'
export interface ConfigArgs {
  server?: string; where?: string; name?: string; owner?: string; tag?: string; kind?: string
  share?: string; credentialsPath?: string; credentials?: string; token?: string; logFile?: string
  claudeChannel?: string; maxWorkers?: number | string; staleDays?: number | string; room?: string; web?: string; roomUrl?: string
}
export interface ResolvedConfig {
  dir: string; server: string; where: string; whereRule: ConfigRule; whereEnv?: 'ROOM_SERVER' | 'ROOM_URL'
  name?: string; owner?: string; tag?: string; kind: 'agent' | 'bot' | 'ci'; share: ShareLevel; shareWarning?: string
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

/** Plain wording shared by join, state and sharing controls. */
export function sharingDescription(level: ShareLevel): string {
  return level === 'full' ? 'the full text of files you change' : level === 'declared' ? 'only the files in your declared area' : 'only your plans, no file text'
}

/** Spoken choices in disclosures; keep tool syntax out of notes relayed to a person. */
export function sharingHumanChoices(level: ShareLevel): string {
  if (level === 'full') return 'to keep file contents on this machine, say: share plans only; to share only my declared files, say: only my declared files.'
  if (level === 'declared') return 'to keep file contents on this machine, say: share plans only.'
  return ''
}

/** Missing means the default; an invalid supplied value can never widen sharing. */
export function resolveShare(raw: unknown, source = 'share'): { level: ShareLevel; warning?: string } {
  if (raw === undefined) return { level: 'full' }
  const level = parseShare(typeof raw === 'string' ? raw.trim() : raw)
  return level ? { level } : { level: 'intent', warning: `${source}='${String(raw)}' is not a level; sharing plans only` }
}

async function readRememberedChoice(dir: string): Promise<{ where?: string; share?: ShareLevel; room?: string }> {
  try {
    const file = path.join(await gitCommonDir(dir), 'room-choice.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { where?: unknown; share?: unknown; room?: unknown }
    return { where: value(parsed.where), share: parseShare(parsed.share), room: value(parsed.room) }
  } catch { return {} }
}

export function resolveCredentialsPath(args: ConfigArgs = {}, e: NodeJS.ProcessEnv = process.env): string {
  return value(args.credentialsPath ?? args.credentials) ?? value(e.ROOM_CREDENTIALS)
    ?? path.join(value(e.XDG_CONFIG_HOME) ?? path.join(os.homedir(), '.config'), 'room', 'credentials.json')
}

export async function resolveConfig({ env, args = {}, dir }: { env?: NodeJS.ProcessEnv | Record<string, string | undefined>; args?: ConfigArgs; dir: string }): Promise<ResolvedConfig> {
  const e = env ?? process.env
  const argWhere = normaliseWhere(args.where ?? args.server)
  const argUrl = !argWhere ? value(args.roomUrl) : undefined
  const envServer = normaliseWhere(e.ROOM_SERVER)
  const roomUrl = argUrl ?? (!argWhere && !envServer ? value(e.ROOM_URL) : undefined)
  const url = roomUrl ? new URL(roomUrl) : undefined
  if (url && !['ws:', 'wss:'].includes(url.protocol)) throw new Error('ROOM_URL must use ws:// or wss://')
  const urlServer = url ? `${url.protocol}//${url.host}${url.search}` : undefined
  const envWhere = envServer ?? (!argUrl ? urlServer : undefined)
  const rememberedChoice = await readRememberedChoice(dir)
  const remembered = !argWhere && !argUrl && !envWhere ? normaliseWhere(rememberedChoice.where) : undefined
  const where = argWhere ?? (argUrl ? urlServer : undefined) ?? envWhere ?? remembered ?? LOCAL
  const whereRule: ConfigRule = argWhere || argUrl ? 'argument' : envWhere ? 'env' : remembered ? 'remembered' : 'default'
  const whereEnv = whereRule === 'env' ? envServer ? 'ROOM_SERVER' : 'ROOM_URL' : undefined
  const rawKind = value(args.kind) ?? value(e.ROOM_KIND) ?? 'agent'
  const kind = rawKind === 'bot' || rawKind === 'ci' ? rawKind : 'agent'
  const rawShare = args.share ?? e.ROOM_SHARE ?? rememberedChoice.share
  const sharing = resolveShare(rawShare, args.share !== undefined ? 'share' : e.ROOM_SHARE !== undefined ? 'ROOM_SHARE' : 'remembered share')
  const credentialsPath = resolveCredentialsPath(args, e)
  return {
    // Empty explicitly disables development channels; do not discard it with value().
    claudeChannel: (args.claudeChannel ?? e.ROOM_CLAUDE_CHANNEL ?? DEFAULT_CLAUDE_CHANNEL).trim(),
    workerId: value(e.ROOM_WORKER_ID), gen: value(e.ROOM_GEN),
    roomUrl, dir: path.resolve(dir), server: resolveServer(where), where, whereRule, whereEnv,
    name: value(args.name) ?? value(e.ROOM_NAME), owner: value(args.owner) ?? value(e.ROOM_OWNER),
    tag: value(args.tag) ?? value(e.ROOM_TAG), kind, share: sharing.level, shareWarning: sharing.warning, credentialsPath,
    token: value(args.token) ?? value(e.ROOM_TOKEN), logFile: value(args.logFile) ?? value(e.ROOM_LOG_FILE),
    maxWorkers: positive(args.maxWorkers ?? e.ROOM_MAX_WORKERS, DEFAULT_MAX_WORKERS),
    staleDays: positive(args.staleDays ?? e.ROOM_STALE_DAYS, DEFAULT_STALE_DAYS),
    room: value(args.room) ?? value(e.ROOM_ROOM) ?? (url ? decodeURIComponent(url.pathname.replace(/^\/+/, '')) || undefined : undefined) ?? (whereRule === 'remembered' && where === LOCAL ? rememberedChoice.room : undefined), web: value(args.web) ?? value(e.ROOM_WEB),
  }
}

/** Explicit worker host wins, then static plugin env, parent process and the SessionStart hint. */
export function resolveSessionHost(dir: string, env: NodeJS.ProcessEnv = process.env, parentCommand: () => string = () => execFileSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } })): string {
  const host = (v: unknown) => v === 'claude' || v === 'codex' ? v : undefined
  if (host(env.ROOM_WORKER_HOST)) return env.ROOM_WORKER_HOST!
  if (host(env.ROOM_HOST)) return env.ROOM_HOST!
  try {
    const command = path.basename(parentCommand().trim()).toLowerCase()
    if (/^codex(?:[.-]|$)/.test(command)) return 'codex'
    if (/^claude(?:[.-]|$)/.test(command)) return 'claude'
  } catch { /* ps unavailable: try the session file */ }
  if (value(env.CLAUDE_CODE_SESSION_ID)) return 'claude'
  try {
    return host(JSON.parse(fs.readFileSync(sessionMetadataPath(dir), 'utf8')).host) ?? 'agent'
  } catch { return 'agent' }
}

/** Per-worktree hook file, also used when the session changes under a live MCP process. */
export function sessionMetadataPath(dir: string): string {
  return path.join(worktreeGitDirFromDotGit(dir), 'room-session.json')
}

type TranscriptFs = Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'statSync' | 'openSync' | 'readSync' | 'closeSync'>

/** Per-session bounded reader; successful reads are repeated only after the transcript changes. */
export function createClaudeTranscriptModelRefresh(io: TranscriptFs = fs): (dir: string) => string | undefined {
  const checked = new Map<string, { sessionId?: string; path: string; mtimeMs: number; size: number; model?: string }>()
  return dir => {
    const sessionFile = sessionMetadataPath(dir)
    let session: Record<string, unknown>
    try { session = JSON.parse(io.readFileSync(sessionFile, 'utf8')) as Record<string, unknown> } catch { return undefined }
    if (session.host !== 'claude' || typeof session.transcript_path !== 'string' || !session.transcript_path) return undefined
    let fd: number | undefined
    try {
      const stat = io.statSync(session.transcript_path)
      const prior = checked.get(sessionFile)
      const sameSession = prior?.sessionId === session.session_id && prior?.path === session.transcript_path
      if (sameSession && prior && prior.mtimeMs === stat.mtimeMs && prior.size === stat.size) return prior.model
      fd = io.openSync(session.transcript_path, 'r')
      const start = Math.max(0, stat.size - 64 * 1024)
      const tail = Buffer.alloc(Math.min(stat.size, 64 * 1024))
      const count = io.readSync(fd, tail, 0, tail.length, start)
      const model = newestModelInTranscriptTail(tail.subarray(0, count).toString('utf8'), start > 0)
      // The first transcript tail may predate the model reported by SessionStart.
      const effective = session.modelFromHook && !sameSession && typeof session.model === 'string' ? session.model : model
      checked.set(sessionFile, { sessionId: typeof session.session_id === 'string' ? session.session_id : undefined, path: session.transcript_path, mtimeMs: stat.mtimeMs, size: stat.size, ...(effective ? { model: effective } : {}) })
      if (effective && session.model !== effective) {
        try { io.writeFileSync(sessionFile, JSON.stringify({ ...session, model: effective }) + '\n') } catch { /* best effort */ }
      }
      return effective
    } catch { return undefined }
    finally { if (fd !== undefined) { try { io.closeSync(fd) } catch { /* best effort */ } } }
  }
}

/** Never infer model/effort from ambient host configuration or inherited host-specific variables. */
export function resolveSessionRuntime(dir: string, env: NodeJS.ProcessEnv = process.env): { model?: string; effort?: string } {
  const clean = (v: unknown) => typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80) || undefined : undefined
  const effort = (v: unknown) => { const e = clean(v); return e && ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(e) ? e : undefined }
  let session: Record<string, unknown> = {}
  try { session = JSON.parse(fs.readFileSync(sessionMetadataPath(dir), 'utf8')) as Record<string, unknown> } catch { /* unknown */ }
  // Claude supplies its session ID to stdio MCP servers, but retains the spawn-time
  // value across /clear. A newer Claude hook file is authoritative; an unrelated
  // host's file from this clone is not.
  if (env.CLAUDE_CODE_SESSION_ID && resolveSessionHost(dir, env) === 'claude' && session.session_id !== env.CLAUDE_CODE_SESSION_ID && session.host !== 'claude') session = {}
  const ownSession = env.ROOM_WORKER_ID ? session.worker_id === env.ROOM_WORKER_ID : !session.worker_id
  return { model: (ownSession ? clean(session.model) : undefined) ?? clean(env.ROOM_WORKER_MODEL), effort: (ownSession ? effort(session.effort) : undefined) ?? effort(env.ROOM_WORKER_EFFORT) }
}
