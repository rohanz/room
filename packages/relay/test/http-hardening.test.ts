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
      expect((await fetch(`http://127.0.0.1:${relay.port}/health`)).status).toBe(200)
    } finally { await relay.close() }
  })
})
