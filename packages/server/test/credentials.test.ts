import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'node:net'
import WebSocket from 'ws'
import { devServers } from './dev-server.js'

const servers = devServers()
let port: number, base: string
const room = 'github.com/credential-tests/repo'
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const bearer = (session: string) => ({ authorization: `Bearer ${session}` })
async function login(): Promise<string> {
  const start = await (await post('/auth/device', {})).json() as { device: string }
  return ((await (await post('/auth/poll', { device: start.device, fakeLogin: 'credential-tests' })).json()) as { session: string }).session
}
function socket(query: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}?schema=2${query}`, { headers })
    ws.once('open', () => resolve(ws))
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    ws.once('error', reject)
  })
}
beforeAll(async () => {
  port = await new Promise<number>((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)) }) })
  base = `http://127.0.0.1:${port}`
  const logs: string[] = []
  const { YPERSISTENCE: _volume, ...inherited } = process.env // in-memory: an empty YPERSISTENCE is a path to LevelDB
  const proc = servers.start({ env: { ...inherited, PORT: String(port), HOST: '127.0.0.1', ROOM_SERVER: '', GITHUB_CLIENT_ID: 'fake', ROOM_TOKEN: 'shared', ROOM_TEST_UPGRADE_DELAY_MS: '150', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] }, { WS_TICKET_TTL_MS: 2000 })
  proc.stdout!.on('data', d => logs.push(String(d))); proc.stderr!.on('data', d => logs.push(String(d)))
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited: ${logs.join('')}`)
    try { if ((await fetch(base + '/health')).ok) return } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`server did not start: ${logs.join('')}`)
}, 30_000)
afterAll(() => servers.stopAll())

describe('credential boundaries', () => {
  it('answers only ticket preflight with scoped CORS and reuses an issued view capability', async () => {
    const session = await login()
    await post('/rooms', { room, schema: 2, session })
    const preflight = await fetch(base + '/ws-ticket', { method: 'OPTIONS', headers: { origin: 'https://view.example',
      'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST')
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type, authorization, x-room-token')
    expect((await fetch(base + '/health')).headers.get('access-control-allow-origin')).toBeNull()
    const first = await (await post('/view-token', { room, schema: 2, session })).json() as { view: string }
    const second = await (await post('/view-token', { room, schema: 2, session })).json() as { view: string }
    expect(second.view).toBe(first.view)
    const exchanged = await post('/ws-ticket', { room, schema: 2, view: first.view })
    expect(exchanged.status).toBe(200)
    expect((await exchanged.json() as { ticket: string }).ticket).toBeTruthy()
  })
  it('accepts HTTP headers, rejects URL credentials, and sends no-referrer', async () => {
    const session = await login()
    expect((await post('/rooms', { room, schema: 2, session })).ok).toBe(true)
    const me = await fetch(base + '/auth/me', { headers: bearer(session) })
    expect(me.status).toBe(200)
    expect(me.headers.get('referrer-policy')).toBe('no-referrer')
    expect((await fetch(base + '/rooms', { headers: bearer(session) })).status).toBe(200)
    const ticket = await post('/ws-ticket', { room, schema: 2 }, bearer(session))
    expect(ticket.status).toBe(200)
    for (const route of ['/health', '/auth/config', '/audit', '/missing']) {
      const response = await fetch(base + route, { headers: bearer(session) })
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
    expect((await fetch(base + `/auth/me?session=${session}`)).status).toBe(400)
    expect((await fetch(base + `/rooms?session=${session}`)).status).toBe(400)
  })

  it('rejects query session upgrades, accepts headers, and logout closes the socket', async () => {
    const session = await login()
    await post('/rooms', { room, schema: 2, session })
    await expect(socket(`&session=${session}`)).rejects.toThrow('HTTP 400')
    const ws = await socket('', bearer(session))
    const { ticket } = await (await post('/ws-ticket', { room, schema: 2 }, bearer(session))).json() as { ticket: string }
    const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)))
    await post('/auth/logout', { session })
    expect(await closed).toBe(4401)
    await expect(socket(`&ticket=${ticket}`)).rejects.toThrow('HTTP 403')
  })
  it('refuses an upgrade suspended after admission when logout revokes its session', async () => {
    const session = await login()
    await post('/rooms', { room, schema: 2, session })
    const pending = socket('', bearer(session))
    await new Promise(resolve => setTimeout(resolve, 40))
    await post('/auth/logout', { session })
    await expect(pending).rejects.toThrow(/HTTP (401|403)/)
  })

  it('exchanges a view key for one-use ticket and closes it on room revocation', async () => {
    const session = await login()
    await post('/rooms', { room, schema: 2, session })
    const { view } = await (await post('/view-token', { room, schema: 2, session })).json() as { view: string }
    const mint = () => post('/ws-ticket', { room, schema: 2, view })
    const { ticket } = await (await mint()).json() as { ticket: string }
    const ws = await socket(`&ticket=${ticket}`)
    await expect(socket(`&ticket=${ticket}`)).rejects.toThrow('HTTP 403')
    const expiring = (await (await mint()).json() as { ticket: string }).ticket
    await new Promise(r => setTimeout(r, 2100))
    await expect(socket(`&ticket=${expiring}`)).rejects.toThrow('HTTP 403')
    const revokedTicket = (await (await mint()).json() as { ticket: string }).ticket
    const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)))
    await fetch(base + '/rooms', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, schema: 2, session }) })
    expect(await closed).toBe(4403)
    await expect(socket(`&ticket=${revokedTicket}`)).rejects.toThrow('HTTP 403')
    const second = await mint()
    expect(second.status).toBe(404)
  })
})
