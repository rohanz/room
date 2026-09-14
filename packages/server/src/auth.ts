/**
 * GitHub device-flow login. With GITHUB_CLIENT_ID set, the server runs the OAuth device flow
 * for clients and keeps the resulting GitHub tokens itself: clients only ever hold an opaque
 * Room session id. Without a client id the server is in "token" mode and accepts a forwarded
 * GitHub token (?gh=) as before (local dev, tests).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface StoredSession { ghToken: string; login: string; at: number }
export interface AuthOptions {
  clientId?: string
  /** Where sessions persist (0600). Omit for in-memory. */
  sessionsFile?: string
  fetch?: typeof fetch
  now?: () => number
  /** Session lifetime, sliding on use. Default 90 days. */
  sessionTtlMs?: number
  log?: (line: string) => void
}
export type DeviceStart = { user_code: string; verification_uri: string; expires_in: number; interval: number; device: string }
export type PollResult = { pending: true } | { error: string } | { session: string; login: string; expiresIn: number }

const GH_DEVICE = 'https://github.com/login/device/code'
const GH_TOKEN = 'https://github.com/login/oauth/access_token'
const GH_USER = 'https://api.github.com/user'

export class Auth {
  readonly mode: 'device' | 'token'
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly ttl: number
  private readonly devices = new Map<string, { code: string; exp: number; interval: number }>()
  private readonly sessions = new Map<string, StoredSession>()

  constructor(private readonly o: AuthOptions = {}) {
    this.mode = o.clientId ? 'device' : 'token'
    this.fetch = o.fetch ?? globalThis.fetch
    this.now = o.now ?? Date.now
    this.ttl = o.sessionTtlMs ?? 90 * 24 * 60 * 60 * 1000
    if (o.sessionsFile && fs.existsSync(o.sessionsFile)) {
      try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(o.sessionsFile, 'utf8')) as Record<string, StoredSession>)) if (v.at + this.ttl > this.now()) this.sessions.set(k, v) } catch { /* start empty */ }
    }
  }

  private save(): void {
    if (!this.o.sessionsFile) return
    try {
      fs.mkdirSync(path.dirname(this.o.sessionsFile), { recursive: true })
      fs.writeFileSync(this.o.sessionsFile, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600 })
      fs.chmodSync(this.o.sessionsFile, 0o600)
    } catch (e) { this.o.log?.(`auth: could not save sessions: ${e instanceof Error ? e.message : e}`) }
  }

  /** Step 1: ask GitHub for a user code. The device_code stays here, keyed by an opaque id. */
  async startDevice(): Promise<DeviceStart> {
    if (!this.o.clientId) throw new Error('device flow not configured (GITHUB_CLIENT_ID)')
    const res = await this.fetch(GH_DEVICE, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'room-server' }, body: JSON.stringify({ client_id: this.o.clientId, scope: 'repo' }) })
    if (!res.ok) throw new Error(`GitHub device code: HTTP ${res.status}`)
    const b = await res.json() as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }
    const device = crypto.randomBytes(16).toString('hex')
    this.devices.set(device, { code: b.device_code, exp: this.now() + b.expires_in * 1000, interval: b.interval })
    for (const [k, v] of this.devices) if (v.exp < this.now()) this.devices.delete(k)
    return { user_code: b.user_code, verification_uri: b.verification_uri, expires_in: b.expires_in, interval: b.interval, device }
  }

  /** Step 2: one poll of GitHub for the pending device. On success the GitHub token is stored and a session id returned. */
  async poll(device: string): Promise<PollResult> {
    const d = this.devices.get(device)
    if (!d) return { error: 'unknown or expired login attempt: start again' }
    if (d.exp < this.now()) { this.devices.delete(device); return { error: 'expired_token' } }
    const res = await this.fetch(GH_TOKEN, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'room-server' }, body: JSON.stringify({ client_id: this.o.clientId, device_code: d.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) })
    const b = await res.json().catch(() => ({})) as { access_token?: string; error?: string; interval?: number }
    if (b.error === 'authorization_pending' || b.error === 'slow_down') { if (b.interval) d.interval = b.interval; return { pending: true } }
    if (b.error || !b.access_token) { this.devices.delete(device); return { error: b.error ?? 'no token returned' } }
    this.devices.delete(device)
    const u = await this.fetch(GH_USER, { headers: { authorization: `Bearer ${b.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'room-server' } })
    if (!u.ok) return { error: `could not read the GitHub user (HTTP ${u.status})` }
    const login = ((await u.json()) as { login?: string }).login
    if (!login) return { error: 'GitHub returned no login' }
    const session = crypto.randomBytes(32).toString('hex')
    this.sessions.set(session, { ghToken: b.access_token, login, at: this.now() })
    this.save()
    this.o.log?.(`login: ${login}`)
    return { session, login, expiresIn: this.ttl }
  }

  /** The GitHub token and login behind a session id; slides the expiry. */
  resolve(session: string | undefined): StoredSession | undefined {
    if (!session) return undefined
    const s = this.sessions.get(session)
    if (!s) return undefined
    if (s.at + this.ttl < this.now()) { this.sessions.delete(session); this.save(); return undefined }
    const now = this.now()
    if (now - s.at > Math.min(60 * 60 * 1000, this.ttl / 10)) { s.at = now; this.save() } // slide, but not on every request
    return s
  }

  logout(session: string | undefined): boolean {
    if (!session || !this.sessions.has(session)) return false
    this.sessions.delete(session); this.save()
    return true
  }

  /** Number of live sessions (diagnostics/tests). */
  get size(): number { return this.sessions.size }
}
