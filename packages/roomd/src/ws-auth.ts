import WebSocket from 'ws'
import { SecureSession, localProofHeader } from '@room/relay'

/** y-websocket polyfill: expose open and ordinary frames only after in-band relay authentication. */
export function authorizedWebSocket(credentials: { session?: string; token?: string; key?: string; viewKey?: string }): typeof WebSocket {
  const headers = {
    ...(credentials.session ? { authorization: `Bearer ${credentials.session}` } : {}),
    ...(credentials.token ? { 'x-room-token': credentials.token } : {}),
  }
  return class AuthorizedWebSocket extends WebSocket {
    private secure?: SecureSession
    private pending: Array<{ data: WebSocket.RawData; options?: { binary?: boolean; mask?: boolean; compress?: boolean; fin?: boolean }; cb?: (error?: Error) => void }> = []
    private opened = false
    private timer?: NodeJS.Timeout
    constructor(address: string | URL, protocols?: string | string[]) {
      const url = new URL(address.toString())
      if (credentials.key || credentials.viewKey) {
        const port = Number(url.port)
        if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('local relay requires ws://127.0.0.1:<port>')
        super(address, protocols, { headers: { ...headers, ...(credentials.key ? { authorization: localProofHeader(credentials.key, 'GET', url.pathname + url.search, port) } : {}) } })
        this.secure = new SecureSession((credentials.key ?? credentials.viewKey)!, decodeURIComponent(url.pathname.slice(1)), 'client')
        this.timer = setTimeout(() => this.close(1008, 'secure handshake timeout'), 5000)
        this.timer.unref?.()
      } else super(address, protocols, { headers })
    }
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      if (!this.secure) return super.emit(event, ...args)
      if (event === 'open') { super.send(this.secure.clientHello()); return true }
      if (event === 'message') {
        try {
          // ws hands over a Buffer, an ArrayBuffer or fragments, by the binaryType y-websocket sets after construction.
          const data = args[0] as Buffer | ArrayBuffer | Buffer[]
          const raw = data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? Buffer.concat(data) : data
          if (!this.opened) {
            this.secure.acceptRelayHello(raw)
            this.opened = true
            clearTimeout(this.timer)
            super.emit('open')
            for (const item of this.pending.splice(0)) this.send(item.data, item.options as never, item.cb)
            return true
          }
          const plain = this.secure.decrypt(raw)
          return super.emit('message', plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength), true)
        } catch { this.close(1008, 'invalid secure frame'); return false }
      }
      if (event === 'close') clearTimeout(this.timer)
      return super.emit(event, ...args)
    }
    override send(data: WebSocket.RawData, options?: { binary?: boolean; mask?: boolean; compress?: boolean; fin?: boolean } | ((error?: Error) => void), cb?: (error?: Error) => void): void {
      if (!this.secure) { super.send(data, options as never, cb); return }
      if (typeof options === 'function') { cb = options; options = undefined }
      if (!this.opened) { this.pending.push({ data, options, cb }); return }
      const frame = this.secure.encrypt(data instanceof ArrayBuffer ? new Uint8Array(data) : Buffer.from(data as Buffer))
      if (options) super.send(frame, options, cb)
      else super.send(frame, cb)
    }
  } as unknown as typeof WebSocket
}
