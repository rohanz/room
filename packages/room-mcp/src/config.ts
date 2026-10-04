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
import { gitCommonDir } from '@room/roomd'
import { mainWorktree } from '@room/roomd/local'
import { parseShare, type ShareLevel } from '@room/roomd'
import { legacyLocalBranchRoom } from './room-name.js'

export const DEFAULT_SERVER = 'wss://room-rohanz.fly.dev'
export const LOCAL = 'local'
export const DEFAULT_CLAUDE_CHANNEL = 'plugin:room@room'
const DEFAULT_MAX_WORKERS = 8
const DEFAULT_STALE_DAYS = 7

export type ConfigRule = 'argument' | 'env' | 'remembered' | 'default'
export interface ConfigArgs {
  server?: string; where?: string; name?: string; owner?: string; tag?: string; kind?: string
  share?: string; shareExplicit?: boolean; credentialsPath?: string; credentials?: string; token?: string; logFile?: string
  claudeChannel?: string; maxWorkers?: number | string; staleDays?: number | string; room?: string; web?: string; roomUrl?: string
}
export interface ResolvedConfig {
  dir: string; server: string; teamServer: string; where: string; whereRule: ConfigRule; whereEnv?: 'ROOM_SERVER' | 'ROOM_URL'
  name?: string; owner?: string; tag?: string; kind: 'agent' | 'bot' | 'ci'; share: ShareLevel; shareExplicit: boolean; shareWarning?: string
  credentialsPath: string; token?: string; logFile?: string; maxWorkers: number; staleDays: number
  room?: string; web?: string; roomUrl?: string
  claudeChannel: string; workerId?: string
  /** A remembered Room 0.16 per-branch local room and its repository room; a join to that room migrates the choice. */
  legacyLocalRoom?: { from: string; to: string }
}

const value = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined
const positive = (v: unknown, fallback: number): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback }
export function normaliseWhere(where?: string): string | undefined {
  const w = value(where)
  if (!w) return undefined
  if (['team', 'hosted', 'web', 'shared'].includes(w)) return 'team'
  return w
}
/** "team" follows the configured team server, which resolveConfig also reads from this clone. */
export function resolveServer(raw?: string, teamServer = DEFAULT_SERVER): string {
  const w = normaliseWhere(raw)
  if (!w || w === LOCAL) return LOCAL
  return w === 'team' ? teamServer : w
}

/** Plain wording shared by join, state and sharing controls. */
export function sharingDescription(level: ShareLevel, retainedChangedFiles = false): string {
  return level === 'full' ? 'the full text of files you change' : level === 'declared'
    ? `paths of every changed file; text only in your declared area${retainedChangedFiles ? '; changed files declared earlier remain shared' : ''}`
    : 'only your plans, no file text'
}

/** Spoken choices in disclosures; keep tool syntax out of notes relayed to a person. */
export function sharingHumanChoices(level: ShareLevel): string {
  if (level === 'full') return 'to keep file contents on this machine, say: share plans only; to share only my declared files, say: only my declared files.'
  if (level === 'declared') return 'to keep file contents on this machine, say: share plans only.'
  return 'to share only my declared files, say: only my declared files; to share all changed files, say: share all changed files.'
}

/** Missing means the default; an invalid supplied value can never widen sharing. */
export function resolveShare(raw: unknown, source = 'share'): { level: ShareLevel; warning?: string } {
  if (raw === undefined) return { level: 'full' }
  const level = parseShare(typeof raw === 'string' ? raw.trim() : raw)
  return level ? { level } : { level: 'intent', warning: `${source}='${String(raw)}' is not a level; sharing plans only` }
}

async function readRememberedChoice(dir: string): Promise<{ where?: string; room?: string; legacy?: { from: string; to: string } }> {
  try {
    const file = path.join(await gitCommonDir(dir), 'room-choice.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { where?: unknown; room?: unknown; schema?: unknown }
    const where = value(parsed.where), room = value(parsed.room)
    // Only a choice written before 0.17 (no schema mark) can hold a 0.16 per-branch local room.
    const to = room && normaliseWhere(where) === LOCAL && parsed.schema === undefined ? legacyLocalBranchRoom(room, path.basename(await mainWorktree(dir))) : undefined
    return to ? { where, legacy: { from: room!, to } } : { where, room }
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
  const concrete = (w?: string) => w && w !== LOCAL && w !== 'team' ? w : undefined
  let teamUrl: string | undefined
  const teamRoomUrl = value(e.ROOM_URL)
  if (teamRoomUrl) {
    const u = new URL(teamRoomUrl)
    if (!['ws:', 'wss:'].includes(u.protocol)) throw new Error('ROOM_URL must use ws:// or wss://')
    teamUrl = `${u.protocol}//${u.host}${u.search}`
  }
  const teamServer = concrete(envServer) ?? teamUrl ?? concrete(normaliseWhere(rememberedChoice.where)) ?? DEFAULT_SERVER
  const remembered = !argWhere && !argUrl && !envWhere ? normaliseWhere(rememberedChoice.where) : undefined
  const where = argWhere ?? (argUrl ? urlServer : undefined) ?? envWhere ?? remembered ?? LOCAL
  const whereRule: ConfigRule = argWhere || argUrl ? 'argument' : envWhere ? 'env' : remembered ? 'remembered' : 'default'
  const whereEnv = whereRule === 'env' ? envServer ? 'ROOM_SERVER' : 'ROOM_URL' : undefined
  const rawKind = value(args.kind) ?? value(e.ROOM_KIND) ?? 'agent'
  const kind = rawKind === 'bot' || rawKind === 'ci' ? rawKind : 'agent'
  const rawShare = args.share ?? e.ROOM_SHARE
  const sharing = resolveShare(rawShare, args.share !== undefined ? 'share' : 'ROOM_SHARE')
  // A worker's launcher supplies its initial default on every run, including retained runs.
  // Preserve the participant's durable policy after that first seed; tool arguments still override it.
  // joinSession admits the worker before any of these options reach publication.
  const shareExplicit = args.shareExplicit ?? (args.share !== undefined || rawShare !== undefined && !value(e.ROOM_WORKER_ID))
  const credentialsPath = resolveCredentialsPath(args, e)
  const explicitRoom = value(args.room) ?? value(e.ROOM_ROOM) ?? (url ? decodeURIComponent(url.pathname.replace(/^\/+/, '')) || undefined : undefined)
  return {
    // Empty explicitly disables development channels; do not discard it with value().
    claudeChannel: (args.claudeChannel ?? e.ROOM_CLAUDE_CHANNEL ?? DEFAULT_CLAUDE_CHANNEL).trim(),
    workerId: value(e.ROOM_WORKER_ID),
    roomUrl, dir: path.resolve(dir), server: resolveServer(where, teamServer), teamServer, where, whereRule, whereEnv,
    name: value(args.name) ?? value(e.ROOM_NAME), owner: value(args.owner) ?? value(e.ROOM_OWNER),
    tag: value(args.tag) ?? value(e.ROOM_TAG), kind, share: sharing.level, shareExplicit, shareWarning: sharing.warning, credentialsPath,
    token: value(args.token) ?? value(e.ROOM_TOKEN), logFile: value(args.logFile) ?? value(e.ROOM_LOG_FILE),
    maxWorkers: positive(args.maxWorkers ?? e.ROOM_MAX_WORKERS, DEFAULT_MAX_WORKERS),
    staleDays: positive(args.staleDays ?? e.ROOM_STALE_DAYS, DEFAULT_STALE_DAYS),
    room: explicitRoom ?? (whereRule === 'remembered' && where === LOCAL ? rememberedChoice.room : undefined), web: value(args.web) ?? value(e.ROOM_WEB),
    ...(where === LOCAL && rememberedChoice.legacy ? { legacyLocalRoom: rememberedChoice.legacy } : {}),
  }
}

/** Explicit worker host wins, then static plugin env and the parent process; 'agent' when none says. */
export function resolveSessionHost(env: NodeJS.ProcessEnv = process.env, parentCommand: () => string = () => execFileSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } })): string {
  const host = (v: unknown) => v === 'claude' || v === 'codex' ? v : undefined
  if (host(env.ROOM_WORKER_HOST)) return env.ROOM_WORKER_HOST!
  if (host(env.ROOM_HOST)) return env.ROOM_HOST!
  try {
    const command = path.basename(parentCommand().trim()).toLowerCase()
    if (/^codex(?:[.-]|$)/.test(command)) return 'codex'
    if (/^claude(?:[.-]|$)/.test(command)) return 'claude'
  } catch { /* ps unavailable */ }
  return value(env.CLAUDE_CODE_SESSION_ID) ? 'claude' : 'agent'
}

/**
 * Model and effort of the bound host session (ledger SF3): SessionStart's values in `session.json`,
 * overlaid by a newer `runtime.json` (written only by the before-edit hook). Never inferred from ambient
 * host configuration or inherited host-specific variables.
 */
export function resolveSessionRuntime(sessionDir: string | undefined, env: NodeJS.ProcessEnv = process.env): { model?: string; effort?: string } {
  const clean = (v: unknown) => typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 80) || undefined : undefined
  const effort = (v: unknown) => { const e = clean(v); return e && ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(e) ? e : undefined }
  const read = (name: string): Record<string, unknown> => {
    if (!sessionDir) return {}
    try { return JSON.parse(fs.readFileSync(path.join(sessionDir, name), 'utf8')) as Record<string, unknown> } catch { return {} }
  }
  const session = read('session.json'), runtime = read('runtime.json')
  const ownSession = env.ROOM_WORKER_ID ? session.worker_id === env.ROOM_WORKER_ID : !session.worker_id
  const newer = typeof runtime.at === 'number' && runtime.at >= (typeof session.at === 'number' ? session.at : 0)
  const pick = (field: 'model' | 'effort', check: (v: unknown) => string | undefined) => ownSession ? (newer ? check(runtime[field]) : undefined) ?? check(session[field]) : undefined
  return { model: pick('model', clean) ?? clean(env.ROOM_WORKER_MODEL), effort: pick('effort', effort) ?? effort(env.ROOM_WORKER_EFFORT) }
}
