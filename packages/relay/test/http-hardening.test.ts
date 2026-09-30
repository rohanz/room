import { describe, expect, it } from 'vitest'
import { safeUrl } from '../src/index.js'

describe('relay request target', () => {
  it('M5 rejects a malformed HTTP or upgrade target before checking the key', () => {
    expect(() => safeUrl('//[')).toThrow('Bad Request')
    expect(safeUrl('/health').pathname).toBe('/health')
  })
})

describe('relay sockets', () => {
  it('M5 a malformed target gets 400 on HTTP and on upgrade, and the relay keeps serving', async () => {
    const { startRelay } = await import('../src/index.js')
    const net = await import('node:net')
    const relay = await startRelay(0, { key: 'test-key' })
    const raw = (request: string) => new Promise<string>((resolve, reject) => {
      const socket = net.connect(relay.port, '127.0.0.1', () => socket.write(request))
      let out = ''
      socket.on('data', chunk => { out += chunk })
      socket.on('close', () => resolve(out))
      socket.on('error', reject)
      setTimeout(() => socket.destroy(), 3000)
    })
    try {
      expect(await raw('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 400 /)
      expect(await raw('GET //[?key=test-key&schema=2 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')).toMatch(/^HTTP\/1\.1 400 /)
      // A well-formed upgrade without the key is still refused: the parser change does not bypass the key check.
      expect(await raw('GET /local%2Fx?schema=2 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')).toMatch(/^HTTP\/1\.1 403 /)
      // A client that resets while its upgrade is being refused must not raise an unhandled EPIPE.
      const reset = (request: string) => new Promise<void>((resolve, reject) => {
        const socket = net.connect(relay.port, '127.0.0.1')
        socket.on('error', reject)
        socket.on('connect', () => socket.write(request, () => { socket.resetAndDestroy(); resolve() }))
      })
      const upgrade = (target: string) => `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`
      for (let i = 0; i < 10; i++) for (const target of ['//[', '/local%2Fx?schema=2', '/local%2Fx']) await reset(upgrade(target))
      await new Promise(r => setTimeout(r, 300))
      expect((await fetch(`http://127.0.0.1:${relay.port}/health`)).status).toBe(200)
    } finally { await relay.close() }
  })
})
