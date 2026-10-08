/**
 * Wakes, level-triggered (ledger "Wake (MF8)"). One reconciler per host session, across its rooms. A message
 * is wakeable when it is owed, its kind wakes (`shouldWakeOnMsg`), it is above the session's frontier, no
 * batch holds it, no pending room_wait will return it, this path has not already woken for it, and it has
 * company (solo.ts: a room is silent while alone).
 * All wakeable messages go out as one content-free pointer over the host's path; only a successful send is
 * recorded, in `wakes.json`, and a wake is never a receipt: the message stays owed until a reply, a wait or
 * the edit hook hands it off. A mid-turn wake still permits one idle queue wake while the message is owed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { git } from '@room/roomd/git'
import { isAgentic, manifestPaths, defaultPriority, parseClaimRelease, shouldWakeOnMsg, type Msg } from '@room/shared'
import type { Session } from './session.js'
import type { Ledger } from './ledger.js'
import { writeAtomic } from './leases.js'
import { claudeWakeUnavailable } from './prompt.js'
import { waitConsumesMessage } from './tools/messaging.js'
import type { SendMidTurn, SendWake, WakeTarget, WakeVia } from './wake-path.js'
import { CodexTurnProbe } from './codex-turn.js'

/** After a failed send: 1, 3, 8, then every 30 s while anything stays wakeable. */
const BACKOFF_MS = [1_000, 3_000, 8_000, 30_000]
/** Wake at once, then gather what arrives during this window into one follow-up. */
const WINDOW_MS = 5_000
/** How often to look again for a bound host session while something is wakeable. */
const POLL_MS = 5_000
const BUSY_POLL_MS = 2_000
const RELEASE_RECHECK_MS = 5_000
const RELEASE_GIT_TIMEOUT_MS = 2_000
const MAX_NAMED = 5

type WakesFile = Record<string, Record<string, { via: WakeVia; at: number }>>

export interface WakeReconcilerOptions {
  ledger: Ledger
  /** The bound host session, re-evaluated on use (registry §17); undefined turns wakes off. */
  bound: () => WakeTarget | undefined
  /** Its directory, for wakes.json; undefined keeps the record in memory. */
  sessionDir: () => string | undefined
  send: SendWake
  midTurn?: SendMidTurn
  /** A lead's own workers: their routine progress notes do not wake it. */
  ownWorkers?: (s: Session) => ReadonlySet<string>
  /** Whether company makes `m` wakeable now (solo.ts); a room is silent while alone. Default: always. */
  audible?: (s: Session) => (m: Msg) => boolean
  log?: (line: string) => void
  now?: () => number
  backoffMs?: readonly number[]
  windowMs?: number
  pollMs?: number
  busyPollMs?: number
  codexTurn?: Pick<CodexTurnProbe, 'busy'>
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
  private readonly midTurnFailures = new Set<string>()
  private readonly codexTurn: Pick<CodexTurnProbe, 'busy'>
  private readonly releaseChecks = new Map<string, { own: boolean; at: number }>()
  /** Messages already logged as held back while alone (one line each). */
  private readonly held = new Set<string>()

  constructor(private readonly o: WakeReconcilerOptions) { this.codexTurn = o.codexTurn ?? new CodexTurnProbe() }

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
  private wakeable(busy = false): { s: Session; m: Msg }[] {
    const out: { s: Session; m: Msg }[] = []
    const woken = this.wakes()
    for (const s of this.sessions.keys()) {
      const { ledger } = this.o
      if (!ledger.fenced(s)) continue
      const frontier = ledger.frontier(s)
      const claims = s.room.openClaims().filter(c => c.by === s.me.name && isAgentic(c.byKind))
      const uncommitted = manifestPaths(s.room, s.me.name).length > 0
      const workers = this.o.ownWorkers?.(s)
      const done = woken[s.roomName] ?? {}
      const audible = this.o.audible?.(s)
      for (const m of ledger.candidates(s)) {
        // Messages owed before this session existed are left for its first reply or hook.
        const prior = done[m.id]
        if ((m.seq ?? 0) <= frontier || (prior && (busy || prior.via !== 'turn')) || ledger.reserved(s, m.id) || waitConsumesMessage(s, m) || this.ownCommitRelease(s, m)) continue
        if (!shouldWakeOnMsg(s.me, m, claims, uncommitted, workers).wake) continue
        if (audible && !audible(m)) {
          const key = `${s.roomName}\0${m.id}`
          if (!this.held.has(key)) { if (this.held.size >= 1000) this.held.clear(); this.held.add(key); this.o.log?.(`wake: not waking for ${m.type} ${m.id} in ${s.roomName}: alone here; it stays in room_state`) }
          continue
        }
        out.push({ s, m })
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
    await this.refreshOwnCommitReleases()
    if (this.stopped) return
    let due = this.wakeable()
    if (!due.length) { this.failures = 0; return }
    const target = this.o.bound()
    if (!target) { this.arm(this.o.pollMs ?? POLL_MS); return }
    const busy = target.host === 'codex' && await this.codexTurn.busy(target.id)
    const windowMs = this.o.windowMs ?? WINDOW_MS
    const since = this.lastSentAt === undefined ? Infinity : this.now() - this.lastSentAt
    if (since < windowMs) { this.arm(windowMs - since); return }
    // The turn probe and window may have taken time: hook and reply receipts, or HEAD, can move meanwhile.
    await this.refreshOwnCommitReleases()
    if (this.stopped) return
    due = this.wakeable(busy)
    // A mid-turn wake stays eligible for the idle queue until the message is received.
    if (busy && !due.length) { this.arm(this.o.busyPollMs ?? BUSY_POLL_MS); return }
    if (!due.length) { this.failures = 0; return }
    const current = this.o.bound()
    if (current?.id !== target.id || current.host !== target.host) { this.arm(this.o.pollMs ?? POLL_MS); return }
    if (busy) {
      const urgent = due.filter(({ m }) => (m.priority ?? defaultPriority({ ...m })) !== 'fyi')
      if (urgent.length && this.o.midTurn) {
        try {
          const via = await this.o.midTurn(target, this.pointer(urgent))
          if (this.stopped) return
          if (via === 'turn') {
            this.midTurnFailures.clear()
            this.lastSentAt = this.now()
            const wakes = this.wakes(), at = this.now()
            for (const { s, m } of urgent) (wakes[s.roomName] ??= {})[m.id] = { via, at }
            this.persist()
            this.o.log?.(`wake: delivered mid-turn to codex session ${target.id} via turn for ${urgent.map(({ m }) => `${m.type} ${m.id}`).join(', ')}`)
          }
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          const key = `${target.id}\0${reason}`
          if (!this.midTurnFailures.has(key)) this.o.log?.(`wake: mid-turn failed for codex session ${target.id}: ${reason}`)
          this.midTurnFailures.add(key)
        }
      }
      this.arm(this.o.busyPollMs ?? BUSY_POLL_MS)
      return
    }
    let via: WakeVia | undefined
    try { via = await this.o.send(target, this.pointer(due)) }
    catch (e) {
      const delays = this.o.backoffMs ?? BACKOFF_MS
      const delay = delays[Math.min(this.failures, delays.length - 1)]
      this.failures++
      this.o.log?.(`wake: could not wake ${target.host} session ${target.id} (${e instanceof Error ? e.message : String(e)}); retrying in ${delay}ms`)
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
    this.o.log?.(`wake: woke ${target.host} session ${target.id} via ${via} for ${due.map(({ m }) => `${m.type} ${m.id}`).join(', ')}`)
  }

  /** `[room] N things may need you: <from> <kind>; …` — who and what kind, never the text. */
  private pointer(due: { m: Msg }[]): string {
    const count = due.length
    const shown = count > MAX_NAMED ? MAX_NAMED - 1 : MAX_NAMED
    const phrases = due.slice(0, shown).map(({ m }) => m.type === 'note' && m.from === 'room' && m.fromKind === 'bot' && parseClaimRelease(m.text)
      ? 'Room released a claim of yours'
      : `${m.from.replace(/\s+/g, ' ').trim().slice(0, 40) || 'someone'} ${kindPhrase(m.type)}`)
    if (count > shown) phrases.push(`${count - shown} more`)
    // The sequence keeps consecutive pointers distinct: the Claude inbox drops identical repeats.
    return `[room] ${count} ${count === 1 ? 'thing may need' : 'things may need'} you: ${phrases.join('; ')}. Call room_state; if it shows nothing new, they were already delivered: do nothing further. (#${++this.sequence})`
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

  private ownCommitRelease(s: Session, m: Msg): boolean {
    return !!claimReleaseSha(s, m) && this.releaseChecks.get(`${s.roomName}\0${m.id}`)?.own === true
  }

  /** Cache ancestry by owed message. A positive answer is final; a negative one can change after a pull. */
  private async refreshOwnCommitReleases(): Promise<void> {
    const now = this.now()
    const live = new Set<string>()
    const checks: { s: Session; sha: string; key: string }[] = []
    for (const s of this.sessions.keys()) {
      if (!this.o.ledger.fenced(s)) continue
      for (const m of this.o.ledger.candidates(s)) {
        const sha = claimReleaseSha(s, m)
        if (!sha) continue
        const key = `${s.roomName}\0${m.id}`
        live.add(key)
        const cached = this.releaseChecks.get(key)
        if (cached?.own || (cached && now - cached.at < RELEASE_RECHECK_MS)) continue
        checks.push({ s, sha, key })
      }
    }
    for (const key of this.releaseChecks.keys()) if (!live.has(key)) this.releaseChecks.delete(key)
    // A burst of release notes should not spawn an unbounded number of Git processes.
    for (let i = 0; i < checks.length && !this.stopped; i += 4) {
      await Promise.all(checks.slice(i, i + 4).map(async ({ s, sha, key }) => {
        let own = false
        try { await git(s.dir, ['merge-base', '--is-ancestor', sha, 'HEAD'], RELEASE_GIT_TIMEOUT_MS); own = true }
        catch { /* unknown or not in HEAD: let the normal wake policy decide */ }
        this.releaseChecks.set(key, { own, at: this.now() })
      }))
    }
  }
}

/** The automatic release stays in the inbox, but a commit already in the holder's HEAD needs no wake. */
function claimReleaseSha(s: Session, m: Msg): string | undefined {
  return m.type === 'note' && m.from === 'room' && m.fromKind === 'bot' && m.to === s.me.name
    ? parseClaimRelease(m.text)?.sha : undefined
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
