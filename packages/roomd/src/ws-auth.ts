import WebSocket from 'ws'
import { localProofHeader, relayHealth } from '@room/relay'

/** y-websocket's Node polyfill can attach credentials to every upgrade, including reconnects. */
export function authorizedWebSocket(credentials: { session?: string; token?: string; key?: string }): typeof WebSocket {
  const headers = {
    ...(credentials.session ? { authorization: `Bearer ${credentials.session}` } : {}),
    ...(credentials.token ? { 'x-room-token': credentials.token } : {}),
  }
  return class AuthorizedWebSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      if (!credentials.key) { super(address, protocols, { headers }); return }
      const url = new URL(address.toString())
      const port = Number(url.port)
      // ws defers sending the upgrade request until finishRequest calls end(). Verify on
      // every constructor invocation, including y-websocket's automatic reconnects.
      super(address, protocols, { headers, finishRequest: request => {
        if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) {
          request.destroy(new Error('local relay requires ws://127.0.0.1:<port>')); return
        }
        void relayHealth(port, credentials.key!).then(health => {
          if (!health) { request.destroy(new Error('local relay identity could not be verified')); return }
          request.setHeader('authorization', localProofHeader(credentials.key!, 'GET', url.pathname + url.search, port))
          request.end()
        }, error => request.destroy(error))
      } })
    }
  } as typeof WebSocket
}
