/**
 * The fenced `room/sessions/<sid>/state.json` writer (ledger "Local files"): counts and coordination for
 * the plugin hooks while this session holds its participant, never message content. The hooks take content
 * from the MCP's arbitration endpoint (arbitration.ts); this file only lets them say what is pending while
 * the MCP is away. Wakes are the WakeReconciler's.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { claimInMyLines, coordinationPaths, digestPath, gitBlobHash, neighbours, participantsView, displayName, formatPlans, manifestPaths, snapshotPath, snapshotStillCurrent, type Presence, isAgentic } from '@room/shared'
import type { Session } from './session.js'
import { hasCompany, describeCompany, type CompanyState } from './company.js'
import { resolveSessionHost } from './config.js'
import { writeAtomic } from './leases.js'
import { ownWorkerNames } from './worker-registry.js'
import { workerText } from './tools/context.js'
import { DISK_TEXT_LIMIT, readBoundedHistoricalText } from './tools/disk-text.js'
import { git } from '@room/roomd/git'

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
  private readonly writer = randomUUID()
  private timer: NodeJS.Timeout | null = null
  private unobserve: (() => void)[] = []
  private stopped = false
  private revision = 0
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
    this.revision++
    for (const u of this.unobserve) u()
    this.unobserve = []
    if (this.timer) clearTimeout(this.timer)
    if (this.written) {
      try { if (JSON.parse(fs.readFileSync(this.written, 'utf8')).writer === this.writer) fs.rmSync(this.written, { force: true }) }
      catch { /* another instance or already gone */ }
    }
  }

  /** Debounced: many small doc updates become one file write. */
  scheduleWrite(): void {
    if (this.stopped) return
    this.revision++
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      try { void this.write().catch(e => this.o.log?.(`hooks: could not write state: ${e instanceof Error ? e.message : String(e)}`)) }
      catch (e) { this.o.log?.(`hooks: could not write state: ${e instanceof Error ? e.message : String(e)}`) }
    }, 150)
    this.timer.unref?.()
  }

  /** state.json: counts and coordination while fenced, or a minimal paused health state on lease loss. */
  async write(): Promise<void> {
    if (this.stopped) return
    const revision = this.revision
    const leaseFence = this.s.lease?.fence()
    const dir = this.o.sessionDir()
    if (!dir) return
    const file = path.join(dir, 'state.json')
    if (!this.o.fenced()) {
      const paused = this.o.paused?.()
      if (!paused || this.written !== file) return
      // A newer MCP may already own this same bound-session endpoint. Never replace its state.
      try { if (JSON.parse(fs.readFileSync(file, 'utf8')).writer !== this.writer) return } catch { return }
      writeAtomic(file, { name: this.s.me.name, room: this.s.roomName, at: this.now(), paused, writer: this.writer })
      return
    }
    const me = this.s.me.name
    const openClaims = this.s.room.openClaims()
    const ownClaims = openClaims.filter(c => c.by === me && isAgentic(c.byKind)).map(c => ({ path: c.path, from: c.from, to: c.to }))
    const views = participantsView(this.s.room, this.s.awareness, this.now())
    const ownerSnapshots = new Map<string, ReturnType<typeof snapshotPath>>()
    const ownerTexts = new Map<string, Promise<string | undefined>>()
    const myTexts = new Map<string, Promise<string | null>>()
    const claims = [] as { id: string; path: string; from: number; to: number; approximate: boolean; by: string; intent: string; plans?: string }[]
    for (const c of openClaims.filter(c => !(c.by === me && isAgentic(c.byKind)))) {
      await new Promise<void>(resolve => setImmediate(resolve))
      const key = `${c.by}\0${c.path}`
      if (!ownerSnapshots.has(key)) ownerSnapshots.set(key, snapshotPath(this.s.room, c.by, views, c.path))
      const owner = ownerSnapshots.get(key)
      const entry = owner?.entries.get(c.path)
      if (!ownerTexts.has(key)) ownerTexts.set(key, (async () => {
        if (!owner?.fenceValid || !owner.head.complete || owner.head.coverage.kind !== 'all' || owner.head.base !== owner.record?.git?.base || owner.head.fence !== owner.record.git.fence) return undefined
        if (entry?.change === 'D') return ''
        if (entry?.hash) {
          try {
            let text: string | undefined
            if (entry.state === 'shared') text = owner.texts.get(c.path)
            else {
              const size = Number((await git(this.s.dir, ['cat-file', '-s', entry.hash])).trim())
              if (!Number.isSafeInteger(size) || size > DISK_TEXT_LIMIT) return undefined
              text = await git(this.s.dir, ['cat-file', '-p', entry.hash])
            }
            if (text !== undefined && Buffer.byteLength(text) <= DISK_TEXT_LIMIT && gitBlobHash(text, entry.hash.length === 64 ? 'sha256' : 'sha1') === entry.hash) return text
          } catch { /* unknown: the claim's own lines, marked approximate, below */ }
        } else if (!entry && !(owner.roomSalt && owner.head.excluded.includes(digestPath(owner.roomSalt, c.path)))) {
          try { return await readBoundedHistoricalText(this.s.dir, owner.head.base, c.path) }
          catch { /* unknown: the claim's own lines, marked approximate, below */ }
        }
        return undefined
      })())
      if (!myTexts.has(c.path)) myTexts.set(c.path, workerText(this.s.dir, c.path).catch(() => null))
      const ownerText = await ownerTexts.get(key)
      const myText = await myTexts.get(c.path)
      // A directory claim holds all of it. Without either text the claim keeps its own numbers, marked approximate:
      // a whole-file range is shown only for a whole-file claim.
      const mapped = c.path.endsWith('/') ? { from: 1, to: Number.MAX_SAFE_INTEGER, approximate: false }
        : myText == null ? { from: c.from, to: c.to, approximate: true } : claimInMyLines(c, ownerText, myText)
      claims.push({ id: c.id, path: c.path, ...mapped, by: c.by, intent: c.intent, ...(c.plans?.length ? { plans: formatPlans(c.plans) } : {}) })
    }
    const freshViews = participantsView(this.s.room, this.s.awareness, this.now())
    if (this.stopped || revision !== this.revision || !this.o.fenced() || this.s.lease?.fence() !== leaseFence || this.o.sessionDir() !== dir ||
        openClaims.map(c => c.id).join('\0') !== this.s.room.openClaims().map(c => c.id).join('\0') ||
        [...ownerSnapshots.values()].some(owner => owner && !snapshotStillCurrent(this.s.room, owner, freshViews))) {
      this.scheduleWrite()
      return
    }
    const near = coordinationPaths(this.s.room, neighbours(participantsView(this.s.room, this.s.awareness, this.now()), me), me, { includeOwnNonAgentClaims: true })
    const company = this.o.company?.() ?? hasCompany(this.s, [], this.now())
    const presences = [...this.s.awareness.getStates().values()] as Partial<Presence>[]
    const others = company.others.map(name => displayName({ name, kind: (presences.find(p => p.user?.name === name && p.user.kind === 'agent') ?? presences.find(p => p.user?.name === name))?.user?.kind ?? this.s.room.scope(name)?.byKind ?? 'agent' }))
    const paused = this.o.paused?.()
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeAtomic(file, { name: me, room: this.s.roomName, at: this.now(), owedCount: this.o.owedCount(), notices: this.o.noticeCount?.() ?? 0, company: company.company, others, companyLine: describeCompany(this.s, company), claims, ownClaims, near, ...(paused ? { paused } : {}), writer: this.writer })
    this.written = file
  }

  private now(): number { return this.o.now?.() ?? Date.now() }
}

type HookHealth = { since: number; calls: number; noted: boolean; observed: boolean; joinNoted: boolean; scopeNoted: boolean }
const hookHealth = new WeakMap<Session, HookHealth>()
const PROCESS_STARTED_AT = Date.now()

/** Hook evidence is local to this host session; ledger message receipts are separate. */
export function hookReceiptPath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, '..', '..', 'hook-receipts', createHash('sha256').update(sessionId).digest('hex').slice(0, 32) + '.json')
}

function readBoundedJson(file: string): Record<string, unknown> | undefined {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    if (fs.fstatSync(fd).size > 4096) return undefined
    const bytes = Buffer.alloc(4097)
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0)
    return count <= 4096 ? JSON.parse(bytes.toString('utf8', 0, count)) : undefined
  } catch { return undefined }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

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
 * Diagnose Claude only after this process has seen the bound host session change its own tree.
 * The per-session hook receipt is evidence of PreToolUse, not a ledger delivery receipt.
 */
export function hookHealthNote(s: Session, sessionDir: string | undefined, expected: boolean, now = Date.now(), tool?: string, team = !s.local): string {
  let health = hookHealth.get(s)
  if (!health) { health = newHookHealth(now); hookHealth.set(s, health) }
  const session = sessionDir ? readBoundedJson(path.join(sessionDir, 'session.json')) : undefined
  const id = typeof session?.session_id === 'string' && session.session_id.length > 0 && session.session_id.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(session.session_id) ? session.session_id : undefined
  // A directory without a bound host identity cannot prove which session owns any receipt.
  if (!sessionDir || !id) return ''
  const sessionAt = session?.at
  const sessionStartedAt = Math.max(PROCESS_STARTED_AT, typeof sessionAt === 'number' && Number.isFinite(sessionAt) ? sessionAt : 0)
  const receipt = readBoundedJson(hookReceiptPath(sessionDir, id))
  const activity = readBoundedJson(path.join(sessionDir, 'hook-activity.json'))
  if ((receipt?.sessionId === id && typeof receipt.at === 'number' && receipt.at >= sessionStartedAt && receipt.at <= now) ||
      (activity?.session_id === id && activity.event === 'PreToolUse' && typeof activity.at === 'number' && activity.at >= sessionStartedAt && activity.at <= now)) health.observed = true
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
