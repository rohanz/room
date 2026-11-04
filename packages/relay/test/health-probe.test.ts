import { afterEach, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { relayIdentityProbe, relayProof } from '../src/proof.js'

const servers: http.Server[] = []
const sockets = new Set<Socket>()
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

async function listen(handler: http.RequestListener): Promise<{ port: number; closed: Promise<void> }> {
  let closed!: () => void
  const socketClosed = new Promise<void>(resolve => { closed = resolve })
  const server = http.createServer(handler)
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => closed()) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, closed: socketClosed }
}

it('answers a valid health line with its proof', async () => {
  const { port } = await listen((req, res) => {
    res.end(JSON.stringify({ ok: true, proof: relayProof('key', String(req.headers['x-room-nonce']), port) }))
  })
  const probe = await relayIdentityProbe(port, 'key', 2_000)
  expect(probe).toEqual({ identity: { health: expect.objectContaining({ ok: true }), proven: true }, timedOut: false })
})

it('enforces an absolute deadline on a listener that drips its health response', async () => {
  const { port, closed } = await listen((_req, res) => {
    res.writeHead(200)
    const drip = setInterval(() => res.write(' '), 50)
    res.on('close', () => clearInterval(drip))
  })
  const started = Date.now()
  expect(await relayIdentityProbe(port, 'key', 400)).toEqual({ timedOut: true })
  expect(Date.now() - started).toBeLessThan(1_500)
  await closed
})

it('settles once when the listener aborts mid-response', async () => {
  const { port } = await listen((_req, res) => {
    res.writeHead(200, { 'content-length': '100' })
    res.write('{"ok":')
    setTimeout(() => res.socket?.destroy(), 20)
  })
  expect(await relayIdentityProbe(port, 'key', 5_000)).toEqual({ identity: undefined, timedOut: false })
})

it('destroys the request at the byte cap instead of waiting for the end', async () => {
  const { port, closed } = await listen((_req, res) => {
    res.writeHead(200)
    res.write('x'.repeat(4096))
  })
  const started = Date.now()
  expect(await relayIdentityProbe(port, 'key', 5_000)).toEqual({ identity: undefined, timedOut: false })
  expect(Date.now() - started).toBeLessThan(2_000)
  await closed
})
