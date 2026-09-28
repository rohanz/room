/**
 * Bridge between the room and the plugin hooks, per host session (ledger "Local files"):
 *  - keeps `room/sessions/<sid>/state.json` current while this session holds its participant: counts and
 *    coordination only, never message content. The hooks take content from the MCP's arbitration
 *    endpoint (arbitration.ts); this file only lets them say what is pending while the MCP is away.
 *  - wakes the bound host session when an interrupt or a question addressed to me arrives: `codex queue`
 *    for Codex, with retries; Claude Code sessions are reached by the socket or channel path instead.
 *    A wake is never a receipt. (The wake path moves to the WakeReconciler in ledger step 4.)
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BASE_CATCH_UP, coordinationPaths, displayName, formatMsg, formatPlans, shouldWakeOnMsg, type Msg, type Presence, isAgentic } from '@room/shared'
import type { Session } from './session.js'
import { claudeWakeUnavailable } from './prompt.js'
import { hasCompany, describeCompany, type CompanyState } from './company.js'
import { resolveSessionHost } from './config.js'
import { writeAtomic } from './leases.js'

type Bound = { id: string; host: 'claude' | 'codex' }

/** The bound session's write intents (recorded by before-edit.mjs): did this session write `p` in the last two minutes? */
export function createWriteIntentReader(dir: string, sessionDir: () => string | undefined, now: () => number = Date.now): (p: string) => boolean | undefined {
  return p => {
    const root = sessionDir()
    if (!root) return undefined
    try {
      const evidence = JSON.parse(fs.readFileSync(path.join(root, 'write-intents.json'), 'utf8'))
      if (!Array.isArray(evidence.writes)) return undefined
      const at = now(), target = path.resolve(dir, p)
      return evidence.writes.some((w: { path?: unknown; at?: unknown }) => typeof w.path === 'string' &&
        typeof w.at === 'number' && Number.isFinite(w.at) && w.at <= at && at - w.at < 120_000 && path.resolve(w.path) === target)
    } catch { return undefined }
  }
}

export interface HooksBridgeOptions {
  /** Which messages count for wakes (the tools' inbox rule). */
  forMe: (m: Msg) => boolean
  /** How many messages this participant is owed now (the ledger's selection, unreserved or not). */
  owedCount: () => number
  /** How many local notices wait for a handoff. */
  noticeCount?: () => number
  /** Whether this process still holds the participant (ledger invariant 5): an unfenced process writes nothing. */
  fenced: () => boolean
  /** The bound host session, re-evaluated on use (registry §17); undefined turns the state file and wakes off. */
  session: () => Bound | undefined
  /** Its directory, `room/sessions/<sid>/`. */
  sessionDir: () => string | undefined
  /** The hub's paused line, carried so the hook can print it (hub §7). */
  paused?: () => string | undefined
  /** The authoritative company state, including workers held by the registry. */
  company?: () => CompanyState
  log?: (line: string) => void
  /** Injectable for tests. */
  queue?: (threadId: string, text: string) => Promise<void>
  now?: () => number
  /** Backoff between queue attempts (ms); default 1s, 3s, 8s. */
  retryDelaysMs?: number[]
  /** How often to look again for a bound session while wakes are pending; default 5s. */
  pendingPollMs?: number
  /** Keep state.json current (default true). A second bridge for the same session (the workers room) only wakes. */
  writeState?: boolean
  /** Give up on a pending wake after this long; default 10 min. */
  pendingMaxMs?: number
}

export class HooksBridge {
  private timer: NodeJS.Timeout | null = null
  private woken = new Set<string>()
  /** Wakes that found no bound session yet, with when they first arrived. */
  private pending = new Map<string, { msg: Msg; since: number }>()
  private pendingTimer: NodeJS.Timeout | null = null
  private unobserve: (() => void)[] = []
  private delivering = new Set<string>()
  private generation = 0
  private stopped = false
  private written?: string
  constructor(private s: Session, private o: HooksBridgeOptions) {
    hookHealth.set(s, newHookHealth(this.now()))
  }

  start(): void {
    this.stopped = false
    this.generation++
    this.s.awareness.setLocalStateField('wakeUnavailable', claudeWakeUnavailable(this.s.dir))
    const kick = () => this.scheduleWrite()
    if (this.o.writeState !== false) {
      this.s.room.doc.on('update', kick); this.s.awareness.on('change', kick)
      this.unobserve.push(() => { this.s.room.doc.off('update', kick); this.s.awareness.off('change', kick) })
    }
    // A local transaction is usually my own post, which never wakes me. It can also be a message this
    // process wrote on someone else's behalf (a worker's synthetic done on exit): that one must.
    const onBus = (ev: { changes: { delta: { insert?: unknown }[] }; transaction: { local: boolean } }) => {
      for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) {
        if (ev.transaction.local && m.from === this.s.me.name && m.fromKind !== 'human') continue
        void this.maybeWake(m)
      }
    }
    this.s.room.bus.observe(onBus)
    this.unobserve.push(() => this.s.room.bus.unobserve(onBus))
    this.scheduleWrite()
  }

  stop(): void {
    this.stopped = true
    this.generation++
    for (const u of this.unobserve) u()
    this.unobserve = []
    if (this.timer) clearTimeout(this.timer)
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pending.clear()
    if (this.o.writeState !== false && this.written) { try { fs.rmSync(this.written, { force: true }) } catch { /* ignore */ } }
  }

  /** Debounced: many small doc updates become one file write. */
  scheduleWrite(): void {
    if (this.o.writeState === false || this.stopped) return
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      try { this.write() } catch (e) { this.o.log?.(`hooks: could not write state: ${e instanceof Error ? e.message : String(e)}`) }
    }, 150)
    this.timer.unref?.()
  }

  /** state.json: counts and coordination for the hooks, written only while fenced (ledger "Local files"). */
  write(): void {
    if (this.stopped || this.o.writeState === false) return
    const dir = this.o.sessionDir()
    if (!dir || !this.o.fenced()) return
    const me = this.s.me.name
    const openClaims = this.s.room.openClaims()
    const ownClaims = openClaims.filter(c => c.by === me && isAgentic(c.byKind)).map(c => ({ path: c.path, from: c.from, to: c.to }))
    const claims = openClaims.filter(c => !(c.by === me && isAgentic(c.byKind))).map(c => ({ id: c.id, path: c.path, from: c.from, to: c.to, by: c.by, intent: c.intent, ...(c.plans?.length ? { plans: formatPlans(c.plans) } : {}) }))
    const near = coordinationPaths(this.s.room, me, { includeOwnNonAgentClaims: true })
    const company = this.o.company?.() ?? hasCompany(this.s, [], this.now())
    const presences = [...this.s.awareness.getStates().values()] as Partial<Presence>[]
    const others = company.others.map(name => displayName({ name, kind: (presences.find(p => p.user?.name === name && p.user.kind === 'agent') ?? presences.find(p => p.user?.name === name))?.user?.kind ?? this.s.room.scope(name)?.byKind ?? 'agent' }))
    const paused = this.o.paused?.()
    const file = path.join(dir, 'state.json')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeAtomic(file, { name: me, room: this.s.roomName, at: this.now(), owedCount: this.o.owedCount(), notices: this.o.noticeCount?.() ?? 0, company: company.company, others, companyLine: describeCompany(this.s, company), claims, ownClaims, near, ...(paused ? { paused } : {}) })
    this.written = file
  }

  /** Interrupts, questions addressed to me, and a base move while I have uncommitted work wake the idle Codex thread, once per message. */
  async maybeWake(m: Msg): Promise<void> {
    if (this.stopped) return
    const generation = this.generation
    if (this.isSeen(m.id)) return
    if (!this.o.forMe(m)) return
    const myClaims = this.s.room.openClaims().filter(c => c.by === this.s.me.name)
    const ownWorkers = new Set(Array.from(this.s.room.workers.values()).filter(w => w.lead === this.s.me.name).map(w => w.name))
    const wake = shouldWakeOnMsg(this.s.me, m, myClaims, this.s.room.changedPaths(this.s.me.name).length > 0, ownWorkers).wake
    if (!wake || this.woken.has(m.id) || this.pending.has(m.id) || this.delivering.has(m.id)) return
    const session = this.o.session()
    if (!session) {
      // Nothing bound yet (SessionStart has not run): keep the message and try again later.
      if (this.stopped || generation !== this.generation) return
      this.pending.set(m.id, { msg: m, since: this.now() })
      this.o.log?.(`cannot wake yet: no bound host session; will retry for ${m.type} ${m.id}`)
      this.schedulePending()
      return
    }
    if (this.stopped || generation !== this.generation) return
    this.delivering.add(m.id)
    try { await this.deliver(m, session, generation) } finally { this.delivering.delete(m.id) }
  }

  private async deliver(m: Msg, session: Bound, generation: number): Promise<void> {
    const active = () => !this.stopped && generation === this.generation
    if (!active()) return
    if (session.host === 'claude') {
      // The socket or channel path (index.ts attachChannel) reaches a live Claude Code session.
      this.woken.add(m.id)
      this.o.log?.(`claude host: ${m.type} ${m.id} handled via channel`)
      return
    }
    const text = m.type === 'base'
      ? `[room] ${formatMsg(m).replace(` — ${BASE_CATCH_UP}`, '')}\nYou have uncommitted work. ${BASE_CATCH_UP} Re-run room_preview_merge with the test command against anyone who changed the same files, then continue.`
      : `[room] ${formatMsg(m)}\nCall room_state, then react per the room-etiquette skill.`
    const delays = this.o.retryDelaysMs ?? [1000, 3000, 8000]
    for (let attempt = 0; ; attempt++) {
      if (!active()) return
      if (this.isSeen(m.id)) return
      try {
        await (this.o.queue ?? defaultQueue)(session.id, text)
        if (!active()) return
        // A queued message reaches Codex at its next turn boundary, which a headless worker may never reach:
        // record the wake so it is not queued again, and leave the message owed until a tool reply,
        // room_wait or the edit hook hands it off.
        this.woken.add(m.id)
        this.o.log?.(`woke session ${session.id.slice(0, 8)} for ${m.type} ${m.id}${attempt ? ` (attempt ${attempt + 1})` : ''}`)
        return
      } catch (e) {
        if (!active()) return
        const why = e instanceof Error ? e.message : String(e)
        if (attempt >= delays.length) { this.o.log?.(`could not wake session ${session.id.slice(0, 8)} for ${m.type} ${m.id} after ${attempt + 1} attempts: ${why}`); return }
        this.o.log?.(`wake attempt ${attempt + 1} failed (${why}); retrying in ${delays[attempt]}ms`)
        await sleep(delays[attempt])
      }
    }
  }

  private schedulePending(): void {
    if (this.stopped || this.pendingTimer || !this.pending.size) return
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      void this.retryPending().catch(e => this.o.log?.(`hooks: could not retry pending wakes: ${e instanceof Error ? e.message : String(e)}`))
    }, this.o.pendingPollMs ?? 5000)
    this.pendingTimer.unref?.()
  }

  /** Look for a bound session again; deliver what we can, drop what is too old. */
  async retryPending(): Promise<void> {
    if (this.stopped) return
    const generation = this.generation
    const maxAge = this.o.pendingMaxMs ?? 10 * 60 * 1000
    const session = this.o.session()
    for (const [id, p] of Array.from(this.pending)) {
      if (this.stopped || generation !== this.generation) return
      if (this.isSeen(id)) { this.pending.delete(id); continue }
      if (this.now() - p.since > maxAge) { this.pending.delete(id); this.o.log?.(`gave up waking for ${p.msg.type} ${id}: no session for ${Math.round(maxAge / 60000)} min`); continue }
      if (!session) continue
      this.pending.delete(id)
      await this.maybeWake(p.msg)
    }
    this.schedulePending()
  }

  private now(): number { return this.o.now?.() ?? Date.now() }
  private isSeen(id: string): boolean { return this.s.room.seen(this.s.me.name).has(id) }
}

const sleep = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); t.unref?.() })

function defaultQueue(threadId: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('codex', ['queue', '--thread', threadId, '--message', text], { timeout: 10_000 }, (err, _out, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve())
  })
}

type HookHealth = { since: number; calls: number; noted: boolean; observed: boolean; joinNoted: boolean; scopeNoted: boolean }
const hookHealth = new WeakMap<Session, HookHealth>()

function newHookHealth(now: number): HookHealth {
  return { since: now, calls: 0, noted: false, observed: false, joinNoted: false, scopeNoted: false }
}

function missingPreEditGuidance(s: Session): string {
  const host = resolveSessionHost()
  if (host === 'claude') return "Room has not seen its before-edit hook run in this session although its tools are in use: the plugin's hooks may not be running; reinstall or re-enable the plugin."
  if (host === 'codex') return 'Pre-edit coordination is not confirmed yet; if the Room hooks were never approved, approve them once in an interactive Codex session.'
  return 'Pre-edit coordination is not confirmed yet; enable the Room hooks for this agent host.'
}

/**
 * Diagnose Claude only after this host session has actually changed its own tree. Evidence is the bound
 * session's `hook-activity.json`, written by before-edit.mjs, and its `session.json` start time.
 */
export function hookHealthNote(s: Session, sessionDir: string | undefined, expected: boolean, now = Date.now(), tool?: string, team = !s.local): string {
  let health = hookHealth.get(s)
  if (!health) { health = newHookHealth(now); hookHealth.set(s, health) }
  let sessionStartedAt = health.since
  if (sessionDir) {
    try {
      const session = JSON.parse(fs.readFileSync(path.join(sessionDir, 'session.json'), 'utf8'))
      if (typeof session.at === 'number' && Number.isFinite(session.at) && session.at <= now) sessionStartedAt = session.at
    } catch { /* use the first room-tool call as the session boundary */ }
    try {
      const activity = JSON.parse(fs.readFileSync(path.join(sessionDir, 'hook-activity.json'), 'utf8'))
      if (activity.event === 'PreToolUse' && typeof activity.at === 'number' && activity.at <= now &&
          (resolveSessionHost() !== 'claude' || activity.at >= sessionStartedAt)) health.observed = true
    } catch { /* no receipt yet */ }
  }
  if (!expected || health.observed || health.noted) return ''
  // Only Codex can skip an unapproved hook silently, so only Codex is told up front. Elsewhere the hook is silent
  // while the agent is alone, which an agent cannot tell from a missing hook: wait for the evidence below instead.
  const upFront = team && resolveSessionHost() === 'codex'
  if (upFront && tool === 'room_join' && !health.joinNoted && !health.scopeNoted) {
    health.joinNoted = true
    return missingPreEditGuidance(s)
  }
  if (upFront && tool === 'room_scope' && !health.scopeNoted) {
    health.scopeNoted = true
    return missingPreEditGuidance(s)
  }
  if (health.joinNoted || health.scopeNoted) return ''
  if (!health.calls) health.since = now
  health.calls++
  if (health.calls < 2 || now - health.since < 30_000) return ''
  if (resolveSessionHost() === 'claude' &&
      !(s.room.changedPaths(s.me.name).length && (s.room.overlayAt.get(s.me.name) ?? -Infinity) >= sessionStartedAt)) return ''
  health.noted = true
  return missingPreEditGuidance(s)
}
