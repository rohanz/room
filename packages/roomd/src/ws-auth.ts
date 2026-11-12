import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { SecureSession, localProofHeader } from '@room/relay'
import { CURRENT_COMPAT, createBootstrapClient, type CompatAdvertisement, type BootstrapSelection } from '@room/hub-core'

export interface SocketNegotiation {
  offer: CompatAdvertisement
  sessionId: string
  onSelection?: (selection: BootstrapSelection) => void
  onRefusal?: (text: string) => void
}

/** Authentication/encryption and contract selection finish before y-websocket observes open or data. */
export function authorizedWebSocket(credentials: { session?: string; token?: string; key?: string; viewKey?: string; negotiation?: SocketNegotiation }): typeof WebSocket {
  const negotiation = credentials.negotiation ?? { offer: CURRENT_COMPAT, sessionId: randomUUID() }
  const headers = {
    ...(credentials.session ? { authorization: `Bearer ${credentials.session}` } : {}),
    ...(credentials.token ? { 'x-room-token': credentials.token } : {}),
  }
  return class AuthorizedWebSocket extends WebSocket {
    private secure?: SecureSession
    private encrypted = false
    private timer?: NodeJS.Timeout
    private bootstrap: ReturnType<typeof createBootstrapClient>
    constructor(address: string | URL, protocols?: string | string[]) {
      const url = new URL(address.toString())
      url.searchParams.set('negotiate', '1')
      if (credentials.key || credentials.viewKey) {
        const port = Number(url.port)
        if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('local relay requires ws://127.0.0.1:<port>')
        super(url, protocols, { headers: { ...headers, ...(credentials.key ? { authorization: localProofHeader(credentials.key, 'GET', url.pathname + url.search, port) } : {}) } })
        this.secure = new SecureSession((credentials.key ?? credentials.viewKey)!, decodeURIComponent(url.pathname.slice(1)), 'client')
        this.timer = setTimeout(() => this.close(1008, 'secure handshake timeout'), 5000)
        this.timer.unref?.()
      } else super(url, protocols, { headers })
      this.bootstrap = createBootstrapClient({
        ...negotiation, send: data => this.sendPlain(Buffer.from(data)),
        onOpen: selection => { negotiation.onSelection?.(selection); super.emit('open') },
        onRefusal: reason => { try { negotiation.onRefusal?.(reason) } finally { this.close(4406, 'Room contract refused') } },
      })
      this.on('error', () => {})
      this.on('unexpected-response', (request, response) => {
        // Owning this event suppresses ws's default handshake abort. End every refusal:
        // request errors produce the ordinary error/close events that drive provider backoff.
        if (response.statusCode === 426) this.bootstrap.refuse('Room server refused the supported contract; update the affected Room client or server, then reconnect Room (/mcp) or restart the session')
        else request.destroy(new Error(`Unexpected server response: ${response.statusCode}`))
        // A completed/destroyed HTTP request can leave its keep-alive socket open.
        // Tear down the transport too, after recording the refusal above.
        request.socket?.destroy()
        // Never wait for or print an unauthenticated (possibly endless) response body.
        response.destroy()
      })
    }
    private sendPlain(data: WebSocket.RawData, cb?: (error?: Error) => void): void {
      const raw = data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? Buffer.concat(data) : data
      if (this.secure) super.send(this.secure.encrypt(raw), cb)
      else super.send(data, cb)
    }
    private authenticated(): boolean {
      clearTimeout(this.timer)
      return this.bootstrap.start()
    }
    private application(raw: Uint8Array): boolean {
      if (this.bootstrap.ready) return super.emit('message', raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), true)
      return this.bootstrap.receive(raw)
    }
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      if (event === 'open') {
        if (this.secure) { super.send(this.secure.clientHello()); return true }
        return this.authenticated()
      }
      if (event === 'message') {
        const data = args[0] as Buffer | ArrayBuffer | Buffer[]
        const raw = data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? Buffer.concat(data) : data
        if (!this.secure) return this.application(raw)
        try {
          if (!this.encrypted) {
            this.secure.acceptRelayHello(raw)
            this.encrypted = true
            return this.authenticated()
          }
          return this.application(this.secure.decrypt(raw))
        } catch { this.close(1008, 'invalid secure frame'); return false }
      }
      if (event === 'close') { clearTimeout(this.timer); this.bootstrap?.close() }
      return super.emit(event, ...args)
    }
    override send(data: WebSocket.RawData, options?: { binary?: boolean; mask?: boolean; compress?: boolean; fin?: boolean } | ((error?: Error) => void), cb?: (error?: Error) => void): void {
      if (typeof options === 'function') cb = options
      if (!this.bootstrap.ready) { cb?.(new Error('Room contract selection is not complete')); return }
      this.sendPlain(data, cb)
    }
  } as unknown as typeof WebSocket
}
