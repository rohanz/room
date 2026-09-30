import WebSocket from 'ws'

/** y-websocket's Node polyfill can attach credentials to every upgrade, including reconnects. */
export function authorizedWebSocket(credentials: { session?: string; token?: string; key?: string }): typeof WebSocket {
  const headers = {
    ...(credentials.session || credentials.key ? { authorization: `Bearer ${credentials.session ?? credentials.key}` } : {}),
    ...(credentials.token ? { 'x-room-token': credentials.token } : {}),
  }
  return class AuthorizedWebSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers })
    }
  } as typeof WebSocket
}
