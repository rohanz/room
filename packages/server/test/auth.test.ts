import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Auth } from '../src/auth.js'

type Call = { url: string; body?: any }
function fakeGitHub(script: { tokenResponses: any[]; login?: string; userStatus?: number }) {
  const calls: Call[] = []
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/login/device/code')) return json({ device_code: 'DC', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
    if (url.endsWith('/login/oauth/access_token')) return json(script.tokenResponses.shift() ?? { error: 'expired_token' })
    if (url.endsWith('/user')) return json(script.login ? { login: script.login } : {}, script.userStatus ?? 200)
    return json({}, 404)
  }) as unknown as typeof fetch
  return { fetch: f, calls }
}

describe('device-flow auth', () => {
  it('token mode without a client id (no GitHub login at all), device mode with one', () => {
    expect(new Auth({}).mode).toBe('token')
    expect(new Auth({}).fake).toBe(false)
    expect(new Auth({ clientId: 'x' }).mode).toBe('device')
    expect(new Auth({ clientId: 'x' }).fake).toBe(false)
  })

  it('the fake issuer: a code without GitHub, confirmed by fakeLogin, never in production', async () => {
    const calls: string[] = []
    const a = new Auth({ clientId: 'fake', production: false, fetch: (async (url: string) => { calls.push(url); return new Response('{}', { status: 500 }) }) as unknown as typeof fetch })
    expect(a.fake).toBe(true)
    expect(a.mode).toBe('device')
    expect(a.providers).toEqual(['github'])
    const s = await a.startDevice()
    expect(s.user_code).toBe('FAKE-0000')
    expect(s.device).toMatch(/^[0-9a-f]{32}$/)
    expect(await a.poll(s.device)).toEqual({ pending: true })
    expect(await a.poll(s.device, { fakeLogin: 'not a login!' })).toMatchObject({ error: expect.stringContaining('not a GitHub login') })
    const s2 = await a.startDevice()
    const r = await a.poll(s2.device, { fakeLogin: 'octo' })
    expect(r).toMatchObject({ login: 'octo', provider: 'github' })
    expect(a.resolve((r as { session: string }).session)).toMatchObject({ login: 'octo', ghToken: 'fake:octo' })
    expect(calls).toEqual([]) // GitHub was never called
    expect(() => new Auth({ clientId: 'fake', production: true })).toThrow(/production/)
  })

  it('start returns a user code and an opaque device id, never the device_code', async () => {
    const gh = fakeGitHub({ tokenResponses: [] })
    const a = new Auth({ clientId: 'cid', fetch: gh.fetch })
    const s = await a.startDevice()
    expect(s.user_code).toBe('ABCD-1234')
    expect(s.verification_uri).toBe('https://github.com/login/device')
    expect(s.device).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(s)).not.toContain('DC')
    expect(gh.calls[0].body).toEqual({ client_id: 'cid', scope: 'repo' })
  })

  it('poll: pending, then success stores the GitHub token server-side and returns a session', async () => {
    const gh = fakeGitHub({ tokenResponses: [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: 'gho_secret', token_type: 'bearer' }], login: 'octo' })
    const a = new Auth({ clientId: 'cid', fetch: gh.fetch })
    const { device } = await a.startDevice()
    expect(await a.poll(device)).toEqual({ pending: true })
    expect(await a.poll(device)).toEqual({ pending: true })
    const r = await a.poll(device)
    expect(r).toMatchObject({ login: 'octo' })
    const session = (r as { session: string }).session
    expect(session).toMatch(/^[0-9a-f]{64}$/)
    expect(a.resolve(session)).toMatchObject({ ghToken: 'gho_secret', login: 'octo' })
    expect(gh.calls.find(c => c.url.endsWith('/login/oauth/access_token'))!.body).toMatchObject({ device_code: 'DC', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
    // the device id is single-use
    expect(await a.poll(device)).toMatchObject({ error: expect.stringContaining('unknown') })
  })

  it('poll: denied and expired report errors; unknown device too', async () => {
    const gh = fakeGitHub({ tokenResponses: [{ error: 'access_denied' }] })
    const a = new Auth({ clientId: 'cid', fetch: gh.fetch })
    const { device } = await a.startDevice()
    expect(await a.poll(device)).toEqual({ error: 'access_denied' })
    expect(await a.poll('nope')).toMatchObject({ error: expect.stringContaining('unknown') })
    let t = 0
    const b = new Auth({ clientId: 'cid', fetch: fakeGitHub({ tokenResponses: [] }).fetch, now: () => t })
    const d2 = await b.startDevice()
    t = 901 * 1000
    expect(await b.poll(d2.device)).toEqual({ error: 'expired_token' })
  })

  it('sessions persist to a 0600 file, expire after the ttl, slide on use, and can be logged out', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-auth-'))
    const file = path.join(dir, 'sessions.json')
    let t = 1_000_000
    const gh = fakeGitHub({ tokenResponses: [{ access_token: 'gho_1' }], login: 'octo' })
    const a = new Auth({ clientId: 'cid', fetch: gh.fetch, now: () => t, sessionsFile: file, sessionTtlMs: 10_000 })
    const { device } = await a.startDevice()
    const { session } = await a.poll(device) as { session: string }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(file, 'utf8')).toContain('gho_1')
    // a restarted server reloads it (sessions load asynchronously through the store)
    const b = new Auth({ clientId: 'cid', fetch: gh.fetch, now: () => t, sessionsFile: file, sessionTtlMs: 10_000 })
    await b.ready
    expect(b.resolve(session)).toMatchObject({ login: 'octo', provider: 'github' })
    // sliding: using it at t+8s keeps it alive past the original 10s
    t += 8_000; expect(b.resolve(session)).toBeTruthy()
    t += 8_000; expect(b.resolve(session)).toBeTruthy()
    // idle past the ttl: gone
    t += 11_000; expect(b.resolve(session)).toBeUndefined()
    // logout
    const gh2 = fakeGitHub({ tokenResponses: [{ access_token: 'gho_2' }], login: 'octo' })
    const c = new Auth({ clientId: 'cid', fetch: gh2.fetch, sessionsFile: file })
    const { session: s2 } = await c.poll((await c.startDevice()).device) as { session: string }
    expect(c.logout(s2)).toMatchObject({ login: 'octo' })
    expect(c.logout(s2)).toBeUndefined()
    expect(c.resolve(s2)).toBeUndefined()
    await new Promise(r => setTimeout(r, 10)) // session writes are queued, in order
    expect(fs.readFileSync(file, 'utf8')).not.toContain('gho_2')
  })
})
