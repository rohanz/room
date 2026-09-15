import fs from 'node:fs'
import path from 'node:path'
import { Areas, CODEOWNERS_PATHS, RoomDoc, claimsOverlap, describeClaim, formatMsg, formatPlans, isAgentic, msgPaths, scopeCovers, sharesArea } from '@room/shared'
import type { Claim, ConflictMsg, Msg, NoteMsg, Plan, PlanMsg, Presence, Priority, ReleaseMsg, Scope, Worker } from '@room/shared'
import { type ShareLevel, type SharePresence } from '@room/roomd'
import { git, gitShow } from '@room/roomd/git'
import { Bridge } from '../bridge.js'
import { HooksBridge } from '../hooks-bridge.js'
import { ConflictWatcher } from '../conflicts.js'
import { branchOf, fetchPrs, isPrName, openPrs, postPrNote, prLeader, renderPrNote, syncPrs, type PrInfo } from '../prs.js'
import { Rooms, type Attachment, type Role } from '../registry.js'
import { authFor, closeRoom, DEFAULT_SERVER, joinSession, leaveSession, LOCAL, parseServer, resolveServer, type JoinOptions, type Session } from '../session.js'
import { pidIsOurWorker, signalWorker, type ProcessInfo, type Spawner } from '../workers.js'

export interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  /** MCP tool annotations; Codex uses these to decide whether a call needs approval. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
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
  worktree?: (repoDir: string, tag: string) => Promise<{ dir: string; branch: string; created: boolean }>
  maxWorkers?: number
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
  dismissWorker: (s: Session, w: Worker, why: string) => string
  gitignored: (dir: string) => boolean
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
  workerPaths: () => string[]
  pendingJoin: Promise<void> | null
  attachHooks: (s: Session) => void
  clearStale: (s: Session) => number
  shutdown: () => Promise<void>
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
  description: 'Changes you intend to make that others may depend on. Declare BEFORE editing.',
  items: { type: 'object', properties: {
    kind: { type: 'string', enum: ['rename', 'signature', 'delete', 'add'] },
    symbol: str('function/class/variable name as it is now'),
    detail: str('new name, new signature, or why'),
  }, required: ['kind', 'symbol'] },
}
export const SHARE = { type: 'string', enum: ['intent', 'declared', 'full'], description: 'sharing level: intent (presence, scope, claims, plans, bus; no file text), declared (file text only under your declared scope paths), full (every changed file). Default ROOM_SHARE, then full; the server may cap it (ROOM_SHARE_MAX).' }

export class NotJoined extends Error {}
export class NeedFetch extends Error { constructor(public person: string, public sha: string, public detail: string) { super(detail) } }

export function createHandlerState(ctx: ToolCtx): HandlerState {
  const now = ctx.now ?? (() => Date.now())
  const log = ctx.log ?? ((l: string) => process.stderr.write(`room-mcp: ${l}\n`))
  const doJoin = ctx.join ?? joinSession
  const doLeave = ctx.leave ?? leaveSession

  // ---- per-session state --------------------------------------------------
  const seen = new Set<string>() // message ids already shown in the inbox (ids, not indexes: the bus is a concurrent array)
  const upgraded = new Set<string>() // "msgId:person" copies already posted
  const conflictPairs = new Set<string>() // sorted "a:b" claim-id pairs already reported
  let pendingJoin: Promise<void> | null = null
  /** The lead-in-two-rooms bridge, while a workers room is open (owned by that session's attachment). */
  let roomBridge: Bridge | null = null
  /** The primary session's hooks bridge (state file); the inbox asks it to rewrite after marking messages seen. */
  let primaryHooks: HooksBridge | null = null
  const doClose = ctx.close ?? (async (s: Session) => { const a = await authFor(s); return closeRoom(a.server, s.roomName, { gh: a.gh, token: a.token }) })
  /**
   * Everything a joined session needs running. The primary gets the hooks bridge (state file + wake),
   * the conflict watcher and the PR mirror. The workers room gets a wake-only hooks bridge (the state
   * file is the team room's), the host's channel push, and the bridge to the lead's team room.
   */
  const attach = (s: Session, role: Role, lead?: Session): Attachment => {
    const hooks = new HooksBridge(s, { forMe: m => forMe(s, m), isSeen: id => seen.has(id), log, queue: ctx.queue, ...(role === 'workers' ? { writeState: false } : {}) })
    hooks.start()
    if (role === 'primary') primaryHooks = hooks
    let watcher: ConflictWatcher | null = null
    let bridge: Bridge | null = null
    if (role === 'primary') {
      watcher = new ConflictWatcher({
        room: s.room, me: s.me, log, debounceMs: ctx.conflictDebounceMs,
        liveText: (p, person) => liveText(s, p, person),
        baseText: (sha, p) => gitShow(s.dir, sha, p),
        baseFor: person => baseFor(s, person),
        mergeBase: async (a, b) => (await git(s.dir, ['merge-base', a, b])).trim(),
      })
      watcher.start()
      startPrSync(s)
    } else if (lead) {
      bridge = new Bridge(lead, s, { log, debounceMs: ctx.conflictDebounceMs === 0 ? 0 : undefined })
      bridge.start()
      roomBridge = bridge
      ctx.attachChannel?.(s)
    }
    return {
      stop() {
        hooks.stop(); watcher?.stop()
        if (primaryHooks === hooks) primaryHooks = null
        if (role === 'primary') stopPrSync()
        if (bridge) { bridge.stop(); if (roomBridge === bridge) roomBridge = null }
      },
      flush: () => watcher?.flush() ?? Promise.resolve(),
    }
  }
  const rooms = new Rooms({ primary: () => ctx.getSession(), setPrimary: s => ctx.setSession(s), observeClaims: s => observeClaims(s), attach })

  // ---- pull requests as intent ------------------------------------------------
  /** Refresh the PR mirror in the doc when I am the elected maintainer (lowest present name). Never throws. */
  let prTimer: ReturnType<typeof setInterval> | null = null
  let prSyncedSession: Session | null = null
  const fetchPrList = ctx.prs?.fetch ?? fetchPrs
  const postNote = ctx.prs?.post ?? postPrNote
  const refreshPrs = async (s: Session): Promise<string> => {
    if (!s.roomName.startsWith('github.com/')) return ''
    const present = presences(s).map(p => p.user.name)
    const leader = prLeader(present.length ? present : [s.me.name], Array.from(s.room.workers.values()).map(w => w.name))
    if (leader !== s.me.name) return ''
    let prs: PrInfo[]
    try { prs = await fetchPrList(s) } catch (e) { log(`pull requests: ${e instanceof Error ? e.message : String(e)}`); return '' }
    const r = syncPrs(s.room, prs, s.me)
    const parts = [r.added.length ? `mirrored ${r.added.map(n => `#${n}`).join(', ')}` : '', r.removed.length ? `removed ${r.removed.map(n => `#${n}`).join(', ')}` : ''].filter(Boolean)
    if (parts.length) log(`pull requests: ${parts.join('; ')}`)
    return parts.join('; ')
  }
  const startPrSync = (s: Session) => {
    if (prSyncedSession === s) return
    stopPrSync()
    prSyncedSession = s
    const every = ctx.prs?.intervalMs ?? 2 * 60_000
    void refreshPrs(s)
    if (every > 0) { prTimer = setInterval(() => { void refreshPrs(s) }, every); prTimer.unref?.() }
  }
  const stopPrSync = () => { if (prTimer) clearInterval(prTimer); prTimer = null; prSyncedSession = null }
  /** room_state section: open PRs targeting this branch, from the mirror. */
  const prLines = (s: Session): string[] => {
    const prs = openPrs(s.room)
    if (!prs.length) return []
    const out = [`open pull requests (${prs.length}):`]
    for (const pr of prs) out.push(`  - PR #${pr.number} "${pr.title}" by ${pr.author} (${pr.head} → ${branchOf(s.roomName)}): ${pr.files.length ? pr.files.slice(0, 8).join(', ') + (pr.files.length > 8 ? `, +${pr.files.length - 8} more` : '') : 'no files'} · ${pr.url}`)
    return out
  }
  /** The open PR whose head is this branch (any base), asked of GitHub; falls back to the mirror (PRs targeting this branch). */
  const myPr = async (s: Session): Promise<PrInfo | undefined> => {
    const head = branchOf(s.roomName)
    try { const byHead = (await fetchPrList(s, { head: true })).find(p => p.head === head); if (byHead) return byHead } catch (e) { log(`pull requests by head: ${e instanceof Error ? e.message : String(e)}`) }
    return openPrs(s.room).find(p => p.head === head)
  }
  /** Render the ledger and post it as the one room comment on the PR. */
  const postLedger = async (s: Session, pr: PrInfo): Promise<string> => {
    const body = renderPrNote(s.room, { roomName: s.roomName, now: now() })
    const r = await postNote(s, pr.number, body)
    s.room.post<NoteMsg>(s.me, { type: 'note', text: `${r.updated ? 'updated' : 'posted'} the room ledger on PR #${pr.number}${r.url ? ` (${r.url})` : ''}`, priority: 'fyi' })
    return `${r.updated ? 'updated' : 'posted'} the room ledger comment on PR #${pr.number} "${pr.title}"${r.url ? `: ${r.url}` : ''} (${body.split('\n').length} lines)`
  }
  /** Two room_claim calls on different machines can both pass the overlap pre-check. When the
   *  other claim arrives, the owner of the lexicographically smaller id reports the conflict. */
  const observeClaims = (s: Session) => {
    s.room.claims.observe((ev, tr) => {
      if (tr.local) return
      for (const [id, ch] of ev.changes.keys) {
        if (ch.action !== 'add') continue
        const arrived = s.room.openClaims().find(c => c.id === id)
        if (!arrived || (arrived.by === s.me.name && arrived.byKind === s.me.kind)) continue
        for (const m of mine(s)) {
          if (!claimsOverlap(m, arrived)) continue
          const key = [m.id, arrived.id].sort().join(':')
          if (conflictPairs.has(key) || s.room.messages().some(x => x.type === 'conflict' && [x.claimId, x.otherClaimId].sort().join(':') === key)) { conflictPairs.add(key); continue }
          conflictPairs.add(key)
          if (m.id.localeCompare(arrived.id) > 0) continue
          const text = `concurrent overlapping claims: ${describeClaim(m)} and ${describeClaim(arrived)}`
          s.room.post<ConflictMsg>(s.me, { type: 'conflict', claimId: m.id, otherClaimId: arrived.id, path: m.path, text, to: arrived.by })
        }
      }
    })
  }

  const S = (): Session => {
    const s = ctx.getSession()
    if (!s) throw new NotJoined()
    return s
  }
  const isMe = (s: Session, p: { name: string; kind: string }) => p.name === s.me.name && p.kind === s.me.kind
  const mine = (s: Session) => s.room.openClaims().filter(c => c.by === s.me.name && c.byKind === s.me.kind)
  const myWorkers = (s: Session): Worker[] => Array.from(s.room.workers.values()).filter(w => w.lead === s.me.name)
  /** Is a process for this worker record alive: one we spawned, or (after a lead restart) one `ps` vouches for. */
  const workerAlive = (s: Session, w: Worker): boolean => rooms.hasHandle(s, w) || pidIsOurWorker(w.pid, w, ctx.probe)
  /** Open (once) the local workers room next to a team session and bridge the two. */
  const ensureWorkersRoom = async (lead: Session): Promise<Session> => {
    if (lead.local) return lead
    const have = rooms.workers()
    if (have) return have
    const ws = await doJoin({ dir: lead.dir, server: LOCAL, name: lead.me.owner ?? lead.me.name, tag: lead.me.label, log })
    for (const m of ws.room.messages()) seen.add(m.id)
    rooms.add(ws, 'workers', lead)
    log(`workers room: ${ws.roomName} (${ws.local?.url ?? 'local'}), bridged to ${lead.roomName}`)
    return ws
  }
  const closeWorkersRoom = async (): Promise<void> => {
    const ws = rooms.workers()
    if (!ws) return
    rooms.remove(ws)
    try { cleanupMine(ws, 'lead left') } catch { /* best effort */ }
    await doLeave(ws)
  }
  /** Workers this lead has running, in every room it is in. */
  const runningWorkers = (s: Session): { s: Session; w: Worker }[] => {
    const out: { s: Session; w: Worker }[] = []
    for (const sess of [s, ...rooms.all().filter(x => x !== s)]) for (const w of myWorkers(sess)) if (w.status === 'running' || workerAlive(sess, w)) out.push({ s: sess, w })
    return out
  }
  /**
   * Stop a running worker. A process this MCP instance spawned is signalled directly. One we only
   * know by pid (the lead restarted) is signalled only if it is alive and started with the worker
   * record: a recycled pid would belong to something else. The record becomes `dismissed` only when
   * a signal was actually delivered; otherwise its status stands and the reply says so.
   */
  const dismissWorker = (s: Session, w: Worker, why: string): string => {
    const proc = rooms.handle(s, w.id)
    let how: string, signalled: boolean
    if (proc) {
      signalled = proc.kill()
      how = signalled ? `pid ${w.pid} signalled` : `pid ${w.pid} could not be signalled: the process is already gone, so its status stands`
    } else if (pidIsOurWorker(w.pid, w, ctx.probe)) {
      signalled = signalWorker(w.pid)
      how = signalled ? `pid ${w.pid} signalled` : `pid ${w.pid} could not be signalled (it exited just now, or is not ours to signal), so its status stands`
    } else {
      signalled = false
      how = `pid ${w.pid} not signalled: it is not alive, or not a process started for this worker (this session did not spawn it), so it was left alone and its status stands`
    }
    if (signalled || !proc) rooms.dropHandle(s, w.id)
    if (signalled && w.status === 'running') s.room.updateWorker(w.tag, { status: 'dismissed' }, w.id)
    s.room.post<NoteMsg>(s.me, { type: 'note', text: signalled ? `dismissed worker ${w.tag} (${w.name}): ${why}` : `could not dismiss worker ${w.tag} (${w.name}): ${how}` })
    return how
  }
  const gitignored = (dir: string): boolean => { try { return fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n').some(l => l.trim() === '.room/' || l.trim() === '.room') } catch { return false } }
  const others = (s: Session): string[] => {
    const names = new Set<string>()
    for (const k of s.room.scopes.keys()) names.add(k)
    for (const k of s.room.overlays.keys()) names.add(k)
    for (const p of presences(s)) names.add(p.user.name)
    names.delete(s.me.name)
    return Array.from(names).filter(n => !isPrName(n)).sort() // PR mirrors are intent, not people: never routed to
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
  const shareLine = (s: Session): string => {
    const level = s.daemon.share ?? 'full'
    const clamped = s.shareRequested && s.shareRequested !== level ? ` (asked for ${s.shareRequested}; the server caps sharing at ${s.shareMax}, ROOM_SHARE_MAX)` : ''
    const held = s.daemon.skipped?.().share ?? []
    return `sharing: ${level}${clamped}${held.length ? `; withheld ${held.length} changed file(s): ${held.join(', ')}` : ''}`
  }
  const setPresence = (s: Session, patch: Partial<Presence>) => {
    const cur = (s.awareness.getLocalState() ?? {}) as Partial<Presence>
    s.awareness.setLocalState({ ...cur, ...patch, lastActive: now() })
  }
  const base = (s: Session) => s.room.meta.base ?? 'HEAD'
  /** The commit a person's overlay is a delta from (their own HEAD), falling back to the room base. */
  const baseFor = (s: Session, person: string) => s.room.baseOf(person) ?? base(s)
  const baseText = async (s: Session, path: string, person = s.me.name): Promise<string | undefined> => gitShow(s.dir, baseFor(s, person), path)
  /** A person's HEAD + their overlay; undefined if the file exists nowhere; null if they deleted it.
   *  Throws NeedFetch when their HEAD is not in this clone. */
  const liveText = async (s: Session, path: string, person: string): Promise<string | undefined | null> => {
    if (s.room.deleted.get(person)?.has(path)) return null
    const ov = s.room.text(path, person)
    if (ov !== undefined) return ov
    try { return await baseText(s, path, person) }
    catch (e) { throw new NeedFetch(person, baseFor(s, person), e instanceof Error ? e.message : String(e)) }
  }
  const lines = (t: string) => t.endsWith('\n') ? t.split('\n').length - 1 : t.split('\n').length

  // ---- areas ------------------------------------------------------------------
  /** Area index per session: CODEOWNERS at the room base (or top-level dirs). Loaded once per join. */
  const areaIndex = new WeakMap<Session, Areas>()
  const loadAreas = async (s: Session): Promise<Areas> => {
    const hit = areaIndex.get(s)
    if (hit) return hit
    let areas = Areas.topLevel()
    for (const p of CODEOWNERS_PATHS) {
      let text: string | undefined
      try { text = await gitShow(s.dir, base(s), p) } catch { text = undefined }
      if (text !== undefined) { areas = Areas.fromCodeowners(text); log(`areas from ${p}: ${areas.areas.join(', ') || '(none)'}`); break }
    }
    areaIndex.set(s, areas)
    return areas
  }
  const areasOf = (s: Session): Areas => areaIndex.get(s) ?? Areas.topLevel()
  /** Areas a person is in: those covering their declared scope paths and their changed paths. */
  const areasFor = (s: Session, person: string): string[] => {
    const sc = s.room.scope(person)
    const paths = [...(sc?.paths ?? []), ...s.room.changedPaths(person)]
    const stored = sc?.areas ?? presences(s).find(p => p.user.name === person)?.areas ?? []
    return Array.from(new Set([...stored, ...areasOf(s).areasOf(paths)])).sort()
  }
  const myAreas = (s: Session): string[] => areasFor(s, s.me.name)
  const inMyAreas = (s: Session, person: string): boolean => sharesArea(myAreas(s), areasFor(s, person))
  /** Who else is in any of these areas, with the areas they share. */
  const alsoIn = (s: Session, areas: string[]): string[] => others(s)
    .map(n => ({ n, shared: areasFor(s, n).filter(a => areas.includes(a)) }))
    .filter(x => x.shared.length)
    .map(x => `${x.n} (${x.shared.join(', ')})`)
  /** "owners of api/: @rohanz, @kieran" for areas I do not own per CODEOWNERS; nothing without CODEOWNERS. */
  const ownerHints = (s: Session, areas: string[]): string[] => {
    const ax = areasOf(s)
    const login = s.me.owner ?? s.me.name
    return areas.filter(a => ax.ownersOf(a).length && !ax.owns(login, a)).map(a => `owners of ${a}: ${ax.ownersOf(a).join(', ')} — not enforced; ask them if you change their contract`)
  }
  const areaLines = (s: Session, areas: string[]): string[] => {
    if (!areas.length) return ['areas: none yet (declare a scope or change a file)']
    const out = [`areas: ${areas.join(', ')} (${areasOf(s).source === 'codeowners' ? 'from CODEOWNERS' : 'top-level dirs; no CODEOWNERS'})`]
    const also = alsoIn(s, areas)
    out.push(also.length ? `also in your areas: ${also.join('; ')}` : 'nobody else is in your areas')
    out.push(...ownerHints(s, areas))
    return out
  }
  /** Does a message concern my areas: any of its paths lands in one, or its sender is in one. */
  const msgInMyAreas = (s: Session, m: Msg): boolean => {
    const mineA = myAreas(s)
    if (!mineA.length) return true
    const paths = msgPaths(m)
    if (paths.length) return areasOf(s).areasOf(paths).some(a => mineA.includes(a))
    return sharesArea(mineA, areasFor(s, m.from))
  }

  // ---- inbox ----------------------------------------------------------------
  const forMe = (s: Session, m: Msg) => {
    if (m.from === s.me.name && isAgentic(m.fromKind)) return false
    if (m.to === s.me.name) return true
    if (m.type === 'base') return true // someone committed: everyone should know to pull
    if (m.to) return false // addressed to someone else
    if (m.type === 'conflict') return mine(s).some(c => c.id === m.claimId || c.id === m.otherClaimId)
    if (m.priority === 'interrupt') return true // broadcast interrupts reach everyone, whatever the area
    if (m.priority === 'notify') return msgInMyAreas(s, m) // broadcast notify only from my areas
    return false // broadcast fyi is read in the ledger, never the inbox
  }
  const inbox = (s: Session): string => {
    const fresh: Msg[] = []
    for (const m of s.room.messages()) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      if (forMe(s, m)) fresh.push(m)
    }
    const ws = rooms.workers()
    if (ws && ws !== s) for (const m of ws.room.messages()) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      if (forMe(ws, m)) fresh.push({ ...m, ...('text' in m ? { text: `[workers room] ${m.text}` } : {}) } as Msg)
    }
    if (seen.size > 5000) { const keep = s.room.lastMessages(2000).map(m => m.id); seen.clear(); for (const k of keep) seen.add(k) }
    if (!fresh.length) return ''
    const rank: Record<Priority, number> = { interrupt: 0, notify: 1, fyi: 2 }
    fresh.sort((a, b) => rank[a.priority] - rank[b.priority] || a.at - b.at)
    s.room.markSeen(s.me.name, fresh.map(m => m.id))
    for (const m of fresh) log(`inbox → ${s.me.name}: [${m.priority}] ${formatMsg(m)}`)
    primaryHooks?.scheduleWrite()
    return `[inbox ${fresh.length}]\n${fresh.map(m => `  ${m.priority.padEnd(9)} [${m.id}] ${formatMsg(m)}`).join('\n')}\n\n`
  }

  // ---- scope upgrade rule ---------------------------------------------------
  /** Who else is affected by these paths/symbols: scope covers a path, or their files mention a symbol. */
  const affected = async (s: Session, paths: string[], symbols: string[]): Promise<Map<string, string>> => {
    const out = new Map<string, string>()
    for (const person of others(s)) {
      const sc = s.room.scope(person)
      const hitPath = sc && paths.find(p => scopeCovers(sc, p))
      if (hitPath) { out.set(person, `scope ${sc.area} covers ${hitPath}`); continue }
      if (!symbols.length) continue
      // Files that use the symbol (graph), owned by this person: in their scope, changed by them, or claimed by them.
      let hit: string | undefined
      if (s.graph) {
        await s.graph.ready
        for (const sym of symbols) {
          const f = s.graph.graph.usersOf(sym).find(u => ownsFile(s, person, u))
          if (f) { hit = `${f} uses ${sym}`; break }
        }
      } else {
        for (const f of s.room.changedPaths(person)) {
          const t = s.room.text(f, person) ?? ''
          const sym = symbols.find(x => t.includes(x))
          if (sym) { hit = `${f} uses ${sym}`; break }
        }
      }
      if (hit) out.set(person, hit)
    }
    return out
  }
  const ownsFile = (s: Session, person: string, f: string): boolean => {
    const sc = s.room.scope(person)
    return (!!sc && scopeCovers(sc, f)) || s.room.changedPaths(person).includes(f) || s.room.openClaims().some(c => c.by === person && c.path === f)
  }
  /** Who is around a file: scope owner, claimants, changers. */
  const owners = (s: Session, f: string): string[] => {
    const out = new Set<string>()
    for (const sc of s.room.allScopes()) if (scopeCovers(sc, f)) out.add(sc.by)
    for (const c of s.room.claimsFor(f)) out.add(c.by)
    for (const p of s.room.whoChanged(f)) out.add(p)
    return Array.from(out).sort()
  }
  const describeUsers = (s: Session, files: string[]): string => files.map(f => { const o = owners(s, f).filter(x => x !== s.me.name); return o.length ? `${f} (${o.join(', ')})` : f }).join(', ')
  /** Open plans by others on symbols that files in my scope (or my changed files) reference. */
  const waitingOn = async (s: Session): Promise<string[]> => {
    if (!s.graph) return []
    await s.graph.ready
    const g = s.graph.graph
    const sc = s.room.scope(s.me.name)
    const myFiles = new Set(s.room.changedPaths(s.me.name))
    if (sc) for (const f of allIndexed(s)) if (scopeCovers(sc, f)) myFiles.add(f)
    const needed = new Map<string, string[]>()
    for (const f of myFiles) for (const d of g.dependenciesOf(f)) { const arr = needed.get(d.symbol) ?? []; arr.push(f); needed.set(d.symbol, arr) }
    const out: string[] = []
    for (const c of s.room.openClaims()) {
      if (c.by === s.me.name || !c.plans?.length) continue
      for (const pl of c.plans) {
        const files = needed.get(pl.symbol)
        if (files) out.push(`  - ${c.by}'s agent plans ${pl.kind} ${pl.symbol}${pl.detail ? ` → ${pl.detail}` : ''} in ${c.path} (claim ${c.id}); you use it in ${Array.from(new Set(files)).join(', ')}`)
      }
    }
    return out
  }
  const allIndexed = (s: Session): string[] => {
    const set = new Set<string>()
    for (const sc of s.room.allScopes()) for (const p of sc.paths) set.add(p)
    // The graph does not expose its file list; approximate via scope paths + changed paths + graph users/definers reached through them.
    for (const person of [s.me.name, ...others(s)]) for (const p of s.room.changedPaths(person)) set.add(p)
    return Array.from(set).filter(p => s.graph!.graph.has(p))
  }
  /** A plan on a released-undone or re-declared claim: tell everyone who was shown the original, at interrupt. */
  const planChanged = (s: Session, c: Claim, plan: Plan, status: PlanMsg['status'], text: string, replacedBy?: Plan): string[] => {
    const deps = (c.msgId ? s.room.dependentsOf(c.msgId) : []).filter(p => p !== s.me.name)
    const base: Omit<PlanMsg, 'id' | 'at' | 'from' | 'fromKind' | 'priority'> = { type: 'plan', status, claimId: c.id, path: c.path, plan, text, ...(replacedBy ? { replacedBy } : {}) }
    const orig = s.room.post<PlanMsg>(s.me, base)
    for (const p of deps) s.room.post<PlanMsg>(s.me, { ...base, to: p, copyOf: orig.id })
    return deps.length ? [`plan ${status}: ${formatPlans([plan])} — told ${deps.map(d => `${d}'s agent`).join(', ')} (they were shown it)`] : [`plan ${status}: ${formatPlans([plan])} — nobody had been shown it`]
  }
  /** If the clone's branch changed since we joined, move to that branch's room. Returns a note for the agent, or ''. */
  const followBranch = async (): Promise<string> => {
    const s = ctx.getSession()
    if (!s || !s.roomName.includes('/') || s.pinnedRoom) return ''
    let branch = ''
    try { branch = (await git(s.dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() } catch { return '' }
    if (!branch || branch === 'HEAD') return ''
    const current = s.roomName.slice(s.roomName.lastIndexOf('/') + 1)
    if (branch === current) return ''
    const repo = s.roomName.slice(0, s.roomName.lastIndexOf('/'))
    const target = `${repo}/${branch}`
    log(`branch changed ${current} -> ${branch}; moving room`)
    cleanupMine(s, `switched branch to ${branch}`)
    rooms.remove(s)
    await doLeave(s)
    try {
      const n = await doJoin({ dir: s.dir, name: s.me.name, room: target, server: s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/')) })
      for (const m of n.room.messages()) seen.add(m.id)
      rooms.add(n, 'primary'); cleanupMine(n, 'stale from an earlier session')
      return `[room] your clone switched to branch ${branch}: left ${current}, joined ${target}. Scope and claims were reset; declare a scope before editing.`
    } catch (e) {
      return `[room] your clone switched to branch ${branch} but joining ${target} failed: ${e instanceof Error ? e.message : String(e)}. Call room_join.`
    }
  }

  /** Uncommitted work shared by people who are gone: no presence, and nothing written for ROOM_STALE_DAYS (7). Evicted on join. */
  const STALE_MS = Number(process.env.ROOM_STALE_DAYS || 7) * 24 * 60 * 60 * 1000
  const evictStale = (s: Session): string[] => {
    const here = new Set(presences(s).map(p => p.user.name))
    const gone: string[] = []
    for (const person of Array.from(s.room.overlays.keys())) {
      if (person === s.me.name || here.has(person)) continue
      const age = s.room.overlayAge(person, now())
      if (age === undefined || age < STALE_MS) continue
      const n = s.room.clearOverlays(person)
      const days = Math.round(age / 86_400_000)
      s.room.post<NoteMsg>(s.me, { type: 'note', text: `evicted stale uncommitted work of ${person} (${n} file${n === 1 ? '' : 's'}; last seen ${days} day${days === 1 ? '' : 's'} ago)`, priority: 'fyi' })
      log(`evicted ${person}'s ${n} stale overlay file(s), ${days} days old`)
      gone.push(person)
    }
    return gone
  }

  /** Release my claims (cancelling their plans) and clear my scope. `why` goes in the release summary.
   *  `keep` exempts claims (room_done keeps the mirrors of workers still running). */
  const cleanupMine = (s: Session, why: string, keep?: (c: Claim) => boolean): number => {
    const released = keep ? mine(s).filter(c => !keep(c)) : mine(s)
    for (const c of released) {
      s.room.removeClaim(c.id)
      s.room.post<ReleaseMsg>(s.me, { type: 'release', claimId: c.id, path: c.path, summary: why, ...(c.plans?.length ? { unfulfilled: c.plans } : {}) })
      for (const pl of c.plans ?? []) planChanged(s, c, pl, 'cancelled', why)
    }
    s.room.clearScope(s.me.name)
    return released.length
  }
  const upgrade = async (s: Session, m: Msg, paths: string[], symbols: string[]): Promise<string[]> => {
    const notes: string[] = []
    for (const [person, why] of await affected(s, paths, symbols)) {
      if (m.to === person) continue
      const key = `${m.id}:${person}`
      if (upgraded.has(key)) continue
      upgraded.add(key)
      const { id: _id, at: _at, from: _f, fromKind: _k, ...body } = m as Msg & Record<string, unknown>
      s.room.post(s.me, { ...(body as object), to: person, priority: 'notify', copyOf: m.id } as never)
      notes.push(`notified ${person}'s agent (${why})`)
    }
    return notes
  }

  // ---- rendering helpers ----------------------------------------------------
  const claimLine = (s: Session, c: Claim) => {
    const stale = !presences(s).some(p => p.user.name === c.by) && now() - c.at > STALE_MS
    return `  - ${c.id}: ${describeClaim(c)}${isMe(s, { name: c.by, kind: c.byKind }) ? ' (yours)' : ''}${stale ? ' [stale: owner offline]' : ''}`
  }
  const ledgerLines = (s: Session, q: NonNullable<Parameters<RoomDoc['ledger']>[0]>, label: string): string[] => {
    const entries = s.room.ledger({ ...q, limit: q.limit ?? 10 }).filter(m => !(m.to && m.to !== s.me.name && m.from !== s.me.name))
    const plans = s.room.openClaims().filter(c => c.plans?.length && !(c.by === s.me.name) && (q.path ? c.path === q.path : true) && (q.area ? s.room.allScopes().some(sc => sc.area === q.area && scopeCovers(sc, c.path)) : true))
    const out = [`${label} ledger (${entries.length}):`]
    for (const m of entries) out.push(`  - ${new Date(m.at).toISOString().slice(11, 19)} ${formatMsg(m)}`)
    if (plans.length) { out.push('open plans by others:'); for (const c of plans) out.push(`  - ${c.by}'s agent in ${c.path}: ${formatPlans(c.plans!)}`) }
    return out
  }
  const scopeLine = (sc: Scope) => `${sc.area}: ${sc.summary} (${sc.paths.join(', ')})`
  /** One line about what a person is doing: live scope, or their last done note, plus unpushed changes. */
  const personLine = (s: Session, name: string): string => {
    const sc = s.room.scope(name)
    const p = presences(s).find(x => x.user.name === name && isAgentic(x.user.kind)) ?? presences(s).find(x => x.user.name === name)
    const changed = s.room.changedPaths(name)
    const lastDone = [...s.room.messages()].reverse().find((m): m is NoteMsg => m.from === name && m.type === 'note' && m.text.startsWith('done'))
    let what: string
    if (sc) what = `working on ${scopeLine(sc)}`
    else if (p?.status?.startsWith('done')) what = `${p.status}`
    else if (lastDone && (!p || p.status === 'idle' || p.status === 'synced')) what = `${lastDone.text} (${new Date(lastDone.at).toISOString().slice(11, 16)})`
    else what = p ? `${p.status ?? 'idle'}, no task declared` : 'offline'
    const level = shareOf(s, name)
    const share = level === 'full' ? '' : `; shares ${level}${level === 'intent' ? ' (no file text)' : ' (file text only under their scope paths)'}`
    return `${what}${share}${changed.length ? `; uncommitted, not yet pushed: ${changed.join(', ')}` : ''}`
  }

  // ---- login ------------------------------------------------------------------
  const serverOf = (a: Record<string, unknown>) => { const r = resolveServer(typeof a.server === 'string' && a.server ? a.server : process.env.ROOM_SERVER); return r === LOCAL ? LOCAL : parseServer(r).server }
  const LOCAL_LOGIN = `no server configured: local rooms need no login. Set ROOM_SERVER=hosted (or a server URL, or pass server=...) to log in to a team server (${DEFAULT_SERVER} is the hosted one)`
  const codeLine = (p: { provider?: string; verification_uri?: string; user_code?: string; url?: string; expires_in: number }) => p.provider === 'oidc' || p.url
    ? `Open ${p.url} in a browser and sign in (valid ${Math.round(p.expires_in / 60)} min). Then call room_login again to wait for the login to confirm.`
    : `Open ${p.verification_uri} and enter the code ${p.user_code} (valid ${Math.round(p.expires_in / 60)} min). Then call room_login again to wait for GitHub to confirm.`

  // ---- handlers -------------------------------------------------------------
  const state: HandlerState = {
    ctx, now, log, doJoin, doLeave, doClose, seen, rooms, S, isMe, mine, myWorkers, workerAlive,
    ensureWorkersRoom, closeWorkersRoom, runningWorkers, dismissWorker, gitignored, others, presences,
    shareOf, withheld, shareLine, setPresence, base, baseFor, baseText, liveText, lines, loadAreas, areasOf,
    areasFor, myAreas, inMyAreas, areaLines, ownerHints, msgInMyAreas, forMe, inbox, waitingOn, describeUsers,
    planChanged, followBranch, evictStale, cleanupMine, upgrade, claimLine, ledgerLines, scopeLine, personLine,
    serverOf, LOCAL_LOGIN, codeLine, refreshPrs, startPrSync, stopPrSync, prLines, myPr, postLedger, observeClaims,
    workerPaths: () => roomBridge?.workerPaths() ?? [],
    get pendingJoin() { return pendingJoin },
    set pendingJoin(value: Promise<void> | null) { pendingJoin = value },
    attachHooks: (s: Session) => rooms.add(s, 'primary'),
    clearStale: (s: Session) => { evictStale(s); return cleanupMine(s, 'stale from an earlier session') },
    async shutdown() {
      const s = ctx.getSession()
      if (!s) return
      for (const r of runningWorkers(s)) { try { dismissWorker(r.s, r.w, "the lead's session ended") } catch { /* best effort */ } }
      await closeWorkersRoom().catch(() => {})
      try { cleanupMine(s, 'session ended') } catch { /* best effort */ }
      rooms.remove(s)
      await doLeave(s)
    },
    async flushConflicts() { await rooms.flush() },
  }
  return state
}
