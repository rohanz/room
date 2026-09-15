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
import { formatMsg, formatPlans, shouldWakeOnMsg, type Msg, isAgentic } from '@room/shared'
import type { Session } from './session.js'

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

export interface HooksBridgeOptions {
  /** Which messages count as unread for the state file (the tools' inbox rule). */
  forMe: (m: Msg) => boolean
  /** Ids already shown through a tool reply. */
  isSeen: (id: string) => boolean
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

/** Written by the plugins' SessionStart hooks. `host` says which CLI owns the thread (missing = codex). */
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
  constructor(private s: Session, private o: HooksBridgeOptions) {}

  start(): void {
    const kick = () => this.scheduleWrite()
    this.s.room.bus.observe(kick); this.s.room.claims.observe(kick)
    this.unobserve.push(() => { this.s.room.bus.unobserve(kick); this.s.room.claims.unobserve(kick) })
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
    if (this.o.writeState === false) return
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.write() }, 150)
    this.timer.unref?.()
  }

  write(): void {
    const me = this.s.me.name
    const unread = this.s.room.messages().filter(m => !this.o.isSeen(m.id) && this.o.forMe(m)).map(m => ({ id: m.id, priority: m.priority, line: formatMsg(m) }))
    const claims = this.s.room.openClaims().filter(c => !(c.by === me && isAgentic(c.byKind))).map(c => ({ id: c.id, path: c.path, from: c.from, to: c.to, by: c.by, intent: c.intent, ...(c.plans?.length ? { plans: formatPlans(c.plans) } : {}) }))
    try { fs.writeFileSync(this.stateFile(), JSON.stringify({ name: me, room: this.s.roomName, at: this.o.now?.() ?? Date.now(), unread, claims }, null, 1) + '\n') }
    catch (e) { this.o.log?.(`hooks: could not write state: ${e instanceof Error ? e.message : e}`) }
  }

  /** Interrupts, questions addressed to me, and a base move while I have uncommitted work wake the idle Codex thread, once per message. */
  async maybeWake(m: Msg): Promise<void> {
    if (!this.o.forMe(m)) return
    const baseMoved = m.type === 'base' && m.from !== this.s.me.name && this.s.room.changedPaths(this.s.me.name).length > 0
    const myClaims = this.s.room.openClaims().filter(c => c.by === this.s.me.name)
    const wake = shouldWakeOnMsg(this.s.me, m, myClaims).wake || baseMoved
    if (!wake || this.woken.has(m.id) || this.pending.has(m.id)) return
    const session = this.freshSession()
    if (!session) {
      // Nothing to wake yet (hook not run, or a stale file from an earlier thread). Keep the
      // message and try again when a session file shows up.
      this.pending.set(m.id, { msg: m, since: this.now() })
      this.o.log?.(`cannot wake yet: no fresh session id for this clone; will retry for ${m.type} ${m.id}`)
      this.schedulePending()
      return
    }
    await this.deliver(m, session)
  }

  /** The thread recorded by the SessionStart hook, if it is recent and for this clone; else a rollout scan. */
  freshSession(): { id: string; host: 'codex' | 'claude' } | undefined {
    let file: SessionFile | undefined
    try { file = JSON.parse(fs.readFileSync(this.sessionFile(), 'utf8')) } catch { /* fall back below */ }
    if (file?.session_id) {
      const fresh = typeof file.at !== 'number' || file.at >= this.startedAt - SESSION_FRESH_MS
      const here = !file.cwd || sameDir(file.cwd, this.s.dir)
      if (fresh && here) return { id: file.session_id, host: file.host === 'claude' ? 'claude' : 'codex' }
      this.o.log?.(`ignoring ${fresh ? 'foreign' : 'stale'} session file ${this.sessionFile()}`)
    }
    const id = findThreadForDir(this.s.dir, this.startedAt)
    return id ? { id, host: 'codex' } : undefined
  }

  private async deliver(m: Msg, session: { id: string; host: 'codex' | 'claude' }): Promise<void> {
    if (session.host === 'claude') {
      // The MCP channel notification (index.ts attachChannel) reaches a live Claude Code session.
      this.woken.add(m.id)
      this.o.log?.(`claude host: ${m.type} ${m.id} delivered via channel`)
      return
    }
    const text = m.type === 'base'
      ? `[room] ${formatMsg(m)}\nYou have uncommitted work. Run git pull --ff-only, re-run room_preview_merge with the test command against anyone who changed the same files, then report and offer to commit and push.`
      : `[room] ${formatMsg(m)}\nCall room_state, then react per the room-etiquette skill.`
    const delays = this.o.retryDelaysMs ?? [1000, 3000, 8000]
    for (let attempt = 0; ; attempt++) {
      try {
        await (this.o.queue ?? defaultQueue)(session.id, text)
        this.woken.add(m.id)
        this.o.log?.(`woke session ${session.id.slice(0, 8)} for ${m.type} ${m.id}${attempt ? ` (attempt ${attempt + 1})` : ''}`)
        return
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        if (attempt >= delays.length) { this.o.log?.(`could not wake session ${session.id.slice(0, 8)} for ${m.type} ${m.id} after ${attempt + 1} attempts: ${why}`); return }
        this.o.log?.(`wake attempt ${attempt + 1} failed (${why}); retrying in ${delays[attempt]}ms`)
        await sleep(delays[attempt])
      }
    }
  }

  private schedulePending(): void {
    if (this.pendingTimer || !this.pending.size) return
    this.pendingTimer = setTimeout(() => { this.pendingTimer = null; void this.retryPending() }, this.o.pendingPollMs ?? 5000)
    this.pendingTimer.unref?.()
  }

  /** Re-check for a session file; deliver what we can, drop what is too old. */
  async retryPending(): Promise<void> {
    const maxAge = this.o.pendingMaxMs ?? 10 * 60 * 1000
    const session = this.freshSession()
    for (const [id, p] of Array.from(this.pending)) {
      if (this.now() - p.since > maxAge) { this.pending.delete(id); this.o.log?.(`gave up waking for ${p.msg.type} ${id}: no session for ${Math.round(maxAge / 60000)} min`); continue }
      if (!session) continue
      this.pending.delete(id)
      await this.deliver(p.msg, session)
    }
    this.schedulePending()
  }

  private now(): number { return this.o.now?.() ?? Date.now() }
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

/**
 * Codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl per thread; the first
 * line carries the cwd. The newest rollout for this clone started around when this MCP
 * server did is our thread.
 */
export function findThreadForDir(dir: string, since: number): string | undefined {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  const want = [path.resolve(dir), fs.realpathSync.native(path.resolve(dir))]
  let best: { id: string; mtime: number } | undefined
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory() && depth < 3) { walk(p, depth + 1); continue }
      const m = e.name.match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)
      if (!m) continue
      let st: fs.Stats
      try { st = fs.statSync(p) } catch { continue }
      if (st.mtimeMs < since - 5 * 60 * 1000 || (best && st.mtimeMs <= best.mtime)) continue
      let head = ''
      try { const fd = fs.openSync(p, 'r'); const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); fs.closeSync(fd); head = buf.toString('utf8', 0, n) } catch { continue }
      const cwd = head.match(/"cwd":"([^"]+)"/)?.[1]?.replace(/^file:\/\//, '')
      if (cwd && want.includes(path.resolve(cwd))) best = { id: m[1], mtime: st.mtimeMs }
    }
  }
  walk(root, 0)
  return best?.id
}
