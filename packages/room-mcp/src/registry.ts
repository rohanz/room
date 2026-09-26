/**
 * The rooms one MCP process is in, and everything hung off each of them.
 *
 * A process used to hold exactly one session; a lead in a team room that dispatches workers into a
 * local room holds two. Every tool that names a participant, a question, a claim or a worker asks
 * this registry which session holds it instead of guessing. The registry also owns the per-session
 * attachments (hooks bridge, conflict watcher, PR mirror, channel push, the lead-in-two-rooms
 * bridge) so they start when a session is added and stop when it is removed, and the process
 * handles of workers this process spawned, keyed by the worker's stable id.
 */
import type { NoteMsg, Presence, Worker } from '@room/shared'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { LOCAL, type Session } from './session.js'
import { cleanupWorker, clearWorkerStopState, defaultSpawner, ignoredWorkerArtifacts, persistedWorkerStopReason, pidAlive, pidIsOurWorker, pruneMissingWorkerWorktree, workerLogTail, workerOperationKey, type SpawnedProcess, type Spawner } from './workers.js'
import { decideResume, decideRetire, processExited, workerRealState } from './worker-state.js'
import { DEFAULT_CLAUDE_CHANNEL, resolveConfig } from './config.js'
import { launchWorkerProcess, reserveWorkerLaunch, WorkerLaunchError } from './worker-launch.js'

export type Role = 'primary' | 'workers'

/** The MCP request's cancellation follows awaits into worker preparation and registry locks. */
const toolSignal = new AsyncLocalStorage<AbortSignal>()
export function withToolSignal<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  return signal ? toolSignal.run(signal, run) : run()
}
export function toolCallAborted(): boolean { return toolSignal.getStore()?.aborted === true }

/** What a session needs running while it is in the registry; built by the host (tools.ts) because the pieces close over tool state. */
export interface Attachment {
  /** Stop everything this attachment started. */
  stop(): void
  /** Run any pending automatic conflict checks now (tests). */
  flush?(): Promise<void>
}

export interface RoomsOptions {
  /** The primary session lives with the host (tests and index.ts set it); the registry reads and writes it through these. */
  primary(): Session | null
  setPrimary(s: Session | null): void
  /** Observe the session's claims map for concurrent overlaps (cheap; every tracked session gets it). */
  observeClaims(s: Session): void
  /** Full attachments for a session that was joined through the tools or adopted at startup. */
  attach(s: Session, role: Role, lead?: Session): Attachment
}

/** A worker's stable identity: one per spawn, never reused. */
export function workerId(lead: string, tag: string, gen: number): string { return `${lead}/${tag}#${gen}` }
/** The part of an id that a concurrent spawn of the same tag would share. */
export function workerIdBase(roomName: string, lead: string, tag: string): string { return `${roomName}|${lead}/${tag}` }
/** Where a worker started from this session connects, and whether this session is itself a worker (its budget is then shared). */
export function workerOrigin(s: Session): { server: string; isWorker: boolean } {
  return {
    server: s.local ? LOCAL : s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/')),
    isWorker: !!process.env.ROOM_TAG || !!s.room.workerOf(s.me.name) || (!!s.me.owner && s.me.owner !== s.me.name),
  }
}

/** A confirmed exit is recorded once, including when discovered after the lead restarts. */
/** `unwitnessed`: a later lead found the recorded worker process gone, but cannot know why it stopped. */
export async function finishWorkerProcess(s: Session, w: Worker, code: number | null, at = Date.now(), error?: string, unwitnessed = false): Promise<void> {
  const current = s.room.workers.get(w.tag)
  if (current !== w || w.exitCode !== undefined) return
  const done = w.status === 'done'
  const exitCode = code ?? -1
  const tail = workerLogTail(path.join(s.dir, '.room', 'workers', `${w.tag}.log`))
  const stopReason = w.stopReason ?? (unwitnessed ? persistedWorkerStopReason(s.dir, w.tag, w.id) : undefined)
  s.room.updateWorker(w.tag, {
    exitCode, finishedAt: w.finishedAt ?? at,
    ...(stopReason ? { stopReason } : {}),
    ...(w.status !== 'running' ? {}
      : unwitnessed ? { status: stopReason ? 'dismissed' as const : 'failed' as const, summary: `stopped while no session of yours was running; ${stopReason ?? 'reason unknown'}; worktree: ${w.dir}; last lines of its log: ${tail || '(empty log)'}` }
      : { status: 'failed' as const, summary: w.summary ?? error ?? 'process exited without room_done' }),
  }, w.id)
  if (!done) {
    // tools/context constructs Rooms: defer this dependency until all tool definitions are loaded.
    const { releaseClaimsOnDone } = await import('./tools/claims.js')
    const current = s.room.workers.get(w.tag)
    if (!current || current.id !== w.id || current.gen !== w.gen || current.startedAt !== w.startedAt) return
    releaseClaimsOnDone(s, undefined, w.name)
  }
  if (!unwitnessed && !w.stopReason && w.dismissedAt === undefined && (exitCode !== 0 || !done)) {
    const seconds = Math.max(0, Math.floor((at - w.startedAt) / 1000))
    const elapsed = seconds < 90 ? `${seconds} s after start` : `after ${Math.floor(seconds / 60)}m`
    s.room.post<NoteMsg>({ name: 'room', kind: 'bot' }, {
      type: 'note', to: w.lead, priority: 'interrupt',
      text: `worker ${w.tag} died ${elapsed} (exit ${code ?? 'unknown'})${!done ? '; exited without room_done' : ''}${error ? `; ${error}` : ''}; last lines of its log: ${tail || '(empty log)'}`,
    })
  }
}

export class Rooms {
  private entries = new Map<Session, { role: Role; attachment?: Attachment }>()
  private tracked = new WeakSet<Session>()
  /** Processes this MCP instance started, by worker id. A lead that restarted only has the pid in the doc. */
  private handles = new Map<string, { proc: SpawnedProcess; session: Session }>()
  private exitWaiters = new Map<string, Set<() => void>>()
  /** Tags whose worktree is being prepared, so two concurrent room_spawn calls cannot both pass the tag check. */
  private reserving = new Set<string>()
  /** Starts awaiting worktree preparation count against the same limit as live workers. */
  private launching = 0
  private retirementTimers = new Map<Session, ReturnType<typeof setInterval>>()
  private retiring = new Map<Session, Promise<void>>()

  constructor(private o: RoomsOptions) {}

  // ---- sessions ---------------------------------------------------------------
  primary(): Session | null { return this.o.primary() }
  /** The local room holding this lead's workers while the lead itself is in a team room. */
  workers(): Session | null {
    for (const [s, e] of this.entries) if (e.role === 'workers') return s
    return null
  }
  /** Primary first, then the workers room. */
  all(): Session[] {
    const p = this.primary()
    const out: Session[] = p ? [p] : []
    const w = this.workers()
    if (w && w !== p) out.push(w)
    return out
  }
  roleOf(s: Session): Role | undefined { return this.entries.get(s)?.role ?? (s === this.primary() ? 'primary' : undefined) }
  byName(roomName: string): Session | undefined { return this.all().find(s => s.roomName === roomName) }

  /** Register a session with its full attachments; idempotent per session. A primary also becomes `primary()`. */
  add(s: Session, role: Role, lead?: Session): void {
    if (role === 'primary' && this.primary() !== s) this.o.setPrimary(s)
    this.track(s)
    const cur = this.entries.get(s)
    if (cur?.attachment) return
    // One primary and one workers room at a time: an older session in the same role is detached first.
    for (const [other, e] of this.entries) if (other !== s && e.role === role) { e.attachment?.stop(); this.stopRetirement(other); this.entries.delete(other) }
    this.entries.set(s, { role, attachment: this.o.attach(s, role, lead) })
  }
  /** Claims observer only (a session the host set without joining through the tools, e.g. in tests). */
  track(s: Session): void {
    if (this.tracked.has(s)) return
    this.tracked.add(s)
    for (const w of s.room.workers.values()) {
      if (w.stopReason) continue
      try {
        const reason = persistedWorkerStopReason(s.dir, w.tag, w.id)
        if (reason) s.room.updateWorker(w.tag, { stopReason: reason, ...(w.status === 'running' ? { status: 'dismissed' as const } : {}) }, w.id)
      } catch { /* an external checkout has no local carry record */ }
    }
    this.o.observeClaims(s)
    const timer = setInterval(() => { void this.retireWorkers(s).catch(() => {}) }, 60_000)
    timer.unref()
    this.retirementTimers.set(s, timer)
  }
  /** Stop the session's attachments and forget it; a primary is also cleared from the host. Does not leave the room. */
  remove(s: Session): void {
    this.stopRetirement(s)
    const e = this.entries.get(s)
    e?.attachment?.stop()
    this.entries.delete(s)
    for (const [id, h] of Array.from(this.handles)) if (h.session === s) this.handles.delete(id)
    if (this.primary() === s) this.o.setPrimary(null)
  }
  async flush(): Promise<void> { for (const e of this.entries.values()) await e.attachment?.flush?.() }

  private stopRetirement(s: Session): void {
    clearInterval(this.retirementTimers.get(s))
    this.retirementTimers.delete(s)
    this.tracked.delete(s)
  }

  /** Recheck after exits, dismissals, merge previews and periodically while a session is tracked. */
  async retireWorkers(session?: Session): Promise<void> {
    for (const s of session ? [session] : this.all()) {
      const pending = this.retiring.get(s)
      if (pending) { await pending; await this.retireWorkers(s); continue }
      const run = this.evaluateRetirement(s)
      this.retiring.set(s, run)
      try { await run } finally { this.retiring.delete(s) }
    }
  }

  private async evaluateRetirement(s: Session): Promise<void> {
    // Older releases archived workers without necessarily withdrawing their live overlays.
    const present = new Set(Array.from(s.awareness?.getStates().values() ?? []).flatMap(p => p.user?.name ? [p.user.name] : []))
    s.room.sweepRetiredWorkers(present)
    for (const w of s.room.workers.values()) {
      // The next lead must be able to explain and resume this intentionally stopped work.
      if (w.stopReason === 'lead-session-ended') continue
      // Keep a finished host session addressable until the lead explicitly collects or
      // discards it. If its checkout vanished, room_send must explain why it cannot resume.
      if (w.status === 'done' && w.hostSessionId) continue
      if (this.reserving.has('discard:' + s.roomName + ':' + w.name)) continue
      if (w.lead !== s.me.name || this.hasHandle(s, w)) continue
      const lock = workerOperationKey(w)
      if (!this.reserve(lock)) continue
      try {
        const state = await workerRealState(s.dir, w, { process: true })
        if (!processExited(state) || pidAlive(w.pid)) continue
        if (w.status !== 'done') s.room.clearWorkerCoordination(w.name)
        if (w.status === 'running') {
          await finishWorkerProcess(s, w, null, Date.now(), undefined, true)
          continue
        }
        if (w.status !== 'done' && !state.dismissed) continue
        if (state.worktree === 'vanished') {
          try { await pruneMissingWorkerWorktree(s.dir, w) } catch { continue }
          if (s.room.workers.get(w.tag) !== w || this.hasHandle(s, w) || !this.retirementTimers.has(s)) continue
          const retiredAt = Date.now()
          s.room.retireParticipant(w.name, {
            name: w.name, tag: w.tag, lead: w.lead, host: w.host, ...(w.model ? { model: w.model } : {}),
            task: w.task, summary: 'worktree was already gone', files: [], fileCount: 0,
            startedAt: w.startedAt, finishedAt: w.finishedAt ?? retiredAt, retiredAt, outcome: 'dismissed',
          })
          continue
        }
        const facts = { ...await workerRealState(s.dir, w, { git: true, leadName: w.lead }), process: state.process }
        const outcome = decideRetire(facts)
        // Git awaits must not let an old evaluation retire a newer spawn or a disconnected session.
        if (!outcome || s.room.workers.get(w.tag) !== w || this.hasHandle(s, w) || !this.retirementTimers.has(s) || this.reserving.has('discard:' + s.roomName + ':' + w.name)) continue
        // An ignored artifact has no recovery patch. Keep both its worktree and the live record so
        // the lead can copy it or explicitly discard it, exactly as manual collection does.
        try { if ((await ignoredWorkerArtifacts(w)).length) continue }
        catch { continue }
        const done = s.room.messages().filter(m => m.type === 'done' && m.from === w.name && m.at >= w.startedAt).at(-1)
        const files = [...new Set([...s.room.changedPaths(w.name), ...(done?.type === 'done' ? done.changed : [])])].sort()
        if (facts.clean && w.exitCode === 0) {
          try { if (!await cleanupWorker(s.dir, w, true, false, [], {}, s.me.name, [...s.room.retiredWorkers(), ...s.room.workers.values()])) continue }
          catch { continue }
        }
        const retiredAt = Date.now()
        s.room.retireParticipant(w.name, {
          name: w.name, tag: w.tag, lead: w.lead, host: w.host, ...(w.model ? { model: w.model } : {}),
          task: w.task, summary: w.summary ?? '', files, fileCount: files.length, startedAt: w.startedAt,
          finishedAt: w.finishedAt ?? done?.at ?? retiredAt, retiredAt, outcome,
          ...(outcome === 'dismissed' && facts.uncommitted !== undefined ? { uncommitted: facts.uncommitted } : {}),
        })
      } finally { this.unreserve(lock) }
    }
  }

  // ---- who lives where ----------------------------------------------------------
  private static presences(s: Session): Presence[] {
    return Array.from(s.awareness.getStates().values()).filter((x): x is Presence => !!x && typeof x === 'object' && !!(x as Presence).user)
  }
  private static activeIn(s: Session, name: string): boolean {
    return s.room.scopes.has(name) || s.room.overlays.has(name) || Rooms.presences(s).some(p => p.user.name === name)
  }
  /**
   * The session in which a participant lives. Where the person is present or has work wins; a worker
   * record alone (the same tag can be spawned in both rooms) decides only when neither room shows them.
   * `from` is the caller's session and the fallback.
   */
  holding(name: string, from: Session = this.primary() ?? this.mustHave()): Session {
    const others = this.all().filter(s => s !== from)
    if (!others.length || name === from.me.name) return from
    if (Rooms.activeIn(from, name)) return from
    for (const s of others) if (Rooms.activeIn(s, name)) return s
    if (from.room.workerOf(name)) return from
    for (const s of others) if (s.room.workerOf(name)) return s
    return from
  }
  /** The session whose bus carries a message id, if any of ours does. */
  holdingQuestion(msgId: string, from: Session = this.primary() ?? this.mustHave()): Session | undefined {
    for (const s of [from, ...this.all().filter(x => x !== from)]) if (s.room.messages().some(m => m.id === msgId)) return s
    return undefined
  }
  /** The session whose workers map has this tag; the caller's session first. */
  holdingWorker(tag: string, from: Session = this.primary() ?? this.mustHave()): Session {
    if (from.room.workers.get(tag)) return from
    for (const s of this.all()) if (s !== from && s.room.workers.get(tag)) return s
    return from
  }
  private mustHave(): Session { throw new Error('not in a room') }

  // ---- worker processes ---------------------------------------------------------
  reserve(base: string): boolean { if (toolCallAborted() || this.reserving.has(base)) return false; this.reserving.add(base); return true }
  unreserve(base: string): void { this.reserving.delete(base) }
  reserveLaunch(max: number, running: number): boolean {
    if (toolCallAborted() || this.launchUsage(running) >= max) return false
    this.launching++
    return true
  }
  releaseLaunch(): void { this.launching-- }
  launchUsage(running: number): number { return running + this.launching }
  runningWorkerCount(s: Session): number {
    const sessions = [s, ...this.all().filter(x => x !== s)]
    let count = 0
    for (const sess of sessions) for (const w of sess.room.workers.values()) {
      if (w.lead === s.me.name && (w.status === 'running' || this.hasHandle(sess, w) || pidIsOurWorker(w.pid, w))) count++
    }
    return count
  }
  /** A worker id is unique per lead and tag, but the same lead may spawn the same tag in its own room and in the workers room: handles are keyed per room. */
  private static hkey(s: Session, id: string): string { return `${s.roomName}|${id}` }
  setHandle(s: Session, id: string, proc: SpawnedProcess): void { this.handles.set(Rooms.hkey(s, id), { proc, session: s }) }
  handle(s: Session, id: string | undefined): SpawnedProcess | undefined { return id ? this.handles.get(Rooms.hkey(s, id))?.proc : undefined }
  /** Forget a handle, but only if it is still the one given (an exit callback of an older process must not drop a newer one). */
  dropHandle(s: Session, id: string | undefined, proc?: SpawnedProcess): void {
    if (!id) return
    const k = Rooms.hkey(s, id)
    const h = this.handles.get(k)
    if (h && (!proc || h.proc === proc)) this.handles.delete(k)
  }
  hasHandle(s: Session, w: Worker): boolean { return !!w.id && this.handles.has(Rooms.hkey(s, w.id)) }

  /** A just-finished host can still be closing. Its exit callback wakes the pending resume. */
  private async waitForPreviousExit(s: Session, w: Worker, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    const signal = toolSignal.getStore()
    while (Date.now() < deadline && !signal?.aborted) {
      const state = await workerRealState(s.dir, w, { process: true, hasHandle: this.hasHandle(s, w) })
      if (state.process === 'not-ours') return true
      const key = Rooms.hkey(s, w.id!)
      await new Promise<void>(resolve => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', done)
          const waiters = this.exitWaiters.get(key)
          waiters?.delete(done)
          if (!waiters?.size) this.exitWaiters.delete(key)
          resolve()
        }
        const waiting = this.exitWaiters.get(key) ?? new Set<() => void>()
        waiting.add(done); this.exitWaiters.set(key, waiting)
        const timer = setTimeout(done, Math.min(this.hasHandle(s, w) ? 1_000 : 100, Math.max(1, deadline - Date.now())))
        signal?.addEventListener('abort', done, { once: true })
        if (!this.hasHandle(s, w) && !pidIsOurWorker(w.pid, w)) done()
      })
    }
    return false
  }

  /** Spawn and resume share the same process-exit accounting and error reporting. */
  watchWorkerProcess(s: Session, id: string, proc: SpawnedProcess, errorPrefix: string, log: (line: string) => void, at: () => number = Date.now): void {
    const exited = (code: number | null, error?: string) => {
      this.dropHandle(s, id, proc)
      const current = s.room.workerById(id)
      const notify = () => { const key = Rooms.hkey(s, id); for (const wake of this.exitWaiters.get(key) ?? []) wake(); this.exitWaiters.delete(key) }
      if (!current || current.pid !== proc.pid) { notify(); return }
      void finishWorkerProcess(s, current, code, at(), error)
        .then(() => { notify(); return this.retireWorkers(s) })
        .catch(e => { notify(); log(`worker exit: ${e}`) })
    }
    proc.onError?.(err => exited(-1, `${errorPrefix}: ${err.message}`))
    proc.onExit(code => exited(code))
  }

  /** Continue an exited, retained worker in its original checkout and host conversation. */
  async resumeWorker(s: Session, w: Worker, message: string, spawner: Spawner = defaultSpawner, claudeChannel = DEFAULT_CLAUDE_CHANNEL, maxWorkers?: number | string, log: (line: string) => void = console.error, at: () => number = Date.now, exitWaitMs = 30_000): Promise<string> {
    // An exit callback starts retirement asynchronously. Let that check finish before competing
    // for the same worktree lock; it retains any worker with work to collect.
    await this.retiring.get(s)
    if (toolCallAborted()) return 'error: tool call cancelled'
    const key = workerOperationKey(w)
    if (!this.reserve(key)) return `error: ${w.tag} is being collected, discarded or resumed; retry after that finishes`
    try {
      const exitWaitLabel = `${Math.ceil(exitWaitMs / 1000)} second${exitWaitMs > 1_000 ? 's' : ''}`
      const current = s.room.workers.get(w.tag)
      if (!current || current.id !== w.id || current.gen !== w.gen) return `error: ${w.tag} changed while you were sending; retry`
      w = current
      if (w.lead !== s.me.name) return `error: ${w.tag} belongs to ${w.lead}`
      if (w.status === 'running') return `error: ${w.tag} is already running`
      if (w.status === 'dismissed' && w.stopReason !== 'lead-session-ended') return `error: ${w.tag} was discarded and cannot be resumed`
      const state = await workerRealState(s.dir, w, { process: true, hasHandle: this.hasHandle(s, w) })
      const initial = decideResume(state)
      if (initial === 'missing') return `error: cannot resume ${w.tag}: its worktree no longer exists`
      if (initial === 'no-session') return `error: ${w.tag} has no recorded ${w.host} session id; it cannot be resumed`
      if (initial === 'unknown') return `error: could not verify ${w.tag}'s process (pid ${w.pid}); message was not delivered and worker was not resumed`
      if (initial === 'wait-exit' && !await this.waitForPreviousExit(s, w, exitWaitMs)) {
        return toolCallAborted() ? 'error: tool call cancelled' : `error: could not resume ${w.tag}: previous process did not exit within ${exitWaitLabel}; message was not delivered and worker was not resumed`
      }
      if (toolCallAborted()) return 'error: tool call cancelled'
      const settled = decideResume(await workerRealState(s.dir, w, { process: true, hasHandle: this.hasHandle(s, w) }))
      if (settled === 'missing') return `error: cannot resume ${w.tag}: its worktree no longer exists`
      if (settled === 'unknown') return `error: could not verify ${w.tag}'s process (pid ${w.pid}); message was not delivered and worker was not resumed`
      if (settled === 'wait-exit') return `error: could not resume ${w.tag}: previous process did not exit within ${exitWaitLabel}; message was not delivered and worker was not resumed`
      if (!w.id) return `error: ${w.tag} has no stable worker id; it cannot be resumed`
      const budget = w.budget
      if (!budget) return `error: ${w.tag} has no recorded compute budget; it cannot be resumed`
      const config = await resolveConfig({ dir: s.dir, env: process.env, args: { maxWorkers } })
      if (toolCallAborted()) return 'error: tool call cancelled'
      const latest = s.room.workers.get(w.tag)
      if (!latest || latest.id !== w.id || latest.gen !== w.gen || latest.status === 'running') return `error: ${w.tag} changed while you were sending; retry`
      w = latest
      const id = w.id
      if (!id) return `error: ${w.tag} has no stable worker id; it cannot be resumed`
      const running = this.runningWorkerCount(s)
      const launchLease = reserveWorkerLaunch(this, config.maxWorkers, running)
      if (!launchLease) return `error: ${this.launchUsage(running)} workers already running or starting (max ${config.maxWorkers}, ROOM_MAX_WORKERS); wait for one to finish`
      try {
        const { server, isWorker } = workerOrigin(s)
        const wasDone = w.status === 'done'
        let launched: ReturnType<typeof launchWorkerProcess>
        try { launched = launchWorkerProcess({ rooms: this, session: s, id, tag: w.tag, dir: w.dir,
          lead: w.lead, owner: s.me.owner ?? s.me.name, host: w.host, model: w.model, effort: w.effort,
          share: w.share ?? 'intent', gen: w.gen ?? 1, budget, server, isWorker,
          token: s.local ? undefined : s.token, claudeChannel, preferredPort: w.port, spawner, log, at },
        { mode: 'resume', message, sessionId: w.hostSessionId!, oldPort: w.port }, launchLease,
        ({ proc, port, startedAt }) => !!s.room.updateWorker(w.tag, { pid: proc.pid, port, status: 'running',
          startedAt, summary: undefined, exitCode: undefined, finishedAt: undefined,
          dismissedAt: undefined, stopReason: undefined }, id)) }
        catch (e) {
          const error = e instanceof WorkerLaunchError ? e : new WorkerLaunchError('start', String(e))
          if (error.phase === 'port') return `error: could not reserve a port for ${w.tag}: ${error.message}`
          if (error.phase === 'budget' || error.phase === 'cancelled') return `error: ${error.message}`
          if (error.phase === 'stale') return `error: ${w.tag} changed during resume; attempted to stop the new process`
          return `error: could not resume ${w.tag}: ${error.message}`
        }
        let stopWarning = ''
        try { clearWorkerStopState(s.dir, w.tag, id) }
        catch (e) { stopWarning = `; warning: could not clear saved stop reason: ${e instanceof Error ? e.message : String(e)}`; log(`worker resume:${stopWarning}`) }
        return `resumed ${w.tag} with your message${wasDone ? `; ${w.tag} had finished and was restarted` : ''}${launched.portChanged ? `; dev-server PORT is ${launched.port}` : ''}${w.share ? '' : ' (legacy worker has no saved sharing level; using intent)'}${stopWarning}`
      } finally {
        launchLease.release()
      }
    } finally { this.unreserve(key) }
  }
}
