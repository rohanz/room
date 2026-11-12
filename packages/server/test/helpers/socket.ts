import type WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import { authorizedWebSocket } from '../../../roomd/src/ws-auth.js'

/** Use the production client bootstrap while retaining per-test credential headers. */
export function connectSocket(address: string, options: ClientOptions = {}): WebSocket {
  const headers = options.headers as Record<string, string> | undefined
  const authorization = headers?.authorization
  const Socket = authorizedWebSocket({
    session: authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined,
    token: headers?.['x-room-token'],
  })
  return new Socket(address)
}
