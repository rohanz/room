import { createWorkerRuntime, registryRunningWorkers } from './workers.js'
import { createJoin } from './join.js'
import { createShare } from './share.js'
import { createPrs } from './prs.js'
import { createInbox } from './messaging.js'
import { createClaims } from './claims.js'
import { createAreas } from './scope.js'
import { isAgentic, scopeCovers, type Presence } from '@room/shared'
import { gitShow } from '@room/roomd/git'
import { workerBaseline } from '@room/roomd/baseline'
import type { ShareLevel, SharePresence } from '@room/roomd'
import { Bridge } from '../bridge.js'
import { HooksBridge } from '../hooks-bridge.js'
import { ConflictSet } from '../conflict-set.js'
import { isPrName } from '../prs.js'
import { Rooms, type Attachment, type Role } from '../registry.js'
import { authFor, closeRoom, joinSession, leaveSession, syntheticSessionId, type Session } from '../session.js'
import { Ledger } from '../ledger.js'
import { createRelevance } from '../relevance.js'
import { decideShutdown, workerRealState } from '../worker-state.js'
import { hasCompany } from '../company.js'
import { repairRetired } from '../retire.js'
import { diskWorker, workerText, NeedFetch, NotJoined, type HandlerState, type ToolCtx } from './context.js'

export function createHandlerState(ctx: ToolCtx): HandlerState {
  const now = ctx.now ?? (() => Date.now())
  const log = ctx.log ?? ((l: string) => process.stderr.write(`room-mcp: ${l}\n`))
  const doJoin = ctx.join ?? joinSession
  const doLeave = ctx.leave ?? leaveSession

  // ---- per-session state --------------------------------------------------
  const upgraded = new Set<string>() // "msgId:person" copies already posted
  /** The lead-in-two-rooms bridge, while a workers room is open (owned by that session's attachment). */
  let roomBridge: Bridge | null = null
  /** The primary session's hooks bridge (state file); the inbox asks it to rewrite after marking messages seen. */
  let primaryHooks: HooksBridge | null = null
  const doClose = ctx.close ?? (async (s: Session) => { const a = await authFor(s); return closeRoom(a.server, s.roomName, { session: a.session, token: a.token }) })
  /**
   * Everything a joined session needs running. The primary gets the hooks bridge (state file + wake),
   * the conflict watcher and the PR mirror. The workers room gets a wake-only hooks bridge (the state
   * file is the team room's), the host's channel push, and the bridge to the lead's team room.
   */
  const attach = (s: Session, role: Role, lead?: Session): Attachment => {
    ledger.bind(s)
    const hooks = new HooksBridge(s, {
      forMe: m => inboxServices.forMe(s, m), owedCount: () => ledger.candidates(s).length, noticeCount: () => ledger.noticeCount(), fenced: () => ledger.fenced(s),
      session: () => ctx.binding?.bound(), sessionDir: () => ctx.binding?.dir(), paused: () => s.hub.paused(),
      company: () => company(s), log, queue: ctx.queue, ...(role === 'workers' ? { writeState: false } : {}),
    })
    hooks.start()
    if (role === 'primary') primaryHooks = hooks
    let watcher: ConflictSet | null = null
    let bridge: Bridge | null = null
    if (role === 'primary') {
      watcher = claims.startConflictSet(s)
      prs.startPrSync(s)
    } else if (lead) {
      bridge = workers.startWorkersBridge(lead, s)
      roomBridge = bridge
    }
    return {
      stop() {
        hooks.stop(); watcher?.stop()
        if (primaryHooks === hooks) primaryHooks = null
        if (role === 'primary') prs.stopPrSync()
        if (bridge) { bridge.stop(); if (roomBridge === bridge) roomBridge = null }
      },
      flush: () => watcher?.flush() ?? Promise.resolve(),
    }
  }
  const rooms = new Rooms({ primary: () => ctx.getSession(), setPrimary: s => ctx.setSession(s), observeClaims: () => {}, attach, probe: ctx.probe, listCwdProcesses: ctx.listCwdProcesses })

  const S = (): Session => {
    const s = ctx.getSession()
    if (!s) throw new NotJoined()
    for (const roomSession of new Set([s, ...rooms.all()])) {
      const present = new Set(Array.from(roomSession.awareness?.getStates().values() ?? []).flatMap(p => p.user?.name ? [p.user.name] : []))
      repairRetired(roomSession, present)
    }
    return s
  }
  const isMe = (s: Session, p: { name: string; kind: string }) => p.name === s.me.name && p.kind === s.me.kind
  const mine = (s: Session) => s.room.openClaims().filter(c => c.by === s.me.name && c.byKind === s.me.kind)

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
  const readText = async (s: Session, path: string, person: string): Promise<string | undefined | null> =>
    person === s.me.name ? workerText(s.dir, path) : liveText(s, path, person)
  const lines = (t: string) => t.endsWith('\n') ? t.split('\n').length - 1 : t.split('\n').length

  const areas = createAreas({ ctx, log, base, presences, others, shareOf, now, isMe })
  const claims = createClaims({ log, ctx })
  const scheduleInboxWrite = () => primaryHooks?.scheduleWrite()
  const ledger: Ledger = new Ledger({
    sessionId: () => ctx.binding?.id() ?? syntheticSessionId({ pid: process.pid, startTime: '', executable: '' }),
    sessionDir: () => ctx.binding?.dir(),
    route: s => ({ claims: mine(s), inMyAreas: m => areas.msgInMyAreas(s, m) }),
    relevant: createRelevance(),
    onSettled: scheduleInboxWrite,
    log,
    hookLeaseMs: ctx.hookLeaseMs,
  })
  const inboxServices = createInbox({ ledger, rooms, log, scheduleInboxWrite, mine, msgInMyAreas: areas.msgInMyAreas, others, upgraded })
  const prs = createPrs({ ctx, presences, log, now })
  const share = createShare()
  const join = createJoin({ ctx, log, doJoin, doLeave, rooms, now, presences,
    runningWorkers: s => registryRunningWorkers(s, rooms) })
  const workers = createWorkerRuntime({ ctx, rooms, doJoin, doLeave, log, cleanupMine: join.cleanupMine, now })
  const company = (s: Session) => hasCompany(s, workers.runningWorkers(s).map(r => r.w), now())
  const state: HandlerState = {
    ...workers,
    ...join,
    ...share,
    ...prs,
    ...inboxServices,
    ...claims,
    ...areas,
    ctx, now, log, doJoin, doLeave, doClose, ledger, rooms, S, isMe, mine, 
    hasCompany: company, others, presences,
    shareOf, withheld, setPresence, base, baseFor, baseText, liveText, readText, lines,
    workerPaths: () => roomBridge?.workerPaths() ?? [],
    scheduleInboxWrite,
    upgraded,
    attachHooks: (s: Session) => rooms.add(s, 'primary'),
    clearStale: (s: Session) => { join.evictStale(s); return state.cleanupMine(s, 'stale from an earlier session') },
    async shutdown() {
      const s = ctx.getSession()
      if (!s) return
      const running = (await Promise.all(state.runningWorkers(s).map(async r => ({ ...r, action: decideShutdown(await workerRealState(r.s.dir, r.w, { process: true, hasHandle: rooms.hasHandle?.(r.s, r.w), probe: ctx.probe })) })))).filter(r => r.action === 'stop')
      const cancellation = new AbortController()
      const pending = new Set(running.map(r => r.w.tag))
      const stops = running.map(async r => {
        try { await state.dismissWorker(r.s, r.w, "the lead's session ended", 'lead-session-ended', cancellation.signal) }
        catch (e) { log(`shutdown dismissal failed for ${r.w.tag}: ${e instanceof Error ? e.message : String(e)}`) }
        finally { pending.delete(r.w.tag) }
      })
      if (stops.length) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const completed = await Promise.race([Promise.all(stops).then(() => true), new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), 1800)
          timer.unref()
        })])
        if (timer) clearTimeout(timer)
        if (!completed) {
          cancellation.abort()
          for (const tag of pending) log(`shutdown dismissal timed out for ${tag}; worker record kept for restart`)
        }
      }
      await state.closeWorkersRoom().catch(() => {})
      try { state.cleanupMine(s, 'session ended') } catch { /* best effort */ }
      rooms.remove(s)
      await doLeave(s)
    },
    async drop(s: Session, reason: string) {
      log(`leaving ${s.roomName}: ${reason}`)
      try { state.cleanupMine(s, reason) } catch { /* best effort */ }
      rooms.remove(s)
      await doLeave(s)
    },
    async flushConflicts() { await rooms.flush() },
  }
  return state
}
