/**
 * The real server process with the fake GitHub issuer: login -> open a github.com repo -> join
 * its branch room over a websocket. Also the refusals every entry point must give: a forwarded
 * GitHub token, and ROOM_TOKEN on a github.com room.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
let proc: ChildProcess, port = 0, base = ''
const logs: string[] = []

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)) })
  })
}
async function startServer(env: Record<string, string>): Promise<ChildProcess> {
  const p = spawn(process.execPath, [path.resolve(here, '../../../node_modules/tsx/dist/cli.mjs'), path.resolve(here, '../src/index.ts')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ROOM_SERVER: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  p.stdout!.on('data', d => logs.push(String(d))); p.stderr!.on('data', d => logs.push(String(d)))
  for (let i = 0; i < 200; i++) {
    if (p.exitCode !== null) throw new Error(`server exited: ${logs.join('')}`)
    try { if ((await fetch(`${base}/health`)).ok) return p } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`server did not start: ${logs.join('')}`)
}
const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
/** Connect a websocket to the room; resolves with the HTTP status of a refusal, or 101 when accepted. */
function join(room: string, query: Record<string, string>): Promise<number> {
  const q = new URLSearchParams(query).toString()
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}${q ? `?${q}` : ''}`)
    ws.on('open', () => { ws.close(); resolve(101) })
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate() })
    ws.on('error', () => resolve(0))
  })
}
async function login(fakeLogin: string): Promise<string> {
  const start = await (await post('/auth/device', {})).json() as { device: string; user_code: string }
  expect(start.user_code).toBe('FAKE-0000')
  const pending = await (await post('/auth/poll', { device: start.device })).json()
  expect(pending).toEqual({ pending: true })
  const done = await (await post('/auth/poll', { device: start.device, fakeLogin })).json() as { session?: string; login?: string }
  expect(done).toMatchObject({ login: fakeLogin, provider: 'github' })
  return done.session!
}

beforeAll(async () => {
  port = await freePort(); base = `http://127.0.0.1:${port}`
  proc = await startServer({ GITHUB_CLIENT_ID: 'fake', ROOM_TOKEN: 'shared', NODE_ENV: 'test' })
}, 30_000)
afterAll(() => { proc?.kill() })

describe('room server with the fake GitHub issuer', () => {
  it('advertises device mode with the fake flag', async () => {
    expect(await (await fetch(`${base}/auth/config`)).json()).toMatchObject({ github: 'device', providers: ['github'], fake: true })
  })

  it('fake login -> open a github.com repo -> join its branch room', async () => {
    const session = await login('octo')
    expect(await (await fetch(`${base}/auth/me?session=${session}`)).json()).toEqual({ login: 'octo', provider: 'github' })
    const open = await post('/rooms', { room: 'github.com/o/r/main', session })
    expect(open.status).toBe(201)
    expect(await open.json()).toMatchObject({ repo: 'github.com/o/r', created: true, login: 'octo' })
    expect(await join('github.com/o/r/main', { session })).toBe(101)
    expect(await join('github.com/o/r/feature/x', { session })).toBe(101) // any branch of an open repo
    const listed = await (await fetch(`${base}/rooms?session=${session}`)).json() as { repo: string }[]
    expect(listed.map(r => r.repo)).toContain('github.com/o/r')
    // the fake issuer holds no real GitHub token: the PR proxy refuses rather than calling GitHub
    expect((await fetch(`${base}/github/prs?room=${encodeURIComponent('github.com/o/r/main')}&session=${session}`)).status).toBe(403)
  })

  it('a forwarded GitHub token is refused with 401 at every entry point', async () => {
    const open = await post('/rooms', { room: 'github.com/o/r/main', gh: 'gho_real' })
    expect(open.status).toBe(401)
    expect(await open.text()).toContain('room_login')
    expect(await join('github.com/o/r/main', { gh: 'gho_real' })).toBe(401)
    expect((await post('/view-token', { room: 'github.com/o/r/main', gh: 'gho_real' })).status).toBe(401)
  })

  it('ROOM_TOKEN opens and joins non-GitHub rooms but never a github.com room', async () => {
    expect((await post('/rooms', { room: 'local/origin/main', token: 'shared' })).status).toBe(201)
    expect(await join('local/origin/main', { token: 'shared' })).toBe(101)
    expect(await join('local/origin/main', { token: 'wrong' })).toBe(401)
    const gh = await post('/rooms', { room: 'github.com/o/other/main', token: 'shared' })
    expect(gh.status).toBe(401)
    expect(await gh.text()).toMatch(/ROOM_TOKEN does not admit GitHub rooms/)
    expect(await join('github.com/o/r/main', { token: 'shared' })).toBe(401)
  })

  it('a login session enters non-GitHub rooms too; no credentials at all is 401', async () => {
    const session = await login('kieran')
    expect(await join('local/origin/main', { session })).toBe(101)
    expect(await join('local/origin/main', {})).toBe(401)
    expect(await join('github.com/o/r/main', {})).toBe(401)
  })
})

describe('room server refuses the fake issuer in production', () => {
  it('exits at startup', async () => {
    const p2 = spawn(process.execPath, [path.resolve(here, '../../../node_modules/tsx/dist/cli.mjs'), path.resolve(here, '../src/index.ts')], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(await freePort()), GITHUB_CLIENT_ID: 'fake', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let err = ''
    p2.stderr!.on('data', d => { err += d })
    const code = await new Promise<number | null>(r => p2.on('exit', r))
    expect(code).toBe(1)
    expect(err).toContain('test issuer')
  }, 30_000)
})
