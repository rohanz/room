import { CURRENT_COMPAT, COMPAT_CLOSE_CODE, type CompatAdvertisement } from '@room/hub-core/protocol'
import { createBootstrapClient } from '@room/hub-core/bootstrap-client'

/** Read-only document support; transport authentication still decides authority. */
export const VIEWER_COMPAT: CompatAdvertisement = {
  bootstrap: CURRENT_COMPAT.bootstrap, hub: CURRENT_COMPAT.hub,
  schemas: { read: CURRENT_COMPAT.schemas.read, write: [] },
  capabilities: { 'room.generation': [1], 'room.manifest': [1], 'room.ledger': [1] },
}

/** Compose with local encryption. Yjs sees open/data only after the bootstrap ACK. */
export function negotiatedWebSocket(Transport: typeof WebSocket, onRefusal: (text: string) => void, offer: CompatAdvertisement = VIEWER_COMPAT): typeof WebSocket {
  return class NegotiatedWebSocket {
    static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3
    readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    private ws: WebSocket
    private bootstrap: ReturnType<typeof createBootstrapClient>
    constructor(address: string | URL, protocols?: string | string[]) {
      const url = new URL(address.toString())
      url.searchParams.set('negotiate', '1')
      this.ws = new Transport(url, protocols)
      this.ws.binaryType = 'arraybuffer'
      this.bootstrap = createBootstrapClient({
        offer, sessionId: crypto.randomUUID(), activeSchema: 2,
        send: data => this.ws.send(data),
        onOpen: () => this.onopen?.(new Event('open')),
        onRefusal: reason => { try { onRefusal(reason) } finally { this.ws.close(COMPAT_CLOSE_CODE, 'Room contract refused') } },
      })
      this.ws.onopen = () => { this.bootstrap.start() }
      this.ws.onmessage = event => {
        if (this.bootstrap.ready) this.onmessage?.(event)
        else this.bootstrap.receive(new Uint8Array(event.data))
      }
      this.ws.onclose = event => { this.bootstrap.close(); this.onclose?.(event) }
      this.ws.onerror = event => this.onerror?.(event)
    }
    get url(): string { return this.ws.url }
    get protocol(): string { return this.ws.protocol }
    get extensions(): string { return this.ws.extensions }
    get readyState(): number { return !this.bootstrap.ready && this.ws.readyState === 1 ? 0 : this.ws.readyState }
    get bufferedAmount(): number { return this.ws.bufferedAmount }
    get binaryType(): BinaryType { return this.ws.binaryType }
    set binaryType(value: BinaryType) { this.ws.binaryType = value }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (!this.bootstrap.ready) throw new Error('Room contract selection is not complete')
      this.ws.send(data)
    }
    close(code?: number, reason?: string): void { this.bootstrap.close(); this.ws.close(code, reason) }
  } as unknown as typeof WebSocket
}
