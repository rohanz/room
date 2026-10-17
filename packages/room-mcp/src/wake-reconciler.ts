/**
 * Wakes, level-triggered (ledger "Wake (MF8)"). One reconciler per host session, across its rooms. A message
 * is wakeable when it is owed, its kind wakes (`shouldWakeOnMsg`), it is above the session's frontier, no
 * batch holds it, no pending room_wait will return it, this path has not already woken for it, and it has
 * company (solo.ts: a room is silent while alone).
 * All wakeable messages go out as one content-free pointer over the host's path; successful sends and
 * explicitly uncertain submissions are recorded separately in `wakes.json`. A wake is never a receipt:
 * the message stays owed until a reply, a wait or
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
import type { SendMidTurn, SendWake, WakeTarget, WakeVia, WakeAttempt, WakePathStatus } from './wake-path.js'
import { CodexTurnProbe, type CodexWakeProbe } from './codex-turn.js'

/** Failed idle sends retry in bursts of three, then cool down before trying again. */
const BACKOFF_MS = [1_000, 3_000]
/** Wake at once, then gather what arrives during this window into one follow-up. */
const WINDOW_MS = 5_000
/** How often to look again for a bound host session while something is wakeable. */
const POLL_MS = 5_000
const BUSY_POLL_MS = 2_000
const RELEASE_RECHECK_MS = 5_000
const RELEASE_GIT_TIMEOUT_MS = 2_000
const MAX_NAMED = 5

type WakesFile = Record<string, Record<string, { via: WakeVia; at: number; uncertain?: boolean }>>
const deliveryKey = ({ s, m }: { s: Session; m: Msg }) => `${s.roomName}\0${m.id}`
const MAX_ATTEMPTS = 3
const RETRY_COOLDOWN_MS = 60_000
const UNKNOWN_BACKOFF_MS = [2_000, 5_000, 30_000]
const HEALTH_SAMPLE_LIMIT = 1_000
type TurnState = Awaited<ReturnType<CodexTurnProbe['state']>>
export interface DeliveryHealth {
  host: 'codex' | 'claude' | 'unbound'
  path?: WakePathStatus
  state?: TurnState
  attempt?: WakeAttempt
  degraded?: 'host-state-unknown' | 'transport-failed' | 'transport-unavailable' | 'mid-turn-retry-limit' | 'wake-retry-limit' | 'submission-uncertain'
  sampled?: boolean
  retainedAddressed: number
  pendingAddressed: number
  oldestPendingMs?: number
  handedToHost: number
  answersRecorded: number
  wakeRecorded: number
  uncertainWakeRecorded: number
}

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
  codexTurn?: CodexWakeProbe
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
  private midTurnFailure?: string
  private readonly midTurnAttempts = new Map<string, number>()
  private readonly sendAttempts = new Map<string, number>()
  // Deadlines survive document-driven re-entry: unknownNextAt gates host probes,
  // midTurnNextAt/sendNextAt gate transport bursts, and retryAfter cools down each
  // exhausted idle message. arm() schedules a pass; it alone cannot enforce these
  // limits because receipts, notices and room updates can start another pass early.
  private readonly retryAfter = new Map<string, number>()
  private unknownFailures = 0
  private unknownNextAt = 0
  private midTurnNextAt = 0
  private sendNextAt = 0
  private bindingKey?: string
  private state?: TurnState
  private degraded?: DeliveryHealth['degraded']
  private degradedNotice?: string
  private readonly codexTurn: CodexWakeProbe
  private readonly releaseChecks = new Map<string, { own: boolean; at: number }>()
  /** Messages already logged as held back while alone (one line each). */
  private readonly held = new Set<string>()

  constructor(private readonly o: WakeReconcilerOptions) { this.codexTurn = o.codexTurn ?? new CodexTurnProbe() }

  /** Aggregate the retained ledger, not a second history. No names, ids, payloads or host errors escape. */
  health(): DeliveryHealth {
    const target = this.o.bound()
    const current = target && this.bindingKey === `${target.host}\0${target.id}`
    const health: DeliveryHealth = { host: target?.host ?? 'unbound', path: target && this.o.send.describe?.(target),
      state: current ? this.state : undefined, degraded: this.degradation(), retainedAddressed: 0, pendingAddressed: 0, handedToHost: 0, answersRecorded: 0, wakeRecorded: 0, uncertainWakeRecorded: 0 }
    health.attempt = target && [this.o.send.lastAttempt?.(target), this.o.midTurn?.lastAttempt?.(target)]
      .filter((a): a is WakeAttempt => !!a).sort((a, b) => b.at - a.at)[0]
    let remaining = HEALTH_SAMPLE_LIMIT
    for (const s of this.sessions.keys()) {
      // Iterate existing storage; never allocate a copy of the whole bus/mail just for diagnostics.
      const retained = new Map<string, Msg>()
      for (const source of [s.room.bus, s.room.mail.values()]) for (const m of source) {
        if (retained.has(m.id)) continue
        if (remaining === 0) { health.sampled = true; break }
        remaining--; retained.set(m.id, m)
      }
      const seen = s.room.seen(s.me.name)
      const wakes = this.wakes()[s.roomName] ?? {}
      for (const m of retained.values()) {
        if (m.to !== s.me.name) continue
        health.retainedAddressed++
        if (seen.has(m.id)) health.handedToHost++
        if (wakes[m.id]?.uncertain) health.uncertainWakeRecorded++
        else if (wakes[m.id]) health.wakeRecorded++
        if (m.type === 'answer') {
          const question = s.room.message(m.inReplyTo)
          if (question?.type === 'question' && question.from === s.me.name && question.to === m.from) health.answersRecorded++
        }
      }
      for (const m of this.o.ledger.candidates(s)) if (m.to === s.me.name) {
        health.pendingAddressed++
        const age = Math.max(0, this.now() - m.at)
        health.oldestPendingMs = Math.max(health.oldestPendingMs ?? 0, age)
      }
    }
    return health
  }

  private degrade(reason: NonNullable<DeliveryHealth['degraded']>): void {
    if (this.degraded !== reason && this.degradedNotice) this.o.ledger.withdraw(this.degradedNotice)
    this.degraded = reason
    this.degradedNotice = this.o.ledger.notice(`delivery-degraded:${reason}`, `[room] Wake delivery: ${reason}. Pending content remains in Room; continue independent work and use room_wait for a Room dependency when needed. room_state(check=true) shows transport and handoff evidence.`).id
  }

  /** Cheap normal-state summary; detailed retained-ledger sampling is reserved for check=true. */
  degradation(): DeliveryHealth['degraded'] {
    const target = this.o.bound()
    return target && this.bindingKey === `${target.host}\0${target.id}` && this.o.send.describe?.(target).availability !== 'off'
      ? this.degraded : undefined
  }

  private recover(): void {
    if (this.degradedNotice) this.o.ledger.withdraw(this.degradedNotice)
    this.degradedNotice = undefined
    this.degraded = undefined
  }

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
    const live = new Set(due.map(deliveryKey))
    for (const attempts of [this.midTurnAttempts, this.sendAttempts]) for (const key of attempts.keys()) if (!live.has(key)) attempts.delete(key)
    for (const key of this.retryAfter.keys()) if (!live.has(key)) this.retryAfter.delete(key)
    if (!due.length) { this.failures = 0; this.unknownFailures = 0; this.unknownNextAt = 0; this.recover(); return }
    const target = this.o.bound()
    if (!target) { this.arm(this.o.pollMs ?? POLL_MS); return }
    const bindingKey = `${target.host}\0${target.id}`
    if (this.bindingKey !== bindingKey) {
      this.bindingKey = bindingKey; this.state = undefined; this.recover()
      this.midTurnAttempts.clear(); this.sendAttempts.clear(); this.midTurnFailure = undefined
      this.retryAfter.clear(); this.unknownFailures = 0; this.unknownNextAt = 0
      this.midTurnNextAt = 0; this.sendNextAt = 0
    }
    if (this.o.send.describe?.(target).availability === 'off') { this.recover(); return }
    let busy = false
    if (target.host === 'codex') {
      if (this.codexTurn.state) {
        if (this.now() < this.unknownNextAt) { this.arm(this.unknownNextAt - this.now()); return }
        this.state = await this.codexTurn.state(target.id)
        if (this.state.kind === 'unknown') {
          const delay = UNKNOWN_BACKOFF_MS[Math.min(this.unknownFailures++, UNKNOWN_BACKOFF_MS.length - 1)]
          this.unknownNextAt = this.now() + delay
          this.degrade('host-state-unknown')
          this.arm(delay)
          return
        }
        this.unknownFailures = 0; this.unknownNextAt = 0
        if (this.degraded === 'host-state-unknown') this.recover()
        busy = this.state.kind === 'active'
      } else busy = await this.codexTurn.busy(target.id)
    }
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
      if (this.now() < this.midTurnNextAt) { this.arm(this.midTurnNextAt - this.now()); return }
      const eligible = due.filter(({ s, m }) => (m.priority ?? defaultPriority({ ...m })) !== 'fyi'
        || (m.type === 'done' && m.to === s.me.name && m.fromKind === 'agent' && this.o.ownWorkers?.(s).has(m.from)))
      const urgent = eligible.filter(item => (this.midTurnAttempts.get(deliveryKey(item)) ?? 0) < MAX_ATTEMPTS)
      if (eligible.length && !urgent.length) this.degrade('mid-turn-retry-limit')
      if (urgent.length && this.o.midTurn) {
        this.midTurnNextAt = this.now() + (this.o.busyPollMs ?? BUSY_POLL_MS)
        for (const item of urgent) { const key = deliveryKey(item); this.midTurnAttempts.set(key, (this.midTurnAttempts.get(key) ?? 0) + 1) }
        try {
          const via = await this.o.midTurn(target, this.pointer(urgent))
          if (this.stopped) return
          if (via === 'turn' || via === 'uncertain-turn') {
            this.midTurnFailure = undefined
            if (via === 'turn') this.recover()
            else this.degrade('submission-uncertain')
            this.lastSentAt = this.now()
            const wakes = this.wakes(), at = this.now()
            for (const { s, m } of urgent) (wakes[s.roomName] ??= {})[m.id] = { via: 'turn', at, ...(via === 'uncertain-turn' && { uncertain: true }) }
            this.persist()
            this.o.log?.(`wake: ${via === 'turn' ? 'submitted' : 'uncertain submission of'} mid-turn pointer to codex session ${target.id} via turn for ${urgent.map(({ m }) => `${m.type} ${m.id}`).join(', ')}`)
          } else if (via === 'idle') {
            this.recover()
            for (const item of urgent) this.midTurnAttempts.delete(deliveryKey(item))
          } else this.degrade('transport-unavailable')
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          const key = `${target.id}\0${reason}`
          if (this.midTurnFailure !== key) this.o.log?.(`wake: mid-turn failed for codex session ${target.id}: ${reason}`)
          this.midTurnFailure = key
          this.degrade('transport-failed')
        }
      }
      this.arm(this.o.busyPollMs ?? BUSY_POLL_MS)
      return
    }
    if (this.now() < this.sendNextAt) { this.arm(this.sendNextAt - this.now()); return }
    let nextRetry = Infinity
    due = due.filter(item => {
      const key = deliveryKey(item), retryAt = this.retryAfter.get(key)
      if (retryAt !== undefined && this.now() >= retryAt) { this.sendAttempts.delete(key); this.retryAfter.delete(key) }
      if ((this.sendAttempts.get(key) ?? 0) < MAX_ATTEMPTS) return true
      nextRetry = Math.min(nextRetry, retryAt ?? this.now() + RETRY_COOLDOWN_MS)
      return false
    })
    if (!due.length) { this.degrade('wake-retry-limit'); this.arm(Math.max(1, nextRetry - this.now())); return }
    for (const item of due) {
      const key = deliveryKey(item), count = (this.sendAttempts.get(key) ?? 0) + 1
      this.sendAttempts.set(key, count)
      if (count === MAX_ATTEMPTS) this.retryAfter.set(key, this.now() + RETRY_COOLDOWN_MS)
    }
    let via: WakeVia | undefined
    try { via = await this.o.send(target, this.pointer(due)) }
    catch (e) {
      this.degrade('transport-failed')
      const delays = this.o.backoffMs ?? BACKOFF_MS
      const delay = delays[Math.min(this.failures, delays.length - 1)]
      this.failures++
      this.sendNextAt = this.now() + delay
      this.o.log?.(`wake: could not wake ${target.host} session ${target.id} (${e instanceof Error ? e.message : String(e)}); retrying in ${delay}ms`)
      this.arm(delay)
      return
    }
    if (this.stopped) return
    if (!via) {
      this.degrade('transport-unavailable')
      if (!this.silent) this.o.log?.(`wake: this ${target.host} session has no wake path; messages wait for its next turn`)
      this.silent = true
      return
    }
    this.failures = 0
    this.sendNextAt = 0
    this.silent = false
    this.recover()
    this.lastSentAt = this.now()
    const at = this.now()
    const wakes = this.wakes()
    for (const { s, m } of due) (wakes[s.roomName] ??= {})[m.id] = { via, at }
    this.persist()
    this.o.log?.(`wake: woke ${target.host} session ${target.id} via ${via} for ${due.map(({ m }) => `${m.type} ${m.id}`).join(', ')}`)
    if (Number.isFinite(nextRetry)) this.arm(Math.max(1, nextRetry - this.now()))
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
