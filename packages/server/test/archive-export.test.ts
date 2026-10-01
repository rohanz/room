/** Socket-level export regression. Run on a host that permits loopback listeners. */
import { afterAll, beforeAll, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { MAX_HTTP_RESPONSES_PER_PRINCIPAL } from '../src/limits.js'
import { devServers } from './dev-server.js'

const servers = devServers()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-export-'))
const repo = 'github.com/archiver/project', archive = `${repo}/main`
const compacted = `${repo}/compacted`, tooLarge = `${repo}/too-large`
// Registered legacy rooms: one never stored a record, one stored an empty document.
const absent = `${repo}/absent`, empty = `${repo}/empty`
const historical = [`${repo}/feature%2Fx`, `${repo}/a%252Fb`, 'github.com/Archiver/Project', `${repo}/`]
let port: number, base: string
const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${route}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})

beforeAll(async () => {
  const db = new LeveldbPersistence(dir)
  const doc = new Y.Doc()
  doc.getText('padding').insert(0, 'x'.repeat(8 * 1024 * 1024))
  await db.storeUpdate(archive, Y.encodeStateAsUpdate(doc))
  doc.destroy()
  for (const [name, mb] of [[compacted, 20], [tooLarge, 28]] as const) {
    const large = new Y.Doc()
    if (name === tooLarge) { large.getMap('fixture').set('small', true); await db.storeUpdate(name, Y.encodeStateAsUpdate(large)) }
    const vector = Y.encodeStateVector(large)
    large.getText('padding').insert(0, 'x'.repeat(mb * 1048576))
    await db.storeUpdate(name, Y.encodeStateAsUpdate(large, vector)); large.destroy()
  }
  for (const name of historical) {
    const old = new Y.Doc(); old.getMap('fixture').set('name', name)
    await db.storeUpdate(name, Y.encodeStateAsUpdate(old)); old.destroy()
  }
  const blank = new Y.Doc(); await db.storeUpdate(empty, Y.encodeStateAsUpdate(blank)); blank.destroy()
  const canonical = new Y.Doc()
  for (let i = 0; i < 1005; i++) canonical.getMap('unresolved').set(`key-${i}-${'x'.repeat(8192)}`, {})
  await db.storeUpdate(repo, Y.encodeStateAsUpdate(canonical))
  canonical.destroy(); await db.destroy()
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({
    [repo]: { at: Date.now(), branches: [archive, compacted, tooLarge, absent, empty, ...historical], legacy: [archive, compacted, tooLarge, absent, empty, ...historical], mode: 'repo', migratedAt: Date.now() },
  }))
  port = await new Promise<number>((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => { const address = socket.address() as net.AddressInfo; socket.close(() => resolve(address.port)) })
  })
  base = `http://127.0.0.1:${port}`
  const proc = servers.start({ env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ROOM_SERVER: '',
    GITHUB_CLIENT_ID: 'fake', NODE_ENV: 'test', YPERSISTENCE: dir, ROOM_DOC_MAX_MB: '24', ROOM_ADMINS: 'archiver', ROOM_TEST_INVENTORY_DELAY_MS: '700', ROOM_TEST_ARCHIVE_LOAD_DELAY_MS: '700' }, stdio: 'ignore' }, { EXPORT_DEADLINE_MS: 3000 })
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) throw new Error('export test server exited')
    try { if ((await fetch(`${base}/health`)).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('export test server did not start')
}, 40_000)
afterAll(async () => { try { await servers.stopAll() } finally { fs.rmSync(dir, { recursive: true, force: true }) } })

// /auth/device allows 10 starts per minute per address; the file's tests share one server.
const sessions = new Map<string, Promise<string>>()
function login(name = 'archiver'): Promise<string> {
  let session = sessions.get(name)
  if (!session) {
    session = (async () => {
      const started = await (await post('/auth/device', {})).json() as { device: string }
      return ((await (await post('/auth/poll', { device: started.device, fakeLogin: name })).json()) as { session: string }).session
    })()
    sessions.set(name, session)
  }
  return session
}
it('exports a single 20 MB snapshot as one frame despite the websocket message cap', async () => {
  const session = await login(), result = await post('/archive/export', { room: compacted, schema: 2, session })
  expect(result.status).toBe(200)
  expect(result.headers.get('content-type')).toBe('application/vnd.room.updates')
  const framed = Buffer.from(await result.arrayBuffer()), length = framed.readUInt32BE(0)
  expect(length).toBeGreaterThan(20 * 1048576)
  expect(framed.length).toBe(length + 4)
  const doc = new Y.Doc(); Y.applyUpdate(doc, framed.subarray(4))
  expect(doc.getText('padding').length).toBe(20 * 1048576); doc.destroy()
}, 15_000)
it('refuses an oversized later record before sending any archive headers or frames', async () => {
  const session = await login(), result = await post('/archive/export', { room: tooLarge, schema: 2, session })
  expect(result.status).toBe(507)
  expect(result.headers.get('content-type')).toBe('text/plain')
  expect(await result.text()).toContain('ROOM_DOC_MAX_MB')
})
it('refuses a registered archive with no stored document with 404 and a reason, before any frames', async () => {
  const session = await login(), result = await post('/archive/export', { room: absent, schema: 2, session })
  expect(result.status).toBe(404)
  expect(result.headers.get('content-type')).toBe('text/plain')
  expect(await result.text()).toBe(`no stored document for ${absent}`)
})
it('exports a stored empty document as one empty-update frame', async () => {
  const session = await login(), result = await post('/archive/export', { room: empty, schema: 2, session })
  expect(result.status).toBe(200)
  expect(result.headers.get('content-type')).toBe('application/vnd.room.updates')
  const framed = Buffer.from(await result.arrayBuffer())
  expect(framed.readUInt32BE(0)).toBe(framed.length - 4)
  const doc = new Y.Doc(); Y.applyUpdate(doc, framed.subarray(4)); expect(doc.share.size).toBe(0); doc.destroy()
})
it('exports exact percent-containing legacy names and refuses their purge', async () => {
  const session = await login(), headers = { authorization: `Bearer ${session}` }
  for (const name of historical) {
    const result = await post('/archive/export', { room: name, schema: 2, session })
    expect(result.status).toBe(200)
    const frame = Buffer.from(await result.arrayBuffer()), doc = new Y.Doc()
    Y.applyUpdate(doc, frame.subarray(4)); expect(doc.getMap('fixture').get('name')).toBe(name); doc.destroy()
    expect((await post('/admin/purge', { name, confirm: name }, headers)).status).toBe(403)
  }
})

it('coalesces admin inventory requests and releases disconnected waiters before the scan ends', async () => {
  const session = await login(), headers = { authorization: `Bearer ${session}` }
  const url = `${base}/admin/inventory`
  // Let startup inventory settle before measuring request-triggered scans.
  await (await fetch(url, { headers })).arrayBuffer()
  const count = async () => ((await (await fetch(`${base}/health`)).json()) as { inventoryScans: number }).inventoryScans
  const before = await count(), controllers = Array.from({ length: MAX_HTTP_RESPONSES_PER_PRINCIPAL }, () => new AbortController())
  const waiting = controllers.map(controller => fetch(url, { headers, signal: controller.signal }).catch(() => undefined))
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(await count()).toBe(before + 1)
  controllers.forEach(controller => controller.abort()); await Promise.all(waiting)
  await new Promise(resolve => setTimeout(resolve, 50))
  const [a, b] = await Promise.all([fetch(url, { headers }), fetch(url, { headers })])
  expect(a.status).toBe(200); expect(b.status).toBe(200)
  expect(await a.json()).toEqual(await b.json())
  expect(await count()).toBe(before + 1)
}, 15_000)

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
  expect(later.headers.get('content-type')).toBe('application/vnd.room.updates')
  const framed = Buffer.from(await later.arrayBuffer()), doc = new Y.Doc()
  for (let at = 0; at < framed.length;) { const length = framed.readUInt32BE(at); at += 4; Y.applyUpdate(doc, framed.subarray(at, at + length)); at += length }
  expect(doc.getText('padding').length).toBe(8 * 1024 * 1024); doc.destroy()
}, 15_000)

it('holds streaming slots for stalled readers and releases them on disconnect', async () => {
  const sessions: string[] = []
  for (const login of ['archiver-a', 'archiver-b', 'archiver-c']) {
    const started = await (await post('/auth/device', {})).json() as { device: string }
    sessions.push(((await (await post('/auth/poll', { device: started.device, fakeLogin: login })).json()) as { session: string }).session)
  }
  const raw = sessions.slice(0, 2).map(() => net.connect(port, '127.0.0.1'))
  try {
    await Promise.all(raw.map((socket, i) => new Promise<void>((resolve, reject) => {
      const body = JSON.stringify({ room: archive, schema: 2, session: sessions[i] })
      socket.once('error', reject)
      socket.once('data', () => { socket.pause(); resolve() })
      socket.write(`POST /archive/export HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    })))
    expect((await post('/archive/export', { room: archive, schema: 2, session: sessions[2] })).status).toBe(429)
    raw.forEach(socket => socket.destroy())
    await new Promise(resolve => setTimeout(resolve, 150))
    const later = await post('/archive/export', { room: archive, schema: 2, session: sessions[2] })
    expect(later.status).toBe(200)
    await later.arrayBuffer()
  } finally { raw.forEach(socket => socket.destroy()) }
}, 15_000)

it('coalesces concurrent archive listings into one canonical load', async () => {
  const started = await (await post('/auth/device', {})).json() as { device: string }
  const session = ((await (await post('/auth/poll', { device: started.device, fakeLogin: 'archiver-list' })).json()) as { session: string }).session
  const count = async () => ((await (await fetch(`${base}/health`)).json()) as { archiveLoads: number }).archiveLoads
  const before = await count()
  const url = `${base}/archive?repo=${encodeURIComponent(repo)}`
  const headers = { authorization: `Bearer ${session}` }
  const [a, b] = await Promise.all([fetch(url, { headers }), fetch(url, { headers })])
  expect(a.status).toBe(200)
  expect(b.status).toBe(200)
  const [listingA, listingB] = await Promise.all([a.json(), b.json()])
  expect(listingA).toEqual(listingB)
  expect(listingA.unresolved).toHaveLength(1000)
  expect(listingA.unresolvedTotal).toBe(1005)
  expect(listingA.truncated).toBe(true)
  expect(await count()).toBe(before + 1)
}, 15_000)


it('bounds coalesced listing waiters before load completion', async () => {
  const started = await (await post('/auth/device', {})).json() as { device: string }
  const session = ((await (await post('/auth/poll', { device: started.device, fakeLogin: 'archiver-bounded' })).json()) as { session: string }).session
  const url = `${base}/archive?repo=${encodeURIComponent(repo)}`, headers = { authorization: `Bearer ${session}` }
  const pending = Array.from({ length: MAX_HTTP_RESPONSES_PER_PRINCIPAL }, () => fetch(url, { headers }))
  await new Promise(resolve => setTimeout(resolve, 150))
  const excess = await fetch(url, { headers })
  expect(excess.status).toBe(429)
  expect(excess.headers.get('retry-after')).toBeTruthy()
  const responses = await Promise.all(pending)
  expect(responses.map(r => r.status)).toEqual(Array(MAX_HTTP_RESPONSES_PER_PRINCIPAL).fill(200))
  await Promise.all(responses.map(r => r.arrayBuffer()))
}, 15_000)

it('ends stalled listing readers on the response deadline and releases their identity slots', async () => {
  const started = await (await post('/auth/device', {})).json() as { device: string }
  const session = ((await (await post('/auth/poll', { device: started.device, fakeLogin: 'archiver-stalled-list' })).json()) as { session: string }).session
  const path = `/archive?repo=${encodeURIComponent(repo)}`
  const sockets = Array.from({ length: MAX_HTTP_RESPONSES_PER_PRINCIPAL }, () => net.connect(port, '127.0.0.1'))
  await Promise.all(sockets.map(socket => new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.once('data', () => { socket.pause(); resolve() })
    socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${session}\r\nConnection: keep-alive\r\n\r\n`)
  })))
  const blocked = await fetch(base + path, { headers: { authorization: `Bearer ${session}` } })
  expect(blocked.status).toBe(429)
  await new Promise(resolve => setTimeout(resolve, 3200))
  sockets.forEach(socket => { socket.resume(); socket.destroy() })
  const later = await fetch(base + path, { headers: { authorization: `Bearer ${session}` } })
  expect(later.status).toBe(200)
  await later.arrayBuffer()
}, 15_000)
