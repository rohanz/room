import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { Auth, oidcIdentity } from '../src/auth.js'
import { FileStore } from '../src/store.js'

const ISSUER = 'https://idp.example.com'
const CLIENT = 'room-client'
const PUBLIC = 'https://room.example.com'

/** A fake IdP: discovery, JWKS, token endpoint. `claims` shapes the ID token it mints for the next code exchange. */
async function fakeIdp(claims: Record<string, unknown>, opts: { badSignature?: boolean; tokenError?: string; noSub?: boolean } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const other = (await generateKeyPair('RS256')).privateKey
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const calls: { url: string; body?: string }[] = []
  let lastNonce: string | undefined
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? String(init.body) : undefined })
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
    if (url === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` })
    if (url === `${ISSUER}/jwks`) return json({ keys: [jwk] })
    if (url === `${ISSUER}/token`) {
      if (opts.tokenError) return json({ error: opts.tokenError, error_description: 'nope' }, 400)
      const form = new URLSearchParams(String(init?.body))
      const jwt = new SignJWT({ ...claims, nonce: lastNonce }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISSUER).setAudience(CLIENT).setIssuedAt().setExpirationTime('5m')
      if (!opts.noSub) jwt.setSubject('sub-1')
      const id_token = await jwt.sign(opts.badSignature ? other : privateKey)
      return json({ access_token: 'at', id_token, token_type: 'Bearer', _form: Object.fromEntries(form) })
    }
    return json({}, 404)
  }) as unknown as typeof fetch
  return { fetch: f, calls, setNonce: (n: string) => { lastNonce = n } }
}

function make(idp: { fetch: typeof fetch }, extra: Partial<ConstructorParameters<typeof Auth>[0]> = {}) {
  return new Auth({ oidc: { issuer: ISSUER, clientId: CLIENT, clientSecret: 'shh', publicUrl: PUBLIC, ...(extra.oidc ?? {}) }, fetch: idp.fetch, ...extra })
}

/** Run the browser's part: take the authorize URL, pull state + nonce out of it, hit the callback. */
async function browserLogsIn(a: Auth, idp: { setNonce: (n: string) => void }, start: { url: string }) {
  const u = new URL(start.url)
  idp.setNonce(u.searchParams.get('nonce')!)
  return a.callbackOidc('CODE-1', u.searchParams.get('state')!)
}

describe('OIDC login', () => {
  it('exposes providers and builds a PKCE authorize URL with state = device', async () => {
    const idp = await fakeIdp({ email: 'ann@example.com', email_verified: true })
    const a = make(idp)
    expect(a.providers).toEqual(['oidc'])
    expect(a.mode).toBe('token')
    const s = await a.start()
    expect(s.provider).toBe('oidc')
    const u = new URL((s as { url: string }).url)
    expect(u.origin + u.pathname).toBe(`${ISSUER}/authorize`)
    expect(u.searchParams.get('state')).toBe(s.device)
    expect(u.searchParams.get('client_id')).toBe(CLIENT)
    expect(u.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/auth/callback`)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(u.searchParams.get('scope')).toContain('openid')
    expect(await a.poll(s.device)).toEqual({ pending: true })
  })

  it('callback exchanges the code with the verifier, verifies the ID token and the poller gets a session', async () => {
    const idp = await fakeIdp({ email: 'Ann@Example.com', email_verified: true })
    const a = make(idp)
    const s = await a.start('oidc') as { url: string; device: string }
    const cb = await browserLogsIn(a, idp, s)
    expect(cb).toEqual({ login: 'ann@example.com', id: 'oidc:idp.example.com:sub-1' })
    const tokenCall = idp.calls.find(c => c.url === `${ISSUER}/token`)!
    const form = new URLSearchParams(tokenCall.body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('CODE-1')
    expect(form.get('client_secret')).toBe('shh')
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const r = await a.poll(s.device)
    expect(r).toMatchObject({ login: 'ann@example.com', provider: 'oidc' })
    const session = (r as { session: string }).session
    expect(a.resolve(session)).toMatchObject({ login: 'ann@example.com', id: 'oidc:idp.example.com:sub-1', provider: 'oidc' })
    expect(a.resolve(session)?.ghToken).toBeUndefined()
    expect(await a.poll(s.device)).toMatchObject({ error: expect.stringContaining('unknown') }) // single use
  })

  it('falls back to preferred_username when there is no email', async () => {
    const idp = await fakeIdp({ preferred_username: 'ann' })
    const a = make(idp)
    const s = await a.start() as { url: string; device: string }
    expect(await browserLogsIn(a, idp, s)).toEqual({ login: 'ann', id: 'oidc:idp.example.com:sub-1' })
  })

  it('the identity is namespaced by issuer host and sub; the display login is the email or username', async () => {
    // Two users with the same-looking display names at different IdPs never share an identity,
    // and an email change at the IdP does not change who the user is.
    expect(oidcIdentity('https://idp.example.com', 'sub-1')).toBe('oidc:idp.example.com:sub-1')
    expect(oidcIdentity('https://Accounts.Google.com/', '1234')).toBe('oidc:accounts.google.com:1234')
    expect(oidcIdentity('https://acme.okta.com:8443/oauth2/default', 'u1')).toBe('oidc:acme.okta.com:8443:u1')
    expect(oidcIdentity('idp.example.com', 'u1')).toBe('oidc:idp.example.com:u1')
    const idp = await fakeIdp({ email: 'ann@example.com', email_verified: true, preferred_username: 'ann' })
    const a = make(idp)
    const s = await a.start() as { url: string; device: string }
    await browserLogsIn(a, idp, s)
    const r = await a.poll(s.device) as { session: string; login: string }
    expect(r.login).toBe('ann@example.com')
    const st = a.resolve(r.session)!
    expect(st.id).toBe('oidc:idp.example.com:sub-1')
    expect(st.login).toBe('ann@example.com')
    // an ID token without sub is refused: there is nothing stable to key the identity on
    const noSub = await fakeIdp({ email: 'ann@example.com', email_verified: true }, { noSub: true })
    const b = make(noSub)
    const s2 = await b.start() as { url: string; device: string }
    expect(await browserLogsIn(b, noSub, s2)).toMatchObject({ error: expect.stringContaining('sub') })
  })

  it('sessions stored before identities existed still load, without an id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-oidc-old-'))
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ old: { login: 'ann@example.com', provider: 'oidc', at: Date.now() } }))
    const idp = await fakeIdp({})
    const a = make(idp, { store: new FileStore({ dir }) })
    await a.ready
    expect(a.resolve('old')).toMatchObject({ login: 'ann@example.com', provider: 'oidc' })
    expect(a.resolve('old')?.id).toBeUndefined()
  })

  it('an unverified email is not an identity: refused by the allowlist, and never the login', async () => {
    const unverified = await fakeIdp({ email: 'admin@example.com', email_verified: false, preferred_username: 'mallory' })
    const a = make(unverified, { oidc: { issuer: ISSUER, clientId: CLIENT, clientSecret: 'shh', publicUrl: PUBLIC, allowedDomains: ['example.com'] } })
    const s = await a.start() as { url: string; device: string }
    expect(await browserLogsIn(a, unverified, s)).toMatchObject({ error: expect.stringContaining('unverified') })
    // without an allowlist the account is admitted, but under its username, not the address it typed
    const idp2 = await fakeIdp({ email: 'admin@example.com', email_verified: false, preferred_username: 'mallory' })
    const c = make(idp2)
    const s2 = await c.start() as { url: string; device: string }
    expect(await browserLogsIn(c, idp2, s2)).toEqual({ login: 'mallory', id: 'oidc:idp.example.com:sub-1' })
  })

  it('enforces the email domain allowlist', async () => {
    const idp = await fakeIdp({ email: 'mallory@evil.com', email_verified: true })
    const a = make(idp, { oidc: { issuer: ISSUER, clientId: CLIENT, clientSecret: 'shh', publicUrl: PUBLIC, allowedDomains: ['example.com', 'Example.org'] } })
    const s = await a.start() as { url: string; device: string }
    expect(await browserLogsIn(a, idp, s)).toMatchObject({ error: expect.stringContaining('not in an allowed domain') })
    // the poller learns of the failure and the attempt is spent
    expect(await a.poll(s.device)).toMatchObject({ error: expect.stringContaining('not in an allowed domain') })
    expect(a.size).toBe(0)
    const ok = await fakeIdp({ email: 'bob@EXAMPLE.ORG', email_verified: true })
    const b = make(ok, { oidc: { issuer: ISSUER, clientId: CLIENT, clientSecret: 'shh', publicUrl: PUBLIC, allowedDomains: ['example.com', 'example.org'] } })
    const s2 = await b.start() as { url: string; device: string }
    expect(await browserLogsIn(b, ok, s2)).toEqual({ login: 'bob@example.org', id: 'oidc:idp.example.com:sub-1' })
    // no email at all is refused when a domain list is set
    const none = await fakeIdp({ preferred_username: 'ghost' })
    const c = make(none, { oidc: { issuer: ISSUER, clientId: CLIENT, clientSecret: 'shh', publicUrl: PUBLIC, allowedDomains: ['example.com'] } })
    const s3 = await c.start() as { url: string; device: string }
    expect(await browserLogsIn(c, none, s3)).toMatchObject({ error: expect.stringContaining('without a verified email') })
  })

  it('rejects a bad signature, a wrong nonce, an unknown state, an IdP error and a failed exchange', async () => {
    const bad = await fakeIdp({ email: 'ann@example.com' }, { badSignature: true })
    const a = make(bad)
    const s = await a.start() as { url: string; device: string }
    expect(await browserLogsIn(a, bad, s)).toMatchObject({ error: expect.stringContaining('ID token rejected') })

    const idp = await fakeIdp({ email: 'ann@example.com', email_verified: true })
    const b = make(idp)
    const s2 = await b.start() as { url: string; device: string }
    idp.setNonce('not-the-nonce')
    expect(await b.callbackOidc('CODE', new URL(s2.url).searchParams.get('state')!)).toMatchObject({ error: expect.stringContaining('nonce') })

    expect(await b.callbackOidc('CODE', 'no-such-state')).toMatchObject({ error: expect.stringContaining('unknown or expired') })
    const s3 = await b.start() as { url: string; device: string }
    expect(await b.callbackOidc(undefined, new URL(s3.url).searchParams.get('state')!, 'access_denied')).toMatchObject({ error: expect.stringContaining('access_denied') })

    const failing = await fakeIdp({ email: 'ann@example.com' }, { tokenError: 'invalid_grant' })
    const c = make(failing)
    const s4 = await c.start() as { url: string; device: string }
    expect(await browserLogsIn(c, failing, s4)).toMatchObject({ error: expect.stringContaining('token exchange failed') })
    expect(a.size + b.size + c.size).toBe(0)
  })

  it('login attempts expire', async () => {
    let t = 1_000_000
    const idp = await fakeIdp({ email: 'ann@example.com', email_verified: true })
    const a = make(idp, { now: () => t, loginTtlMs: 60_000 })
    const s = await a.start() as { url: string; device: string; expires_in: number }
    expect(s.expires_in).toBe(60)
    t += 61_000
    expect(await a.poll(s.device)).toEqual({ error: 'expired_token' })
  })

  it('both providers configured: github first, start(provider) picks; unknown provider refused', async () => {
    const idp = await fakeIdp({ email: 'ann@example.com', email_verified: true })
    const a = make(idp, { clientId: 'gh-cid' })
    expect(a.providers).toEqual(['github', 'oidc'])
    expect(a.mode).toBe('device')
    expect((await a.start('oidc')).provider).toBe('oidc')
    await expect(new Auth({ clientId: 'gh-cid', fetch: idp.fetch }).start('oidc')).rejects.toThrow(/not configured/)
    await expect(new Auth({}).start()).rejects.toThrow(/no login provider/)
  })

  it('OIDC sessions persist through the FileStore without a GitHub token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-oidc-'))
    const idp = await fakeIdp({ email: 'ann@example.com', email_verified: true })
    const a = make(idp, { store: new FileStore({ dir }) })
    const s = await a.start() as { url: string; device: string }
    await browserLogsIn(a, idp, s)
    const { session } = await a.poll(s.device) as { session: string }
    await new Promise(r => setTimeout(r, 10))
    expect(fs.statSync(path.join(dir, 'sessions.json')).mode & 0o777).toBe(0o600)
    const b = make(idp, { store: new FileStore({ dir }) })
    await b.ready
    expect(b.resolve(session)).toMatchObject({ login: 'ann@example.com', provider: 'oidc' })
    expect(b.logout(session)).toMatchObject({ login: 'ann@example.com' })
    expect(b.logout(session)).toBeUndefined()
  })
})
