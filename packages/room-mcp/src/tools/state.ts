import { createWorkerRuntime, registryRunningWorkers } from './workers.js'
import { createJoin } from './join.js'
import { createShare } from './share.js'
import { createPrs } from './prs.js'
import { createInbox } from './messaging.js'
import { createClaims } from './claims.js'
import { createAreas } from './scope.js'
import { neighbours, participantRecord, participantsView, snapshot, snapshotStillCurrent, versionOf, type Presence } from '@room/shared'
import { git, gitShow } from '@room/roomd/git'
import type { SharePresence } from '@room/roomd'
import { Bridge } from '../bridge.js'
import { HooksBridge } from '../hooks-bridge.js'
import { WakeReconciler } from '../wake-reconciler.js'
import { ConflictSet } from '../conflict-set.js'
import { Rooms, type Attachment, type Role } from '../registry.js'
import { authFor, closeRoom, joinSession, leaveSession, syntheticSessionId, type Session } from '../session.js'
import { Ledger } from '../ledger.js'
import { createRelevance } from '../relevance.js'
import { decideShutdown, workerRealState } from '../worker-state.js'
import { hasCompany } from '../company.js'
import { trustedWorker, workerText, NotJoined, type HandlerState, type ToolCtx } from './context.js'

export function createHandlerState(ctx: ToolCtx): HandlerState {
  const now = ctx.now ?? (() => Date.now())
  const log = ctx.log ?? ((l: string) => process.stderr.write(`room-mcp: ${l}\n`))
  const doJoin = ctx.join ?? joinSession
  const doLeave = ctx.leave ?? leaveSession

  // ---- per-session state --------------------------------------------------
  const upgraded = new Set<string>() // "msgId:person" copies already posted
  /** The lead-in-two-rooms bridge, while a workers room is open (owned by that session's attachment). */
  let roomBridge: Bridge | null = null
  let preserveBridgeFacts = false
  /** The primary session's hooks bridge (state file); the inbox asks it to rewrite after marking messages seen. */
  let primaryHooks: HooksBridge | null = null
  const doClose = ctx.close ?? (async (s: Session) => { const a = await authFor(s); return closeRoom(a.server, s.roomName, { session: a.session, token: a.token }) })
  /**
   * Everything a joined session needs running. Both rooms get wakes. The primary gets the hooks bridge
   * (state file), the conflict watcher and the PR mirror. The workers room gets the bridge to the lead's
   * team room (the state file is the team room's).
   */
  const attach = (s: Session, role: Role, lead?: Session): Attachment => {
    ledger.bind(s)
    wakes.attach(s)
    const hooks = role === 'primary' ? new HooksBridge(s, {
      owedCount: () => ledger.candidates(s).length, noticeCount: () => ledger.noticeCount(), fenced: () => ledger.fenced(s),
      sessionDir: () => ctx.binding?.dir(), paused: () => s.rejected
        ? `[room] ${s.rejected.reason}: your changes are not reaching others; your last edits are not in the room`
        : s.lease?.paused() ?? s.hub.paused(), company: () => company(s), log,
    }) : null
    hooks?.start()
    if (hooks) primaryHooks = hooks
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
        wakes.detach(s); hooks?.stop(); watcher?.stop()
        if (hooks && primaryHooks === hooks) primaryHooks = null
        if (role === 'primary') prs.stopPrSync()
        if (bridge) { bridge.stop(preserveBridgeFacts); if (roomBridge === bridge) roomBridge = null }
      },
      flush: () => watcher?.flush() ?? Promise.resolve(),
      project: () => bridge?.sync() ?? Promise.resolve(),
    }
  }
  const rooms = new Rooms({ primary: () => ctx.getSession(), setPrimary: s => ctx.setSession(s), attach, log, probe: ctx.probe, listCwdProcesses: ctx.listCwdProcesses })

  const S = (): Session => {
    const s = ctx.getSession()
    if (!s) throw new NotJoined()
    return s
  }
  const isMe = (s: Session, p: { name: string; kind: string }) => p.name === s.me.name && p.kind === s.me.kind
  const mine = (s: Session) => s.room.openClaims().filter(c => c.by === s.me.name && c.byKind === s.me.kind)

  const others = (s: Session): string[] => {
    const names = neighbours(participantsView(s.room, s.awareness, now()), s.me.name).names()
    const retired = new Set(s.room.retiredWorkers().map(w => w.name))
    return names.filter(n => !retired.has(n) || s.room.acceptedWorkerViewOf(n)).sort()
  }
  const presences = (s: Session): SharePresence[] =>
    Array.from(s.awareness.getStates().values()).filter((x): x is SharePresence => !!x && typeof x === 'object' && !!(x as Presence).user)
  /** Display only; publication and reads use the manifest, never presence sharing. */
  const shareOf = (s: Session, person: string) => s.room.manifestHead.get(person)?.level ?? 'intent'
  const setPresence = (s: Session, patch: Partial<Presence>) => {
    const cur = (s.awareness.getLocalState() ?? {}) as Partial<Presence>
    s.awareness.setLocalState({ ...cur, ...patch, lastActive: now() })
  }
  /** The commit a person's overlay is a delta from (their own HEAD). A carried worker in a
   *  team room publishes its lead's HEAD, because only the lead's machine has the carried commit; that machine (the lead
   *  and its workers) uses the carried commit itself. */
  const baseFor = (s: Session, person: string) => s.room.manifestHead.get(person)?.base ?? participantRecord(s.room, person)?.git?.base ?? 'HEAD'
  const baseText = async (s: Session, path: string, person = s.me.name): Promise<string | undefined> => gitShow(s.dir, baseFor(s, person), path)
  const readVersion: HandlerState['readVersion'] = async (s, path, person) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const view = participantsView(s.room, s.awareness, now())
      const snap = snapshot(s.room, person, view)
      const result = await versionOf(snap, path, {
        gitAt: (sha, relpath) => gitShow(s.dir, sha, relpath),
        known: hash => git(s.dir, ['cat-file', 'blob', hash]).catch(() => undefined),
      })
      if (!snap || snapshotStillCurrent(s.room, snap, participantsView(s.room, s.awareness, now()))) return result
    }
    return { kind: 'unknown', why: 'updating', detail: `${person}'s changes moved during the read; re-run` }
  }
  const readText: HandlerState['readText'] = async (s, path, person) => {
    if (person === s.me.name) return workerText(s.dir, path)
    const worker = await trustedWorker(s, person)
    if (worker) return workerText(worker.dir, path)
    const version = await readVersion(s, path, person)
    if (version.kind === 'text') return version.text
    if (version.kind === 'deleted') return null
    if (version.kind === 'base') return version.text
    throw new Error(`${path}: ${person}'s version is ${version.kind}${'detail' in version ? ` (${version.detail})` : ''}`)
  }
  const lines = (t: string) => t.endsWith('\n') ? t.split('\n').length - 1 : t.split('\n').length

  const areas = createAreas({ ctx, log, presences, others, shareOf, now, isMe })
  const claims = createClaims({ log, ctx })
  const scheduleInboxWrite = () => primaryHooks?.scheduleWrite()
  const ledger: Ledger = new Ledger({
    sessionId: () => ctx.binding?.id() ?? syntheticSessionId({ pid: process.pid, startTime: '', executable: '' }),
    sessionDir: () => ctx.binding?.dir(),
    route: s => ({ claims: mine(s), inMyAreas: m => areas.msgInMyAreas(s, m) }),
    relevant: createRelevance(),
    onSettled: () => { scheduleInboxWrite(); wakes.reconcile() },
    log,
    hookLeaseMs: ctx.hookLeaseMs,
  })
  const wakes = new WakeReconciler({
    ledger, bound: () => ctx.binding?.bound(), sessionDir: () => ctx.binding?.dir(), log,
    send: ctx.wake ?? (async () => undefined), // without a host sender (tests), wakes are off
    ownWorkers: s => new Set(workers.myWorkers(s).map(w => w.name)),
  })
  const inboxServices = createInbox({ ledger, rooms, log, scheduleInboxWrite, mine, msgInMyAreas: areas.msgInMyAreas, others, upgraded, readVersion })
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
    shareOf, setPresence, baseFor, baseText, readVersion, readText, lines,
    workerPaths: () => roomBridge?.workerPaths() ?? [],
    scheduleInboxWrite,
    upgraded,
    attachHooks: (s: Session) => rooms.add(s, 'primary'),
    clearStale: (s: Session) => state.cleanupMine(s, 'stale from an earlier session'),
    async shutdown() {
      preserveBridgeFacts = true
      wakes.stop()
      const s = ctx.getSession()
      if (!s) { await state.closeWorkersRoom(true).catch(() => {}); return }
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
      await state.closeWorkersRoom(true).catch(() => {})
      rooms.remove(s)
      await doLeave(s)
    },
    async drop(s: Session, reason: string) {
      log(`leaving ${s.roomName}: ${reason}`)
      rooms.remove(s)
      await doLeave(s)
    },
    async flushConflicts() { await rooms.flush() },
  }
  return state
}
