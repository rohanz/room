/**
 * The fenced `room/sessions/<sid>/state.json` writer (ledger "Local files"): counts and coordination for
 * the plugin hooks while this session holds its participant, never message content. The hooks take content
 * from the MCP's arbitration endpoint (arbitration.ts); this file only lets them say what is pending while
 * the MCP is away. Wakes are the WakeReconciler's.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { claimInMyLines, coordinationPaths, digestPath, gitBlobHash, neighbours, participantsView, displayName, formatPlans, manifestPaths, snapshot, type Presence, isAgentic } from '@room/shared'
import type { Session } from './session.js'
import { hasCompany, describeCompany, type CompanyState } from './company.js'
import { resolveSessionHost } from './config.js'
import { writeAtomic } from './leases.js'
import { ownWorkerNames } from './worker-registry.js'
import { workerText } from './tools/context.js'

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
  /** How many messages this participant is owed now (the ledger's selection, unreserved or not). */
  owedCount: () => number
  /** How many local notices wait for a handoff. */
  noticeCount?: () => number
  /** Whether this process still holds the participant (ledger invariant 5): an unfenced process writes nothing. */
  fenced: () => boolean
  /** The bound session's directory, `room/sessions/<sid>/`; undefined turns the state file off. */
  sessionDir: () => string | undefined
  /** The hub's paused line, carried so the hook can print it (hub §7). */
  paused?: () => string | undefined
  /** The authoritative company state, including workers held by the registry. */
  company?: () => CompanyState
  log?: (line: string) => void
  now?: () => number
}

export class HooksBridge {
  private timer: NodeJS.Timeout | null = null
  private unobserve: (() => void)[] = []
  private stopped = false
  private written?: string
  constructor(private s: Session, private o: HooksBridgeOptions) {
    hookHealth.set(s, newHookHealth(this.now()))
  }

  start(): void {
    this.stopped = false
    const kick = () => this.scheduleWrite()
    this.s.room.doc.on('update', kick); this.s.awareness.on('change', kick)
    this.unobserve.push(() => { this.s.room.doc.off('update', kick); this.s.awareness.off('change', kick) })
    this.scheduleWrite()
  }

  stop(): void {
    this.stopped = true
    for (const u of this.unobserve) u()
    this.unobserve = []
    if (this.timer) clearTimeout(this.timer)
    if (this.written) { try { fs.rmSync(this.written, { force: true }) } catch { /* ignore */ } }
  }

  /** Debounced: many small doc updates become one file write. */
  scheduleWrite(): void {
    if (this.stopped) return
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      try { this.write() } catch (e) { this.o.log?.(`hooks: could not write state: ${e instanceof Error ? e.message : String(e)}`) }
    }, 150)
    this.timer.unref?.()
  }

  /** state.json: counts and coordination for the hooks, written only while fenced (ledger "Local files"). */
  write(): void {
    if (this.stopped) return
    const dir = this.o.sessionDir()
    if (!dir || !this.o.fenced()) return
    const me = this.s.me.name
    const openClaims = this.s.room.openClaims()
    const ownClaims = openClaims.filter(c => c.by === me && isAgentic(c.byKind)).map(c => ({ path: c.path, from: c.from, to: c.to }))
    const views = participantsView(this.s.room, this.s.awareness, this.now())
    const ownerSnapshots = new Map<string, ReturnType<typeof snapshot>>()
    const claims = openClaims.filter(c => !(c.by === me && isAgentic(c.byKind))).map(c => {
      if (!ownerSnapshots.has(c.by)) ownerSnapshots.set(c.by, snapshot(this.s.room, c.by, views))
      const owner = ownerSnapshots.get(c.by)
      const entry = owner?.entries.get(c.path)
      let ownerText: string | undefined
      if (owner?.fenceValid && owner.head.complete && owner.head.coverage.kind === 'all' && owner.head.base === owner.record?.git?.base && owner.head.fence === owner.record.git.fence) {
        if (entry?.change === 'D') ownerText = ''
        else if (entry?.hash) {
          try {
            const text = entry.state === 'shared' ? owner.texts.get(c.path) : execFileSync('git', ['-C', this.s.dir, 'cat-file', '-p', entry.hash], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
            if (text !== undefined && gitBlobHash(text, entry.hash.length === 64 ? 'sha256' : 'sha1') === entry.hash) ownerText = text
          } catch { /* whole-file approximate warning below */ }
        } else if (!entry && !(owner.roomSalt && owner.head.excluded.includes(digestPath(owner.roomSalt, c.path)))) {
          try { ownerText = execFileSync('git', ['-C', this.s.dir, 'show', `${owner.head.base}:${c.path}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) }
          catch { /* whole-file approximate warning below */ }
        }
      }
      let myText = ''
      try { myText = workerText(this.s.dir, c.path) ?? '' } catch { /* unavailable file */ }
      const mapped = c.path.endsWith('/') ? { from: 1, to: Number.MAX_SAFE_INTEGER, approximate: true } : claimInMyLines(c, ownerText, myText)
      return { id: c.id, path: c.path, ...mapped, by: c.by, intent: c.intent, ...(c.plans?.length ? { plans: formatPlans(c.plans) } : {}) }
    })
    const near = coordinationPaths(this.s.room, neighbours(participantsView(this.s.room, this.s.awareness, this.now()), me), me, { includeOwnNonAgentClaims: true })
    const company = this.o.company?.() ?? hasCompany(this.s, [], this.now())
    const presences = [...this.s.awareness.getStates().values()] as Partial<Presence>[]
    const others = company.others.map(name => displayName({ name, kind: (presences.find(p => p.user?.name === name && p.user.kind === 'agent') ?? presences.find(p => p.user?.name === name))?.user?.kind ?? this.s.room.scope(name)?.byKind ?? 'agent' }))
    const paused = this.o.paused?.()
    const file = path.join(dir, 'state.json')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeAtomic(file, { name: me, room: this.s.roomName, at: this.now(), owedCount: this.o.owedCount(), notices: this.o.noticeCount?.() ?? 0, company: company.company, others, companyLine: describeCompany(this.s, company), claims, ownClaims, near, ...(paused ? { paused } : {}) })
    this.written = file
  }

  private now(): number { return this.o.now?.() ?? Date.now() }
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
      !(manifestPaths(s.room, s.me.name).length && (s.room.manifestHead.get(s.me.name)?.scannedAt ?? -Infinity) >= sessionStartedAt)) return ''
  health.noted = true
  return missingPreEditGuidance(s)
}
