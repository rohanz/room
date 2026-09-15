import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTools } from '../src/tools.js'
import { credentialsPath, getCredential, setCredential, removeCredential } from '../src/credentials.js'
import { resolveAuth, NotLoggedIn, serverFetch } from '../src/session.js'

/** A stand-in room server: device login that confirms on the second poll. */
let server: http.Server, url = '', polls = 0, loggedOut: string[] = []
const mode = { github: 'device' }
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c }); req.on('end', () => {
      const json = (o: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
      if (req.url === '/auth/config') return json(mode)
      if (req.url === '/auth/device') return json({ user_code: 'WXYZ-9876', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0, device: 'dev1' })
      if (req.url === '/auth/poll') { polls++; return json(polls < 2 ? { pending: true } : { session: 's'.repeat(64), login: 'octo', expiresIn: 1 }) }
      if (req.url === '/auth/logout') { loggedOut.push(JSON.parse(body).session); return json({ ok: true }) }
      res.writeHead(404); res.end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.ROOM_CREDENTIALS = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'room-cred-')), 'creds.json')
  process.env.ROOM_SERVER = url
})
afterAll(() => { server.close(); delete process.env.ROOM_CREDENTIALS; delete process.env.ROOM_SERVER })

describe('credentials store', () => {
  it('round-trips per server origin with 0600 perms', () => {
    setCredential('wss://a.example/', { session: 'x', login: 'me', at: 1 })
    expect(getCredential('wss://a.example')).toMatchObject({ login: 'me' })
    expect(fs.statSync(credentialsPath()).mode & 0o777).toBe(0o600)
    expect(removeCredential('wss://a.example')).toBe(true)
    expect(getCredential('wss://a.example')).toBeUndefined()
  })
})

describe('room_login / room_logout', () => {
  const tools = () => createTools({ getSession: () => null, setSession: () => {}, cwd: process.cwd() })
  it('device mode: first call shows the code, second waits and stores the session; join auth then uses it', async () => {
    const t = tools()
    const first = await t.call('room_login', {})
    expect(first).toContain('WXYZ-9876')
    expect(first).toContain('https://github.com/login/device')
    expect(first).toContain('call room_login again')
    const second = await t.call('room_login', { wait: 5 })
    expect(second).toContain('logged in to')
    expect(second).toContain('as octo')
    expect(getCredential(url)).toMatchObject({ login: 'octo', session: 's'.repeat(64) })
    let joined = false
    const guarded = createTools({ getSession: () => null, setSession: () => {}, cwd: process.cwd(), join: async () => { joined = true; throw new Error('must not join') } })
    expect(await guarded.call('room_join', { server: url, room: 'github.com/x/y/main', name: 'alias' }))
      .toBe('error: name is your GitHub login on this server (octo); use ROOM_TAG for a second agent')
    expect(joined).toBe(false)
    // the join path picks the session up and binds the name to the login
    const a = await resolveAuth(url, 'github.com/x/y/main')
    expect(a).toMatchObject({ session: 's'.repeat(64), login: 'octo' })
    expect(a.gh).toBeUndefined()
    expect(await t.call('room_login', {})).toContain('already logged in')
    const out = await t.call('room_logout', {})
    expect(out).toContain('logged out')
    expect(loggedOut).toEqual(['s'.repeat(64)])
    expect(getCredential(url)).toBeUndefined()
  })
  it('device mode without a login: joining a GitHub room throws NotLoggedIn even with a shared token; non-GitHub rooms are unaffected', async () => {
    await expect(resolveAuth(url, 'github.com/x/y/main')).rejects.toBeInstanceOf(NotLoggedIn)
    await expect(resolveAuth(url, 'github.com/x/y/main', 'tok')).rejects.toBeInstanceOf(NotLoggedIn)
    expect(await resolveAuth(url, 'local/dir/main', 'tok')).toEqual({ token: 'tok' })
  })
  it('a server without GitHub login cannot admit a GitHub room; the local gh token is never offered', async () => {
    mode.github = 'token'
    try {
      const { serverAuthMode } = await import('../src/session.js')
      // the config is cached per server string: a trailing slash is a fresh entry read under the new mode
      expect(await serverAuthMode(url + '/')).toBe('token')
      await expect(resolveAuth(url + '/', 'github.com/x/y/main', 'tok')).rejects.toThrow(/no GitHub login/)
      expect(await resolveAuth(url + '/', 'local/dir/main', 'tok')).toEqual({ token: 'tok' })
      expect(await resolveAuth(url + '/', 'git/gitlab.example/o/r/main')).toEqual({ token: undefined })
    } finally { mode.github = 'device' }
  })
  it('logout with nothing stored says so', async () => {
    expect(await tools().call('room_logout', {})).toContain('no login stored')
  })
})

describe('serverFetch retry policy', () => {
  it('does not retry when told not to, so a device-code start never mints twice', async () => {
    let hits = 0
    const flaky = http.createServer((_q, res) => { hits++; res.writeHead(502); res.end('starting') })
    await new Promise<void>(r => flaky.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(flaky.address() as { port: number }).port}`
    const res = await serverFetch(`${base}/auth/start`, { method: 'POST', retry: false, timeoutMs: 2000 })
    expect(res.status).toBe(502)
    expect(hits).toBe(1)
    flaky.close()
  })
})
