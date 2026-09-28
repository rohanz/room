/**
 * Wakes, level-triggered (ledger "Wake (MF8)"). One reconciler per host session, across its rooms. A message
 * is wakeable when it is owed, its kind wakes (`shouldWakeOnMsg`), it is above the session's frontier, no
 * batch holds it, no pending room_wait will return it, and this session was not already woken for it.
 * All wakeable messages go out as one content-free pointer over the host's path; only a successful send is
 * recorded, in `wakes.json`, and a wake is never a receipt: the message stays owed until a reply, a wait or
 * the edit hook hands it off.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isAgentic, shouldWakeOnMsg, type Msg } from '@room/shared'
import type { Session } from './session.js'
import type { Ledger } from './ledger.js'
import { writeAtomic } from './leases.js'
import { claudeWakeUnavailable } from './prompt.js'
import { waitConsumesMessage } from './tools/messaging.js'
import type { SendWake, WakeTarget, WakeVia } from './wake-path.js'

/** After a failed send: 1, 3, 8, then every 30 s while anything stays wakeable. */
const BACKOFF_MS = [1_000, 3_000, 8_000, 30_000]
/** Wake at once, then gather what arrives during this window into one follow-up. */
const WINDOW_MS = 5_000
/** How often to look again for a bound host session while something is wakeable. */
const POLL_MS = 5_000
const MAX_NAMED = 5

type WakesFile = Record<string, Record<string, { via: WakeVia; at: number }>>

export interface WakeReconcilerOptions {
  ledger: Ledger
  /** The bound host session, re-evaluated on use (registry §17); undefined turns wakes off. */
  bound: () => WakeTarget | undefined
  /** Its directory, for wakes.json; undefined keeps the record in memory. */
  sessionDir: () => string | undefined
  send: SendWake
  /** A lead's own workers: their routine progress notes do not wake it. */
  ownWorkers?: (s: Session) => ReadonlySet<string>
  log?: (line: string) => void
  now?: () => number
  backoffMs?: readonly number[]
  windowMs?: number
  pollMs?: number
}

export class WakeReconciler {
  private readonly sessions = new Map<Session, () => void>()
  private running = false
  private again = false
  private stopped = false
  private timer?: ReturnType<typeof setTimeout>
  private failures = 0
  private lastSentAt?: number
  private sequence = 0
  private record?: { dir: string | undefined; wakes: WakesFile }
  private silent = false

  constructor(private readonly o: WakeReconcilerOptions) {}

  /** Watch a joined room: any change to it (bus, receipts, outcomes, claims) reconciles. */
  attach(s: Session): void {
    if (this.sessions.has(s)) return
    s.awareness.setLocalStateField('wakeUnavailable', claudeWakeUnavailable(s.dir))
    const kick = () => this.reconcile()
    s.room.doc.on('update', kick)
    this.sessions.set(s, () => s.room.doc.off('update', kick))
    this.reconcile()
  }

  detach(s: Session): void {
    this.sessions.get(s)?.()
    this.sessions.delete(s)
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
    for (const s of [...this.sessions.keys()]) this.detach(s)
  }

  /** Single-flight: a call during a pass runs one more pass after it. */
  reconcile(): void {
    if (this.stopped) return
    this.again = true
    if (this.running) return
    this.running = true
    queueMicrotask(() => { void this.drain() })
  }

  /** What would be woken now, in delivery order. */
  private wakeable(): { s: Session; m: Msg }[] {
    const out: { s: Session; m: Msg }[] = []
    const woken = this.wakes()
    for (const s of this.sessions.keys()) {
      const { ledger } = this.o
      if (!ledger.fenced(s)) continue
      const frontier = ledger.frontier(s)
      const claims = s.room.openClaims().filter(c => c.by === s.me.name && isAgentic(c.byKind))
      const uncommitted = s.room.changedPaths(s.me.name).length > 0
      const workers = this.o.ownWorkers?.(s)
      const done = woken[s.roomName] ?? {}
      for (const m of ledger.candidates(s)) {
        // Messages owed before this session existed are left for its first reply or hook.
        if ((m.seq ?? 0) <= frontier || done[m.id] || ledger.reserved(s, m.id) || waitConsumesMessage(s, m)) continue
        if (shouldWakeOnMsg(s.me, m, claims, uncommitted, workers).wake) out.push({ s, m })
      }
    }
    return out
  }

  private async drain(): Promise<void> {
    try {
      while (this.again && !this.stopped) { this.again = false; await this.pass() }
    } catch (e) { this.o.log?.(`wake: reconcile failed: ${e instanceof Error ? e.message : String(e)}`) }
    finally { this.running = false }
  }

  private async pass(): Promise<void> {
    this.clearTimer()
    const due = this.wakeable()
    if (!due.length) { this.failures = 0; return }
    const target = this.o.bound()
    if (!target) { this.arm(this.o.pollMs ?? POLL_MS); return }
    const windowMs = this.o.windowMs ?? WINDOW_MS
    const since = this.lastSentAt === undefined ? Infinity : this.now() - this.lastSentAt
    if (since < windowMs) { this.arm(windowMs - since); return }
    let via: WakeVia | undefined
    try { via = await this.o.send(target, this.pointer(due)) }
    catch (e) {
      const delays = this.o.backoffMs ?? BACKOFF_MS
      const delay = delays[Math.min(this.failures, delays.length - 1)]
      this.failures++
      this.o.log?.(`wake: could not wake ${target.host} session ${target.id.slice(0, 8)} (${e instanceof Error ? e.message : String(e)}); retrying in ${delay}ms`)
      this.arm(delay)
      return
    }
    if (this.stopped) return
    if (!via) {
      if (!this.silent) this.o.log?.(`wake: this ${target.host} session has no wake path; messages wait for its next turn`)
      this.silent = true
      return
    }
    this.failures = 0
    this.lastSentAt = this.now()
    const at = this.now()
    const wakes = this.wakes()
    for (const { s, m } of due) (wakes[s.roomName] ??= {})[m.id] = { via, at }
    this.persist()
    this.o.log?.(`wake: woke ${target.host} session ${target.id.slice(0, 8)} via ${via} for ${due.map(({ m }) => `${m.type} ${m.id}`).join(', ')}`)
  }

  /** `[room] N things need you: <from> <kind>; …` — who and what kind, never the text. */
  private pointer(due: { m: Msg }[]): string {
    const count = due.length
    const shown = count > MAX_NAMED ? MAX_NAMED - 1 : MAX_NAMED
    const phrases = due.slice(0, shown).map(({ m }) => `${m.from.replace(/\s+/g, ' ').trim().slice(0, 40) || 'someone'} ${kindPhrase(m.type)}`)
    if (count > shown) phrases.push(`${count - shown} more`)
    // The sequence keeps consecutive pointers distinct: the Claude inbox drops identical repeats.
    return `[room] ${count} ${count === 1 ? 'thing needs' : 'things need'} you: ${phrases.join('; ')}. Call room_state; it shows them. (#${++this.sequence})`
  }

  /** wakes.json of the bound session, reloaded when the binding moves; entries no longer owed are pruned on write. */
  private wakes(): WakesFile {
    const dir = this.o.sessionDir()
    if (this.record && this.record.dir === dir) return this.record.wakes
    let wakes: WakesFile = {}
    if (dir) { try { wakes = JSON.parse(fs.readFileSync(path.join(dir, 'wakes.json'), 'utf8')) as WakesFile } catch { /* none yet */ } }
    this.record = { dir, wakes }
    return wakes
  }

  private persist(): void {
    const record = this.record
    if (!record) return
    for (const s of this.sessions.keys()) {
      const entries = record.wakes[s.roomName]
      if (!entries || !this.o.ledger.fenced(s)) continue
      const owed = new Set(this.o.ledger.candidates(s).map(m => m.id))
      for (const id of Object.keys(entries)) if (!owed.has(id)) delete entries[id]
    }
    if (!record.dir) return
    try { fs.mkdirSync(record.dir, { recursive: true, mode: 0o700 }); writeAtomic(path.join(record.dir, 'wakes.json'), record.wakes) }
    catch (e) { this.o.log?.(`wake: could not write wakes.json: ${e instanceof Error ? e.message : String(e)}`) }
  }

  private arm(ms: number): void {
    if (this.stopped) return
    this.clearTimer()
    this.timer = setTimeout(() => { this.timer = undefined; this.reconcile() }, ms)
    this.timer.unref?.()
  }

  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined }
  private now(): number { return this.o.now?.() ?? Date.now() }
}

function kindPhrase(type: Msg['type']): string {
  switch (type) {
    case 'question': return 'asked a question'
    case 'answer': return 'answered'
    case 'changed': return 'reported a change'
    case 'note': return 'sent a note'
    case 'done': return 'finished'
    case 'base': return 'moved the base'
    default: return 'has an update'
  }
}
