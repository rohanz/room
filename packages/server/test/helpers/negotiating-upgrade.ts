import { EventEmitter } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import { CURRENT_COMPAT, decodeFrame, encodeFrame, type BootstrapSelection } from '@room/hub-core'

/** Replace only the socket transport; the server must finish its real negotiated admission. */
export function installNegotiatingUpgrade(): void {
  WebSocketServer.prototype.handleUpgrade = function(req, socket, _head, done) {
    const complete = (result: { status: number; body?: string }) =>
      (socket as unknown as { completed(result: unknown): void }).completed(result)
    const ws = Object.assign(new EventEmitter(), {
      readyState: 1, OPEN: 1, bufferedAmount: 0, _receiver: { _maxPayload: 16 * 1024 * 1024 },
      send(data: Uint8Array, ...args: unknown[]) {
        const callback = args.find(arg => typeof arg === 'function') as (() => void) | undefined
        callback?.()
        if (data[0] !== 7) return
        const frame = decodeFrame(data) as BootstrapSelection
        if (!frame.ok) { complete({ status: 4406, body: JSON.stringify(frame) }); return }
        if (frame.re === 'probe-hello') {
          queueMicrotask(() => ws.emit('message', encodeFrame({ v: 1, id: 'probe-ack', op: 'compat-ack', selectionId: frame.selectionId }), true))
        } else if (frame.re === 'probe-ack') complete({ status: 101 })
      },
      ping() {},
      close() { if (ws.readyState === 3) return; ws.readyState = 3; ws.emit('close') },
      terminate() { ws.close() },
    })
    done(ws as unknown as WebSocket, req)
    queueMicrotask(() => ws.emit('message', encodeFrame({ v: 1, id: 'probe-hello', op: 'compat-hello', sessionId: 'storage-probe', offer: CURRENT_COMPAT }), true))
  }
}
