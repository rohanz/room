import { afterEach, expect, it, vi } from 'vitest'
import { CURRENT_COMPAT, decodeFrame, encodeFrame, selectContract, type BootstrapSelection } from '@room/hub-core/protocol'
import { negotiatedWebSocket, VIEWER_COMPAT } from './negotiated-websocket.js'

class Socket {
  static current: Socket
  readyState = 1; binaryType = 'arraybuffer'; url: string
  onopen?: (e: Event) => void
  onmessage?: (e: MessageEvent) => void
  onclose?: (e: CloseEvent) => void
  onerror?: (e: Event) => void
  send = vi.fn()
  close = vi.fn()
  constructor(url: URL) { this.url = String(url); Socket.current = this }
  receive(frame: unknown) { this.onmessage?.(new MessageEvent('message', { data: encodeFrame(frame as never).buffer })) }
}
afterEach(() => vi.useRealTimers())
function setup() {
  const refusal = vi.fn(), ws = new (negotiatedWebSocket(Socket as unknown as typeof WebSocket, refusal))('ws://localhost/room')
  const opened = vi.fn(), data = vi.fn()
  ws.onopen = opened; ws.onmessage = data
  const socket = Socket.current
  socket.onopen!(new Event('open'))
  const result = selectContract(VIEWER_COMPAT, CURRENT_COMPAT, { activeSchema: 2, readOnly: true })
  if (!result.ok) throw new Error(result.error.text)
  const selection: BootstrapSelection = { v: 1, re: 'compat-hello', ok: true, selectionId: 'selected', selection: result.selection, compat: CURRENT_COMPAT, generation: '0', policyRevision: 1, incarnation: 1, ttlMs: 45000, renewMs: 15000, requiredCapabilities: {} }
  return { ws, socket, opened, data, refusal, selection }
}
it('offers only read support and withholds Yjs open and data until the ACK', () => {
  const { ws, socket, opened, data, selection } = setup()
  expect(new URL(socket.url).searchParams.get('negotiate')).toBe('1')
  expect(decodeFrame(socket.send.mock.calls[0][0])).toMatchObject({ op: 'compat-hello', offer: { schemas: { read: [2], write: [] } } })
  expect(() => ws.send(new Uint8Array([0]))).toThrow('not complete')
  socket.receive(selection)
  expect(opened).not.toHaveBeenCalled()
  expect(data).not.toHaveBeenCalled()
  expect(decodeFrame(socket.send.mock.calls[1][0])).toMatchObject({ op: 'compat-ack', selectionId: 'selected' })
  socket.receive({ v: 1, re: 'compat-ack', ok: true })
  expect(opened).toHaveBeenCalledOnce()
  socket.onmessage!(new MessageEvent('message', { data: new Uint8Array([0]).buffer }))
  expect(data).toHaveBeenCalledOnce()
  ws.close()
})
it('rejects a selection outside the read-only offer before opening', () => {
  const { socket, selection, opened, refusal } = setup()
  socket.receive({ ...selection, selection: { ...selection.selection, schema: 3 } })
  expect(opened).not.toHaveBeenCalled()
  expect(refusal).toHaveBeenCalledOnce()
  expect(socket.close).toHaveBeenCalledWith(4406, 'Room contract refused')
})
it('ends a stalled bootstrap with a bounded diagnostic', () => {
  vi.useFakeTimers()
  const { socket, refusal, opened } = setup()
  vi.advanceTimersByTime(5000)
  expect(refusal).toHaveBeenCalledWith('Room server did not select a contract within 5 seconds')
  expect(opened).not.toHaveBeenCalled()
  expect(socket.close).toHaveBeenCalledOnce()
})
