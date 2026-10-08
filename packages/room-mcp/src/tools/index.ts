import { formatMsg, type Priority } from '@room/shared'
import { createHandlerState } from './state.js'
import { hookHealthNote } from '../hooks-bridge.js'
import type { Batch, Ledger, Notice } from '../ledger.js'
import { INBOX_BUDGET, selectWithin, type Chosen } from '../inbox-budget.js'
import { greeted } from '../post.js'
import { hasCompany } from '../company.js'
import { waitForCompletionReconnect } from '../completion-reconnect.js'
import { connectedBefore, trackConnection } from '../connection.js'
import { toolCallAborted, withToolSignal } from '../registry.js'
import { repositoryProblem } from '../repository.js'
import { createStaleVersionWarning } from '../stale-version.js'
import { currentToolTiming } from '../timing.js'
import { LOCAL, NotLoggedIn, type Session } from '../session.js'
import { NeedFetch, NotJoined, REPLY_BATCH, type HandlerState, type ToolCtx, type ToolDef } from './context.js'
import { defs as joinDefs, handlers as joinHandlers, offerTeamSharingDisclosure } from './join.js'
import { defs as scopeDefs, handlers as scopeHandlers } from './scope.js'
import { defs as claimDefs, handlers as claimHandlers } from './claims.js'
import { defs as messagingDefs, handlers as messagingHandlers, WAIT_SIGNAL } from './messaging.js'
import { defs as collectDefs, handlers as collectHandlers } from './collect.js'
import { defs as fileDefs, handlers as fileHandlers } from './files.js'
import { deferWorkerCompletion, defs as workerDefs, handlers as workerHandlers } from './workers.js'
import { defs as shareDefs, handlers as shareHandlers } from './share.js'
import { defs as prDefs, handlers as prHandlers } from './prs.js'

/**
 * How the host's transport ends a reply's batch: commit after a confirmed write of a reply carrying `text`
 * (the tool's reply, whose inbox the batch holds), release on failure or when the reply sent is another.
 */
export interface Settle { text: string; commit(): void; release(): void }
/** One line the before-edit or SessionStart hook prints (ledger "Before-edit and SessionStart hooks"). */
export interface HookItem { id: string; line: string; priority: Priority }

export interface Tools {
  list(): ToolDef[]
  /**
   * One tool call. Its inbox and notices are reserved in a ledger batch: with `handoff`, the caller commits
   * it once the reply's bytes are written (FlushedStdioTransport); without, it commits when the call returns.
   */
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal, handoff?: (settle: Settle) => void): Promise<string>
  /** The session's delivery ledger (the hooks' arbitration endpoint selects through it). */
  readonly ledger: Ledger
  /**
   * A hook's select: pending notices, then what the joined rooms owe in inbox order, reserved in a hook
   * batch while their text fits `budget` characters; `more` stays owed.
   */
  hookSelect(budget?: number): { batch: Batch; items: HookItem[]; notices: string[]; more: number }
  /** A startup notice, offered until a reply or hook hands it off, or until a room is joined. */
  startupNotice(text: string): void
  /** Attach the hooks bridge (state file + wake) to a session; idempotent. */
  attachHooks(s: Session): void
  /** Release claims, clear scope, stop the bridge and daemon (process exit path). */
  shutdown(): Promise<void>
  /** For sessions joined outside room_join (auto-join): clear stale state under my name. */
  clearStale(s: Session): number
  /** The automatic join: every tool call ensures it first; room_join/create retarget it, room_leave/close end it. */
  setAutoJoin(a: AutoJoinHandle): void
  /** Leave a session that can no longer reach its room, without dismissing workers. */
  drop(s: Session, reason: string): Promise<void>
  /** Run any pending automatic conflict checks now (tests). */
  flushConflicts(): Promise<void>
  /** A room_wait is in progress (the idle lease never ends presence during one, registry §18). */
  waiting(): boolean
  /** Current primary and workers-room sessions, for the host's presence lease. */
  joinedSessions(): Session[]
  /** Reattach the secondary workers room after a host-session rebind. */
  attachWorkersRoom(s: Session, lead: Session): void
}

/** What the tools need of the automatic join (auto-join.ts). */
export interface AutoJoinHandle { ensure(): Promise<void>; settle(): Promise<void>; cancel(): void; retarget(s: Session): void; readonly failure?: string }
/** Tools that choose the room themselves: the automatic join pauses while one runs, and stays stopped unless it joined a room. */
const CHOOSES_ROOM = new Set(['room_join', 'room_create', 'room_leave', 'room_close'])
/** A move must not interleave with spawn, a send that resumes a worker, or collect. */
const WORKER_OPS = new Set(['room_spawn', 'room_send', 'room_collect'])
/** Writes fenced by the name lease: refused while coordination is paused (hub §7). Posts are refused by the hub client. */
const FENCED = new Set(['room_scope', 'room_claim', 'room_release', 'room_done'])

const ALL_DEFS = [...joinDefs, ...scopeDefs, ...fileDefs, ...claimDefs, ...messagingDefs, ...workerDefs, ...collectDefs, ...prDefs, ...shareDefs]
const DEF_ORDER = ['room_login', 'room_create', 'room_join', 'room_leave', 'room_close', 'room_export', 'room_scope', 'room_state', 'room_open', 'room_read', 'room_claim', 'room_release', 'room_send', 'room_wait', 'room_done', 'room_pr_note', 'room_impact', 'room_preview_merge', 'room_share', 'room_spawn', 'room_collect']
export const DEFS: ToolDef[] = DEF_ORDER.map(name => ALL_DEFS.find(d => d.name === name)!)

export function createTools(ctx: ToolCtx): Tools {
  const staleVersionWarning = ctx.staleVersionWarning ?? createStaleVersionWarning()
  const state: HandlerState = createHandlerState(ctx)
  const initial = ctx.getSession()
  if (initial) { trackConnection(initial, state.now); state.ledger.bind(initial) }
  let autoJoin: AutoJoinHandle | undefined
  let moves: Promise<void> = Promise.resolve()
  let pendingMoves = 0
  const workerOps = new Set<Promise<void>>()
  const untilAborted = (signal?: AbortSignal) => {
    let onAbort: (() => void) | undefined
    const aborted = new Promise<true>(resolve => {
      onAbort = () => resolve(true)
      if (signal?.aborted) resolve(true)
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
    return { aborted, done: () => { if (onAbort) signal?.removeEventListener('abort', onAbort) } }
  }
  const notJoined = () => autoJoin?.failure ? `error: not in a room. ${autoJoin.failure}`
    : ctx.config?.server === LOCAL ? 'error: not in the local room; room_join to join it.'
    : 'error: not in a room. room_join if a teammate has opened this repo, room_create otherwise.'
  let waits = 0
  const handlers = Object.assign({}, joinHandlers(state), scopeHandlers(state), fileHandlers(state), claimHandlers(state), messagingHandlers(state), workerHandlers(state), collectHandlers(state), prHandlers(state), shareHandlers(state))

  const { ledger } = state
  let startup: Notice | undefined
  /** A room joined since the startup notice was written makes it moot. */
  const withdrawStartup = () => { if (startup && ctx.getSession()) { ledger.withdraw(startup.id); startup = undefined } }
  const run = (name: string, args: Record<string, unknown>, signal: AbortSignal | undefined, batch: Batch): Promise<string> => withToolSignal(signal, async () => {
      if (toolCallAborted()) return 'error: tool call cancelled'
      const h = handlers[name]
      if (!h) return `error: unknown tool ${name}`
      if (name === 'room_done') {
        const completionDir = ctx.getSession()?.dir ?? ctx.cwd
        let joined = !autoJoin && !ctx.completionReady
        // Do not let an in-flight or failed replacement swallow the completion deadline.
        if (!joined) void (async () => { await ctx.completionReady?.(); await autoJoin?.ensure(); joined = true })()
          .catch(error => ctx.log?.(`completion reconnect failed: ${String(error)}`))
        const waited = await waitForCompletionReconnect(() => { const s = ctx.getSession(); return joined || s?.closed || s?.rejected ? s : null }, signal)
        if (waited === 'cancelled') return 'error: tool call cancelled'
        if (waited === 'timeout') {
          const saved = await deferWorkerCompletion(ctx, completionDir, String(args?.summary ?? ''))
          return saved ?? 'error: completion could not reconnect within 30 seconds; retry room_done'
        }
      }
      const joinDir = CHOOSES_ROOM.has(name) && typeof args?.dir === 'string' && args.dir ? args.dir : undefined
      // An existing session has already passed the join preflight. Recheck only when
      // choosing another checkout or before the first join.
      if (name !== 'room_login' && !(name === 'room_state' && args?.check === true) && (joinDir || !ctx.getSession())) {
        const problem = await repositoryProblem(joinDir ?? ctx.cwd ?? process.cwd())
        if (problem) return problem
      }
      if (autoJoin && CHOOSES_ROOM.has(name)) {
        const joining = autoJoin
        await (currentToolTiming()?.phase('settle', () => joining.settle()) ?? joining.settle())
        joining.cancel()
      } else if (autoJoin && name !== 'room_done') {
        const joining = autoJoin
        await (currentToolTiming()?.phase('settle', () => joining.ensure()) ?? joining.ensure())
      }
      if (toolCallAborted()) return 'error: tool call cancelled'
      const current = ctx.getSession()
      current?.daemon.touch()
      const closed = current?.closed
      const offlineTool = name === 'room_state' || name === 'room_send' || name === 'room_wait' || name === 'room_collect'
      if (closed && name !== 'room_leave' && !offlineTool) return `error: ${closed.reason}; ${closed.reason.startsWith('logged out') ? 'run room_login, then room_leave and room_join' : closed.reason.includes('revoked') ? 'ask for access, then room_leave and room_join' : 'room_leave, then room_create to reopen'}`
      if (toolCallAborted()) return 'error: tool call cancelled'
      const s = ctx.getSession()
      if (s) ledger.acceptPrompt(s)
      s?.refreshRuntime?.()
      if (s && !s.provider.synced && name !== 'room_leave' && !(offlineTool && (s.closed || connectedBefore(s)))) return 'error: room not synced yet, retry'
      if (s) { trackConnection(s, state.now); state.rooms.track(s) }
      const paused = s?.lease?.paused()
      if (paused && FENCED.has(name)) return `${paused}\n\nnot done: ${name} writes under your name, and coordination is paused; retry once it resumes.`
      try {
        if (name === 'room_wait') waits++
        let body: string
        try { body = await h(name === 'room_wait' ? { ...(args ?? {}), [WAIT_SIGNAL]: signal, [REPLY_BATCH]: batch } : args ?? {}) }
        finally { if (name === 'room_wait') waits-- }
        if (toolCallAborted() && name !== 'room_send' && name !== 'room_spawn') return 'error: tool call cancelled'
        if (name === 'room_preview_merge' || name.startsWith('room_pr_')) await state.rooms.autoRetire()
        const s2 = ctx.getSession()
        if (s2 && s2 !== s) s2.refreshRuntime?.()
        if (s2 && autoJoin && (name === 'room_join' || name === 'room_create')) autoJoin.retarget(s2)
        const unread = s2 && name !== 'room_join' && name !== 'room_create' ? state.inbox(s2, batch) : ''
        if (s2) await offerTeamSharingDisclosure(s2, ledger)
        withdrawStartup()
        const notices = ledger.notices(batch).map(n => n.text + '\n\n').join('')
        if (s2) await greeted(s2.hub)
        const paused = s2?.lease?.paused() ?? s2?.hub.paused()
        const health = s2 ? hookHealthNote(s2, ctx.binding?.dir(), !s2.local || hasCompany(s2, state.myWorkers(s2), state.now()).company, state.now(), name, !s2.local) : ''
        const autoTag = s2?.autoTagNote, upgrade = s2?.upgradeNote
        if (s2) { delete s2.autoTagNote; delete s2.upgradeNote }
        return notices + (paused ? paused + '\n\n' : '') + (health ? health + '\n\n' : '') + (upgrade ? upgrade + '\n\n' : '') + (autoTag ? autoTag + '\n\n' : '') + (unread ? unread + body : body)
      } catch (e) {
        // The reply is an error line now: whatever was selected for it is not in it (M5).
        ledger.discard(batch)
        if (toolCallAborted()) return 'error: tool call cancelled'
        if (e instanceof NotJoined) return notJoined()
        if (e instanceof NotLoggedIn) return `error: ${e.message}`
        if (e instanceof NeedFetch) return e.lead
          ? `error: ${e.person}'s base ${e.sha.slice(0, 10)} is ${e.lead}'s carried uncommitted work, which exists only on ${e.lead}'s machine; ${e.person}'s unchanged files cannot be read here, their changed files can`
          : `error: ${e.person}'s HEAD ${e.sha.slice(0, 10)} is not in this clone (${e.detail}); run git fetch, then retry; if it is still missing, ${e.person} has not pushed it yet`
        return `error: ${e instanceof Error ? e.message : String(e)}`
      }
      })

  return {
    list: () => DEFS,
    ledger,
    attachHooks: state.attachHooks,
    clearStale: state.clearStale,
    setAutoJoin(a) { autoJoin = a },
    drop: state.drop,
    shutdown: state.shutdown,
    flushConflicts: state.flushConflicts,
    waiting: () => waits > 0,
    joinedSessions: () => state.rooms.all(),
    attachWorkersRoom: (s, lead) => state.rooms.add(s, 'workers', lead),
    startupNotice(text) { startup = ledger.notice('startup', text); withdrawStartup() },
    hookSelect(budget = INBOX_BUDGET) {
      const batch = ledger.open('hook')
      withdrawStartup()
      const s = ctx.getSession()
      const ws = state.rooms.workers()
      const notices = ledger.notices(batch).map(n => n.text)
      if (s?.rejected) notices.unshift(`[room] ${s.rejected.reason}: your changes are not reaching others; your last edits are not in the room`)
      const line = ({ s: source, m }: Chosen) => `${source === s ? '' : '[workers room] '}${formatMsg(m)}`
      const room = budget - notices.reduce((n, text) => n + text.length + 1, 0)
      // Silent while alone (solo.ts): what has no company stays for room_state and the next Room tool reply.
      const { chosen, more } = s ? selectWithin(ledger, [s, ...(ws && ws !== s ? [ws] : [])], batch, room, c => line(c).length + 3, false, state.audible) : { chosen: [], more: 0 }
      const items: HookItem[] = chosen.map(c => ({ id: c.m.id, priority: c.m.priority, line: line(c) }))
      return { batch, items, notices, more }
    },
    async call(name, args, signal, handoff) {
      // Setup checks must work while auto-join, rebinding, or room sync is stuck.
      // They do not reserve inbox messages or touch the current room.
      if (name === 'room_state' && args?.check === true) return handlers.room_state(args)
      let release: (() => void) | undefined
      if (CHOOSES_ROOM.has(name)) {
        pendingMoves++
        const previous = moves
        const mine = new Promise<void>(resolve => { release = () => { pendingMoves--; resolve() } })
        moves = previous.then(() => mine)
        const wait = untilAborted(signal)
        const cancelled = await Promise.race([previous.then(async () => { while (workerOps.size) await Promise.all([...workerOps]) }).then(() => false), wait.aborted])
        wait.done()
        if (cancelled) { release!(); return 'error: tool call cancelled' }
      } else if (WORKER_OPS.has(name)) {
        const wait = untilAborted(signal)
        while (pendingMoves) {
          if (await Promise.race([moves.then(() => false), wait.aborted])) { wait.done(); return 'error: tool call cancelled' }
        }
        wait.done()
        const done = new Promise<void>(resolve => { release = resolve })
        workerOps.add(done)
        void done.then(() => workerOps.delete(done))
      }
      try {
      if (name === 'room_spawn') currentToolTiming()?.endQueue()
      const batch = ledger.open('reply')
      try {
        const body = await run(name, args, signal, batch)
        const rejected = ctx.getSession()?.rejected
        const result = rejected ? `[room] ${rejected.reason}: your changes are not reaching others; your last edits are not in the room\n\n${body}` : body
        const warning = name === 'room_state' ? staleVersionWarning() : undefined
        const text = warning ? `${warning}\n${result}` : result
        // A cancelled call's reply is never written: its selections stay owed.
        if (signal?.aborted) ledger.release(batch)
        else if (handoff) handoff({ text, commit: () => ledger.commit(batch), release: () => ledger.discard(batch) })
        else ledger.commit(batch)
        return text
      } catch (e) { ledger.release(batch); throw e }
      } finally { release?.() }
    },
  }
}

export type { ToolCtx, ToolDef } from './context.js'
export { linkSharedDirs, supersetSide } from './files.js'
export { msgPaths } from '@room/shared'
