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
import { highestSeq, type Presence } from '@room/shared'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { LOCAL, type Session } from './session.js'
import { defaultSpawner, pidPresent, probeProcess, type CwdProcessLister, type ProcessProbe, type SpawnedProcess, type Spawner } from './worker-process.js'
import { decideResume, workerRealState } from './worker-state.js'
import { DEFAULT_CLAUDE_CHANNEL, resolveConfig } from './config.js'
import { launchWorkerProcess, WorkerLaunchError } from './worker-launch.js'
import { registryForDir, registrySnapshotForDir } from './worker-registry.js'
import { postWorkerMessage } from './post.js'
import { realStateInput, type LocalWorker } from './worker-status.js'
import { autoRetire } from './retire.js'
import { WorkerProjector } from './worker-projector.js'

export type Role = 'primary' | 'workers'
export interface DeliveredResume { delivered: true; reply: string }

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
  /** Write this attachment's worker facts now (the bridge's team projection). */
  project?(): Promise<void>
}

export interface RoomsOptions {
  probe?: ProcessProbe
  listCwdProcesses?: CwdProcessLister
  /** The primary session lives with the host (tests and index.ts set it); the registry reads and writes it through these. */
  primary(): Session | null
  setPrimary(s: Session | null): void
  /** Full attachments for a session that was joined through the tools or adopted at startup. */
  attach(s: Session, role: Role, lead?: Session): Attachment
  log?: (line: string) => void
}

/** Where a worker started from this session connects, and whether this session is itself a worker (its budget is then shared). */
export function workerOrigin(s: Session): { server: string; isWorker: boolean } {
  return {
    server: s.local ? LOCAL : s.roomUrl.slice(0, s.roomUrl.lastIndexOf('/')),
    isWorker: !!process.env.ROOM_TAG || !!s.room.workerViewOf(s.me.name) || (!!s.me.owner && s.me.owner !== s.me.name),
  }
}

export class Rooms {
  private entries = new Map<Session, { role: Role; attachment?: Attachment }>()
  private tracked = new WeakSet<Session>()
  /** Processes this MCP instance started, by worker id. A lead that restarted only has the pid in the doc. */
  private handles = new Map<string, { proc: SpawnedProcess; session: Session }>()
  private exitWaiters = new Map<string, Set<() => void>>()
  private autoRetireTimers = new Map<Session, ReturnType<typeof setInterval>>()
  private retiring = new Map<Session, Promise<void>>()
  /** Each tracked session's writer of its workers' views and retirement cleanup (registry §13). */
  private projectors = new Map<Session, WorkerProjector>()

  constructor(private o: RoomsOptions) {}
  probe(pid: number) { return (this.o.probe ?? probeProcess)(pid) }
  get listCwdProcesses(): CwdProcessLister | undefined { return this.o.listCwdProcesses }

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
  /** The worker projector and auto-retirement only (a session the host set without joining through the tools, e.g. in tests). */
  track(s: Session): void {
    if (this.tracked.has(s)) return
    this.tracked.add(s)
    void registryForDir(s.dir).then(registry => {
      if (!this.tracked.has(s) || this.projectors.has(s)) return
      const projector = new WorkerProjector(s, registry, this.o.log)
      this.projectors.set(s, projector)
      projector.start()
    }).catch(() => {})
    const timer = setInterval(() => { void this.autoRetire(s).catch(() => {}) }, 60_000)
    timer.unref()
    this.autoRetireTimers.set(s, timer)
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
    clearInterval(this.autoRetireTimers.get(s))
    this.autoRetireTimers.delete(s)
    this.projectors.get(s)?.stop()
    this.projectors.delete(s)
    this.tracked.delete(s)
  }

  /** Auto-retirement (registry §12, decideRetire's rules): after exits, before previews and PR tools, and every minute. */
  async autoRetire(session?: Session): Promise<void> {
    for (const s of session ? [session] : this.all()) {
      const pending = this.retiring.get(s)
      if (pending) { await pending; await this.autoRetire(s); continue }
      const run = autoRetire(s, this)
      this.retiring.set(s, run)
      try { await run } finally { this.retiring.delete(s) }
    }
  }

  /** Every writer of worker facts runs once now: each session's projector, then attachments (the bridge). */
  async project(): Promise<void> {
    for (const projector of this.projectors.values()) await projector.project()
    for (const e of this.entries.values()) await e.attachment?.project?.()
  }
  /** Whether a session is still tracked (an auto-retirement pass stops writing for one that left). */
  tracking(s: Session): boolean { return this.tracked.has(s) }

  // ---- who lives where ----------------------------------------------------------
  private static presences(s: Session): Presence[] {
    return Array.from(s.awareness.getStates().values()).filter((x): x is Presence => !!x && typeof x === 'object' && !!(x as Presence).user)
  }
  /** A worker's view where it joins: a `local` worker's view in the team room is only the bridge's projection. */
  private static joinedBy(s: Session, name: string): boolean {
    const view = s.room.acceptedWorkerViewOf(name)
    return !!view && (view.mode === 'here' || !!s.local)
  }
  private static activeIn(s: Session, name: string): boolean {
    return s.room.scopes.has(name) || s.room.manifestHead.has(name) || Rooms.presences(s).some(p => p.user.name === name)
  }
  /**
   * The session in which a participant lives. Where the person is present or has work wins; a worker
   * record alone (the same tag can be spawned in both rooms) decides only when neither room shows them.
   * `from` is the caller's session and the fallback.
   */
  holding(name: string, from: Session = this.primary() ?? this.mustHave()): Session {
    const others = this.all().filter(s => s !== from)
    if (!others.length || name === from.me.name) return from
    // A projected head in the team room is evidence for peers, not a local join.
    // The lead's registry determines the source room of its own local worker.
    try {
      const owned = registrySnapshotForDir(from.dir).list().find(record => record.name === name
        && record.lead.participant === from.me.name && record.mode === 'local'
        && !['retiring', 'retired', 'abandoned'].includes(record.phase))
      const source = owned && others.find(s => s.roomName === owned.room)
      if (source) return source
    } catch { /* Without a local registry, ordinary room evidence decides. */ }
    if (Rooms.activeIn(from, name)) return from
    for (const s of others) if (Rooms.activeIn(s, name)) return s
    if (Rooms.joinedBy(from, name)) return from
    for (const s of others) if (Rooms.joinedBy(s, name)) return s
    return from
  }
  /** The session whose bus carries a message id, if any of ours does. */
  holdingQuestion(msgId: string, from: Session = this.primary() ?? this.mustHave()): Session | undefined {
    for (const s of [from, ...this.all().filter(x => x !== from)]) if (s.room.message(msgId)) return s
    return undefined
  }
  private mustHave(): Session { throw new Error('not in a room') }

  // ---- worker processes ---------------------------------------------------------
  setHandle(s: Session, id: string, proc: SpawnedProcess): void { this.handles.set(id, { proc, session: s }) }
  handle(_s: Session, id: string | undefined): SpawnedProcess | undefined { return id ? this.handles.get(id)?.proc : undefined }
  /** Forget a handle, but only if it is still the one given (an exit callback of an older process must not drop a newer one). */
  dropHandle(s: Session, id: string | undefined, proc?: SpawnedProcess): void {
    if (!id) return
    const k = id
    const h = this.handles.get(k)
    if (h && (!proc || h.proc === proc)) this.handles.delete(k)
  }
  hasHandle(_s: Session, w: Pick<LocalWorker, 'id'>): boolean { return !!w.id && this.handles.has(w.id) }

  /** A just-finished host can still be closing. Its exit callback wakes the pending resume. */
  private async waitForPreviousExit(s: Session, w: LocalWorker, timeoutMs = 30_000): Promise<'exited' | 'unknown' | 'timeout'> {
    const deadline = Date.now() + timeoutMs
    const signal = toolSignal.getStore()
    while (Date.now() < deadline && !signal?.aborted) {
      const state = await workerRealState(s.dir, w, { process: true, hasHandle: this.hasHandle(s, w), probe: this.probe.bind(this) })
      if (state.process === 'not-ours') return 'exited'
      if (state.process === 'unknown') return 'unknown'
      const key = w.id
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
      })
    }
    return 'timeout'
  }

  /** Continue an exited, retained worker using a new durable run intent. */
  /**
   * `beforeLaunch` runs once every check has passed and the run is reserved, just before the host starts; an
   * error string from it (the follow-up could not be posted) ends the run unlaunched and is returned as is.
   */
  async resumeWorker(s: Session, w: Pick<LocalWorker, 'id' | 'tag' | 'host'>, followUp: string, spawner: Spawner = defaultSpawner, claudeChannel = DEFAULT_CLAUDE_CHANNEL, maxWorkers?: number | string, log: (line: string) => void = console.error, at: () => number = Date.now, exitWaitMs = 30_000, beforeLaunch?: () => Promise<string | { ids: string[]; prompt: string } | undefined>): Promise<string | DeliveredResume> {
    if (toolCallAborted()) return 'error: tool call cancelled'
    const registry = await registryForDir(s.dir)
    const known = registry.reserved(w.tag)
    if (known && ['retiring', 'retired'].includes(known.phase)) return `error: ${w.tag} was collected or discarded; it cannot resume`
    if (known && !fs.existsSync(known.dir)) return `error: cannot resume ${w.tag}: its worktree no longer exists`
    const trusted = await registry.trusted({ participant: s.me.name, room: s.roomName, dir: s.dir }, w.tag)
    if (!trusted || trusted.record.id !== w.id) return `error: ${w.tag} has no local worker capability; cannot resume`
    const record = trusted.record
    const local = realStateInput(record, trusted.status)
    const processState = await workerRealState(s.dir, local, { process: true, hasHandle: this.hasHandle(s, local), probe: this.probe.bind(this) })
    const initial = decideResume(processState)
    if (initial === 'missing') return `error: cannot resume ${w.tag}: its worktree no longer exists`
    if (initial === 'no-session') return `error: ${w.tag} has no recorded ${w.host} session id; it cannot be resumed`
    if (initial === 'unknown') return `error: could not verify ${w.tag}'s process; message was not delivered`
    if (initial === 'wait-exit') {
      const settled = await this.waitForPreviousExit(s, local, exitWaitMs)
      if (settled !== 'exited') return `error: previous ${w.tag} process ${settled}; message was not delivered`
    }
    if (toolCallAborted()) return 'error: tool call cancelled'
    const config = await resolveConfig({ dir: s.dir, env: process.env, args: { maxWorkers } })
    const logFile = path.join(s.dir, '.room', 'workers', `${w.tag}.log`)
    let logStart = 0
    try { logStart = fs.statSync(logFile).size } catch { /* a new log starts at zero */ }
    let run: import('./worker-status.js').Run
    try {
      const next = await registry.resume(record.id, config.maxWorkers, { nonce: randomUUID(), logStart, logFile,
        busFrontier: highestSeq(s.room) })
      run = next.runs.at(-1)!
    } catch (error) { return `error: ${error instanceof Error ? error.message : String(error)}` }
    let posting: string | { ids: string[]; prompt: string } | undefined
    try {
    try {
      posting = await beforeLaunch?.()
      const refused = typeof posting === 'string' ? posting : undefined
      if (refused) {
        await registry.update(record.id, old => ({ ...old, phase: 'active',
          runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, launch: { outcome: 'never', error: refused } }], seq: old.seq + 1 }))
        return refused
      }
      if (posting && typeof posting !== 'string' && posting.ids.length) {
        const ids = [...new Set(posting.ids)]
        const updated = await registry.update(record.id, old => ({ ...old,
          runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, promptMsgIds: ids }],
          seq: old.seq + 1 }))
        run = updated.runs.at(-1)!
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await registry.update(record.id, old => ({ ...old, phase: 'active',
        runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, launch: { outcome: 'never', error: reason } }], seq: old.seq + 1 }))
      throw error
    }
    try {
      const { server, isWorker } = workerOrigin(s)
      const launched = await launchWorkerProcess({ session: s, id: record.id, tag: record.tag, dir: record.dir,
        lead: record.lead.participant, owner: s.me.owner ?? s.me.name, host: record.host, model: record.model,
        effort: record.effort, share: record.share, run: run.n, nonce: run.nonce, registry: registry.root,
        budget: record.budget, server, isWorker, token: s.local ? undefined : s.token, claudeChannel,
        preferredPort: record.port, spawner, probe: this.probe.bind(this), log, at },
      { mode: 'resume', sessionId: record.hostSessionId!, followUp: typeof posting === 'object' ? posting.prompt : followUp, oldPort: record.port },
      { setHandle: (id, proc) => this.setHandle(s, id, proc),
        watch: (_id, proc, onExit) => proc.onExit(onExit), aborted: toolCallAborted },
      async pid => { await registry.update(record.id, old => ({ ...old,
        runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, launch: { outcome: 'launched', pid } }], seq: old.seq + 1 })) },
      async result => {
        await registry.update(record.id, old => ({ ...old, phase: 'active', port: result.port,
          runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, launch: { outcome: 'launched', pid: result.proc.pid,
            ...(result.processStartTime ? { process: { pid: result.proc.pid, startTime: result.processStartTime,
              executable: this.probe(result.proc.pid)?.executable ?? '' } } : {}) } }], seq: old.seq + 1 }))
      }, async code => {
        await registry.writeExit(record.id, { run: run.n, code, witnessed: true, at: at() })
        this.dropHandle(s, record.id)
        await registry.postObservedFailure(record.id, run.n, message => postWorkerMessage(s.post, record, message))
      })
      return [`resumed ${record.tag}'s retained conversation with your message${launched.portChanged ? `; dev-server PORT is ${launched.port}` : ''}`, ...launched.warnings].join('\n')
    } catch (error) {
      const launchError = error instanceof WorkerLaunchError ? error : new WorkerLaunchError('start', String(error))
      if (!launchError.delivered) await registry.update(record.id, old => ({ ...old, phase: 'active',
        runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, launch: { outcome: 'never', error: launchError.message } }], seq: old.seq + 1 }))
      else {
        if (!registry.read(record.id)?.runs.at(-1)?.launch) await registry.update(record.id, old => ({ ...old,
          phase: 'active', runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, launch: { outcome: 'ambiguous', at: at() } }],
          seq: old.seq + 1 })).catch(writeError => log(`worker resume outcome: ${writeError}`))
        await registry.beginStop(record.id, launchError.phase === 'cancelled' ? 'message-delivered-cancelled' : 'message-delivered-failed')
          .catch(writeError => log(`worker resume stop record: ${writeError}`))
      }
      return launchError.delivered
        ? { delivered: true, reply: launchError.stopped ? `stopped after receiving your message: ${launchError.message}` : `could not stop ${record.tag}; left running` }
        : `error: could not resume ${record.tag}: ${launchError.message}`
    }
    } finally { await registry.finishOperation(record.id) }
  }

}
