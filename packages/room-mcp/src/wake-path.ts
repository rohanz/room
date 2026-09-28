/**
 * How a content-free wake reaches the bound host session (ledger "Wake (MF8)"). No path acknowledges that
 * the model read anything, so a sent wake is never a receipt.
 *  - Codex: `codex queue --thread <id> --message <text>` queues the text for the thread's next turn.
 *  - Claude Code 2.1.224+ (2.1.234+ on native Windows): the session's cross-session messaging inbox,
 *    exported as CLAUDE_CODE_MESSAGING_SOCKET and _TOKEN; an idle session starts a turn with the message.
 *  - Claude Code with the Room channel admitted (channels research preview, `--channels` or
 *    `--dangerously-load-development-channels`): a `notifications/claude/channel` notification.
 */
import net from 'node:net'
import { execFile, execFileSync } from 'node:child_process'
import { DEFAULT_CLAUDE_CHANNEL } from './config.js'
import { sendChannelNotification, type ChannelNotification } from './channel.js'

type WakeEnv = NodeJS.ProcessEnv
type Mode = 'auto' | 'socket' | 'channels' | 'off'

export interface WakeTarget { id: string; host: 'claude' | 'codex' }
export type WakeVia = 'queue' | 'socket' | 'channel'
/** Resolves with the path that took the wake, or undefined when this host has none; rejects when the path failed. */
export type SendWake = (target: WakeTarget, text: string) => Promise<WakeVia | undefined>

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

function codexQueue(threadId: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('codex', ['queue', '--thread', threadId, '--message', text], { timeout: 10_000 }, (err, _out, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve())
  })
}

export interface WakeSenderOptions {
  /** The MCP server's notification sender (the channel path). */
  notify: (notification: ChannelNotification) => Promise<unknown>
  channel?: string
  env?: WakeEnv
  parentArgs?: string
  post?: typeof postSocketWake
  queue?: (threadId: string, text: string) => Promise<void>
}

/** Codex: the queue. Claude: the socket, then the channel if the socket fails and the channel is admitted. */
export function createWakeSender(o: WakeSenderOptions): SendWake {
  return async (target, text) => {
    if (target.host === 'codex') { await (o.queue ?? codexQueue)(target.id, text); return 'queue' }
    const env = o.env ?? process.env
    const selected = mode(env)
    if (selected === 'off') return undefined
    const admitted = () => channelAdmitted(env, o.parentArgs ?? claudeParentArgs(), o.channel)
    const channel = async (): Promise<WakeVia> => { await sendChannelNotification(text, o.notify); return 'channel' }
    if (selected === 'channels') return o.channel === '' ? undefined : channel()
    const socket = env.CLAUDE_CODE_MESSAGING_SOCKET
    if (!socket) return selected === 'auto' && admitted() ? channel() : undefined
    try { await (o.post ?? postSocketWake)(socket, env.CLAUDE_CODE_MESSAGING_TOKEN, text); return 'socket' }
    catch (error) {
      if (selected === 'auto' && admitted()) return channel()
      throw error
    }
  }
}
