import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { serverAuthConfig } from '../src/session.js'

let server: http.Server | undefined
afterEach(() => { server?.close(); server = undefined })

describe('serverAuthConfig cache', () => {
  it('does not keep a failed lookup: a server that was down at first contact is read again once it answers', async () => {
    let up = false
    server = http.createServer((req, res) => {
      if (!up) { res.writeHead(500); res.end('down'); return }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ github: 'device' }))
    })
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`
    expect(await serverAuthConfig(url)).toEqual({ mode: 'token', providers: [] })
    up = true
    expect(await serverAuthConfig(url)).toEqual({ mode: 'device', providers: ['github'] })
  })
})
