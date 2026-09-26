import net from 'node:net'
import { execFileSync } from 'node:child_process'
import type { WakeEvent } from './wake.js'
import { DEFAULT_CLAUDE_CHANNEL } from './config.js'
import { sendChannelNotification } from './channel.js'
import { dropSatisfiedBaseNotice } from './base-notice.js'
import type { Session } from './session.js'

type Notification = { method: 'notifications/claude/channel'; params: { content: string; meta: Record<string, string> } }
type WakeEnv = NodeJS.ProcessEnv
type Mode = 'auto' | 'socket' | 'channels' | 'off'

/** Wake immediately, then gather events during this window into one follow-up. */
const SOCKET_WAKE_WINDOW_MS = 5_000
const SOCKET_POST_TIMEOUT_MS = 1_500

let parentArgsCache: string | undefined
function claudeParentArgs(): string {
  if (parentArgsCache !== undefined) return parentArgsCache
  try { parentArgsCache = execFileSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } }).trim() }
  catch { parentArgsCache = '' }
  return parentArgsCache
}

function mode(env: WakeEnv): Mode {
  const value = env.ROOM_WAKE
  return value === 'socket' || value === 'channels' || value === 'off' ? value : 'auto'
}

function channelAdmitted(env: WakeEnv, parentArgs: string, channel: string | undefined): boolean {
  const entry = channel ?? env.ROOM_CLAUDE_CHANNEL ?? DEFAULT_CLAUDE_CHANNEL
  if (!entry) return false
  const admitted = [...parentArgs.matchAll(/(?:^|\s)--(?:dangerously-load-development-channels|channels)(?:=|\s)(\S+)/g)]
  return admitted.some(m => m[1].split(',').includes(entry))
}

export interface WakeAvailability {
  host: string
  env?: WakeEnv
  parentArgs?: string
  channel?: string
}

/** Claude Code exports the socket only after binding its inbox (v2.1.224+); env-vars.md has no version variable. */
export function claudeWakeAvailable(o: WakeAvailability): boolean {
  if (o.host !== 'claude') return false
  const env = o.env ?? process.env
  const selected = mode(env)
  if (selected === 'off') return false
  const socket = !!env.CLAUDE_CODE_MESSAGING_SOCKET
  if (selected === 'socket') return socket
  if (selected === 'auto' && socket) return true
  const channel = channelAdmitted(env, o.parentArgs ?? claudeParentArgs(), o.channel)
  return selected === 'channels' ? channel : socket || channel
}

/** The inbox protocol is newline-delimited JSON. No acknowledgement exists, so a clean close means only that bytes were handed to the socket. */
function postSocketWake(socketPath: string, token: string | undefined, content: string, timeoutMs = SOCKET_POST_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let settled = false
    let flushed = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error); else resolve()
    }
    socket.setTimeout(timeoutMs, () => finish(new Error('Claude inbox socket timed out')))
    socket.once('error', finish)
    socket.once('close', () => { if (!settled) finish(flushed ? undefined : new Error('Claude inbox socket closed before write')) })
    socket.once('connect', () => {
      const lines = token ? [{ type: 'auth', token }, { type: 'user', message: { role: 'user', content } }]
        : [{ type: 'user', message: { role: 'user', content } }]
      socket.end(lines.map(line => JSON.stringify(line)).join('\n') + '\n', () => { flushed = true })
    })
  })
}

export interface SocketWakeOptions extends WakeAvailability {
  notify: (notification: Notification) => Promise<unknown>
  recipient?: Pick<Session, 'dir' | 'room' | 'me' | 'closed'>
  /** Checked immediately before sending, since room_wait may consume a queued event. */
  isUnread?: (wake: WakeEvent) => boolean
  /** A pending room_wait will deliver this event itself. */
  isPendingWait?: (wake: WakeEvent) => boolean
  windowMs?: number
  post?: typeof postSocketWake
  log?: (line: string) => void
}

/** One router per joined session; at most one immediate and one follow-up post per window. */
export class SocketWakeRouter {
  private pending: WakeEvent[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private sequence = 0
  private lastSentAt: number | undefined
  private loggedError = false
  private loggedFlushError = false
  private closed = false
  constructor(private o: SocketWakeOptions) {}

  push(wake: WakeEvent | null): void {
    if (!wake || this.closed || this.o.host !== 'claude') return
    if (this.o.isPendingWait?.(wake)) return
    const env = this.o.env ?? process.env
    const selected = mode(env)
    if (selected === 'off') return
    if (selected === 'channels') { if (this.unread(wake)) void this.channel(wake); return }
    if (!env.CLAUDE_CODE_MESSAGING_SOCKET) {
      if (selected === 'auto' && this.channelAdmitted() && this.unread(wake)) void this.channel(wake)
      return
    }
    this.pending.push(wake)
    if (this.timer) return
    const windowMs = this.o.windowMs ?? SOCKET_WAKE_WINDOW_MS
    const elapsed = this.lastSentAt === undefined ? windowMs : Date.now() - this.lastSentAt
    this.timer = setTimeout(() => { this.timer = undefined; this.flushSafely() }, elapsed < windowMs ? windowMs - elapsed : windowMs)
    if (elapsed >= windowMs) this.flushSafely()
  }

  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.pending = [] }

  private async channel(wake: WakeEvent): Promise<void> {
    if (this.closed || this.o.recipient?.closed || this.o.channel === '') return
    if (wake.meta.type === 'base' && await this.satisfied(wake)) return
    if (this.closed || this.o.recipient?.closed || !this.unread(wake) || this.o.isPendingWait?.(wake)) return
    await sendChannelNotification(wake, this.o.notify)
  }

  private async satisfied(wake: WakeEvent): Promise<boolean> {
    const s = this.o.recipient
    const m = s?.room.messages().find(m => m.id === wake.meta.msg_id)
    return !!s && !!m && dropSatisfiedBaseNotice(s, m)
  }

  private channelAdmitted(): boolean {
    const env = this.o.env ?? process.env
    return channelAdmitted(env, this.o.parentArgs ?? claudeParentArgs(), this.o.channel)
  }

  private unread(wake: WakeEvent): boolean { return this.o.isUnread?.(wake) ?? true }

  private flushSafely(): void {
    void this.flush().catch(error => {
      if (this.loggedFlushError) return
      this.loggedFlushError = true
      this.o.log?.(`Claude wake fallback failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async flush(): Promise<void> {
    const items: WakeEvent[] = []
    for (const w of this.pending.splice(0)) {
      if (this.closed || this.o.recipient?.closed) return
      if (!this.o.isPendingWait?.(w) && this.unread(w) && (w.meta.type !== 'base' || !await this.satisfied(w))) items.push(w)
    }
    if (!items.length || this.closed || this.o.recipient?.closed) return
    this.lastSentAt = Date.now()
    const count = items.length
    const shown = count > 5 ? 4 : 5
    const phrases = items.slice(0, shown).map(w => `${(w.meta.from ?? 'someone').replace(/\s+/g, ' ').trim().slice(0, 40) || 'someone'} ${kindPhrase(w.meta.type)}`)
    if (count > shown) phrases.push(`${count - shown} more`)
    // Sequence makes consecutive bursts distinct even when sender and kind are unchanged.
    const collectHint = items.some(w => w.meta.type === 'done') ? ' (room_collect brings in finished workers)' : ''
    const content = `[room] ${count} ${count === 1 ? 'thing needs' : 'things need'} you: ${phrases.join('; ')}. Use the room_state tool to read them${collectHint}. (#${++this.sequence})`
    const env = this.o.env ?? process.env
    try { await (this.o.post ?? postSocketWake)(env.CLAUDE_CODE_MESSAGING_SOCKET!, env.CLAUDE_CODE_MESSAGING_TOKEN, content) }
    catch (error) {
      if (!this.loggedError) { this.loggedError = true; this.o.log?.(`Claude socket wake failed: ${error instanceof Error ? error.message : String(error)}`) }
      if (mode(env) === 'auto' && this.channelAdmitted()) await this.channel({ content, meta: { type: 'room_wake', count: String(count) } })
    }
  }
}

function kindPhrase(type: string | undefined): string {
  switch (type) {
    case 'question': return 'asked a question'
    case 'answer': return 'answered'
    case 'changed': return 'reported a change'
    case 'note': return 'sent a note'
    case 'done': return 'finished'
    default: return 'has an update'
  }
}
