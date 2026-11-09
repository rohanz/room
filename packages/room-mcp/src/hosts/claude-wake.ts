import { mode } from './wake-mode.js'
import net from 'node:net'
import type { WakeAvailability, WakePathStatus } from './wake-types.js'
import { wakeTarget } from './wake-types.js'
import type { WakeFacet, WakeFacetOptions } from './wake.js'
import { sendResult } from './wake-result.js'
import type { WakeSenderOptions, WakeVia } from './wake-types.js'
import type { WakeAttemptRunner } from './wake.js'

const SOCKET_POST_TIMEOUT_MS = 1_500

/** Claude Code exports the socket only after binding its inbox (v2.1.224+); env-vars.md has no version variable. */
export function claudeWakeAvailable(o: WakeAvailability): boolean {
  if (o.host !== 'claude') return false
  const env = o.env ?? process.env
  const selected = mode(env)
  if (selected === 'off') return false
  return !!env.CLAUDE_CODE_MESSAGING_SOCKET
}

/** Configuration evidence only: this does not contact the host or prove acceptance. */
export function wakePathStatus(o: WakeAvailability): WakePathStatus {
  const env = o.env ?? process.env, selected = mode(env)
  if (selected === 'off') return { mode: selected, transport: 'none', availability: 'off' }
  const socket = !!env.CLAUDE_CODE_MESSAGING_SOCKET
  if (socket) return { mode: selected, transport: 'socket', availability: 'configured' }
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

export async function sendClaudeWake(o: WakeSenderOptions, text: string, attempt: WakeAttemptRunner): Promise<WakeVia | undefined> {
  const env = o.env ?? process.env
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET
  if (!socket) return undefined
  return attempt('socket', () => (o.post ?? postSocketWake)(socket, env.CLAUDE_CODE_MESSAGING_TOKEN, text))
}
