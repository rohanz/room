/**
 * Login for the room server. Two providers, both ending in the same opaque Room session id
 * that clients hold and send as ?session=:
 *
 *  - GitHub device flow (GITHUB_CLIENT_ID): the server keeps the GitHub token itself and
 *    proves push access to github.com rooms with it. This is the only way into a github.com
 *    room; forwarded GitHub tokens are never accepted. GITHUB_CLIENT_ID=fake (never in
 *    production) is a test issuer: /auth/device hands out a code and /auth/poll confirms it as
 *    soon as the body carries `fakeLogin`, so tests and the demo walk the real code path.
 *  - OIDC authorization code + PKCE (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, PUBLIC_URL):
 *    for self-hosted servers with an Okta/Google/Keycloak style IdP. The client prints the
 *    authorize URL; the IdP sends the browser back to GET /auth/callback on this server; the
 *    client polls /auth/poll exactly like the device flow. An OIDC session has no GitHub
 *    token: it is admitted to local/ and git/ rooms, never to github.com rooms.
 *
 * Sessions persist through a Store (JSON file by default, Postgres with DATABASE_URL).
 */
import crypto from 'node:crypto'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import { FileStore, type Store, type StoredSession } from './store.js'

export type { StoredSession } from './store.js'
export type Provider = 'github' | 'oidc'

export interface OidcOptions {
  /** Issuer URL, e.g. https://accounts.google.com or https://acme.okta.com. Discovery is read from <issuer>/.well-known/openid-configuration. */
  issuer: string
  clientId: string
  clientSecret: string
  /** Email domains allowed to log in (lower-case, no @). Empty: any user the IdP accepts. */
  allowedDomains?: string[]
  /** This server's external https URL; the redirect URI is <publicUrl>/auth/callback. */
  publicUrl: string
}
export interface AuthOptions {
  /** GitHub OAuth App client id; the literal `fake` selects the test issuer (refused when `production`). */
  clientId?: string
  /** Default: NODE_ENV === 'production'. The fake issuer is never enabled in production. */
  production?: boolean
  oidc?: OidcOptions
  /** Where sessions persist. Default: FileStore at sessionsFile, or in memory. */
  store?: Store
  /** Shorthand for a FileStore holding only sessions (0600). */
  sessionsFile?: string
  fetch?: typeof fetch
  now?: () => number
  /** Session lifetime, sliding on use. Default 90 days. */
  sessionTtlMs?: number
  /** How long a started login may take before the client must start again. Default 15 min. */
  loginTtlMs?: number
  log?: (line: string) => void
}
export type DeviceStart = { provider: 'github'; user_code: string; verification_uri: string; expires_in: number; interval: number; device: string }
export type OidcStart = { provider: 'oidc'; url: string; expires_in: number; interval: number; device: string }
export type LoginStart = DeviceStart | OidcStart
export type PollResult = { pending: true } | { error: string } | { session: string; login: string; provider: Provider; expiresIn: number }

/** Namespaced identity of an OIDC user: `oidc:<issuer-host>:<sub>`. ROOM_ADMINS may list this form. */
export function oidcIdentity(issuer: string, sub: string): string {
  let host: string
  try { host = new URL(issuer).host.toLowerCase() } catch { host = issuer.replace(/^[a-z]+:\/\//i, '').split('/')[0]!.toLowerCase() }
  return `oidc:${host}:${sub}`
}

const GH_DEVICE = 'https://github.com/login/device/code'
const GH_TOKEN = 'https://github.com/login/oauth/access_token'
const GH_USER = 'https://api.github.com/user'

interface Discovery { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer?: string }
type Pending =
  | { provider: 'github'; code: string; exp: number; interval: number }
  | { provider: 'oidc'; verifier: string; nonce: string; exp: number; interval: number; result?: { session: string; login: string } | { error: string } }

export const FAKE_CLIENT_ID = 'fake'

export class Auth {
  /** `device`: GitHub login is configured (github.com rooms possible). `token`: no GitHub login; only non-GitHub rooms, admitted by ROOM_TOKEN or another provider. */
  readonly mode: 'device' | 'token'
  readonly providers: Provider[]
  /** The test issuer is active: logins are minted from `fakeLogin` without talking to GitHub. */
  readonly fake: boolean
  /** Resolves once persisted sessions are loaded; index.ts awaits it before listening. */
  readonly ready: Promise<void>
  private readonly store: Store
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly ttl: number
  private readonly loginTtl: number
  private readonly devices = new Map<string, Pending>()
  private readonly sessions = new Map<string, StoredSession>()
  private discovery?: { doc: Discovery; jwks?: { set: JSONWebKeySet; at: number } }

  constructor(private readonly o: AuthOptions = {}) {
    const production = o.production ?? process.env.NODE_ENV === 'production'
    this.fake = o.clientId === FAKE_CLIENT_ID
    if (this.fake && production) throw new Error(`GITHUB_CLIENT_ID=${FAKE_CLIENT_ID} is the test issuer and cannot run with NODE_ENV=production`)
    this.mode = o.clientId ? 'device' : 'token'
    this.providers = [...(o.clientId ? ['github' as const] : []), ...(o.oidc ? ['oidc' as const] : [])]
    this.store = o.store ?? new FileStore({ sessionsFile: o.sessionsFile })
    this.fetch = o.fetch ?? globalThis.fetch
    this.now = o.now ?? Date.now
    this.ttl = o.sessionTtlMs ?? 90 * 24 * 60 * 60 * 1000
    this.loginTtl = o.loginTtlMs ?? 15 * 60 * 1000
    this.ready = this.load()
  }
  private async load(): Promise<void> {
    try {
      await this.store.init()
      // Sessions written before OIDC existed have no provider: they are GitHub sessions.
      for (const [k, v] of Object.entries(await this.store.loadSessions())) if (v.at + this.ttl > this.now()) this.sessions.set(k, { ...v, provider: v.provider ?? 'github' })
    } catch (e) { this.o.log?.(`auth: could not load sessions: ${e instanceof Error ? e.message : e}`) }
  }

  private persist(p: Promise<void>): void {
    p.catch(e => this.o.log?.(`auth: could not save session: ${e instanceof Error ? e.message : e}`))
  }
  private sweep(): void {
    for (const [k, v] of this.devices) if (v.exp < this.now()) this.devices.delete(k)
  }
  private newSession(s: Omit<StoredSession, 'at'>): { session: string; login: string; provider: Provider; expiresIn: number } {
    const session = crypto.randomBytes(32).toString('hex')
    const stored: StoredSession = { ...s, at: this.now() }
    this.sessions.set(session, stored)
    this.persist(this.store.putSession(session, stored))
    this.o.log?.(`login: ${s.login} (${s.provider}${s.id ? `, ${s.id}` : ''})`)
    return { session, login: s.login, provider: s.provider, expiresIn: this.ttl }
  }

  /** Start a login with the given provider (default: the first configured one). */
  async start(provider?: Provider): Promise<LoginStart> {
    const p = provider ?? this.providers[0]
    if (!p) throw new Error('no login provider configured (GITHUB_CLIENT_ID or OIDC_ISSUER)')
    if (!this.providers.includes(p)) throw new Error(`login provider ${p} is not configured on this server (available: ${this.providers.join(', ')})`)
    return p === 'github' ? this.startDevice() : this.startOidc()
  }

  // ---- GitHub device flow ----

  /** Step 1: ask GitHub for a user code. The device_code stays here, keyed by an opaque id. */
  async startDevice(): Promise<DeviceStart> {
    if (!this.o.clientId) throw new Error('device flow not configured (GITHUB_CLIENT_ID)')
    if (this.fake) {
      const device = crypto.randomBytes(16).toString('hex')
      this.devices.set(device, { provider: 'github', code: 'fake', exp: this.now() + this.loginTtl, interval: 0 })
      this.sweep()
      return { provider: 'github', user_code: 'FAKE-0000', verification_uri: 'fake: pass fakeLogin to /auth/poll', expires_in: Math.round(this.loginTtl / 1000), interval: 0, device }
    }
    const res = await this.fetch(GH_DEVICE, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'room-server' }, body: JSON.stringify({ client_id: this.o.clientId, scope: 'repo' }) })
    if (!res.ok) throw new Error(`GitHub device code: HTTP ${res.status}`)
    const b = await res.json() as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }
    const device = crypto.randomBytes(16).toString('hex')
    this.devices.set(device, { provider: 'github', code: b.device_code, exp: this.now() + b.expires_in * 1000, interval: b.interval })
    this.sweep()
    return { provider: 'github', user_code: b.user_code, verification_uri: b.verification_uri, expires_in: b.expires_in, interval: b.interval, device }
  }

  private async pollDevice(device: string, d: Extract<Pending, { provider: 'github' }>, fakeLogin?: string): Promise<PollResult> {
    if (this.fake) {
      const login = fakeLogin?.trim()
      if (!login) return { pending: true }
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)) { this.devices.delete(device); return { error: `fakeLogin ${JSON.stringify(login)} is not a GitHub login` } }
      this.devices.delete(device)
      return this.newSession({ provider: 'github', login, ghToken: `fake:${login}` })
    }
    const res = await this.fetch(GH_TOKEN, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'room-server' }, body: JSON.stringify({ client_id: this.o.clientId, device_code: d.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) })
    const b = await res.json().catch(() => ({})) as { access_token?: string; error?: string; interval?: number }
    if (b.error === 'authorization_pending' || b.error === 'slow_down') { if (b.interval) d.interval = b.interval; return { pending: true } }
    if (b.error || !b.access_token) { this.devices.delete(device); return { error: b.error ?? 'no token returned' } }
    this.devices.delete(device)
    const u = await this.fetch(GH_USER, { headers: { authorization: `Bearer ${b.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'room-server' } })
    if (!u.ok) return { error: `could not read the GitHub user (HTTP ${u.status})` }
    const login = ((await u.json()) as { login?: string }).login
    if (!login) return { error: 'GitHub returned no login' }
    return this.newSession({ provider: 'github', login, ghToken: b.access_token })
  }

  // ---- OIDC authorization code + PKCE ----

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery.doc
    const oidc = this.o.oidc!
    const url = `${oidc.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
    const res = await this.fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status} from ${url}`)
    const doc = await res.json() as Discovery
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error('OIDC discovery document lacks authorization_endpoint, token_endpoint or jwks_uri')
    this.discovery = { doc }
    return doc
  }
  private async jwks(): Promise<JSONWebKeySet> {
    const doc = await this.discover()
    const d = this.discovery!
    if (d.jwks && d.jwks.at + 10 * 60 * 1000 > this.now()) return d.jwks.set
    const res = await this.fetch(doc.jwks_uri, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`OIDC JWKS failed: HTTP ${res.status}`)
    const set = await res.json() as JSONWebKeySet
    d.jwks = { set, at: this.now() }
    return set
  }
  private redirectUri(): string { return `${this.o.oidc!.publicUrl.replace(/\/+$/, '')}/auth/callback` }

  /** Step 1: build the IdP authorize URL. state = the opaque device id the client polls with. */
  async startOidc(): Promise<OidcStart> {
    const oidc = this.o.oidc
    if (!oidc) throw new Error('OIDC login not configured (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, PUBLIC_URL)')
    const doc = await this.discover()
    const device = crypto.randomBytes(16).toString('hex')
    const verifier = crypto.randomBytes(32).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    const nonce = crypto.randomBytes(16).toString('hex')
    const u = new URL(doc.authorization_endpoint)
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: oidc.clientId, redirect_uri: this.redirectUri(), scope: 'openid email profile', state: device, nonce, code_challenge: challenge, code_challenge_method: 'S256' })) u.searchParams.set(k, v)
    const expires_in = Math.round(this.loginTtl / 1000)
    this.devices.set(device, { provider: 'oidc', verifier, nonce, exp: this.now() + this.loginTtl, interval: 3 })
    this.sweep()
    return { provider: 'oidc', url: u.toString(), expires_in, interval: 3, device }
  }

  /** Step 2 (browser -> server): exchange the code, verify the ID token, create the session the poller will pick up. */
  async callbackOidc(code: string | undefined, state: string | undefined, error?: string): Promise<{ login: string; id: string } | { error: string }> {
    const fail = (d: Extract<Pending, { provider: 'oidc' }> | undefined, msg: string) => { if (d) d.result = { error: msg }; this.o.log?.(`oidc login failed: ${msg}`); return { error: msg } }
    const d = state ? this.devices.get(state) : undefined
    if (!d || d.provider !== 'oidc') return { error: 'unknown or expired login attempt: run room_login again' }
    if (d.exp < this.now()) { this.devices.delete(state!); return { error: 'login attempt expired: run room_login again' } }
    if (error) return fail(d, `identity provider returned ${error}`)
    if (!code) return fail(d, 'no code in callback')
    const oidc = this.o.oidc!
    let doc: Discovery
    try { doc = await this.discover() } catch (e) { return fail(d, e instanceof Error ? e.message : String(e)) }
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri(), client_id: oidc.clientId, client_secret: oidc.clientSecret, code_verifier: d.verifier })
    let idToken: string | undefined
    try {
      const res = await this.fetch(doc.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() })
      const b = await res.json().catch(() => ({})) as { id_token?: string; error?: string; error_description?: string }
      if (!res.ok || !b.id_token) return fail(d, `token exchange failed: ${b.error_description ?? b.error ?? `HTTP ${res.status}`}`)
      idToken = b.id_token
    } catch (e) { return fail(d, `token endpoint unreachable: ${e instanceof Error ? e.message : e}`) }
    let claims: { email?: string; email_verified?: boolean; preferred_username?: string; nonce?: string; sub?: string }
    try {
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(await this.jwks()), { issuer: doc.issuer ?? oidc.issuer, audience: oidc.clientId, currentDate: new Date(this.now()) })
      claims = payload as typeof claims
    } catch (e) { return fail(d, `ID token rejected: ${e instanceof Error ? e.message : e}`) }
    if (claims.nonce !== d.nonce) return fail(d, 'ID token nonce mismatch')
    // Only a verified email is an identity: an IdP may pass through an unverified address anyone can type in.
    const rawEmail = claims.email?.trim().toLowerCase()
    const email = rawEmail && claims.email_verified === true ? rawEmail : undefined
    const domains = oidc.allowedDomains?.map(x => x.trim().toLowerCase()).filter(Boolean) ?? []
    if (domains.length) {
      const domain = email?.split('@')[1]
      if (!domain || !domains.includes(domain)) return fail(d, `${email ?? (rawEmail ? `${rawEmail} (unverified)` : 'an account without a verified email')} is not in an allowed domain (${domains.join(', ')})`)
    }
    const login = email || claims.preferred_username?.trim() || claims.sub
    if (!login) return fail(d, 'ID token has no email, preferred_username or sub')
    if (!claims.sub) return fail(d, 'ID token has no sub')
    // The identity is the issuer's stable subject, namespaced so it can never collide with a GitHub
    // login or with a display login from another IdP; the login stays what people recognise.
    const id = oidcIdentity(doc.issuer ?? oidc.issuer, claims.sub)
    d.result = this.newSession({ provider: 'oidc', login, id })
    return { login, id }
  }

  /** One poll for a pending login. GitHub: asks GitHub (fake issuer: confirms once `fakeLogin` is given). OIDC: reports whether the callback has landed. */
  async poll(device: string, opts: { fakeLogin?: string } = {}): Promise<PollResult> {
    const d = this.devices.get(device)
    if (!d) return { error: 'unknown or expired login attempt: start again' }
    if (d.exp < this.now()) { this.devices.delete(device); return { error: 'expired_token' } }
    if (d.provider === 'github') return this.pollDevice(device, d, opts.fakeLogin)
    if (!d.result) return { pending: true }
    this.devices.delete(device)
    if ('error' in d.result) return d.result
    return { ...d.result, provider: 'oidc', expiresIn: this.ttl }
  }

  /** The session behind an id (login, provider, GitHub token if any); slides the expiry. */
  resolve(session: string | undefined): StoredSession | undefined {
    if (!session) return undefined
    const s = this.sessions.get(session)
    if (!s) return undefined
    if (s.at + this.ttl < this.now()) { this.sessions.delete(session); this.persist(this.store.deleteSession(session)); return undefined }
    const now = this.now()
    if (now - s.at > Math.min(60 * 60 * 1000, this.ttl / 10)) { s.at = now; this.persist(this.store.putSession(session, s)) } // slide, but not on every request
    return s
  }

  /** Removes the session; returns what it was (for the audit log) or undefined. */
  logout(session: string | undefined): StoredSession | undefined {
    if (!session) return undefined
    const s = this.sessions.get(session)
    if (!s) return undefined
    this.sessions.delete(session); this.persist(this.store.deleteSession(session))
    return s
  }

  /** Number of live sessions (diagnostics/tests). */
  get size(): number { return this.sessions.size }
}
