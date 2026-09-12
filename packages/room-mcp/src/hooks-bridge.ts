/**
 * Bridge between the room and the Codex plugin hooks:
 *  - keeps <clone>/.git/room-state.json current (unread inbox for me, others' claims) so the
 *    PreToolUse hook can show them before an edit without a room tool call;
 *  - wakes the Codex thread recorded by the SessionStart hook (<clone>/.git/room-session.json)
 *    with `codex queue` when an interrupt or a question addressed to me arrives.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { formatMsg, formatPlans, type Msg } from '@room/shared'
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
}

export class HooksBridge {
  private timer: NodeJS.Timeout | null = null
  private woken = new Set<string>()
  private unobserve: (() => void)[] = []
  constructor(private s: Session, private o: HooksBridgeOptions) {}

  start(): void {
    const kick = () => this.scheduleWrite()
    this.s.room.bus.observe(kick); this.s.room.claims.observe(kick)
    this.unobserve.push(() => { this.s.room.bus.unobserve(kick); this.s.room.claims.unobserve(kick) })
    const onBus = (ev: { changes: { delta: { insert?: unknown }[] }; transaction: { local: boolean } }) => {
      if (ev.transaction.local) return
      for (const d of ev.changes.delta) for (const m of (d.insert ?? []) as Msg[]) void this.maybeWake(m)
    }
    this.s.room.bus.observe(onBus)
    this.unobserve.push(() => this.s.room.bus.unobserve(onBus))
    this.scheduleWrite()
  }

  stop(): void {
    for (const u of this.unobserve) u()
    this.unobserve = []
    if (this.timer) clearTimeout(this.timer)
    try { fs.rmSync(this.stateFile(), { force: true }) } catch { /* ignore */ }
  }

  stateFile(): string { return gitStatePath(this.s.dir, 'room-state.json') }
  sessionFile(): string { return gitStatePath(this.s.dir, 'room-session.json') }

  /** Debounced: many small doc updates become one file write. */
  scheduleWrite(): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.write() }, 150)
    this.timer.unref?.()
  }

  write(): void {
    const me = this.s.me.name
    const unread = this.s.room.messages().filter(m => !this.o.isSeen(m.id) && this.o.forMe(m)).map(m => ({ id: m.id, priority: m.priority, line: formatMsg(m) }))
    const claims = this.s.room.openClaims().filter(c => !(c.by === me && c.byKind === 'agent')).map(c => ({ id: c.id, path: c.path, from: c.from, to: c.to, by: c.by, intent: c.intent, ...(c.plans?.length ? { plans: formatPlans(c.plans) } : {}) }))
    try { fs.writeFileSync(this.stateFile(), JSON.stringify({ name: me, room: this.s.roomName, at: this.o.now?.() ?? Date.now(), unread, claims }, null, 1) + '\n') }
    catch (e) { this.o.log?.(`hooks: could not write state: ${e instanceof Error ? e.message : e}`) }
  }

  /** Interrupts and questions addressed to me wake the idle Codex thread, once per message. */
  async maybeWake(m: Msg): Promise<void> {
    if (!this.o.forMe(m)) return
    const wake = m.priority === 'interrupt' || (m.type === 'question' && m.to === this.s.me.name)
    if (!wake || this.woken.has(m.id)) return
    this.woken.add(m.id)
    let session: { session_id?: string } | undefined
    try { session = JSON.parse(fs.readFileSync(this.sessionFile(), 'utf8')) } catch { return }
    if (!session?.session_id) return
    const text = `[room] ${formatMsg(m)}\nCall room_state, then react per the room-etiquette skill.`
    try {
      await (this.o.queue ?? defaultQueue)(session.session_id, text)
      this.o.log?.(`woke session ${session.session_id.slice(0, 8)} for ${m.type} ${m.id}`)
    } catch (e) { this.o.log?.(`could not wake session: ${e instanceof Error ? e.message : e}`) }
  }
}

function defaultQueue(threadId: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('codex', ['queue', '--thread', threadId, '--message', text], { timeout: 10_000 }, (err, _out, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve())
  })
}
