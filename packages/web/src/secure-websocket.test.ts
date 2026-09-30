import { afterEach, describe, expect, it } from 'vitest'
import { SecureSession } from '../../relay/src/secure.js'
import { secureWebSocket } from './secure-websocket.js'

const original = globalThis.WebSocket
class FakeSocket {
  static mode: 'normal' | 'flip' | 'replay' | 'reorder' = 'normal'
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3
  readyState = 0
  bufferedAmount = 0
  binaryType: BinaryType = 'blob'
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  session: SecureSession
  frames: Uint8Array[] = []
  private held?: Uint8Array
  constructor(url: string | URL, _protocols?: string | string[]) {
    this.session = new SecureSession('view-secret', decodeURIComponent(new URL(url).pathname.slice(1)), 'relay')
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event('open')) })
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const frame = new Uint8Array(data as ArrayBuffer)
    this.frames.push(frame)
    if (!this.session.ready) {
      const reply = this.session.relayHello(frame)
      queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: reply })))
      return
    }
    const plain = this.session.decrypt(frame)
    const reply = this.session.encrypt(plain)
    if (FakeSocket.mode === 'reorder') {
      if (!this.held) { this.held = reply; return }
      const held = this.held
      queueMicrotask(() => { this.onmessage?.(new MessageEvent('message', { data: reply })); this.onmessage?.(new MessageEvent('message', { data: held })) })
      return
    }
    if (FakeSocket.mode === 'flip') reply[0] ^= 1
    queueMicrotask(() => {
      this.onmessage?.(new MessageEvent('message', { data: reply }))
      if (FakeSocket.mode === 'replay') this.onmessage?.(new MessageEvent('message', { data: reply }))
    })
  }
  close(_code?: number, _reason?: string): void { this.readyState = 3; this.onclose?.({ code: _code ?? 1000, reason: _reason ?? '' } as CloseEvent) }
}

afterEach(() => { globalThis.WebSocket = original; FakeSocket.mode = 'normal' })
describe('browser relay secure transport', () => {
  it('interoperates with Node for 100 ordered frames including 5 MiB', async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const Polyfill = secureWebSocket('view-secret')
    const ws = new Polyfill('ws://127.0.0.1:4402/local%2Fa')
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onclose = () => reject(new Error('closed')) })
    const replies: ArrayBuffer[] = []
    const done = new Promise<void>(resolve => { ws.onmessage = e => { replies.push(e.data); if (replies.length === 100) resolve() } })
    for (let n = 0; n < 100; n++) ws.send(new Uint8Array(n === 50 ? 5 * 1024 * 1024 : 4).fill(n))
    await done
    expect(replies).toHaveLength(100)
    expect(new Uint8Array(replies[50]).length).toBe(5 * 1024 * 1024)
    expect((ws as unknown as { ws: FakeSocket }).ws.frames[51].length).toBe(5 * 1024 * 1024 + 16)
    ws.close()
  })
  it('refuses a relay proof from the wrong key before open', async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
    const ws = new (secureWebSocket('wrong-key'))('ws://127.0.0.1:4402/local%2Fa')
    let opened = false
    ws.onopen = () => { opened = true }
    await new Promise<void>(resolve => { ws.onclose = () => resolve() })
    expect(opened).toBe(false)
    expect((ws as unknown as { ws: FakeSocket }).ws.frames).toHaveLength(1)
  })
  for (const mode of ['flip', 'replay', 'reorder'] as const) {
    it(`closes on ${mode} ciphertext`, async () => {
      FakeSocket.mode = mode
      globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
      const ws = new (secureWebSocket('view-secret'))('ws://127.0.0.1:4402/local%2Fa')
      await new Promise<void>(resolve => { ws.onopen = () => resolve() })
      const closed = new Promise<void>(resolve => { ws.onclose = () => resolve() })
      ws.send(Uint8Array.of(1))
      if (mode === 'reorder') ws.send(Uint8Array.of(2))
      await closed
      expect(ws.readyState).toBe(WebSocket.CLOSED)
    })
  }
})
