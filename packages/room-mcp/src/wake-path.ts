/**
 * How a content-free wake reaches the bound host session (ledger "Wake (MF8)"). No path acknowledges that
 * the model read anything, so a sent wake is never a receipt.
 *  - Codex active daemon turn: room_notify tool output joins it between tool calls.
 *  - Codex idle: `codex queue --thread <id> --message <text>` queues the next turn.
 *  - Codex daemon unavailable (including exec/--no-daemon): wait for idle, then use the queue.
 *  - Claude Code 2.1.224+ (2.1.234+ on native Windows): the session's cross-session messaging inbox,
 *    exported as CLAUDE_CODE_MESSAGING_SOCKET and _TOKEN; an idle session starts a turn with the message.
 *  - Claude Code with the Room channel admitted (channels research preview, `--channels` or
 *    `--dangerously-load-development-channels`): a `notifications/claude/channel` notification.
 */
import net from 'node:net'
import { execFile, execFileSync } from 'node:child_process'
import { codexControlSocket, postCodexToolOutput } from './codex-app-server.js'
import { DEFAULT_CLAUDE_CHANNEL } from './config.js'
import { sendChannelNotification, type ChannelNotification } from './channel.js'

type WakeEnv = NodeJS.ProcessEnv
type Mode = 'auto' | 'socket' | 'channels' | 'off'

export interface WakeTarget { id: string; host: 'claude' | 'codex' }
export type WakeVia = 'queue' | 'socket' | 'channel' | 'turn'
/** One bounded observation, never peer content, host error text, paths or credentials. */
export interface WakeAttempt {
  via: WakeVia
  at: number
  outcome: 'attempting' | 'written' | 'queued' | 'submitted' | 'uncertain' | 'failed' | 'unavailable' | 'skipped-idle'
  fallback?: 'socket-failed'
}
export interface WakePathStatus {
  mode: Mode
  transport: 'turn/queue' | 'legacy/queue' | 'socket' | 'channel' | 'none'
  availability: 'configured' | 'unknown' | 'off' | 'unavailable'
}
/** Resolves with the path that took the wake, or undefined when this host has none; rejects when the path failed. */
export type SendWake = ((target: WakeTarget, text: string) => Promise<WakeVia | undefined>) & {
  describe?: (target: WakeTarget) => WakePathStatus
  lastAttempt?: (target?: WakeTarget) => WakeAttempt | undefined
}

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

/** Configuration evidence only: this does not contact the host or prove acceptance. */
export function wakePathStatus(o: WakeAvailability): WakePathStatus {
  const env = o.env ?? process.env, selected = mode(env)
  if (selected === 'off') return { mode: selected, transport: 'none', availability: 'off' }
  if (o.host === 'codex') return { mode: selected, transport: codexControlSocket(env) ? 'turn/queue' : 'legacy/queue', availability: 'unknown' }
  const socket = !!env.CLAUDE_CODE_MESSAGING_SOCKET
  if (selected !== 'channels' && socket) return { mode: selected, transport: 'socket', availability: 'configured' }
  if (selected === 'channels' && o.channel !== '') return { mode: selected, transport: 'channel', availability: 'configured' }
  if (selected === 'auto' && channelAdmitted(env, o.parentArgs ?? claudeParentArgs(), o.channel)) return { mode: selected, transport: 'channel', availability: 'configured' }
  return { mode: selected, transport: 'none', availability: 'unavailable' }
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

/** Codex: the queue. Claude: the socket, then the channel if the socket fails and the channel is admitted. ROOM_WAKE=off sends nothing. */
export function createWakeSender(o: WakeSenderOptions): SendWake {
  let last: WakeAttempt | undefined
  let lastTarget: string | undefined
  const attempt = async (via: WakeVia, run: () => Promise<unknown>): Promise<WakeVia> => {
    last = { via, at: Date.now(), outcome: 'attempting' }
    try { await run(); last = { ...last, outcome: via === 'queue' ? 'queued' : 'written' }; return via }
    catch (e) { last = { ...last, outcome: 'failed' }; throw e }
  }
  const send: SendWake = async (target, text) => {
    const key = `${target.host}\0${target.id}`
    if (lastTarget !== key) last = undefined
    lastTarget = key
    const env = o.env ?? process.env
    const selected = mode(env)
    // ROOM_WAKE=off is the user's switch for every host; the ledger still owes the message.
    if (selected === 'off') return undefined
    if (target.host === 'codex') return attempt('queue', () => (o.queue ?? codexQueue)(target.id, text))
    const admitted = () => channelAdmitted(env, o.parentArgs ?? claudeParentArgs(), o.channel)
    const channel = () => attempt('channel', () => sendChannelNotification(text, o.notify))
    if (selected === 'channels') return o.channel === '' ? undefined : channel()
    const socket = env.CLAUDE_CODE_MESSAGING_SOCKET
    if (!socket) return selected === 'auto' && admitted() ? channel() : undefined
    try { return await attempt('socket', () => (o.post ?? postSocketWake)(socket, env.CLAUDE_CODE_MESSAGING_TOKEN, text)) }
    catch (error) {
      if (selected === 'auto' && admitted()) {
        try { return await channel() } finally { if (last) last = { ...last, fallback: 'socket-failed' } }
      }
      throw error
    }
  }
  send.describe = target => wakePathStatus({ ...o, host: target.host })
  send.lastAttempt = target => (!target || `${target.host}\0${target.id}` === lastTarget) && last ? { ...last } : undefined
  return send
}

export type SendMidTurn = ((target: WakeTarget, text: string) => Promise<WakeVia | 'uncertain-turn' | 'idle' | undefined>)
  & Pick<SendWake, 'describe' | 'lastAttempt'>

export function createMidTurnSender(o: { env?: WakeEnv; post?: typeof postCodexToolOutput; log?: (line: string) => void; clientVersion?: string } = {}): SendMidTurn {
  let last: WakeAttempt | undefined
  let lastTarget: string | undefined
  let lastFailure: string | undefined
  const send: SendMidTurn = async (target, text) => {
    const key = `${target.host}\0${target.id}`
    if (lastTarget !== key) last = undefined
    lastTarget = key
    const env = o.env ?? process.env
    if (target.host !== 'codex' || mode(env) === 'off') return undefined
    last = { via: 'turn', at: Date.now(), outcome: 'attempting' }
    let result
    try { result = await (o.post ?? postCodexToolOutput)({ socketPath: codexControlSocket(env), threadId: target.id, text, clientVersion: o.clientVersion }) }
    catch (e) { last = { ...last, outcome: 'failed' }; throw e }
    last = { ...last, outcome: result.kind === 'joined' ? 'submitted' : result.kind === 'idle' ? 'skipped-idle' : result.kind }
    if (result.kind === 'joined') {
      lastFailure = undefined
      o.log?.(`wake: Codex mid-turn joined turn ${result.turnId} of session ${target.id}`)
      return 'turn'
    }
    if (result.kind === 'uncertain') return 'uncertain-turn'
    if (result.kind === 'idle') return 'idle'
    if (result.kind === 'unavailable') {
      const key = `${target.id}\0${result.reason}`
      if (key !== lastFailure) o.log?.(`wake: Codex mid-turn unavailable for session ${target.id}: ${result.reason}`)
      lastFailure = key
    }
    return undefined
  }
  send.lastAttempt = target => (!target || `${target.host}\0${target.id}` === lastTarget) && last ? { ...last } : undefined
  return send
}
