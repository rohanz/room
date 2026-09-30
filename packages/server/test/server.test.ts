/**
 * The real server process with the fake GitHub issuer: login -> open a github.com repo -> join
 * its branch room over a websocket. Also the refusals every entry point must give: a forwarded
 * GitHub token, and ROOM_TOKEN on a github.com room.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import { devServers } from './dev-server.js'

const servers = devServers()
let proc: ChildProcess, port = 0, base = ''
const persistenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-server-test-'))
const logs: string[] = []

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)) })
  })
}
async function startServer(env: Record<string, string>): Promise<ChildProcess> {
  const p = servers.start({
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
  const { session, token, ...params } = query
  const schema2 = params.schema === '2'
  const q = new URLSearchParams(schema2 || token ? params : query).toString()
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}${q ? `?${q}` : ''}`, { headers: { ...(schema2 && session ? { authorization: `Bearer ${session}` } : {}), ...(token ? { 'x-room-token': token } : {}) } })
    ws.on('open', () => { ws.close(); resolve(101) })
    ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate() })
    ws.on('error', () => resolve(0))
  })
}
function sendMemberUpdate(room: string, session: string, change: (doc: Y.Doc) => void): Promise<void> {
  const doc = new Y.Doc()
  change(doc)
  const message = encoding.createEncoder()
  encoding.writeVarUint(message, 0)
  syncProtocol.writeUpdate(message, Y.encodeStateAsUpdate(doc))
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?schema=2`, { headers: { authorization: `Bearer ${session}` } })
    ws.on('open', () => {
      ws.send(encoding.toUint8Array(message))
      setTimeout(() => { ws.close(); doc.destroy(); resolve() }, 50)
    })
    ws.on('error', reject)
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
  proc = await startServer({ GITHUB_CLIENT_ID: 'fake', ROOM_TOKEN: 'shared', ROOM_ADMINS: 'bob', ROOM_IDENTITY_GUARD: '', NODE_ENV: 'test', YPERSISTENCE: persistenceDir })
}, 30_000)
afterAll(async () => { try { await servers.stopAll() } finally { fs.rmSync(persistenceDir, { recursive: true, force: true }) } })

describe('room server with the fake GitHub issuer', () => {
  it('refuses incomplete GitHub parents before admission and preserves the victim room', async () => {
    const session = await login('namespace-victim')
    const victim = 'github.com/namespace-victim/private'
    expect((await post('/rooms', { room: victim, session, schema: 2 })).status).toBe(201)
    for (const parent of ['github.com', 'github.com/namespace-victim']) {
      expect((await post('/rooms', { room: parent, session, schema: 2 })).status).toBe(400)
      expect((await post('/view-token', { room: parent, session, schema: 2 })).status).toBe(400)
      expect((await fetch(`${base}/archive?repo=${encodeURIComponent(parent)}`, { headers: { authorization: `Bearer ${session}` } })).status).toBe(400)
      expect((await post('/archive/export', { room: parent, session, schema: 2 })).status).toBe(400)
      expect((await fetch(`${base}/github/prs?room=${encodeURIComponent(parent)}`, { headers: { authorization: `Bearer ${session}` } })).status).toBe(400)
      expect((await post('/github/pr-note', { room: parent, session, number: 1, body: 'note' })).status).toBe(400)
      expect((await fetch(`${base}/?view=x&room=${encodeURIComponent(`${base}/${encodeURIComponent(parent)}`)}`)).status).toBe(400)
      expect((await fetch(`${base}/rooms`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: parent, session, schema: 2 }) })).status).toBe(400)
      expect(await join(parent, { session, schema: '2' })).toBe(400)
    }
    expect((await post('/view-token', { room: victim, session, schema: 2 })).status).toBe(200)
    expect(await join(victim, { session, schema: '2' })).toBe(101)
    expect(await join(`${victim}/main`, { session, schema: '2' })).toBe(400)
  })
  it('refuses new 0.16 branch population and keeps schema-2 access', async () => {
    const session = await login('cutover')
    const room = 'github.com/cutover/project'
    const oldText = `update Room to 0.17 or later: this repository now has one room for all branches (${room})`
    const oldOpen = await post('/rooms', { room: `${room}/main`, session })
    expect(oldOpen.status).toBe(403)
    expect(await oldOpen.text()).toBe(oldText)
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    expect((await post('/view-token', { room, schema: 2 })).status).toBe(401)
    const migrated = await post('/view-token', { room, session, schema: 2 })
    expect(migrated.status).toBe(200)
    expect(await migrated.json()).toMatchObject({ room, hub: 1 })
    for (const [route, body] of [
      ['/view-token', { room: `${room}/main`, session }],
      ['/rooms', { room: `${room}/main`, session }],
    ] as const) {
      const refused = await post(route, body)
      expect(refused.status).toBe(403)
      expect(await refused.text()).toBe(oldText)
    }
    // Admission comes first: without a login the upgrade text is not an oracle for which repositories have rooms.
    expect((await post('/view-token', { room: `${room}/main` })).status).toBe(401)
    expect(await join(`${room}/main`, { session })).toBe(403)
    expect(await join(room, { session, schema: '2' })).toBe(101)
    const alias = await post('/rooms', { room: `${room}/main`, session, schema: 2 })
    expect(alias.status).toBe(400)
    expect(await alias.text()).toContain('invalid room name')
  })

  it('refuses a 0.16 socket with the upgrade text', async () => {
    const session = await login('old-socket')
    const room = 'github.com/socket/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    expect(await join(`${room}/main`, { session })).toBe(403)
  })

  it('keeps old members in an unmigrated canonical-key room, but refuses its token to a schema-2 viewer', async () => {
    const session = await login('canonical-view')
    const room = 'github.com/canonical/view'
    expect((await post('/rooms', { room, session })).status).toBe(403)
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    expect(await join(room, { session })).toBe(403)
    expect((await post('/view-token', { room, session, schema: 2 })).status).toBe(200)
  })

  it('returns an actionable 410 page and websocket refusal for an archived branch link', async () => {
    const session = await login('old-link')
    const room = 'github.com/old-link/project'
    const branch = `${room}/main`
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    const view = 'retired-branch-view'
    const link = `${base}/?room=${encodeURIComponent(`ws://127.0.0.1:${port}/${encodeURIComponent(branch)}`)}&view=${view}`
    const page = await fetch(link)
    expect(page.status).toBe(410)
    expect(await page.text()).toContain('this link was for a branch room that no longer exists; ask a teammate for a new link')
    // A view key in a websocket URL is refused outright; the ticket exchange carries the explanation.
    expect(await join(branch, { schema: '2', view })).toBe(400)
    const ticket = await post('/ws-ticket', { room: branch, schema: 2, view })
    expect(ticket.status).toBe(410)
  })

  it('does not create legacy archives in a fresh schema-2 room and closes while unjoined', async () => {
    const session = await login('archiver')
    const room = 'github.com/archive/project'
    expect((await post('/rooms', { room, session, schema: 2 })).status).toBe(201)
    expect((await post('/view-token', { room, session, schema: 2 })).status).toBe(200)
    const archive = await post('/archive/export', { room: `${room}/main`, session, schema: 2 })
    expect(archive.status).toBe(404)
    expect((await post('/archive/export', { room: `${room}/main`, view: 'token', schema: 2 })).status).toBe(403)
    const closed = await fetch(`${base}/rooms`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, session, schema: 2 }) })
    expect(closed.status).toBe(200)
    expect(await join(room, { session, schema: '2' })).toBe(404)
  })
  it('advertises device mode with the fake flag', async () => {
    expect(await (await fetch(`${base}/auth/config`)).json()).toMatchObject({ github: 'device', providers: ['github'], fake: true })
  })

  it('fake login -> open a github.com repo -> join its repository room', async () => {
    const session = await login('octo')
    expect(await (await fetch(`${base}/auth/me`, { headers: { authorization: `Bearer ${session}` } })).json()).toEqual({ login: 'octo', provider: 'github' })
    const open = await post('/rooms', { room: 'github.com/o/r', session, schema: 2 })
    expect(open.status).toBe(201)
    expect(await open.json()).toMatchObject({ repo: 'github.com/o/r', created: true, login: 'octo' })
    expect(await join('github.com/o/r', { session, schema: '2' })).toBe(101)
    expect(await join('github.com/o/r/feature/x', { session })).toBe(403)
    const listed = await (await fetch(`${base}/rooms`, { headers: { authorization: `Bearer ${session}` } })).json() as { repo: string }[]
    expect(listed.map(r => r.repo)).toContain('github.com/o/r')
    // the fake issuer holds no real GitHub token: the PR proxy refuses rather than calling GitHub
    expect((await fetch(`${base}/github/prs?room=${encodeURIComponent('github.com/o/r/main')}`, { headers: { authorization: `Bearer ${session}` } })).status).toBe(403)
  })

  it('a forwarded GitHub token is refused with 401 at every entry point', async () => {
    const open = await post('/rooms', { room: 'github.com/o/r/main', gh: 'gho_real' })
    expect(open.status).toBe(401)
    expect(await open.text()).toContain('room_login')
    expect(await join('github.com/o/r/main', { gh: 'gho_real' })).toBe(400)
    expect((await post('/view-token', { room: 'github.com/o/r/main', gh: 'gho_real' })).status).toBe(401)
  })

  it('ROOM_TOKEN opens and joins non-GitHub rooms but never a github.com room', async () => {
    expect((await post('/rooms', { room: 'local/origin', token: 'shared', schema: 2 })).status).toBe(201)
    expect(await join('local/origin', { token: 'shared', schema: '2' })).toBe(101)
    expect(await join('local/origin', { token: 'wrong', schema: '2' })).toBe(401)
    const gh = await post('/rooms', { room: 'github.com/o/other/main', token: 'shared' })
    expect(gh.status).toBe(401)
    expect(await gh.text()).toMatch(/ROOM_TOKEN does not admit GitHub rooms/)
    expect(await join('github.com/o/r/main', { token: 'shared' })).toBe(401)
  })

  it('a login session enters non-GitHub rooms too; no credentials at all is 401', async () => {
    const session = await login('kieran')
    expect(await join('local/origin', { session, schema: '2' })).toBe(101)
    expect(await join('local/origin', { schema: '2' })).toBe(401)
    expect(await join('github.com/o/r/main', {})).toBe(401)
  })

  it('logs and audits an observed identity objection while applying the member update', async () => {
    const session = await login('bob')
    const repo = 'github.com/o/identity'
    expect((await post('/rooms', { room: repo, session, schema: 2 })).status).toBe(201)
    await sendMemberUpdate(repo, session, doc => doc.getMap('scopes').set('alice', {
      by: 'alice', byKind: 'agent', area: 'api', summary: 'foreign', paths: ['a.ts'], at: 1,
    }))

    let entries: { event: string; room?: string; login?: string; reason?: string }[] = []
    for (let i = 0; i < 20; i++) {
      entries = await (await fetch(`${base}/audit`, { headers: { authorization: `Bearer ${session}` } })).json() as typeof entries
      if (entries.some(entry => entry.event === 'identity_violation' && entry.room === repo)) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(entries).toContainEqual(expect.objectContaining({
      event: 'identity_violation', room: repo, login: 'bob', reason: expect.stringMatching(/update applied: scopes mutation for alice/),
    }))
    expect(logs.join('')).toContain(`observed identity-bearing update from bob (room ${repo}); update applied: scopes mutation for alice`)
  })

  it('answers malformed targets with 400, caps request bodies at 413, and keeps serving', async () => {
    const raw = (request: string) => new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(request))
      let out = ''
      socket.on('data', chunk => { out += chunk })
      socket.on('close', () => resolve(out))
      socket.on('error', reject)
      setTimeout(() => socket.destroy(), 3000)
    })
    // Node's parser accepts this target; `new URL` does not (security review M5).
    expect(await raw('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toMatch(/^HTTP\/1\.1 400 /)
    expect(await raw('GET //[ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')).toMatch(/^HTTP\/1\.1 400 /)
    // An unauthenticated chunked body past the limit is refused while streaming (M6).
    const chunk = 'a'.repeat(32 * 1024)
    let big = 'POST /auth/start HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n'
    for (let i = 0; i < 8; i++) big += `${chunk.length.toString(16)}\r\n${chunk}\r\n`
    expect(await raw(big)).toMatch(/^HTTP\/1\.1 413 /)
    expect((await fetch(`${base}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024) }, body: 'x'.repeat(1024 * 1024) }).catch(() => ({ status: 413 }))).status).toBe(413)
    // A path that escapes to a sibling directory sharing the static root's prefix is not served (S3).
    expect((await raw('GET /x/..//etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'))).not.toMatch(/root:/)
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, schema: 2, hub: 1 })
  })

  it('survives clients that reset the connection while an upgrade is being refused', async () => {
    const reset = (request: string) => new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.on('error', reject)
      socket.on('connect', () => socket.write(request, () => { socket.resetAndDestroy(); resolve() }))
    })
    const upgrade = (target: string) => `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`
    // Malformed target (400), invalid room name (400) and failed admission (401/403/404): each refusal writes to a reset socket.
    for (let i = 0; i < 10; i++) for (const target of ['//[', '/github.com', '/github.com%2Fnobody%2Fnothing?schema=2']) await reset(upgrade(target))
    await new Promise(r => setTimeout(r, 300))
    expect((await fetch(`${base}/health`)).status).toBe(200)
    expect(proc.exitCode).toBeNull()
  })

  it('reads a large PR-note body only for a live session in the Authorization header', async () => {
    const session = await login('note-size')
    const body = JSON.stringify({ room: 'github.com/note-size/project', schema: 2, number: 1, body: 'x'.repeat(1024 * 1024) })
    const send = (headers: Record<string, string>) => fetch(`${base}/github/pr-note`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }).then(r => r.status, () => 413)
    expect(await send({})).toBe(413)
    expect(await send({ authorization: 'Bearer not-a-session' })).toBe(413)
    // Read in full and then judged on its merits (this room was never opened).
    expect(await send({ authorization: `Bearer ${session}` })).not.toBe(413)
  })
})

describe('room server refuses the fake issuer in production', () => {
  it('exits at startup', async () => {
    const p2 = servers.start({
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(await freePort()), GITHUB_CLIENT_ID: 'fake', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let err = ''
    p2.stderr!.on('data', d => { err += d })
    const code = p2.exitCode ?? await new Promise<number | null>(r => p2.once('exit', r))
    expect(code).toBe(1)
    expect(err).toContain('test issuer')
  }, 30_000)
})
