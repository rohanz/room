/** Socket-level export regression. Run on a host that permits loopback listeners. */
import { afterAll, beforeAll, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { devServers } from './dev-server.js'

const servers = devServers()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-export-'))
const repo = 'github.com/archiver/project', archive = `${repo}/main`
let port: number, base: string
const post = (route: string, body: unknown) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeAll(async () => {
  const db = new LeveldbPersistence(dir)
  const doc = new Y.Doc()
  doc.getText('padding').insert(0, 'x'.repeat(8 * 1024 * 1024))
  await db.storeUpdate(archive, Y.encodeStateAsUpdate(doc))
  doc.destroy(); await db.destroy()
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({
    [repo]: { at: Date.now(), branches: [archive], legacy: [archive], mode: 'repo', migratedAt: Date.now() },
  }))
  port = await new Promise<number>((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => { const address = socket.address() as net.AddressInfo; socket.close(() => resolve(address.port)) })
  })
  base = `http://127.0.0.1:${port}`
  const proc = servers.start({ env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ROOM_SERVER: '',
    GITHUB_CLIENT_ID: 'fake', NODE_ENV: 'test', YPERSISTENCE: dir, ROOM_EXPORT_DEADLINE_MS: '3000' }, stdio: 'ignore' })
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) throw new Error('export test server exited')
    try { if ((await fetch(`${base}/health`)).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('export test server did not start')
}, 40_000)
afterAll(async () => { try { await servers.stopAll() } finally { fs.rmSync(dir, { recursive: true, force: true }) } })

it('holds one principal slot for a stalled client, then releases it on deadline', async () => {
  const started = await (await post('/auth/device', {})).json() as { device: string }
  const session = ((await (await post('/auth/poll', { device: started.device, fakeLogin: 'archiver' })).json()) as { session: string }).session
  const body = JSON.stringify({ room: archive, schema: 2, session })
  const raw = net.connect(port, '127.0.0.1')
  const firstHeaders = new Promise<void>((resolve, reject) => {
    raw.once('error', reject)
    raw.once('data', () => { raw.pause(); resolve() })
  })
  raw.write(`POST /archive/export HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`)
  await firstHeaders
  const busy = await post('/archive/export', { room: archive, schema: 2, session })
  expect(busy.status).toBe(429)
  expect(busy.headers.get('retry-after')).toBeTruthy()
  await new Promise(resolve => setTimeout(resolve, 3200))
  raw.resume()
  if (!raw.destroyed) await new Promise<void>(resolve => raw.once('close', () => resolve()))
  const later = await post('/archive/export', { room: archive, schema: 2, session })
  expect(later.status).toBe(200)
  await later.arrayBuffer()
}, 15_000)
