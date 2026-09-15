/**
 * Where the server keeps its small, non-document state: the registry of opened repos, login
 * sessions and the audit log. Room documents stay in LevelDB (y-websocket persistence).
 *
 *  - FileStore: JSON files next to the LevelDB data (default; in-memory when no directory is set).
 *  - PgStore:   three tables in Postgres (DATABASE_URL), created on start.
 */
import fs from 'node:fs'
import path from 'node:path'

export interface OpenRepo { by?: string; at: number; branches: string[]; lastSeen?: number }
/** `login` is the display name (GitHub login, verified email or preferred_username). `id` is the
 *  namespaced identity used for admission and admin checks: `oidc:<issuer-host>:<sub>` for OIDC
 *  sessions; absent (same as the login) for GitHub sessions and sessions written before it existed. */
export interface StoredSession { login: string; id?: string; provider: 'github' | 'oidc'; ghToken?: string; at: number }
export type AuditEvent = 'login' | 'logout' | 'room_opened' | 'room_closed' | 'join' | 'refused'
export interface AuditEntry { at: number; event: AuditEvent; login?: string; id?: string; provider?: string; room?: string; reason?: string; readOnly?: boolean }

/** Most in-memory audit entries kept when there is no audit file: oldest are dropped past this. */
export const MEM_AUDIT_MAX = 5000

/** Runs async writes one after another, in call order, so overlapping fire-and-forget saves cannot
 *  interleave (PgStore.saveRooms replaces the whole table; two in flight could leave the older state). */
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn)
    this.tail = p.then(() => undefined, () => undefined)
    return p
  }
}

export interface Store {
  /** Create tables / directories. Called once before use. */
  init(): Promise<void>
  loadRooms(): Promise<Record<string, OpenRepo>>
  saveRooms(all: Record<string, OpenRepo>): Promise<void>
  loadSessions(): Promise<Record<string, StoredSession>>
  putSession(id: string, s: StoredSession): Promise<void>
  deleteSession(id: string): Promise<void>
  audit(e: AuditEntry): Promise<void>
  /** Entries at or after `since` (ms), oldest first, at most `limit`. */
  readAudit(o?: { since?: number; limit?: number }): Promise<AuditEntry[]>
  close(): Promise<void>
}

export interface FileStoreOptions {
  /** Directory for rooms.json, sessions.json and audit.log. Omit for in-memory. */
  dir?: string
  sessionsFile?: string
  roomsFile?: string
  auditFile?: string
}

export class FileStore implements Store {
  private readonly sessionsFile?: string
  private readonly roomsFile?: string
  private readonly auditFile?: string
  private sessions: Record<string, StoredSession> = {}
  private memAudit: AuditEntry[] = []
  private readonly writes = new WriteQueue()

  constructor(o: FileStoreOptions = {}) {
    this.sessionsFile = o.sessionsFile ?? (o.dir ? path.join(o.dir, 'sessions.json') : undefined)
    this.roomsFile = o.roomsFile ?? (o.dir ? path.join(o.dir, 'rooms.json') : undefined)
    this.auditFile = o.auditFile ?? (o.dir ? path.join(o.dir, 'audit.log') : undefined)
  }

  async init(): Promise<void> {
    for (const f of [this.sessionsFile, this.roomsFile, this.auditFile]) if (f) fs.mkdirSync(path.dirname(f), { recursive: true })
  }

  private readJson<T>(file: string | undefined): T | undefined {
    if (!file || !fs.existsSync(file)) return undefined
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return undefined }
  }

  async loadRooms(): Promise<Record<string, OpenRepo>> {
    const raw = this.readJson<Record<string, Partial<OpenRepo>>>(this.roomsFile) ?? {}
    const out: Record<string, OpenRepo> = {}
    for (const [k, v] of Object.entries(raw)) out[k] = { by: v.by, at: v.at ?? Date.now(), branches: v.branches ?? [], lastSeen: v.lastSeen }
    return out
  }
  saveRooms(all: Record<string, OpenRepo>): Promise<void> {
    const text = JSON.stringify(all)
    return this.writes.run(async () => { if (this.roomsFile) fs.writeFileSync(this.roomsFile, text) })
  }

  async loadSessions(): Promise<Record<string, StoredSession>> {
    this.sessions = this.readJson<Record<string, StoredSession>>(this.sessionsFile) ?? {}
    return { ...this.sessions }
  }
  /** Sessions hold GitHub tokens: the file is 0600. */
  private writeSessions(): Promise<void> {
    const text = JSON.stringify(this.sessions)
    return this.writes.run(async () => {
      if (!this.sessionsFile) return
      fs.writeFileSync(this.sessionsFile, text, { mode: 0o600 })
      fs.chmodSync(this.sessionsFile, 0o600)
    })
  }
  putSession(id: string, s: StoredSession): Promise<void> { this.sessions[id] = s; return this.writeSessions() }
  deleteSession(id: string): Promise<void> { delete this.sessions[id]; return this.writeSessions() }

  async audit(e: AuditEntry): Promise<void> {
    if (this.auditFile) { fs.appendFileSync(this.auditFile, JSON.stringify(e) + '\n'); return }
    this.memAudit.push(e)
    if (this.memAudit.length > MEM_AUDIT_MAX) this.memAudit.splice(0, this.memAudit.length - MEM_AUDIT_MAX)
  }
  async readAudit(o: { since?: number; limit?: number } = {}): Promise<AuditEntry[]> {
    const since = o.since ?? 0
    const limit = o.limit ?? 1000
    let all: AuditEntry[]
    if (this.auditFile) {
      if (!fs.existsSync(this.auditFile)) return []
      all = fs.readFileSync(this.auditFile, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as AuditEntry] } catch { return [] } })
    } else all = this.memAudit
    const hits = all.filter(e => e.at >= since)
    return hits.slice(Math.max(0, hits.length - limit))
  }
  async close(): Promise<void> { /* nothing open */ }
}

/** Minimal shape of a `pg` Pool, so the driver is only loaded when DATABASE_URL is set. */
interface PgClientLike { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; release(): void }
interface PgLike { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; connect(): Promise<PgClientLike>; end(): Promise<void> }

export class PgStore implements Store {
  private pool?: PgLike
  private readonly writes = new WriteQueue()
  constructor(private readonly databaseUrl: string, private readonly connect?: (url: string) => Promise<PgLike>) {}

  private async db(): Promise<PgLike> {
    if (this.pool) return this.pool
    const make = this.connect ?? (async (url: string) => {
      const pg = await import('pg')
      return new pg.default.Pool({ connectionString: url }) as unknown as PgLike
    })
    this.pool = await make(this.databaseUrl)
    return this.pool
  }

  async init(): Promise<void> {
    const db = await this.db()
    await db.query(`CREATE TABLE IF NOT EXISTS room_repos (repo TEXT PRIMARY KEY, data JSONB NOT NULL)`)
    await db.query(`CREATE TABLE IF NOT EXISTS room_sessions (id TEXT PRIMARY KEY, data JSONB NOT NULL, at BIGINT NOT NULL)`)
    await db.query(`CREATE TABLE IF NOT EXISTS room_audit (id BIGSERIAL PRIMARY KEY, at BIGINT NOT NULL, data JSONB NOT NULL)`)
    await db.query(`CREATE INDEX IF NOT EXISTS room_audit_at ON room_audit (at)`)
  }

  async loadRooms(): Promise<Record<string, OpenRepo>> {
    const { rows } = await (await this.db()).query(`SELECT repo, data FROM room_repos`)
    return Object.fromEntries(rows.map(r => [r.repo as string, r.data as OpenRepo]))
  }
  saveRooms(all: Record<string, OpenRepo>): Promise<void> {
    // Snapshot now, write in turn: a full-table replacement must not overlap or reorder with the previous one.
    const rows = Object.entries(all).map(([repo, data]) => [repo, JSON.stringify(data)] as const)
    return this.writes.run(async () => {
      // One client for the whole transaction: on a Pool each query() may use a different connection.
      const client = await (await this.db()).connect()
      try {
        await client.query('BEGIN')
        await client.query(`DELETE FROM room_repos`)
        for (const [repo, data] of rows) await client.query(`INSERT INTO room_repos (repo, data) VALUES ($1, $2)`, [repo, data])
        await client.query('COMMIT')
      } catch (e) { try { await client.query('ROLLBACK') } catch { /* connection gone */ } throw e }
      finally { client.release() }
    })
  }

  async loadSessions(): Promise<Record<string, StoredSession>> {
    const { rows } = await (await this.db()).query(`SELECT id, data FROM room_sessions`)
    return Object.fromEntries(rows.map(r => [r.id as string, r.data as StoredSession]))
  }
  putSession(id: string, s: StoredSession): Promise<void> {
    const data = JSON.stringify(s)
    return this.writes.run(async () => { await (await this.db()).query(`INSERT INTO room_sessions (id, data, at) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, at = EXCLUDED.at`, [id, data, s.at]) })
  }
  deleteSession(id: string): Promise<void> { return this.writes.run(async () => { await (await this.db()).query(`DELETE FROM room_sessions WHERE id = $1`, [id]) }) }

  async audit(e: AuditEntry): Promise<void> {
    await (await this.db()).query(`INSERT INTO room_audit (at, data) VALUES ($1, $2)`, [e.at, JSON.stringify(e)])
  }
  async readAudit(o: { since?: number; limit?: number } = {}): Promise<AuditEntry[]> {
    const { rows } = await (await this.db()).query(`SELECT data FROM room_audit WHERE at >= $1 ORDER BY id DESC LIMIT $2`, [o.since ?? 0, o.limit ?? 1000])
    return rows.map(r => r.data as AuditEntry).reverse()
  }
  async close(): Promise<void> { await this.pool?.end(); this.pool = undefined }
}

/** FileStore under YPERSISTENCE (or in memory), unless DATABASE_URL points at Postgres. */
export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): Store {
  const url = env.DATABASE_URL?.trim()
  if (url) return new PgStore(url)
  return new FileStore({ dir: env.YPERSISTENCE?.trim() || undefined })
}
