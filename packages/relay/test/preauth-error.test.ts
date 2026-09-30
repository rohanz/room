import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { WebSocket } from 'ws'
import { relayConnectionHandler } from '../src/index.js'

describe('relay pre-authentication websocket errors', () => {
  it('installs the error listener first, clears the handshake, and terminates', () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const socket = new EventEmitter() as EventEmitter & { terminate(): void; close(): void }
      const on = socket.on.bind(socket)
      socket.on = ((event: string, listener: (...args: unknown[]) => void) => {
        events.push(event)
        return on(event, listener)
      }) as typeof socket.on
      const terminate = vi.fn(() => socket.emit('close'))
      socket.terminate = terminate
      socket.close = vi.fn(() => socket.emit('close'))
      const log = vi.fn()
      relayConnectionHandler(new Map(), { key: 'test-key', log })(socket as unknown as WebSocket, { url: '/local%2Fx?schema=2' } as http.IncomingMessage)
      expect(events[0]).toBe('error')
      expect(vi.getTimerCount()).toBe(1)
      expect(() => socket.emit('error', new Error('invalid opcode'))).not.toThrow()
      expect(terminate).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      expect(log).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})
