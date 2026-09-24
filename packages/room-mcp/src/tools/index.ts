import { hookHealthNote } from '../hooks-bridge.js'
import { hasCompany } from '../company.js'
import { connectedBefore, trackConnection } from '../connection.js'
import { toolCallAborted, withToolSignal } from '../registry.js'
import { LOCAL, NotLoggedIn, type Session } from '../session.js'
import { createHandlerState, NeedFetch, NotJoined, type HandlerState, type ToolCtx, type ToolDef } from './context.js'
import { defs as joinDefs, handlers as joinHandlers, install as installJoin, teamSharingNote } from './join.js'
import { defs as scopeDefs, handlers as scopeHandlers, install as installScope } from './scope.js'
import { defs as claimDefs, handlers as claimHandlers, install as installClaims } from './claims.js'
import { defs as messagingDefs, handlers as messagingHandlers, install as installMessaging, WAIT_SIGNAL } from './messaging.js'
import { defs as collectDefs, handlers as collectHandlers } from './collect.js'
import { defs as fileDefs, handlers as fileHandlers } from './files.js'
import { defs as workerDefs, handlers as workerHandlers, install as installWorkers } from './workers.js'
import { defs as shareDefs, handlers as shareHandlers, install as installShare } from './share.js'
import { defs as prDefs, handlers as prHandlers, install as installPrs } from './prs.js'

export interface Tools {
  list(): ToolDef[]
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>
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
}

/** What the tools need of the automatic join (auto-join.ts). */
export interface AutoJoinHandle { ensure(): Promise<void>; settle(): Promise<void>; cancel(): void; retarget(s: Session): void; readonly failure?: string }
/** Tools that choose the room themselves: the automatic join pauses while one runs, and stays stopped unless it joined a room. */
const CHOOSES_ROOM = new Set(['room_join', 'room_create', 'room_leave', 'room_close'])

const ALL_DEFS = [...joinDefs, ...scopeDefs, ...fileDefs, ...claimDefs, ...messagingDefs, ...workerDefs, ...collectDefs, ...prDefs, ...shareDefs]
const DEF_ORDER = ['room_login', 'room_create', 'room_join', 'room_leave', 'room_close', 'room_export', 'room_scope', 'room_state', 'room_read', 'room_claim', 'room_release', 'room_send', 'room_wait', 'room_done', 'room_pr_note', 'room_impact', 'room_preview_merge', 'room_share', 'room_spawn', 'room_collect']
export const DEFS: ToolDef[] = DEF_ORDER.map(name => ALL_DEFS.find(d => d.name === name)!)

export function createTools(ctx: ToolCtx): Tools {
  const state: HandlerState = createHandlerState(ctx)
  const initial = ctx.getSession()
  if (initial) trackConnection(initial, state.now)
  installScope(state)
  installClaims(state)
  installMessaging(state)
  installPrs(state)
  installJoin(state)
  installWorkers(state)
  installShare(state)
  let autoJoin: AutoJoinHandle | undefined
  const notJoined = () => autoJoin?.failure ? `error: not in a room. ${autoJoin.failure}`
    : ctx.config?.server === LOCAL ? 'error: not in the local room; room_join to join it.'
    : 'error: not in a room. room_join if a teammate has opened this repo, room_create otherwise.'
  const handlers = Object.assign({}, joinHandlers(state), scopeHandlers(state), fileHandlers(state), claimHandlers(state), messagingHandlers(state), workerHandlers(state), collectHandlers(state), prHandlers(state), shareHandlers(state))

  return {
    list: () => DEFS,
    attachHooks: state.attachHooks,
    clearStale: state.clearStale,
    setAutoJoin(a) { autoJoin = a },
    drop: state.drop,
    shutdown: state.shutdown,
    flushConflicts: state.flushConflicts,
    async call(name, args, signal) {
      return withToolSignal(signal, async () => {
      if (toolCallAborted()) return 'error: tool call cancelled'
      const h = handlers[name]
      if (!h) return `error: unknown tool ${name}`
      if (autoJoin && CHOOSES_ROOM.has(name)) { await autoJoin.settle(); autoJoin.cancel() }
      else if (autoJoin) await autoJoin.ensure()
      if (toolCallAborted()) return 'error: tool call cancelled'
      const current = ctx.getSession()
      current?.daemon.touch()
      const closed = current?.closed
      const offlineTool = name === 'room_state' || name === 'room_send' || name === 'room_wait' || name === 'room_collect'
      if (closed && name !== 'room_leave' && !offlineTool) { const rn = current!.roomName; return `error: the room for ${rn.slice(0, rn.lastIndexOf('/'))} was closed (${closed.reason}); room_leave, then room_create to reopen` }
      const moved = await state.followBranch()
      if (toolCallAborted()) return 'error: tool call cancelled'
      const s = ctx.getSession()
      s?.refreshRuntime?.()
      if (s && !s.provider.synced && name !== 'room_leave' && !(offlineTool && (s.closed || connectedBefore(s)))) return 'error: room not synced yet, retry'
      if (s) { trackConnection(s, state.now); state.rooms.track(s) }
      try {
        const body = await h(name === 'room_wait' ? { ...(args ?? {}), [WAIT_SIGNAL]: signal } : args ?? {})
        if (toolCallAborted()) return 'error: tool call cancelled'
        if (name === 'room_preview_merge' || name.startsWith('room_pr_')) await state.rooms.retireWorkers()
        const s2 = ctx.getSession()
        if (s2 && s2 !== s) s2.refreshRuntime?.()
        if (s2 && autoJoin && (name === 'room_join' || name === 'room_create')) autoJoin.retarget(s2)
        const prefix = moved ? `${moved}\n\n` : ''
        const unread = s2 && name !== 'room_join' && name !== 'room_create' ? state.inbox(s2) : ''
        const sharing = s2 ? await teamSharingNote(s2) : ''
        const health = s2 ? hookHealthNote(s2, !s2.local || hasCompany(s2, state.myWorkers(s2), state.now()).company, state.now(), name, !s2.local) : ''
        const autoTag = s2?.autoTagNote
        if (s2) delete s2.autoTagNote
        return prefix + (sharing ? sharing + '\n\n' : '') + (health ? health + '\n\n' : '') + (autoTag ? autoTag + '\n\n' : '') + (unread ? unread + body : body)
      } catch (e) {
        if (toolCallAborted()) return 'error: tool call cancelled'
        if (e instanceof NotJoined) return notJoined()
        if (e instanceof NotLoggedIn) return `error: ${e.message}`
        if (e instanceof NeedFetch) return e.lead
          ? `error: ${e.person}'s base ${e.sha.slice(0, 10)} is ${e.lead}'s carried uncommitted work, which exists only on ${e.lead}'s machine; ${e.person}'s unchanged files cannot be read here, their changed files can`
          : `error: ${e.person}'s HEAD ${e.sha.slice(0, 10)} is not in this clone (${e.detail}); run git fetch, then retry; if it is still missing, ${e.person} has not pushed it yet`
        return `error: ${e instanceof Error ? e.message : String(e)}`
      }
      })
    },
  }
}

export type { ToolCtx, ToolDef } from './context.js'
export { linkSharedDirs, supersetSide } from './files.js'
export { msgPaths } from '@room/shared'
