import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { CURRENT_COMPAT, decodeFrame, encodeFrame, selectContract } from '@room/hub-core'
const { wires } = vi.hoisted(() => ({ wires: [] as unknown[] }))
vi.mock('ws', () => ({ default: class extends EventEmitter {
  sent: unknown[] = []; readyState = 1
  constructor(public address: string | URL) { super(); wires.push(this) }
  send(data: unknown) { this.sent.push(data) }
  close(code?: number, reason?: string) { this.emit('close', code, reason) }
} }))
import { authorizedWebSocket } from '../src/ws-auth.js'
beforeEach(() => { wires.length = 0 })
it('gates open, sends the offer, and waits for selection ACK before exposing any sync', () => {
  const selected = vi.fn(), failed = vi.fn()
  const Socket = authorizedWebSocket({ negotiation: { offer: CURRENT_COMPAT, sessionId: 'session', onSelection: selected, onRefusal: failed } })
  const socket = new Socket('ws://localhost:1234/repo?schema=2') as any
  const opened = vi.fn(), messages = vi.fn()
  socket.on('open', opened); socket.on('message', messages)
  socket.emit('open')
  expect(opened).not.toHaveBeenCalled()
  expect(new URL(String(socket.address)).searchParams.get('negotiate')).toBe('1')
  const hello = decodeFrame(socket.sent[0]) as any
  expect(hello).toMatchObject({ op: 'compat-hello', sessionId: 'session', offer: CURRENT_COMPAT })
  const frame = { v: 1, re: hello.id, ok: true, selectionId: 'selection', selection: { bootstrap: 1, hub: 1, schema: 2, capabilities: { 'room.generation': 1, 'room.manifest': 1, 'room.ledger': 1 } }, compat: CURRENT_COMPAT, generation: '0', policyRevision: 1, incarnation: 1, ttlMs: 45000, renewMs: 15000, requiredCapabilities: {} }
  socket.emit('message', encodeFrame(frame as any))
  expect(opened).not.toHaveBeenCalled()
  expect(messages).not.toHaveBeenCalled()
  const ack = decodeFrame(socket.sent[1]) as any
  expect(ack).toMatchObject({ op: 'compat-ack', selectionId: 'selection' })
  socket.emit('message', encodeFrame({ v: 1, re: ack.id, ok: true }))
  expect(opened).toHaveBeenCalledOnce()
  expect(selected).toHaveBeenCalledOnce()
  expect(failed).not.toHaveBeenCalled()
  socket.close()
})
it('refuses unexpected Yjs before selection without exposing open or bytes', () => {
  const failed = vi.fn()
  const Socket = authorizedWebSocket({ negotiation: { offer: CURRENT_COMPAT, sessionId: 's', onRefusal: failed } })
  const socket = new Socket('ws://localhost:1234/repo') as any
  const opened = vi.fn(), message = vi.fn()
  socket.on('open', opened); socket.on('message', message)
  socket.emit('open'); socket.emit('message', new Uint8Array([0, 0]))
  expect(failed).toHaveBeenCalledOnce()
  expect(opened).not.toHaveBeenCalled(); expect(message).not.toHaveBeenCalled()
})

it('keeps encryption failures separate from contract refusals', () => {
  const refused = vi.fn(), closed = vi.fn()
  const Socket = authorizedWebSocket({ key: 'a'.repeat(64), negotiation: { offer: CURRENT_COMPAT, sessionId: 's', onRefusal: refused } })
  const socket = new Socket('ws://127.0.0.1:1234/room') as any
  socket.on('close', closed)
  socket.emit('open'); socket.emit('message', new Uint8Array([0]))
  expect(refused).not.toHaveBeenCalled()
  expect(closed).toHaveBeenCalledWith(1008, 'invalid secure frame')
})

it.each([401, 403, 429, 503])('aborts HTTP %i handshakes with the ordinary status error and destroys the underlying socket', statusCode => {
  const refused = vi.fn()
  const Socket = authorizedWebSocket({ negotiation: { offer: CURRENT_COMPAT, sessionId: 's', onRefusal: refused } })
  const socket = new Socket('ws://localhost:1234/repo')
  // Model a completed request whose destroy() no longer closes its transport.
  const request = { destroy: vi.fn(), socket: { destroy: vi.fn() } }
  const response = { statusCode, destroy: vi.fn(), resume: vi.fn() }
  socket.emit('unexpected-response', request, response)
  expect(request.destroy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: `Unexpected server response: ${statusCode}` }))
  expect(request.socket.destroy).toHaveBeenCalledExactlyOnceWith()
  expect(response.destroy).toHaveBeenCalledOnce()
  expect(response.resume).not.toHaveBeenCalled()
  expect(refused).not.toHaveBeenCalled()
})

it('keeps HTTP 426 compatibility guidance terminal and discards the untrusted body', () => {
  const refused = vi.fn()
  const Socket = authorizedWebSocket({ negotiation: { offer: CURRENT_COMPAT, sessionId: 's', onRefusal: refused } })
  const socket = new Socket('ws://localhost:1234/repo')
  const closed = vi.fn()
  socket.on('close', closed)
  const request = { destroy: vi.fn(), socket: { destroy: vi.fn() } }
  const response = { statusCode: 426, destroy: vi.fn(), resume: vi.fn() }
  socket.emit('unexpected-response', request, response)
  expect(refused).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('reconnect Room (/mcp)'))
  expect(closed).toHaveBeenCalledWith(4406, 'Room contract refused')
  expect(request.socket.destroy).toHaveBeenCalledExactlyOnceWith()
  expect(response.destroy).toHaveBeenCalledOnce()
  expect(response.resume).not.toHaveBeenCalled()
})

describe('HTTP upgrade refusal recovery with the installed ws and y-websocket', () => {
  let realAuthorizedWebSocket: typeof authorizedWebSocket
  let WebSocketServer: typeof import('ws').WebSocketServer
  beforeAll(async () => {
    // The frame-gating tests above use a wire fixture; these regressions need ws's
    // actual unexpected-response/request error/close behavior and provider backoff.
    vi.doUnmock('ws')
    vi.resetModules()
    ;({ authorizedWebSocket: realAuthorizedWebSocket } = await import('../src/ws-auth.js'))
    ;({ WebSocketServer } = await import('ws'))
  })

  async function authority(refuse: (attempt: number) => number | undefined) {
    const server = createServer()
    const wss = new WebSocketServer({ noServer: true })
    const sockets = new Set<Socket>()
    const attempts: number[] = []
    const remote = new Y.Doc()
    remote.getMap('test').set('value', 'recovered')
    server.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.on('upgrade', (request, socket, head) => {
      attempts.push(Date.now())
      const status = refuse(attempts.length)
      if (status) {
        // Deliberately never finish this body: rejection must close independently
        // of response EOF, including when an authority keeps the connection alive.
        socket.write(`HTTP/1.1 ${status} Refused\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n1\r\nx\r\n`)
        // After 'upgrade' the HTTP server no longer owns this socket, so model what a real server does
        // with a connection its client has finished: close it. The client must still have sent that FIN.
        socket.on('end', () => socket.destroy())
        return
      }
      wss.handleUpgrade(request, socket, head, ws => {
        ws.on('error', () => {})
        ws.once('message', data => {
          const hello = decodeFrame(new Uint8Array(data as Buffer)) as { id: string; offer: typeof CURRENT_COMPAT }
          const selected = selectContract(hello.offer, CURRENT_COMPAT, { activeSchema: 2 })
          if (!selected.ok) throw new Error(selected.error.text)
          ws.send(encodeFrame({ v: 1, re: hello.id, ok: true, selectionId: 'retry', selection: selected.selection, compat: CURRENT_COMPAT, generation: '0', policyRevision: 1, incarnation: 1, ttlMs: 45000, renewMs: 15000, requiredCapabilities: {} }))
          ws.once('message', data => {
            const ack = decodeFrame(new Uint8Array(data as Buffer)) as { id: string }
            ws.send(encodeFrame({ v: 1, re: ack.id, ok: true }))
            ws.once('message', () => {
          const update = Y.encodeStateAsUpdate(remote)
          expect(update.length).toBeLessThan(128)
          // y-websocket messageSync (0), sync step 2 (1), varUint8Array update.
          ws.send(new Uint8Array([0, 1, update.length, ...update]))
            })
          })
        })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as { port: number }).port
    return {
      url: `ws://127.0.0.1:${port}`, attempts, sockets,
      async stop() {
        for (const socket of sockets) socket.destroy()
        await Promise.all([
          new Promise<void>(resolve => wss.close(() => resolve())),
          new Promise<void>(resolve => server.close(() => resolve())),
        ])
        remote.destroy()
      },
    }
  }

  it('retries a first HTTP 503 upgrade refusal and syncs on the next connection', async () => {
    const fixture = await authority(attempt => attempt === 1 ? 503 : undefined)
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(fixture.url, 'repo', doc, {
      WebSocketPolyfill: realAuthorizedWebSocket({}), disableBc: true,
    })
    const errors = vi.fn(), closes = vi.fn()
    provider.on('connection-error', errors)
    provider.on('connection-close', closes)
    try {
      await vi.waitFor(() => expect(provider.synced).toBe(true), { timeout: 3000 })
      expect(doc.getMap('test').get('value')).toBe('recovered')
      expect(fixture.attempts).toHaveLength(2)
      expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Unexpected server response: 503' }), provider)
      expect(closes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 1006 }), provider)
      expect(provider.wsUnsuccessfulReconnects).toBe(0)
    } finally {
      provider.destroy(); doc.destroy(); await fixture.stop()
    }
  })

  it('surfaces permanent HTTP 401 refusals and backs off instead of spinning', async () => {
    const fixture = await authority(() => 401)
    const doc = new Y.Doc()
    const refused = vi.fn()
    const provider = new WebsocketProvider(fixture.url, 'repo', doc, {
      WebSocketPolyfill: realAuthorizedWebSocket({ negotiation: { offer: CURRENT_COMPAT, sessionId: 's', onRefusal: refused } }),
      disableBc: true,
    })
    const errors = vi.fn(), closes = vi.fn()
    provider.on('connection-error', errors)
    provider.on('connection-close', closes)
    try {
      await vi.waitFor(() => expect(closes).toHaveBeenCalledTimes(3), { timeout: 3000 })
      expect(fixture.attempts).toHaveLength(3)
      expect(errors).toHaveBeenCalledTimes(3)
      for (const [event] of errors.mock.calls) expect(event.message).toBe('Unexpected server response: 401')
      for (const [event] of closes.mock.calls) expect(event.code).toBe(1006)
      expect(fixture.attempts[1] - fixture.attempts[0]).toBeGreaterThanOrEqual(180)
      expect(fixture.attempts[2] - fixture.attempts[1]).toBeGreaterThanOrEqual(380)
      expect(provider.wsUnsuccessfulReconnects).toBe(3)
      expect(provider.wsconnecting).toBe(false)
      expect(provider.synced).toBe(false)
      expect(refused).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(fixture.sockets.size).toBe(0), { timeout: 5000 })
    } finally {
      provider.destroy(); doc.destroy(); await fixture.stop()
    }
  })
})
