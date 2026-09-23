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
import fs from 'node:fs'
import path from 'node:path'
import type { Session } from './session.js'
import { cleanupWorker, ignoredWorkerArtifacts, persistedWorkerStopReason, pidIsOurWorker, shouldRetire, workerGitFacts, workerLogTail, workerOperationKey, type SpawnedProcess } from './workers.js'

export type Role = 'primary' | 'workers'

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

/** A confirmed exit is recorded once, including when discovered after the lead restarts. */
/** `unwitnessed`: a later lead found the recorded worker process gone, but cannot know why it stopped. */
export async function finishWorkerProcess(s: Session, w: Worker, code: number | null, at = Date.now(), error?: string, unwitnessed = false): Promise<void> {
  const current = s.room.workers.get(w.tag)
  if (current !== w || w.exitCode !== undefined) return
  const done = w.status === 'done'
  const exitCode = code ?? -1
  const tail = workerLogTail(path.join(s.dir, '.room', 'workers', `${w.tag}.log`))
  const stopReason = w.stopReason ?? (unwitnessed ? persistedWorkerStopReason(s.dir, w.tag) : undefined)
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
  /** Tags whose worktree is being prepared, so two concurrent room_spawn calls cannot both pass the tag check. */
  private reserving = new Set<string>()
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
        const reason = persistedWorkerStopReason(s.dir, w.tag)
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
    for (const w of s.room.workers.values()) {
      // The next lead must be able to explain and resume this intentionally stopped work.
      if (w.stopReason === 'lead-session-ended') continue
      if (this.reserving.has('discard:' + s.roomName + ':' + w.name)) continue
      if (w.lead !== s.me.name || this.hasHandle(s, w)) continue
      const lock = workerOperationKey(w)
      if (!this.reserve(lock)) continue
      try {
        const exited = w.exitCode !== undefined || !pidIsOurWorker(w.pid, w)
        if (!exited) continue
        if (w.status === 'running') {
          await finishWorkerProcess(s, w, null, Date.now(), undefined, true)
          continue
        }
        const facts = { exited, done: w.status === 'done', dismissed: w.dismissedAt !== undefined || w.status === 'dismissed', merged: false, clean: false, ahead: undefined as number | undefined, uncommitted: undefined as number | undefined }
        if (!facts.done && !facts.dismissed) continue
        Object.assign(facts, await workerGitFacts(s.dir, w))
        const outcome = shouldRetire(facts)
        // Git awaits must not let an old evaluation retire a newer spawn or a disconnected session.
        if (!outcome || s.room.workers.get(w.tag) !== w || this.hasHandle(s, w) || !this.retirementTimers.has(s) || this.reserving.has('discard:' + s.roomName + ':' + w.name)) continue
        // An ignored artifact has no recovery patch. Keep both its worktree and the live record so
        // the lead can copy it or explicitly discard it, exactly as manual collection does.
        if (fs.existsSync(w.dir)) {
          try { if ((await ignoredWorkerArtifacts(w)).length) continue }
          catch { continue }
        }
        const done = s.room.messages().filter(m => m.type === 'done' && m.from === w.name && m.at >= w.startedAt).at(-1)
        const files = [...new Set([...s.room.changedPaths(w.name), ...(done?.type === 'done' ? done.changed : [])])].sort()
        if (facts.clean && w.exitCode === 0) {
          try { if (!await cleanupWorker(s.dir, w, true)) continue }
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
  reserve(base: string): boolean { if (this.reserving.has(base)) return false; this.reserving.add(base); return true }
  unreserve(base: string): void { this.reserving.delete(base) }
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
}
