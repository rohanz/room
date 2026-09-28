import fs from 'node:fs'
import path from 'node:path'
import type { Areas, RoomDoc, Claim, Msg, Plan, PlanMsg, Presence, Scope, Worker, Version } from '@room/shared'
import { DISK_READ_PATH, containedRepoPath, isInsideRoot, validRepoPath, type ShareLevel, type SharePresence } from '@room/roomd'
import type { Bridge } from '../bridge.js'
import type { ConflictSet } from '../conflict-set.js'
import type { PrInfo } from '../prs.js'
import type { Rooms } from '../registry.js'
import type { JoinOptions, Session } from '../session.js'
import type { CwdProcessLister, ProcessInfo, Spawner } from '../worker-process.js'
import type { ResolvedConfig } from '../config.js'
import type { CompanyState } from '../company.js'
import type { Batch, Ledger } from '../ledger.js'
import type { SessionBinding } from '../binding.js'
import { registryForDir } from '../worker-registry.js'
import { realStateInput } from '../worker-status.js'

export interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  /** MCP tool annotations; Codex uses these to decide whether a call needs approval. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
  _meta?: { 'anthropic/requiresUserInteraction'?: true }
}

export interface ToolCtx {
  /** Current session, or null before room_join. */
  getSession(): Session | null
  setSession(s: Session | null): void
  /** Working directory used by room_join when the caller passes none. */
  cwd: string
  /** Injectable for tests. */
  join?: (o: JoinOptions) => Promise<Session>
  leave?: (s: Session) => Promise<void>
  /** Injectable for tests (default: DELETE /rooms on the session's server). Returns the rooms closed. */
  close?: (s: Session) => Promise<string[]>
  /** Debounce for the automatic conflict checks; default 2s. */
  conflictDebounceMs?: number
  now?: () => number
  /** Collection exit grace period; injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable wake for tests (default: `codex queue`). */
  queue?: (threadId: string, text: string) => Promise<void>
  /** Diagnostics (inbox deliveries etc.); default stderr. */
  log?: (line: string) => void
  /** Called for a secondary session (the workers room) so the host can push its wake-ups too. */
  attachChannel?: (s: Session) => void
  /** Pull-request integration; injectable for tests. */
  prs?: { fetch?: (s: Session, opts?: { head?: boolean; branch?: string }) => Promise<PrInfo[]>; post?: (s: Session, number: number, body: string) => Promise<{ url: string; updated: boolean }>; intervalMs?: number }
  /** Workers (room_spawn): injectable process starter and worktree maker for tests. */
  spawner?: Spawner
  worktree?: (repoDir: string, tag: string) => Promise<{ dir: string; branch: string; created: boolean; base?: string }>
  maxWorkers?: number
  /** Client settings resolved once at startup; tests may omit it to use defaults. */
  config?: ResolvedConfig
  /** What `ps` knows about a pid; injectable for tests. */
  probe?: (pid: number) => ProcessInfo | undefined
  /** Processes with a cwd; injectable for tests (default: OS process list). */
  listCwdProcesses?: CwdProcessLister
  /** This MCP's host session (receipts, session directory); tests default to an unbound synthetic session. */
  binding?: SessionBinding
  /** How long a hook's selection stays reserved without a confirm; injectable for tests. */
  hookLeaseMs?: number
}

export type Handler = (args: Record<string, unknown>) => Promise<string>
/** Internal argument supplied by the tool wrapper, never by MCP callers: the reply's ledger batch. */
export const REPLY_BATCH = Symbol('reply batch')

/** Explicit shared state passed to every concern's handlers factory. */
export interface HandlerState {
  ctx: ToolCtx
  now: () => number
  log: (line: string) => void
  doJoin: (o: JoinOptions) => Promise<Session>
  doLeave: (s: Session) => Promise<void>
  doClose: (s: Session) => Promise<string[]>
  /** The session's delivery ledger: the only selector and receipt writer. */
  ledger: Ledger
  rooms: Rooms
  S: () => Session
  isMe: (s: Session, p: { name: string; kind: string }) => boolean
  mine: (s: Session) => Claim[]
  myWorkers: (s: Session) => Worker[]
  workerAlive: (s: Session, w: Worker) => boolean
  ensureWorkersRoom: (lead: Session) => Promise<Session>
  closeWorkersRoom: () => Promise<void>
  runningWorkers: (s: Session) => { s: Session; w: Worker }[]
  hasCompany: (s: Session) => CompanyState
  dismissWorker: (s: Session, w: Worker, why: string, stopReason?: Worker['stopReason'], cancelled?: AbortSignal) => string | Promise<string>
  others: (s: Session) => string[]
  presences: (s: Session) => SharePresence[]
  shareOf: (s: Session, person: string) => ShareLevel
  shareLine: (s: Session) => string
  setPresence: (s: Session, patch: Partial<Presence>) => void
  base: (s: Session) => string
  baseFor: (s: Session, person: string) => string
  baseText: (s: Session, path: string, person?: string) => Promise<string | undefined>
  readText: (s: Session, path: string, person: string) => Promise<string | undefined | null>
  readVersion: (s: Session, path: string, person: string) => Promise<Version>
  lines: (text: string) => number
  loadAreas: (s: Session) => Promise<Areas>
  areasOf: (s: Session) => Areas
  areasFor: (s: Session, person: string) => string[]
  myAreas: (s: Session) => string[]
  inMyAreas: (s: Session, person: string) => boolean
  areaLines: (s: Session, areas: string[]) => string[]
  ownerHints: (s: Session, areas: string[]) => string[]
  msgInMyAreas: (s: Session, msg: Msg) => boolean
  forMe: (s: Session, msg: Msg) => boolean
  /** Select what `s` (and its workers room) is owed into `batch`, rendered as the reply's inbox prefix. */
  inbox: (s: Session, batch: Batch) => string
  waitingOn: (s: Session) => Promise<string[]>
  describeUsers: (s: Session, files: string[]) => string
  planChanged: (s: Session, claim: Claim, plan: Plan, status: PlanMsg['status'], text: string, replacedBy?: Plan) => string[]
  followBranch: () => Promise<string>
  evictStale: (s: Session) => string[]
  cleanupMine: (s: Session, why: string, keep?: (claim: Claim) => boolean) => number
  upgrade: (s: Session, msg: Msg, paths: string[], symbols: string[]) => Promise<string[]>
  claimLine: (s: Session, claim: Claim) => string
  ledgerLines: (s: Session, query: NonNullable<Parameters<RoomDoc['ledger']>[0]>, label: string, excludeId?: string) => string[]
  scopeLine: (scope: Scope) => string
  personLine: (s: Session, name: string) => string
  serverOf: (args: Record<string, unknown>) => string
  LOCAL_LOGIN: string
  codeLine: (pending: { provider?: string; verification_uri?: string; user_code?: string; url?: string; expires_in: number }) => string
  refreshPrs: (s: Session) => Promise<string>
  startPrSync: (s: Session) => void
  stopPrSync: () => void
  prLines: (s: Session) => string[]
  myPr: (s: Session) => Promise<PrInfo | undefined>
  postLedger: (s: Session, pr: PrInfo) => Promise<string>
  startConflictSet: (s: Session) => ConflictSet
  startWorkersBridge: (lead: Session, workers: Session) => Bridge
  workerPaths: () => string[]
  /** Rewrite the hook's state.json (counts only) after a delivery changed what is owed. */
  scheduleInboxWrite: () => void
  upgraded: Set<string>
  attachHooks: (s: Session) => void
  clearStale: (s: Session) => number
  shutdown: () => Promise<void>
  drop: (s: Session, reason: string) => Promise<void>
  flushConflicts: () => Promise<void>
}

/** Room tools only touch the shared room doc, never the user's files, so none is destructive. */
export const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
export const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
export const str = (d: string) => ({ type: 'string', description: d })
export const int = (d: string) => ({ type: 'integer', description: d })
export const strs = (d: string) => ({ type: 'array', items: { type: 'string' }, description: d })
export const PLANS = {
  type: 'array',
  description: 'Public API changes planned before editing.',
  items: { type: 'object', properties: {
    kind: { type: 'string', enum: ['rename', 'signature', 'delete', 'add'] },
    symbol: str('current symbol'),
    detail: str('new name/signature or reason'),
  }, required: ['kind', 'symbol'] },
}
export const SHARE = { type: 'string', enum: ['intent', 'declared', 'full'], description: 'intent: plans only; declared: scoped files; full: all changed files' }

export class NotJoined extends Error {}
/** A person's base is not in this clone; `lead` is set when it is a worker's carried commit, which only its lead's machine has. */
export class NeedFetch extends Error { constructor(public person: string, public sha: string, public detail: string, public lead?: string) { super(detail) } }

/** Local worktree reads require a registry capability; replicated worker fields grant none. */
export async function trustedWorker(s: Session, person: string): Promise<Worker | undefined> {
  const worker = s.room.workerOf(person)
  if (!worker?.id || worker.lead !== s.me.name) return undefined
  const trusted = await (await registryForDir(s.dir)).trusted({ participant: s.me.name, room: s.roomName, dir: s.dir }, worker.tag)
  if (!trusted || trusted.record.id !== worker.id || trusted.record.name !== person) return undefined
  return { ...realStateInput(trusted.record, trusted.status), dir: fs.realpathSync(trusted.record.dir) }
}
export const WORKTREE_NOTE = "(read from the worker's worktree on disk; the worker is not connected)"

/** Resolve both lexical and symlink paths before reading anything outside git. */
export function workerText(dir: string, rel: string): string | null {
  if (!validRepoPath(rel, DISK_READ_PATH)) throw new Error('unsafe worker path: ' + rel)
  const root = fs.realpathSync(dir)
  const candidate = path.resolve(root, rel)
  if (!isInsideRoot(root, candidate)) throw new Error('unsafe worker path: ' + rel)
  try {
    const result = containedRepoPath(root, candidate, { leaf: 'read-contained-link' })
    if (!result.ok) throw new Error('unsafe worker symlink: ' + rel)
    const real = result.path
    return fs.readFileSync(real, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
