const magic = new TextEncoder().encode('room-secure-v1')
const text = (s: string) => new TextEncoder().encode(s)
const source = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])
const bytes = async (data: unknown): Promise<Uint8Array> => {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  throw new Error('non-binary secure frame')
}

export function secureWebSocket(viewKey: string): typeof WebSocket {
  return class SecureWebSocket {
    static readonly CONNECTING = WebSocket.CONNECTING
    static readonly OPEN = WebSocket.OPEN
    static readonly CLOSING = WebSocket.CLOSING
    static readonly CLOSED = WebSocket.CLOSED
    readonly CONNECTING = WebSocket.CONNECTING
    readonly OPEN = WebSocket.OPEN
    readonly CLOSING = WebSocket.CLOSING
    readonly CLOSED = WebSocket.CLOSED
    readonly url: string
    readonly protocol = ''
    readonly extensions = ''
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    private ws: WebSocket
    private cn = crypto.getRandomValues(new Uint8Array(16))
    private tx?: CryptoKey
    private rx?: CryptoKey
    private sent = 0n
    private received = 0n
    private outgoing: Promise<void> = Promise.resolve()
    private incoming: Promise<void> = Promise.resolve()
    private opened = false
    private timer: ReturnType<typeof setTimeout>
    private room: string
    constructor(address: string | URL, protocols?: string | string[]) {
      this.url = address.toString()
      this.room = decodeURIComponent(new URL(this.url).pathname.slice(1))
      this.ws = new WebSocket(address, protocols)
      this.ws.binaryType = 'arraybuffer'
      this.timer = setTimeout(() => this.close(1008, 'secure handshake timeout'), 5000)
      this.ws.onopen = () => this.ws.send(concat(magic, this.cn))
      this.ws.onmessage = event => { this.incoming = this.incoming.then(() => this.receive(event.data)).catch(() => this.close(1008, 'invalid secure frame')) }
      this.ws.onclose = event => { clearTimeout(this.timer); this.onclose?.(event) }
      this.ws.onerror = event => this.onerror?.(event)
    }
    get readyState(): number { return this.opened ? this.ws.readyState : this.ws.readyState === WebSocket.OPEN ? WebSocket.CONNECTING : this.ws.readyState }
    get bufferedAmount(): number { return this.ws.bufferedAmount }
    get binaryType(): BinaryType { return this.ws.binaryType }
    set binaryType(value: BinaryType) { this.ws.binaryType = value }
    private iv(counter: bigint): Uint8Array { const iv = new Uint8Array(12); new DataView(iv.buffer).setBigUint64(4, counter); return iv }
    private async receive(raw: unknown): Promise<void> {
      const frame = await bytes(raw)
      if (!this.opened) {
        if (frame.length !== magic.length + 48 || !equal(frame.subarray(0, magic.length), magic)) throw new Error('invalid relay hello')
        const sn = frame.subarray(magic.length, magic.length + 16)
        const key = await crypto.subtle.importKey('raw', source(text(viewKey)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
        const proof = new Uint8Array(await crypto.subtle.sign('HMAC', key, source(concat(text('room-relay-v2\0relay\0'), this.cn, sn, new Uint8Array([0]), text(this.room)))))
        if (!equal(proof, frame.subarray(magic.length + 16))) throw new Error('invalid relay proof')
        const material = await crypto.subtle.importKey('raw', source(text(viewKey)), 'HKDF', false, ['deriveKey'])
        const salt = concat(this.cn, sn)
        const derive = (info: string) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: source(salt), info: source(text(info)) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
        ;[this.tx, this.rx] = await Promise.all([derive('room-relay-v2 c2s'), derive('room-relay-v2 s2c')])
        this.opened = true
        clearTimeout(this.timer)
        this.onopen?.(new Event('open'))
        return
      }
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: source(this.iv(this.received)) }, this.rx!, source(frame))
      this.received++
      this.onmessage?.(new MessageEvent('message', { data: plain }))
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      this.outgoing = this.outgoing.then(async () => {
        if (!this.opened || this.ws.readyState !== WebSocket.OPEN) throw new Error('secure websocket is not open')
        const frame = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: source(this.iv(this.sent++)) }, this.tx!, source(await bytes(data)))
        this.ws.send(frame)
      }).catch(() => this.close(1008, 'invalid secure frame'))
    }
    close(code?: number, reason?: string): void { clearTimeout(this.timer); this.ws.close(code, reason) }
  } as unknown as typeof WebSocket
}
