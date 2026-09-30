/** Production-shaped crash containment: the unsafe loader must fail in a bounded child heap. */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import { devServers } from './dev-server.js'

const repo = 'github.com/o/r', encoded = 'github.com%2Fo%2Fr%2Fenterprise', huge = `${repo}/large`, branch = `${repo}/main`
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-oversized-')), servers = devServers()
beforeAll(async () => {
  const provider = new LeveldbPersistence(dir)
  try {
    const small = new Y.Doc(); small.getMap('scopes').set('alice', { by: 'alice', byKind: 'agent', area: 'core', summary: 'small', paths: [], at: 1 })
    await provider.storeUpdate(branch, Y.encodeStateAsUpdate(small)); small.destroy()
    for (const [name, count] of [[encoded, 1100], [huge, 280]] as const) {
      for (let i = 0; i < count; i++) {
        const doc = new Y.Doc(); doc.getMap('padding').set(`record-${i}`, 'x'.repeat(150 * 1024))
        await provider.storeUpdate(name, Y.encodeStateAsUpdate(doc)); doc.destroy()
      }
    }
  } finally { await provider.destroy() }
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ [repo]: { at: Date.now(), branches: [branch, huge], mode: 'branch' } }))
}, 180_000)
afterAll(async () => { try { await servers.stopAll() } finally { fs.rmSync(dir, { recursive: true, force: true }) } })

it('migrates in a 128 MB child heap without loading or clearing oversized keys', async () => {
  const result = path.join(dir, 'result.json'), start = Date.now()
  const child = spawn(process.execPath, ['--max-old-space-size=128', '--import', 'tsx', fileURLToPath(new URL('./helpers/oversized-migration-child.ts', import.meta.url)), dir, result], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-8000) })
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('migration child timed out')) }, 120_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
  })
  console.log(`migration child: code=${exit.code} signal=${exit.signal} elapsed=${Date.now() - start}ms`)
  expect(exit, stderr).toEqual({ code: 0, signal: null })
  const found = JSON.parse(fs.readFileSync(result, 'utf8'))
  expect(found.entry.migratedAt).toBeGreaterThan(0)
  expect(found.entry.quarantined.map((q: { name: string }) => q.name)).toEqual(expect.arrayContaining([encoded, huge]))
  expect(found.entry.legacy).toContain(huge)
  expect(found.entry.migrationSkippedRecordCountsUnknown).toBeGreaterThan(0)
  expect(found.loaded).not.toContain(encoded); expect(found.loaded).not.toContain(huge)
  expect(found.cleared).toEqual([])
  expect(found.names).toEqual(expect.arrayContaining([encoded, huge]))
}, 150_000)

it('keeps the real server healthy and streams oversized archives after opening schema 2', async () => {
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const address = server.address() as net.AddressInfo; server.close(() => resolve(address.port)) })
  })
  const base = `http://127.0.0.1:${port}`
  const proc = servers.start({ env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=128', HOST: '127.0.0.1', PORT: String(port), ROOM_SERVER: '', GITHUB_CLIENT_ID: 'fake', NODE_ENV: 'test', YPERSISTENCE: dir, ROOM_ADMINS: 'operator' }, stdio: 'ignore' })
  try {
    for (let i = 0; i < 200; i++) {
      if (proc.exitCode !== null || proc.signalCode !== null) throw Error('server exited')
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const { device } = await (await post('/auth/device', {})).json() as { device: string }
    const { session } = await (await post('/auth/poll', { device, fakeLogin: 'operator' })).json() as { session: string }
    const opened = await post('/rooms', { room: repo, schema: 2, session })
    expect([200, 201]).toContain(opened.status)
    expect((await fetch(`${base}/health`)).ok).toBe(true)
    const inventory = await fetch(`${base}/admin/inventory`, { headers: { authorization: `Bearer ${session}` } })
    expect(inventory.status).toBe(200)
    expect((await inventory.json()).docs).toContainEqual(expect.objectContaining({ name: encoded, kind: 'never-served', over: true }))
    const exported = await post('/archive/export', { room: huge, schema: 2, session })
    expect(exported.status).toBe(200); expect(exported.headers.get('content-type')).toBe('application/vnd.room.updates')
    // Count frames incrementally: the test must not buffer or apply a 40 MB archive in the server child.
    const reader = exported.body!.getReader()
    let header: number[] = [], remaining = 0, frames = 0, bytes = 0
    for (;;) {
      const { done, value } = await reader.read(); if (done) break
      bytes += value.length
      for (let at = 0; at < value.length;) {
        if (remaining) { const n = Math.min(remaining, value.length - at); remaining -= n; at += n }
        else { header.push(value[at++]); if (header.length === 4) { remaining = Buffer.from(header).readUInt32BE(); header = []; frames++ } }
      }
    }
    expect(remaining).toBe(0); expect(header).toEqual([]); expect(frames).toBe(280); expect(bytes).toBeGreaterThan(32 * 1048576)
    expect((await fetch(`${base}/health`)).ok).toBe(true)
    expect((await fetch(`${base}/admin/inventory`)).status).toBe(401)
    const admin = { authorization: `Bearer ${session}` }
    expect((await post('/admin/purge', { name: encoded, confirm: 'wrong' }, admin)).status).toBe(400)
    expect((await post('/admin/purge', { name: huge, confirm: huge }, admin)).status).toBe(403)
    expect((await post('/archive/export', { room: encoded, schema: 2, session })).status).toBe(404)
    const purged = await post('/admin/purge', { name: encoded, confirm: encoded }, admin)
    expect(purged.status).toBe(200)
    expect(await purged.json()).toEqual({ purged: encoded })
    const after = await (await fetch(`${base}/admin/inventory`, { headers: { authorization: `Bearer ${session}` } })).json()
    expect(after.docs.map((doc: { name: string }) => doc.name)).not.toContain(encoded)
  } finally { await servers.stop(proc) }
}, 120_000)
