/**
 * Bridge between the room and the Codex plugin hooks:
 *  - keeps <clone>/.git/room-state.json current (unread inbox for me, others' claims) so the
 *    PreToolUse hook can show them before an edit without a room tool call;
 *  - wakes the thread recorded by the SessionStart hook (<clone>/.git/room-session.json)
 *    when an interrupt or a question addressed to me arrives: `codex queue` for Codex, with
 *    retries; Claude Code sessions are reached by the MCP channel notification instead.
 *    A message is only marked delivered once the wake succeeded; with no fresh session
 *    known it stays pending and is retried when a session file appears.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { BASE_CATCH_UP, formatMsg, formatPlans, shouldWakeOnMsg, type Msg, isAgentic } from '@room/shared'
import { resolveSessionHost } from './config.js'
import type { Session } from './session.js'
import { claudeWakeUnavailable } from './prompt.js'
import { hasCompany, describeCompany, type CompanyState } from './company.js'

function gitStatePath(root: string, name: string): string {
  const dotgit = path.join(root, '.git')
  try {
    if (fs.statSync(dotgit).isFile()) {
      const m = fs.readFileSync(dotgit, 'utf8').match(/gitdir:\s*(.+)/)
      if (m) return path.join(path.resolve(root, m[1].trim()), name)
    }
  } catch { /* fall through */ }
  return path.join(dotgit, name)
}

type PendingHookField = 'pendingDisclosure' | 'pendingNotice'
type HookState = Record<string, unknown> & { sessionId?: string; at?: number; pendingDisclosure?: string; deliveredDisclosure?: string; pendingNotice?: string; deliveredNotice?: string }

function readHookState(dir: string): HookState {
  try { return JSON.parse(fs.readFileSync(gitStatePath(dir, 'room-state.json'), 'utf8')) as HookState } catch { return {} }
}

function hookSessionId(dir: string): string | undefined {
  try { const id = JSON.parse(fs.readFileSync(gitStatePath(dir, 'room-session.json'), 'utf8')).session_id; return typeof id === 'string' && id ? id : undefined } catch { return undefined }
}

/** Queue context for either hook path. The hook moves the field to its delivered acknowledgement. */
export function writePendingHookContext(dir: string, field: PendingHookField, text: string, room?: string, now = Date.now()): void {
  const file = gitStatePath(dir, 'room-state.json')
  const previous = readHookState(dir)
  const delivered = field === 'pendingDisclosure' ? 'deliveredDisclosure' : 'deliveredNotice'
  const sessionId = hookSessionId(dir)
  const sameBoundary = !!sessionId && previous.sessionId === sessionId
  const state: HookState = { ...(sameBoundary ? previous : { company: false, others: [], unread: [], claims: [], ownClaims: [], near: [] }), ...(room ? { room } : {}), ...(sessionId ? { sessionId } : {}), at: now, [field]: text }
  delete state[delivered]
  try { fs.writeFileSync(file, JSON.stringify(state, null, 1) + '\n') } catch { /* hooks are optional */ }
}

/** Arbitrate the hook and tool delivery paths for the same sharing sentence. */
export function consumeHookDisclosure(s: Session, sentence: string): 'hook' | 'tool' | 'pending' | undefined {
  return consumeHookContext(s.dir, 'pendingDisclosure', sentence)
}

/** The same once-only arbitration for startup connection notices, before a Session exists. */
export function consumeHookNotice(dir: string, sentence: string): 'hook' | 'tool' | 'pending' | undefined {
  return consumeHookContext(dir, 'pendingNotice', sentence)
}

function consumeHookContext(dir: string, field: PendingHookField, sentence: string): 'hook' | 'tool' | 'pending' | undefined {
  const file = gitStatePath(dir, 'room-state.json')
  const delivered = field === 'pendingDisclosure' ? 'deliveredDisclosure' : 'deliveredNotice'
  const held = acquireNoticeLock(file)
  if (!held) return readHookState(dir)[delivered] === sentence ? 'hook' : 'pending'
  try {
    const state = readHookState(dir)
    if (state[delivered] === sentence) return 'hook'
    if (state[field] !== sentence) return undefined
    state[delivered] = sentence
    delete state[field]
    fs.writeFileSync(file, JSON.stringify(state, null, 1) + '\n')
    return 'tool'
  } catch {
    return undefined
  } finally {
    held()
  }
}

/** Same tiny process-owner protocol as the dependency-free hook in common.mjs. */
function acquireNoticeLock(file: string): (() => void) | undefined {
  const lock = file + '.notice-lock'
  const owner = { pid: process.pid, startedAt: Date.now() - process.uptime() * 1000, token: randomUUID() }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600)
      try { fs.writeFileSync(fd, JSON.stringify(owner)) } finally { fs.closeSync(fd) }
      return () => {
        try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).token === owner.token) fs.rmSync(lock, { force: true }) } catch { /* best effort */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
      try {
        const stat = fs.statSync(lock)
        const prior = JSON.parse(fs.readFileSync(lock, 'utf8')) as Partial<typeof owner>
        let alive = typeof prior.pid === 'number' && Number.isInteger(prior.pid)
        if (alive) { try { process.kill(prior.pid!, 0) } catch (e) { alive = (e as NodeJS.ErrnoException).code === 'EPERM' } }
        if (prior.pid === process.pid && Math.abs((prior.startedAt ?? 0) - owner.startedAt) > 5000) alive = false
        if (alive && Date.now() - stat.mtimeMs < 10_000) return undefined
        if (fs.readFileSync(lock, 'utf8') === JSON.stringify(prior)) fs.rmSync(lock, { force: true })
      } catch { /* another process may have replaced it */ }
      try { if (Date.now() - fs.statSync(lock).mtimeMs >= 10_000) fs.rmSync(lock, { force: true }) } catch { /* best effort */ }
    }
  }
  return undefined
}

/** Pin the host session before another session can replace the clone's hint. */
export function createWriteIntentReader(dir: string, now: () => number = Date.now): (p: string) => boolean | undefined {
  const sessionId = () => {
    try { const id = JSON.parse(fs.readFileSync(gitStatePath(dir, 'room-session.json'), 'utf8')).session_id; return typeof id === 'string' && id ? id : undefined } catch { return undefined }
  }
  let id = sessionId()
  return p => {
    id ??= sessionId()
    if (!id) return undefined
    try {
      const file = gitStatePath(dir, `room-write-intents-${createHash('sha256').update(id).digest('hex')}.json`)
      const evidence = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (evidence.session_id !== id || !Array.isArray(evidence.writes)) return undefined
      const at = now(), target = path.resolve(dir, p)
      return evidence.writes.some((w: { path?: unknown; at?: unknown }) => typeof w.path === 'string' &&
        typeof w.at === 'number' && Number.isFinite(w.at) && w.at <= at && at - w.at < 120_000 && path.resolve(w.path) === target)
    } catch { return undefined }
  }
}

/** Reconcile the hook's durable receipt before another delivery path reads its inbox. */
export function syncHookSeen(s: Session): void {
  try {
    const value = JSON.parse(fs.readFileSync(gitStatePath(s.dir, 'room-hook-seen.json'), 'utf8'))
    const ids = Array.isArray(value) ? value : value?.seen
    if (!Array.isArray(ids)) return
    // New hooks record whose inbox was displayed. Legacy receipts have no such
    // proof: accept only messages explicitly addressed to this participant.
    const known = new Set(s.room.messages().filter(m => typeof value?.shown?.[m.id] === 'string'
      ? value.shown[m.id] === s.me.name : m.to === s.me.name).map(m => m.id))
    s.room.markSeen(s.me.name, ids.filter((id): id is string => typeof id === 'string' && known.has(id) && !s.room.seen(s.me.name).has(id)))
  } catch { /* Hooks are optional, and files may be in the middle of a write. */ }
}

export interface HooksBridgeOptions {
  /** Which messages count as unread for the state file (the tools' inbox rule). */
  forMe: (m: Msg) => boolean
  /** Ids already shown through a tool reply. */
  isSeen: (id: string) => boolean
  /** The authoritative company state, including workers held by the registry. */
  company?: () => CompanyState
  log?: (line: string) => void
  /** Injectable for tests. */
  queue?: (threadId: string, text: string) => Promise<void>
  now?: () => number
  /** Backoff between queue attempts (ms); default 1s, 3s, 8s. */
  retryDelaysMs?: number[]
  /** How often to look again for a session file while wakes are pending; default 5s. */
  pendingPollMs?: number
  /** Keep <clone>/.git/room-state.json current (default true). A second bridge on the same clone (the workers room) only wakes. */
  writeState?: boolean
  /** Give up on a pending wake after this long; default 10 min. */
  pendingMaxMs?: number
}

/** Written by the plugins' SessionStart hooks. Host hints can be stale; process configuration determines wake routing. */
interface SessionFile { session_id?: string; at?: number; cwd?: string; host?: 'codex' | 'claude' }

const SESSION_FRESH_MS = 10 * 60 * 1000

export class HooksBridge {
  private timer: NodeJS.Timeout | null = null
  private woken = new Set<string>()
  /** Wakes that found no fresh session yet, with when they first arrived. */
  private pending = new Map<string, { msg: Msg; since: number }>()
  private pendingTimer: NodeJS.Timeout | null = null
  private startedAt = Date.now()
  private unobserve: (() => void)[] = []
  private delivering = new Set<string>()
  private generation = 0
  private stopped = false
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
      // Receipts must remove delivered ids from the hook snapshot immediately,
      // before the next tool's hook can replay a stale inbox.
      const receipts = this.s.room.seen(this.s.me.name)
      const onSeen = () => this.write()
      receipts.observe(onSeen)
      this.unobserve.push(() => receipts.unobserve(onSeen))
    }
    // A local transaction is usually my own post, which never wakes me. It can also be a message this
    // process wrote on someone else's behalf (a worker's synthetic done on exit): that one must.
    const onBus = (ev: { changes: { delta: { insert?: unknown }[] }; transaction: { local: boolean } }) => {
      for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) {
        if (ev.transaction.local && m.from === this.s.me.name) continue
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
    if (this.o.writeState !== false) { try { fs.rmSync(this.stateFile(), { force: true }) } catch { /* ignore */ } }
  }

  stateFile(): string { return gitStatePath(this.s.dir, 'room-state.json') }
  sessionFile(): string { return gitStatePath(this.s.dir, 'room-session.json') }

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

  write(): void {
    if (this.stopped) return
    syncHookSeen(this.s)
    const me = this.s.me.name
    const unread = this.s.room.messages().filter(m => !this.isSeen(m.id) && this.o.forMe(m)).map(m => ({ id: m.id, priority: m.priority, line: formatMsg(m) }))
    const openClaims = this.s.room.openClaims()
    const ownClaims = openClaims.filter(c => c.by === me && isAgentic(c.byKind)).map(c => ({ path: c.path, from: c.from, to: c.to }))
    const claims = openClaims.filter(c => !(c.by === me && isAgentic(c.byKind))).map(c => ({ id: c.id, path: c.path, from: c.from, to: c.to, by: c.by, intent: c.intent, ...(c.plans?.length ? { plans: formatPlans(c.plans) } : {}) }))
    const near = [
      ...this.s.room.allScopes().filter(sc => sc.by !== me).flatMap(sc => sc.paths.map(path => ({ by: sc.by, path, reason: 'scope' }))),
      ...claims.map(c => ({ by: c.by, path: c.path, reason: 'claim' })),
      ...[...new Set([...this.s.room.overlays.keys(), ...this.s.room.deleted.keys()])].filter(by => by !== me)
        .flatMap(by => this.s.room.changedPaths(by).map(path => ({ by, path, reason: 'changed' }))),
    ]
    const company = this.o.company?.() ?? hasCompany(this.s, [], this.o.now?.() ?? Date.now())
    const sessionId = this.freshSession()?.id
    const held = acquireNoticeLock(this.stateFile())
    if (!held) { this.scheduleWrite(); return }
    try {
      const previous = readHookState(this.s.dir)
      const at = this.now()
      const carry = (!previous.sessionId || !sessionId || previous.sessionId === sessionId) &&
        typeof previous.at === 'number' && previous.at <= at && at - previous.at < 60_000
        ? Object.fromEntries(['pendingDisclosure', 'deliveredDisclosure', 'pendingNotice', 'deliveredNotice']
            .filter(key => typeof previous[key] === 'string').map(key => [key, previous[key]])) : {}
      fs.writeFileSync(this.stateFile(), JSON.stringify({ name: me, room: this.s.roomName, ...(sessionId ? { sessionId } : {}), at, company: company.company, others: company.others, companyLine: describeCompany(this.s, company), unread, claims, ownClaims, near, ...carry }, null, 1) + '\n')
    } catch (e) {
      this.o.log?.(`hooks: could not write state: ${e instanceof Error ? e.message : e}`)
    } finally {
      held()
    }
  }

  /** Interrupts, questions addressed to me, and a base move while I have uncommitted work wake the idle Codex thread, once per message. */
  async maybeWake(m: Msg): Promise<void> {
    if (this.stopped) return
    const generation = this.generation
    syncHookSeen(this.s)
    if (this.isSeen(m.id)) return
    if (!this.o.forMe(m)) return
    const myClaims = this.s.room.openClaims().filter(c => c.by === this.s.me.name)
    const ownWorkers = new Set(Array.from(this.s.room.workers.values()).filter(w => w.lead === this.s.me.name).map(w => w.name))
    const wake = shouldWakeOnMsg(this.s.me, m, myClaims, this.s.room.changedPaths(this.s.me.name).length > 0, ownWorkers).wake
    if (!wake || this.woken.has(m.id) || this.pending.has(m.id) || this.delivering.has(m.id)) return
    const session = this.freshSession()
    if (!session) {
      // Nothing to wake yet (hook not run, or a stale file from an earlier thread). Keep the
      // message and try again when a session file shows up.
      if (this.stopped || generation !== this.generation) return
      this.pending.set(m.id, { msg: m, since: this.now() })
      this.o.log?.(`cannot wake yet: no fresh session id for this clone; will retry for ${m.type} ${m.id}`)
      this.schedulePending()
      return
    }
    if (this.stopped || generation !== this.generation) return
    this.delivering.add(m.id)
    try { await this.deliver(m, session, generation) } finally { this.delivering.delete(m.id) }
  }

  /** The thread recorded by the SessionStart hook, if it is recent and for this clone; else a rollout scan. */
  freshSession(): { id: string; host: 'codex' | 'claude' } | undefined {
    const host = resolveSessionHost(this.s.dir)
    let file: SessionFile | undefined
    try { file = JSON.parse(fs.readFileSync(this.sessionFile(), 'utf8')) } catch { /* fall back below */ }
    if (file?.session_id) {
      const fresh = typeof file.at !== 'number' || file.at >= this.startedAt - SESSION_FRESH_MS
      const here = !file.cwd || sameDir(file.cwd, this.s.dir)
      if (fresh && here) return { id: file.session_id, host: host === 'claude' ? 'claude' : 'codex' }
      this.o.log?.(`ignoring ${fresh ? 'foreign' : 'stale'} session file ${this.sessionFile()}`)
    }
    if (host === 'claude') return undefined
    const id = findThreadForDir(this.s.dir, this.startedAt)
    return id ? { id, host: 'codex' } : undefined
  }

  private async deliver(m: Msg, session: { id: string; host: 'codex' | 'claude' }, generation: number): Promise<void> {
    const active = () => !this.stopped && generation === this.generation
    if (!active()) return
    if (session.host === 'claude') {
      // The MCP channel notification (index.ts attachChannel) reaches a live Claude Code session.
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
      syncHookSeen(this.s)
      if (!active()) return
      if (this.isSeen(m.id)) return
      try {
        await (this.o.queue ?? defaultQueue)(session.id, text)
        if (!active()) return
        this.woken.add(m.id)
        this.s.room.markSeen(this.s.me.name, [m.id])
        if (this.o.writeState !== false) this.write()
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

  /** Re-check for a session file; deliver what we can, drop what is too old. */
  async retryPending(): Promise<void> {
    if (this.stopped) return
    const generation = this.generation
    const maxAge = this.o.pendingMaxMs ?? 10 * 60 * 1000
    const session = this.freshSession()
    for (const [id, p] of Array.from(this.pending)) {
      if (this.stopped || generation !== this.generation) return
      syncHookSeen(this.s)
      if (this.isSeen(id)) { this.pending.delete(id); continue }
      if (this.now() - p.since > maxAge) { this.pending.delete(id); this.o.log?.(`gave up waking for ${p.msg.type} ${id}: no session for ${Math.round(maxAge / 60000)} min`); continue }
      if (!session) continue
      this.pending.delete(id)
      await this.maybeWake(p.msg)
    }
    this.schedulePending()
  }

  private now(): number { return this.o.now?.() ?? Date.now() }
  private isSeen(id: string): boolean { return this.o.isSeen(id) || this.s.room.seen(this.s.me.name).has(id) }
}

function sameDir(a: string, b: string): boolean {
  const norm = (d: string) => { const r = path.resolve(d.replace(/^file:\/\//, '')); try { return fs.realpathSync.native(r) } catch { return r } }
  return norm(a) === norm(b)
}

const sleep = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); t.unref?.() })

function defaultQueue(threadId: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('codex', ['queue', '--thread', threadId, '--message', text], { timeout: 10_000 }, (err, _out, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve())
  })
}

/** Find a Codex thread in rollout storage when the SessionStart hook ID is unavailable. */
const rolloutCache = new Map<string, { at: number; id?: string }>()
export function findThreadForDir(dir: string, since: number): string | undefined {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  const key = `${root}\0${path.resolve(dir)}\0${since}`
  const cached = rolloutCache.get(key)
  if (cached && Date.now() - cached.at < 5000) return cached.id
  const want = [path.resolve(dir)]
  try { want.push(fs.realpathSync.native(path.resolve(dir))) } catch { /* clone may have gone */ }
  let best: { id: string; mtime: number } | undefined
  let remaining = 500
  const deadline = Date.now() + 50
  const walk = (d: string, depth: number) => {
    if (remaining <= 0 || Date.now() >= deadline) return
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (--remaining < 0 || Date.now() >= deadline) return
      const p = path.join(d, e.name)
      if (e.isDirectory() && depth < 3) { walk(p, depth + 1); continue }
      const m = e.name.match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)
      if (!m) continue
      let st: fs.Stats
      try { st = fs.statSync(p) } catch { continue }
      if (st.mtimeMs < since - 5 * 60 * 1000 || (best && st.mtimeMs <= best.mtime)) continue
      let head = ''
      let fd: number | undefined
      try { fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); head = buf.toString('utf8', 0, n) } catch { continue }
      finally { if (fd !== undefined) try { fs.closeSync(fd) } catch { /* best effort */ } }
      const cwd = head.match(/"cwd":"([^"]+)"/)?.[1]?.replace(/^file:\/\//, '')
      if (cwd && want.includes(path.resolve(cwd))) best = { id: m[1], mtime: st.mtimeMs }
    }
  }
  walk(root, 0)
  rolloutCache.set(key, { at: Date.now(), id: best?.id })
  if (rolloutCache.size > 100) rolloutCache.delete(rolloutCache.keys().next().value!)
  return best?.id
}

type HookHealth = { since: number; calls: number; noted: boolean; observed: boolean; joinNoted: boolean; scopeNoted: boolean }
const hookHealth = new WeakMap<Session, HookHealth>()

function newHookHealth(now: number): HookHealth {
  return { since: now, calls: 0, noted: false, observed: false, joinNoted: false, scopeNoted: false }
}

function missingPreEditGuidance(s: Session): string {
  const host = resolveSessionHost(s.dir)
  if (host === 'claude') return "Room has not seen its before-edit hook run in this session although its tools are in use: the plugin's hooks may not be running; reinstall or re-enable the plugin."
  if (host === 'codex') return 'Pre-edit coordination is not confirmed yet; if the Room hooks were never approved, approve them once in an interactive Codex session.'
  return 'Pre-edit coordination is not confirmed yet; enable the Room hooks for this agent host.'
}

/** Diagnose Claude only after this host session has actually changed its own tree. */
export function hookHealthNote(s: Session, expected: boolean, now = Date.now(), tool?: string, team = !s.local): string {
  let health = hookHealth.get(s)
  if (!health) { health = newHookHealth(now); hookHealth.set(s, health) }
  let sessionStartedAt = health.since
  try {
    const session = JSON.parse(fs.readFileSync(gitStatePath(s.dir, 'room-session.json'), 'utf8'))
    if (typeof session.at === 'number' && Number.isFinite(session.at) && session.at <= now) sessionStartedAt = session.at
  } catch { /* use the first room-tool call as the session boundary */ }
  try {
    const activity = JSON.parse(fs.readFileSync(gitStatePath(s.dir, 'room-hook-activity.json'), 'utf8'))
    const session = JSON.parse(fs.readFileSync(gitStatePath(s.dir, 'room-session.json'), 'utf8'))
    if (activity.event === 'PreToolUse' && typeof activity.at === 'number' && activity.at <= now &&
        (resolveSessionHost(s.dir) !== 'claude' || activity.at >= sessionStartedAt) &&
        activity.session_id === session.session_id) health.observed = true
  } catch { /* no receipt yet */ }
  if (!expected || health.observed || health.noted) return ''
  // Only Codex can skip an unapproved hook silently, so only Codex is told up front. Elsewhere the hook is silent
  // while the agent is alone, which an agent cannot tell from a missing hook: wait for the evidence below instead.
  const upFront = team && resolveSessionHost(s.dir) === 'codex'
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
  if (resolveSessionHost(s.dir) === 'claude' &&
      !(s.room.changedPaths(s.me.name).length && (s.room.overlayAt.get(s.me.name) ?? -Infinity) >= sessionStartedAt)) return ''
  health.noted = true
  return missingPreEditGuidance(s)
}
