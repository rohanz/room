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
import type { Presence, Worker } from '@room/shared'
import type { Session } from './session.js'
import type { SpawnedProcess } from './workers.js'

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

export class Rooms {
  private entries = new Map<Session, { role: Role; attachment?: Attachment }>()
  private tracked = new WeakSet<Session>()
  /** Processes this MCP instance started, by worker id. A lead that restarted only has the pid in the doc. */
  private handles = new Map<string, { proc: SpawnedProcess; session: Session }>()
  /** Tags whose worktree is being prepared, so two concurrent room_spawn calls cannot both pass the tag check. */
  private reserving = new Set<string>()

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
    for (const [other, e] of this.entries) if (other !== s && e.role === role) { e.attachment?.stop(); this.entries.delete(other) }
    this.entries.set(s, { role, attachment: this.o.attach(s, role, lead) })
  }
  /** Claims observer only (a session the host set without joining through the tools, e.g. in tests). */
  track(s: Session): void {
    if (this.tracked.has(s)) return
    this.tracked.add(s)
    this.o.observeClaims(s)
  }
  /** Stop the session's attachments and forget it; a primary is also cleared from the host. Does not leave the room. */
  remove(s: Session): void {
    const e = this.entries.get(s)
    e?.attachment?.stop()
    this.entries.delete(s)
    for (const [id, h] of Array.from(this.handles)) if (h.session === s) this.handles.delete(id)
    if (this.primary() === s) this.o.setPrimary(null)
  }
  async flush(): Promise<void> { for (const e of this.entries.values()) await e.attachment?.flush?.() }

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
