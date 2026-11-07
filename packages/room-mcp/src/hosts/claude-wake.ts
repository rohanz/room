import { mode } from './wake-mode.js'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { DEFAULT_CLAUDE_CHANNEL } from './claude-binding.js'
import type { WakeEnv, WakeAvailability, WakePathStatus } from './wake-types.js'
import { wakeTarget } from './wake-types.js'
import type { WakeFacet, WakeFacetOptions } from './wake.js'
import { sendResult } from './wake-result.js'
import { sendChannelNotification } from './claude-channel.js'
import type { WakeSenderOptions, WakeVia } from './wake-types.js'
import type { WakeAttemptRunner } from './wake.js'

const SOCKET_POST_TIMEOUT_MS = 1_500

let parentArgsCache: string | undefined
function claudeParentArgs(): string {
  if (parentArgsCache !== undefined) return parentArgsCache
  try { parentArgsCache = execFileSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } }).trim() }
  catch { parentArgsCache = '' }
  return parentArgsCache
}

function channelAdmitted(env: WakeEnv, parentArgs: string, channel: string | undefined): boolean {
  const entry = channel ?? env.ROOM_CLAUDE_CHANNEL ?? DEFAULT_CLAUDE_CHANNEL
  if (!entry) return false
  const admitted = [...parentArgs.matchAll(/(?:^|\s)--(?:dangerously-load-development-channels|channels)(?:=|\s)(\S+)/g)]
  return admitted.some(m => m[1].split(',').includes(entry))
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

export function createClaudeWakeFacet(o: WakeFacetOptions): WakeFacet {
  return {
    reportsState: false,
    describe: target => { const path = o.send.describe?.(wakeTarget(target)); return path && { ...path, limitation: 'A write is not a receipt.' } },
    state: async () => ({ kind: 'unneeded' }),
    send: async (target, pointer, phase) => phase === 'active' ? { kind: 'unavailable' } : sendResult(await o.send(wakeTarget(target), pointer)),
  }
}

export async function sendClaudeWake(o: WakeSenderOptions, text: string, attempt: WakeAttemptRunner, fallback: () => void): Promise<WakeVia | undefined> {
  const env = o.env ?? process.env
  const selected = mode(env)
  const admitted = () => channelAdmitted(env, o.parentArgs ?? claudeParentArgs(), o.channel)
  const channel = () => attempt('channel', () => sendChannelNotification(text, o.notify))
  if (selected === 'channels') return o.channel === '' ? undefined : channel()
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET
  if (!socket) return selected === 'auto' && admitted() ? channel() : undefined
  try { return await attempt('socket', () => (o.post ?? postSocketWake)(socket, env.CLAUDE_CODE_MESSAGING_TOKEN, text)) }
  catch (error) {
    if (selected === 'auto' && admitted()) {
      try { return await channel() } finally { fallback() }
    }
    throw error
  }
}
