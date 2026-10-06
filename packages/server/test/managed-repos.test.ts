import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import WebSocket from 'ws'
import { devServers } from './dev-server.js'

const servers = devServers()
const dirs: string[] = []
afterEach(async () => { await servers.stopAll(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

it('only operators register rooms; GitHub collaborators join approved repos across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-managed-')); dirs.push(dir)
  const socket = net.createServer()
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = (socket.address() as net.AddressInfo).port
  await new Promise<void>(resolve => socket.close(() => resolve()))
  const base = `http://127.0.0.1:${port}`
  async function start(managed = true, admins = 'owner') {
    const proc = servers.start({ env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test', GITHUB_CLIENT_ID: 'fake', ROOM_TOKEN: 'fixture-secret', YPERSISTENCE: dir, ROOM_ADMINS: admins, ROOM_MANAGED_REPOS: String(managed) }, stdio: 'ignore' })
    await expect.poll(async () => { try { return (await fetch(`${base}/health`)).status } catch { return 0 } }, { timeout: 10000 }).toBe(200)
    return proc
  }
  const request = (route: string, body: unknown, session?: string, method = 'POST') => fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) }, body: JSON.stringify(body) })
  async function login(name: string) {
    const start = await (await request('/auth/start', { provider: 'github' })).json() as { device: string }
    const result = await (await request('/auth/poll', { device: start.device, fakeLogin: name })).json() as { session: string }
    expect(result.session).toBeTruthy()
    return result.session
  }
  const room = 'github.com/example/approved'
  let proc = await start()
  // The test issuer represents users with push access; production still uses GitHub's check.
  const owner = await login('owner'), collaborator = await login('collaborator')
  const opened = { room, schema: 2 }
  expect((await request('/rooms', opened, collaborator)).status).toBe(403)
  expect((await request('/rooms', opened)).status).toBe(403)
  expect((await request('/rooms', { room: 'local/token-bypass', schema: 2, token: 'fixture-secret' })).status).toBe(403)
  expect((await request('/rooms', opened, owner)).status).toBe(201)
  expect((await request('/view-token', opened, collaborator)).status).toBe(200)
  expect((await request('/rooms', { room: 'github.com/collaborator/unapproved', schema: 2 }, collaborator)).status).toBe(403)
  expect((await request('/rooms', opened, collaborator, 'DELETE')).status).toBe(403)
  const status = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?schema=2`, { headers: { authorization: `Bearer ${collaborator}` } })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('websocket admission timed out')) }, 5000)
    ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); res.resume(); resolve(res.statusCode!); ws.terminate() })
    ws.on('open', () => { clearTimeout(timer); ws.close(); resolve(101) })
    ws.on('error', () => {})
  })
  expect(status).toBe(101)
  await servers.stop(proc)
  proc = await start()
  expect((await request('/view-token', opened, collaborator)).status).toBe(200)
  expect((await request('/rooms', opened, collaborator, 'DELETE')).status).toBe(403)
  expect((await request('/rooms', opened, owner, 'DELETE')).status).toBe(200)
  expect((await request('/view-token', opened, collaborator)).status).toBe(404)
  await servers.stop(proc)
  proc = await start(true, '')
  expect((await request('/rooms', opened, owner)).status).toBe(403)
  await servers.stop(proc)
  proc = await start(false)
  expect((await request('/rooms', opened, collaborator)).status).toBe(201)
  await servers.stop(proc)
})
