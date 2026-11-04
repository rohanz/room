import { afterAll, beforeAll, expect, it } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { devServers } from './dev-server.js'

const servers = devServers()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-logout-durable-'))
const sessionsFile = path.join(dir, 'sessions.json')
let base: string
const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeAll(async () => {
  const port = await new Promise<number>((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)) }) })
  base = `http://127.0.0.1:${port}`
  const logs: string[] = []
  const proc = servers.start({ env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ROOM_SERVER: '', GITHUB_CLIENT_ID: 'fake', YPERSISTENCE: dir, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout!.on('data', d => logs.push(String(d))); proc.stderr!.on('data', d => logs.push(String(d)))
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited: ${logs.join('')}`)
    try { if ((await fetch(base + '/health')).ok) return } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`server did not start: ${logs.join('')}`)
}, 30_000)
afterAll(async () => { await servers.stopAll(); fs.rmSync(dir, { recursive: true, force: true }) })

it('answers a retryable 503 to logout until the deletion is stored', async () => {
  const { device } = await (await post('/auth/device', {})).json() as { device: string }
  const { session } = await (await post('/auth/poll', { device, fakeLogin: 'durable' })).json() as { session: string }
  for (let i = 0; i < 50 && !fs.existsSync(sessionsFile); i++) await new Promise(r => setTimeout(r, 20))
  const good = fs.readFileSync(sessionsFile, 'utf8')
  expect(good).toContain(session)
  fs.writeFileSync(sessionsFile, good.slice(0, 10))
  const failed = await post('/auth/logout', { session })
  expect(failed.status).toBe(503)
  expect(await failed.json()).toMatchObject({ ok: false, retryable: true })
  expect((await fetch(base + '/auth/me', { headers: { authorization: `Bearer ${session}` } })).status).toBe(401)
  fs.writeFileSync(sessionsFile, good)
  const retried = await post('/auth/logout', { session })
  expect(retried.status).toBe(200)
  expect(await retried.json()).toEqual({ ok: true })
  expect(fs.readFileSync(sessionsFile, 'utf8')).not.toContain(session)
})
