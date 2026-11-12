import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Auth } from '../src/auth.js'
import { FileStore, type StoredSession } from '../src/store.js'

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
    let now = 0
    const a = new Auth({ clientId: 'cid', fetch: gh.fetch, now: () => now })
    const { device } = await a.startDevice()
    expect(await a.poll(device)).toEqual({ pending: true })
    expect(await a.poll(device)).toEqual({ pending: true })
    expect(gh.calls.filter(c => c.url.endsWith('/login/oauth/access_token'))).toHaveLength(1)
    now += 5000
    expect(await a.poll(device)).toEqual({ pending: true })
    now += 10000
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
    expect(await c.logout(s2)).toEqual({ removed: expect.objectContaining({ login: 'octo' }) })
    expect(await c.logout(s2)).toEqual({})
    expect(c.resolve(s2)).toBeUndefined()
    expect(fs.readFileSync(file, 'utf8')).not.toContain('gho_2')
  })

  it('sweeps idle sessions and announces revocation with an injected clock', async () => {
    let now = 1000
    const removed: string[] = []
    const auth = new Auth({ clientId: 'fake', now: () => now, sessionTtlMs: 1000,
      onSessionRemoved: (id, reason) => removed.push(`${id}:${reason}`) })
    await auth.ready
    const start = await auth.startDevice()
    const { session } = await auth.poll(start.device, { fakeLogin: 'octo' }) as { session: string }
    now = 2001
    auth.sweepSessions()
    expect(removed).toEqual([`${session}:session expired`])
    expect(auth.peek(session)).toBeUndefined()
  })

  it('keeps in-memory logins valid across the periodic session reconciliation', async () => {
    let now = 1000
    const removed: string[] = []
    const store = new FileStore()
    const auth = new Auth({ clientId: 'fake', production: false, store, now: () => now,
      onSessionRemoved: id => removed.push(id) })
    await auth.ready
    const { session } = await auth.poll((await auth.startDevice()).device, { fakeLogin: 'octo' }) as { session: string }
    now += 60_000
    await auth.reconcileSessions()
    expect(auth.resolve(session)).toMatchObject({ login: 'octo' })
    await auth.reconcileSessions()
    expect(removed).toEqual([])
    await auth.logout(session)
    await auth.reconcileSessions()
    expect(auth.peek(session)).toBeUndefined()
    expect(removed).toEqual([session])
  })

  it('keeps sessions and reports storage unavailable when the sessions file cannot be read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-auth-corrupt-'))
    const file = path.join(dir, 'sessions.json')
    try {
      const removed: string[] = []
      const auth = new Auth({ clientId: 'fake', sessionsFile: file, onSessionRemoved: id => removed.push(id) })
      await auth.ready
      const { session } = await auth.poll((await auth.startDevice()).device, { fakeLogin: 'octo' }) as { session: string }
      await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(file, 'utf8'))[session], 'session persisted before external file edit').toBeDefined())
      const good = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, good.slice(0, 10)) // a torn or half-copied file
      expect(await auth.reconcileSessions()).toMatchObject({ ok: false, error: expect.stringMatching(/sessions\.json/) })
      expect(removed).toEqual([])
      expect(auth.peek(session)).toMatchObject({ login: 'octo' })
      fs.writeFileSync(file, good)
      expect(await auth.reconcileSessions()).toEqual({ ok: true })
      expect(auth.peek(session)).toMatchObject({ login: 'octo' })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('adopts stored sessions once a store that failed at startup becomes readable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-auth-late-'))
    const file = path.join(dir, 'sessions.json')
    try {
      const good = JSON.stringify({ s1: { login: 'octo', provider: 'github', ghToken: 'gho_1', at: Date.now() } })
      fs.writeFileSync(file, good.slice(0, 10))
      const auth = new Auth({ clientId: 'fake', sessionsFile: file })
      await auth.ready
      expect(auth.peek('s1')).toBeUndefined()
      fs.writeFileSync(file, good)
      expect(await auth.reconcileSessions()).toEqual({ ok: true })
      expect(auth.peek('s1')).toMatchObject({ login: 'octo' })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('logout reports a retryable failure until the deletion is persisted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-auth-logout-'))
    const file = path.join(dir, 'sessions.json')
    try {
      const removed: string[] = []
      const auth = new Auth({ clientId: 'fake', sessionsFile: file, onSessionRemoved: id => removed.push(id) })
      await auth.ready
      const { session } = await auth.poll((await auth.startDevice()).device, { fakeLogin: 'octo' }) as { session: string }
      await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(file, 'utf8'))[session], 'session persisted before external file edit').toBeDefined())
      const good = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, good.slice(0, 10))
      const failed = await auth.logout(session)
      expect(failed).toEqual({ removed: expect.objectContaining({ login: 'octo' }), error: 'the logout could not be saved yet; retry' })
      // Sockets close and the session stops working at once; the durable deletion is still owed.
      expect(removed).toEqual([session])
      expect(auth.peek(session)).toBeUndefined()
      fs.writeFileSync(file, good)
      // A restart now would reload the token: logout is retried, not reported as done.
      expect(await auth.logout(session)).toEqual({ removed: expect.objectContaining({ login: 'octo' }) })
      expect(fs.readFileSync(file, 'utf8')).not.toContain(session)
      expect(removed).toEqual([session])
      expect(await auth.logout(session)).toEqual({})
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('retries owed logout deletions during reconciliation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-auth-owed-'))
    const file = path.join(dir, 'sessions.json')
    try {
      const auth = new Auth({ clientId: 'fake', sessionsFile: file })
      await auth.ready
      const { session } = await auth.poll((await auth.startDevice()).device, { fakeLogin: 'octo' }) as { session: string }
      await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(file, 'utf8'))[session], 'session persisted before external file edit').toBeDefined())
      const good = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, good.slice(0, 10))
      expect((await auth.logout(session)).error).toBeTruthy()
      fs.writeFileSync(file, good)
      expect(await auth.reconcileSessions()).toEqual({ ok: true })
      expect(fs.readFileSync(file, 'utf8')).not.toContain(session)
      expect(auth.peek(session)).toBeUndefined()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('notices an operator deleting a persisted session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-auth-delete-'))
    const file = path.join(dir, 'sessions.json')
    try {
      const removed: string[] = []
      const auth = new Auth({ clientId: 'fake', sessionsFile: file,
        onSessionRemoved: (id, reason) => removed.push(`${id}:${reason}`) })
      await auth.ready
      const { session } = await auth.poll((await auth.startDevice()).device, { fakeLogin: 'octo' }) as { session: string }
      await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(file, 'utf8'))[session], 'session persisted before external file edit').toBeDefined())
      fs.writeFileSync(file, '{}')
      await auth.reconcileSessions()
      expect(removed).toEqual([`${session}:logged out`])
      expect(auth.peek(session)).toBeUndefined()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('logout of a token the server has not loaded yet', () => {
  function flakyStore(sessions: Record<string, StoredSession>) {
    const state = { loadFails: true, deleteFails: false, deleted: [] as string[] }
    const store = new class extends FileStore {
      override async loadSessions() { if (state.loadFails) throw new Error('storage down'); return { ...sessions } }
      override async putSession(id: string, s: StoredSession) { sessions[id] = s }
      override async deleteSession(id: string) { if (state.deleteFails) throw new Error('storage down'); state.deleted.push(id); delete sessions[id] }
    }()
    return { store, state }
  }
  it('deletes it from the store, tells the client to retry until that is stored, and never adopts it back', async () => {
    const now = Date.now()
    const stored = { tok1: { login: 'alice', provider: 'github' as const, at: now }, tok2: { login: 'bob', provider: 'github' as const, at: now } }
    const { store, state } = flakyStore(stored)
    const auth = new Auth({ clientId: 'fake', production: false, store, now: () => now })
    await auth.ready // startup load failed; nothing adopted yet
    state.deleteFails = true
    expect(await auth.logout('tok1')).toMatchObject({ error: expect.stringContaining('retry') })
    state.deleteFails = false
    expect(await auth.logout('tok1')).toEqual({})
    expect(state.deleted).toEqual(['tok1'])
    state.loadFails = false
    expect(await auth.reconcileSessions()).toEqual({ ok: true })
    expect(auth.resolve('tok1')).toBeUndefined()
    expect(auth.resolve('tok2')).toMatchObject({ login: 'bob' })
  })
  it('retries a failed unloaded logout on reconciliation and keeps the token out of adoption meanwhile', async () => {
    const now = Date.now()
    const stored = { tok1: { login: 'alice', provider: 'github' as const, at: now } }
    const { store, state } = flakyStore(stored)
    const auth = new Auth({ clientId: 'fake', production: false, store, now: () => now })
    await auth.ready
    state.deleteFails = true
    await auth.logout('tok1')
    state.loadFails = false
    expect(await auth.reconcileSessions()).toEqual({ ok: true })
    expect(auth.resolve('tok1')).toBeUndefined() // still in the store, but never adopted
    state.deleteFails = false
    await auth.reconcileSessions()
    expect(state.deleted).toEqual(['tok1'])
  })
})
