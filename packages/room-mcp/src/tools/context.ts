import fs from 'node:fs'
import path from 'node:path'
import { Areas, CODEOWNERS_PATHS, RoomDoc, claimsOverlap, describeClaim, formatMsg, formatPlans, isAgentic, msgPaths, scopeCovers, sharesArea } from '@room/shared'
import type { Claim, ConflictMsg, Msg, NoteMsg, Plan, PlanMsg, Presence, Priority, ReleaseMsg, Scope, Worker } from '@room/shared'
import { type ShareLevel, type SharePresence } from '@room/roomd'
import { git, gitShow } from '@room/roomd/git'
import { workerBaseline } from '@room/roomd/baseline'
import { Bridge } from '../bridge.js'
import { HooksBridge } from '../hooks-bridge.js'
import { ConflictWatcher } from '../conflicts.js'
import { branchOf, fetchPrs, isPrName, openPrs, postPrNote, prLeader, renderPrNote, syncPrs, type PrInfo } from '../prs.js'
import { Rooms, type Attachment, type Role } from '../registry.js'
import { authFor, closeRoom, DEFAULT_SERVER, joinSession, leaveSession, LOCAL, parseServer, resolveServer, type JoinOptions, type Session } from '../session.js'
import { pidIsOurWorker, signalWorker, type ProcessInfo, type Spawner } from '../workers.js'
import type { ResolvedConfig } from '../config.js'
import { hasCompany, type CompanyState } from '../company.js'

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
  prs?: { fetch?: (s: Session, opts?: { head?: boolean }) => Promise<PrInfo[]>; post?: (s: Session, number: number, body: string) => Promise<{ url: string; updated: boolean }>; intervalMs?: number }
  /** Workers (room_spawn): injectable process starter and worktree maker for tests. */
  spawner?: Spawner
  worktree?: (repoDir: string, tag: string) => Promise<{ dir: string; branch: string; created: boolean; base?: string }>
  maxWorkers?: number
  /** Client settings resolved once at startup; tests may omit it to use defaults. */
  config?: ResolvedConfig
  /** What `ps` knows about a pid; injectable for tests. */
  probe?: (pid: number) => ProcessInfo | undefined
}

export type Handler = (args: Record<string, unknown>) => Promise<string>

/** Explicit shared state passed to every concern's handlers factory. */
export interface HandlerState {
  ctx: ToolCtx
  now: () => number
  log: (line: string) => void
  doJoin: (o: JoinOptions) => Promise<Session>
  doLeave: (s: Session) => Promise<void>
  doClose: (s: Session) => Promise<string[]>
  seen: Set<string>
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
  dismissWorker: (s: Session, w: Worker, why: string, stopReason?: Worker['stopReason']) => string | Promise<string>
  others: (s: Session) => string[]
  presences: (s: Session) => SharePresence[]
  shareOf: (s: Session, person: string) => ShareLevel
  withheld: (s: Session, person: string, path?: string) => string | undefined
  shareLine: (s: Session) => string
  setPresence: (s: Session, patch: Partial<Presence>) => void
  base: (s: Session) => string
  baseFor: (s: Session, person: string) => string
  baseText: (s: Session, path: string, person?: string) => Promise<string | undefined>
  liveText: (s: Session, path: string, person: string) => Promise<string | undefined | null>
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
  inbox: (s: Session) => string
  waitingOn: (s: Session) => Promise<string[]>
  describeUsers: (s: Session, files: string[]) => string
  planChanged: (s: Session, claim: Claim, plan: Plan, status: PlanMsg['status'], text: string, replacedBy?: Plan) => string[]
  followBranch: () => Promise<string>
  evictStale: (s: Session) => string[]
  cleanupMine: (s: Session, why: string, keep?: (claim: Claim) => boolean) => number
  upgrade: (s: Session, msg: Msg, paths: string[], symbols: string[]) => Promise<string[]>
  claimLine: (s: Session, claim: Claim) => string
  ledgerLines: (s: Session, query: NonNullable<Parameters<RoomDoc['ledger']>[0]>, label: string) => string[]
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
  observeClaims: (s: Session) => void
  startConflictWatcher: (s: Session) => ConflictWatcher
  startWorkersBridge: (lead: Session, workers: Session) => Bridge
  workerPaths: () => string[]
  scheduleInboxWrite: () => void
  upgraded: Set<string>
  conflictPairs: Set<string>
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

/** Only disconnected local workers may expose their worktree to the lead. */
export function diskWorker(s: Session, person: string): Worker | undefined {
  if (!s.local || s.room.overlays.get(person)?.size) return undefined
  if ([...s.awareness.getStates().values()].some(p => p.user?.name === person)) return undefined
  const worker = s.room.workerOf(person)
  return worker?.dir && fs.existsSync(worker.dir) ? worker : undefined
}
export const WORKTREE_NOTE = "(read from the worker's worktree on disk; the worker is not connected)"

/** Resolve both lexical and symlink paths before reading anything outside git. */
function workerText(dir: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error('unsafe worker path: ' + rel)
  const root = fs.realpathSync(dir)
  const candidate = path.resolve(root, rel)
  if (!candidate.startsWith(root + path.sep)) throw new Error('unsafe worker path: ' + rel)
  try {
    const real = fs.realpathSync(candidate)
    if (!real.startsWith(root + path.sep)) throw new Error('unsafe worker symlink: ' + rel)
    return fs.readFileSync(real, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export function createHandlerState(ctx: ToolCtx): HandlerState {
  const now = ctx.now ?? (() => Date.now())
  const log = ctx.log ?? ((l: string) => process.stderr.write(`room-mcp: ${l}\n`))
  const doJoin = ctx.join ?? joinSession
  const doLeave = ctx.leave ?? leaveSession

  // ---- per-session state --------------------------------------------------
  const seen = new Set<string>() // message ids already shown in the inbox (ids, not indexes: the bus is a concurrent array)
  const upgraded = new Set<string>() // "msgId:person" copies already posted
  const conflictPairs = new Set<string>() // sorted "a:b" claim-id pairs already reported
  /** The lead-in-two-rooms bridge, while a workers room is open (owned by that session's attachment). */
  let roomBridge: Bridge | null = null
  /** The primary session's hooks bridge (state file); the inbox asks it to rewrite after marking messages seen. */
  let primaryHooks: HooksBridge | null = null
  let runtime!: HandlerState
  const doClose = ctx.close ?? (async (s: Session) => { const a = await authFor(s); return closeRoom(a.server, s.roomName, { session: a.session, token: a.token }) })
  /**
   * Everything a joined session needs running. The primary gets the hooks bridge (state file + wake),
   * the conflict watcher and the PR mirror. The workers room gets a wake-only hooks bridge (the state
   * file is the team room's), the host's channel push, and the bridge to the lead's team room.
   */
  const attach = (s: Session, role: Role, lead?: Session): Attachment => {
    const hooks = new HooksBridge(s, { forMe: m => runtime.forMe(s, m), isSeen: id => seen.has(id), company: () => runtime.hasCompany(s), log, queue: ctx.queue, ...(role === 'workers' ? { writeState: false } : {}) })
    hooks.start()
    if (role === 'primary') primaryHooks = hooks
    let watcher: ConflictWatcher | null = null
    let bridge: Bridge | null = null
    if (role === 'primary') {
      watcher = runtime.startConflictWatcher(s)
      runtime.startPrSync(s)
    } else if (lead) {
      bridge = runtime.startWorkersBridge(lead, s)
      roomBridge = bridge
    }
    return {
      stop() {
        hooks.stop(); watcher?.stop()
        if (primaryHooks === hooks) primaryHooks = null
        if (role === 'primary') runtime.stopPrSync()
        if (bridge) { bridge.stop(); if (roomBridge === bridge) roomBridge = null }
      },
      flush: () => watcher?.flush() ?? Promise.resolve(),
    }
  }
  const rooms = new Rooms({ primary: () => ctx.getSession(), setPrimary: s => ctx.setSession(s), observeClaims: s => runtime.observeClaims(s), attach })

  // ---- pull requests as intent ------------------------------------------------
  /** Refresh the PR mirror in the doc when I am the elected maintainer (lowest present name). Never throws. */







  /** room_state section: open PRs targeting this branch, from the mirror. */

  /** The open PR whose head is this branch (any base), asked of GitHub; falls back to the mirror (PRs targeting this branch). */

  /** Render the ledger and post it as the one room comment on the PR. */

  /** Two room_claim calls on different machines can both pass the overlap pre-check. When the
   *  other claim arrives, the owner of the lexicographically smaller id reports the conflict. */


  const S = (): Session => {
    const s = ctx.getSession()
    if (!s) throw new NotJoined()
    for (const roomSession of new Set([s, ...rooms.all()])) {
      const present = new Set(Array.from(roomSession.awareness?.getStates().values() ?? []).flatMap(p => p.user?.name ? [p.user.name] : []))
      roomSession.room.sweepRetiredWorkers(present)
    }
    return s
  }
  const isMe = (s: Session, p: { name: string; kind: string }) => p.name === s.me.name && p.kind === s.me.kind
  const mine = (s: Session) => s.room.openClaims().filter(c => c.by === s.me.name && c.byKind === s.me.kind)

  /** Is a process for this worker record alive: one we spawned, or (after a lead restart) one `ps` vouches for. */

  /** Open (once) the local workers room next to a team session and bridge the two. */


  /** Workers this lead has running, in every room it is in. */

  /**
   * Stop a running worker. A process this MCP instance spawned is signalled directly. One we only
   * know by pid (the lead restarted) is signalled only if it is alive and started with the worker
   * record: a recycled pid would belong to something else. The record becomes `dismissed` only when
   * a signal was actually delivered; otherwise its status stands and the reply says so.
   */


  const others = (s: Session): string[] => {
    const names = new Set<string>()
    for (const k of s.room.scopes.keys()) names.add(k)
    for (const k of s.room.overlays.keys()) names.add(k)
    for (const p of presences(s)) names.add(p.user.name)
    names.delete(s.me.name)
    const retired = new Set(s.room.retiredWorkers().map(w => w.name))
    return Array.from(names).filter(n => !isPrName(n) && (!retired.has(n) || s.room.workerOf(n))).sort() // PR mirrors and retired workers are not routed to
  }
  const presences = (s: Session): SharePresence[] =>
    Array.from(s.awareness.getStates().values()).filter((x): x is SharePresence => !!x && typeof x === 'object' && !!(x as Presence).user)
  /** A person's sharing level as their presence announces it; absent presence or an older client means full. */
  const shareOf = (s: Session, person: string): ShareLevel => {
    if (person === s.me.name) return s.daemon.share ?? 'full'
    const p = presences(s).find(x => x.user.name === person && isAgentic(x.user.kind)) ?? presences(s).find(x => x.user.name === person)
    return p?.share ?? 'full'
  }
  /** Why a person's version of a path is not in the room, or undefined when it is (or could be). */
  const withheld = (s: Session, person: string, p?: string): string | undefined => {
    const level = shareOf(s, person)
    if (level === 'intent') return `${person} shares intent only; ask them or wait for their push`
    if (level === 'declared' && p !== undefined && !scopeCovers({ paths: s.room.scope(person)?.paths ?? [] }, p)) return `${p}: not shared (${person} shares declared paths only; ${p} is outside their scope)`
    return undefined
  }
  /** One line for join/room_share replies: the level, and whether the server lowered it. */

  const setPresence = (s: Session, patch: Partial<Presence>) => {
    const cur = (s.awareness.getLocalState() ?? {}) as Partial<Presence>
    s.awareness.setLocalState({ ...cur, ...patch, lastActive: now() })
  }
  const base = (s: Session) => s.room.meta.base ?? 'HEAD'
  /** The commit a person's overlay is a delta from (their own HEAD), falling back to the room base. A carried worker in a
   *  team room publishes its lead's HEAD, because only the lead's machine has the carried commit; that machine (the lead
   *  and its workers) uses the carried commit itself. */
  const baseFor = (s: Session, person: string) => {
    const worker = diskWorker(s, person)
    if (worker) return worker.base ?? base(s)
    const record = s.room.workerOf(person)
    if (workerBaseline(record)?.carriedCommit && (record!.lead === s.me.name || s.room.workerOf(s.me.name)?.lead === record!.lead)) return record!.base!
    return s.room.baseOf(person) ?? base(s)
  }
  const baseText = async (s: Session, path: string, person = s.me.name): Promise<string | undefined> => gitShow(diskWorker(s, person)?.dir ?? s.dir, baseFor(s, person), path)
  /** A person's HEAD + their overlay; undefined if the file exists nowhere; null if they deleted it.
   *  Throws NeedFetch when their HEAD is not in this clone. */
  const liveText = async (s: Session, path: string, person: string): Promise<string | undefined | null> => {
    const worker = diskWorker(s, person)
    if (worker) return workerText(worker.dir, path)
    if (s.room.deleted.get(person)?.has(path)) return null
    const ov = s.room.text(path, person)
    if (ov !== undefined) return ov
    try { return await baseText(s, path, person) }
    catch (e) {
      const sha = baseFor(s, person), worker = s.room.workerOf(person), baseline = workerBaseline(worker)
      throw new NeedFetch(person, sha, e instanceof Error ? e.message : String(e), baseline?.carriedCommit && baseline.sha === sha ? worker!.lead : undefined)
    }
  }
  const lines = (t: string) => t.endsWith('\n') ? t.split('\n').length - 1 : t.split('\n').length

  // ---- areas ------------------------------------------------------------------
  /** Area index per session: CODEOWNERS at the room base (or top-level dirs). Loaded once per join. */



  /** Areas a person is in: those covering their declared scope paths and their changed paths. */



  /** Who else is in any of these areas, with the areas they share. */

  /** "owners of api/: @rohanz, @kieran" for areas I do not own per CODEOWNERS; nothing without CODEOWNERS. */


  /** Does a message concern my areas: any of its paths lands in one, or its sender is in one. */


  // ---- inbox ----------------------------------------------------------------



  // ---- scope upgrade rule ---------------------------------------------------
  /** Who else is affected by these paths/symbols: scope covers a path, or their files mention a symbol. */


  /** Who is around a file: scope owner, claimants, changers. */


  /** Open plans by others on symbols that files in my scope (or my changed files) reference. */


  /** A plan on a released-undone or re-declared claim: tell everyone who was shown the original, at interrupt. */

  /** If the clone's branch changed since we joined, move to that branch's room. Returns a note for the agent, or ''. */


  /** Uncommitted work shared by people who are gone: no presence, and nothing written for ROOM_STALE_DAYS (7). Evicted on join. */



  /** Release my claims (cancelling their plans) and clear my scope. `why` goes in the release summary.
   *  `keep` exempts claims (room_done keeps the mirrors of workers still running). */



  // ---- rendering helpers ----------------------------------------------------



  /** One line about what a person is doing: live scope, or their last done note, plus unpushed changes. */


  // ---- login ------------------------------------------------------------------




  // ---- handlers -------------------------------------------------------------
  runtime = {
    ctx, now, log, doJoin, doLeave, doClose, seen, rooms, S, isMe, mine, myWorkers: undefined!, workerAlive: undefined!,
    ensureWorkersRoom: undefined!, closeWorkersRoom: undefined!, runningWorkers: undefined!, hasCompany: s => hasCompany(s, runtime.runningWorkers(s).map(r => r.w), now()), dismissWorker: undefined!, others, presences,
    shareOf, withheld, shareLine: undefined!, setPresence, base, baseFor, baseText, liveText, lines, loadAreas: undefined!, areasOf: undefined!,
    areasFor: undefined!, myAreas: undefined!, inMyAreas: undefined!, areaLines: undefined!, ownerHints: undefined!, msgInMyAreas: undefined!, forMe: undefined!, inbox: undefined!, waitingOn: undefined!, describeUsers: undefined!,
    planChanged: undefined!, followBranch: undefined!, evictStale: undefined!, cleanupMine: undefined!, upgrade: undefined!, claimLine: undefined!, ledgerLines: undefined!, scopeLine: undefined!, personLine: undefined!,
    serverOf: undefined!, LOCAL_LOGIN: undefined!, codeLine: undefined!, refreshPrs: undefined!, startPrSync: undefined!, stopPrSync: undefined!, prLines: undefined!, myPr: undefined!, postLedger: undefined!, observeClaims: undefined!, startConflictWatcher: undefined!, startWorkersBridge: undefined!,
    workerPaths: () => roomBridge?.workerPaths() ?? [],
    scheduleInboxWrite: () => primaryHooks?.scheduleWrite(),
    upgraded, conflictPairs,
    attachHooks: (s: Session) => rooms.add(s, 'primary'),
    clearStale: (s: Session) => { runtime.evictStale(s); return runtime.cleanupMine(s, 'stale from an earlier session') },
    async shutdown() {
      const s = ctx.getSession()
      if (!s) return
      const stops = runtime.runningWorkers(s).map(async r => {
        try { await runtime.dismissWorker(r.s, r.w, "the lead's session ended", 'lead-session-ended') }
        catch { /* best effort */ }
      })
      if (stops.length) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([Promise.all(stops), new Promise<void>(resolve => {
          timer = setTimeout(resolve, 1800)
          timer.unref()
        })])
        if (timer) clearTimeout(timer)
      }
      await runtime.closeWorkersRoom().catch(() => {})
      try { runtime.cleanupMine(s, 'session ended') } catch { /* best effort */ }
      rooms.remove(s)
      await doLeave(s)
    },
    async drop(s: Session, reason: string) {
      log(`leaving ${s.roomName}: ${reason}`)
      try { runtime.cleanupMine(s, reason) } catch { /* best effort */ }
      rooms.remove(s)
      await doLeave(s)
    },
    async flushConflicts() { await rooms.flush() },
  }
  return runtime
}
