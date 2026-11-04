/**
 * Where the server keeps its small, non-document state: the registry of opened repos, login
 * sessions and the audit log. Room documents stay in LevelDB (y-websocket persistence).
 *
 *  - FileStore: JSON files next to the LevelDB data (default; in-memory when no directory is set).
 *  - PgStore:   three tables in Postgres (DATABASE_URL), created on start.
 */
import fs from 'node:fs'
import path from 'node:path'
import { auditKeepFiles, envMegabytes } from './settings.js'

/** The migration step is a commit record; publish a complete registry snapshot before proceeding. */
export function writeAtomicFile(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  const fd = fs.openSync(temporary, 'wx', 0o600)
  let replaced = false
  try {
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd) }
    finally { fs.closeSync(fd) }
    fs.renameSync(temporary, file)
    replaced = true
  } finally { if (!replaced) fs.rmSync(temporary, { force: true }) }
  try {
    const dir = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  } catch (e) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e
  }
}

interface MigrationPlan { id: string; sources: string[]; moved?: string }
export interface OpenRepo {
  by?: string; at: number; branches: string[]; lastSeen?: number
  mode?: 'branch' | 'repo'; legacy?: string[]; plan?: MigrationPlan
  step?: 'planned' | 'frozen' | 'moved' | 'written'; migratedAt?: number; unresolved?: number
  quarantined?: { name: string; bytes: number; over: boolean; reason: string }[]
  migrationSkippedSources?: number; migrationSkippedRecords?: number; migrationSkippedRecordCountsUnknown?: number
}
/** `login` is the display name (GitHub login, verified email or preferred_username). `id` is the
 *  namespaced identity used for admission and admin checks: `oidc:<issuer-host>:<sub>` for OIDC
 *  sessions; absent (same as the login) for GitHub sessions and sessions written before it existed. */
export interface StoredSession { login: string; id?: string; provider: 'github' | 'oidc'; ghToken?: string; at: number }
type AuditEvent = 'login' | 'logout' | 'room_opened' | 'room_closed' | 'join' | 'refused' | 'identity_violation' | 'document_purged'
export interface AuditEntry { at: number; event: AuditEvent; login?: string; id?: string; provider?: string; room?: string; reason?: string; readOnly?: boolean }
/** The whole audit, or `complete: false` (and no entries) when any of it could be missing or unreadable. */
export interface AuditRead { entries: AuditEntry[]; complete: boolean }
/** Why entries in a requested range may be missing: the scan's byte budget or deadline ran out before it
 *  reached the range's start, a line could not be read, older history was deleted (by retention, or a
 *  segment vanished during the read), or the audit kept rotating while the read opened it (retry). */
type AuditGap = 'scan-bytes' | 'deadline' | 'unreadable' | 'pruned' | 'rotated'
/** A requested tail, oldest first. `complete` is true only when no entry the request covers can be missing. */
export interface AuditTail { entries: AuditEntry[]; complete: boolean; gaps: AuditGap[] }
export interface AuditQuery {
  /** Entries at or after this time (ms). Default 0. */
  since?: number
  /** Newest entries kept. Default 1000. */
  limit?: number
  /** Bytes a file audit scan may read. Default AUDIT_SCAN_MAX_BYTES. */
  maxScanBytes?: number
  /** Time the scan may take. Default AUDIT_SCAN_DEADLINE_MS. */
  deadlineMs?: number
}
/** Default bytes one audit listing may scan. */
const AUDIT_SCAN_MAX_BYTES = 64 * 1048576
/** Default time one audit read may take; it yields between chunks, so other rooms keep running meanwhile. */
const AUDIT_SCAN_DEADLINE_MS = 10_000
const AUDIT_CHUNK_BYTES = 64 * 1024
/** A line longer than this is not an entry the server wrote: skipped as unreadable without being buffered. */
const AUDIT_MAX_LINE_BYTES = 1048576
const GAP_ORDER: AuditGap[] = ['rotated', 'pruned', 'scan-bytes', 'deadline', 'unreadable']
const gapList = (gaps: Set<AuditGap>) => GAP_ORDER.filter(g => gaps.has(g))

/** Reads audit segments (oldest first, already opened so rotation cannot move them away) backwards in
 *  bounded chunks, keeping at most `limit` entries at or after `since`. Entries are appended in time
 *  order, so the first one older than `since` ends the scan. `strict` stops at the first unreadable line. */
async function scanAuditTail(handles: { fd: fs.promises.FileHandle; size: number }[], o: Required<AuditQuery> & { strict?: boolean },
  now: () => number = Date.now): Promise<{ entries: AuditEntry[]; gaps: Set<AuditGap>; reachedStart: boolean }> {
  const out: AuditEntry[] = [], gaps = new Set<AuditGap>()
  const deadline = now() + o.deadlineMs
  let scanned = 0
  /** false: stop scanning (limit reached, older than since, or strict failure). */
  const take = (line: Buffer): boolean => {
    if (!line.length) return true
    let e: unknown
    try { e = JSON.parse(line.toString('utf8')) } catch { e = undefined }
    if (!isEntry(e) || typeof e.at !== 'number') { gaps.add('unreadable'); return !o.strict }
    if (e.at < o.since) return false
    out.push(e)
    return out.length < o.limit
  }
  for (let i = handles.length - 1; i >= 0; i--) {
    const { fd, size } = handles[i]!
    let position = size, carry: Buffer = Buffer.alloc(0), discarding = false
    while (position > 0) {
      if (scanned >= o.maxScanBytes) { gaps.add('scan-bytes'); return { entries: out.reverse(), gaps, reachedStart: false } }
      if (now() > deadline) { gaps.add('deadline'); return { entries: out.reverse(), gaps, reachedStart: false } }
      const length = Math.min(AUDIT_CHUNK_BYTES, position, o.maxScanBytes - scanned)
      position -= length
      const chunk = Buffer.alloc(length)
      const { bytesRead } = await fd.read(chunk, 0, length, position)
      scanned += bytesRead
      let buf = chunk.subarray(0, bytesRead)
      if (discarding) {
        // Skipping the start of an overlong line: everything up to the newline that ends the line before it.
        const nl = buf.lastIndexOf(10)
        if (nl < 0) continue
        buf = buf.subarray(0, nl + 1); discarding = false
      } else buf = carry.length ? Buffer.concat([buf, carry]) : buf
      // The bytes before this chunk's first newline continue into the previous chunk.
      let end = buf.length
      for (let nl = buf.lastIndexOf(10, end - 1); nl >= 0; nl = nl > 0 ? buf.lastIndexOf(10, nl - 1) : -1) {
        if (!take(buf.subarray(nl + 1, end))) return { entries: out.reverse(), gaps, reachedStart: false }
        end = nl
      }
      carry = Buffer.from(buf.subarray(0, end))
      if (carry.length > AUDIT_MAX_LINE_BYTES) { gaps.add('unreadable'); if (o.strict) return { entries: out.reverse(), gaps, reachedStart: false }; carry = Buffer.alloc(0); discarding = true }
    }
    if (!discarding && !take(carry)) return { entries: out.reverse(), gaps, reachedStart: false }
  }
  return { entries: out.reverse(), gaps, reachedStart: true }
}
const incomplete = (): AuditRead => ({ entries: [], complete: false })
const isEntry = (e: unknown): e is AuditEntry => !!e && typeof e === 'object' && !Array.isArray(e)

/** A JSON object of records. Only a missing file is empty: an unreadable, torn or non-object file
 *  throws, so callers keep the state they have instead of treating it as an empty table. */
function readTable<T>(file: string): Record<string, T> {
  let text: string
  try { text = fs.readFileSync(file, 'utf8') }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`could not read ${file}: ${e instanceof Error ? e.message : e}`)
  }
  let value: unknown
  try { value = JSON.parse(text) } catch (e) { throw new Error(`${file} is not valid JSON: ${e instanceof Error ? e.message : e}`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} does not hold a JSON object`)
  return value as Record<string, T>
}

/** Most in-memory audit entries kept when there is no audit file: oldest are dropped past this. */
export const MEM_AUDIT_MAX = 5000

/** A store's pending-write bound is reached: the operation was not queued; answer unavailable and retry. */
export class StoreBusy extends Error {
  constructor(what: string) { super(`${what} store busy: too many writes pending; retry`) }
}
/** One pending write's acknowledgement, shared by every caller coalesced into it: a stalled store holds
 *  one promise per pending write however many callers wait, never one per call. */
class Generation {
  readonly done: Promise<void>
  private resolve!: () => void
  private reject!: (e: unknown) => void
  constructor() { this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject }) }
  async run(write: () => Promise<void>): Promise<void> {
    try { await write(); this.resolve() } catch (e) { this.reject(e) }
  }
}

/** Whole-table replacements, one at a time in call order. The first is written at once; snapshots saved
 *  while it runs collapse into one pending write of the newest, which acknowledges every caller it replaced
 *  (a later complete snapshot is at least as new as theirs). So a slow store holds two snapshots and two
 *  acknowledgements at most. */
export class SnapshotWriter<T> {
  private pending?: { value: T; ack: Generation }
  private running = false
  constructor(private readonly write: (value: T) => Promise<void>) {}
  save(value: T): Promise<void> {
    if (this.pending) this.pending.value = value
    else this.pending = { value, ack: new Generation() }
    const { done } = this.pending.ack
    if (!this.running) void this.drain()
    return done
  }
  private async drain(): Promise<void> {
    this.running = true
    while (this.pending) {
      const { value, ack } = this.pending
      this.pending = undefined
      await ack.run(() => this.write(value))
    }
    this.running = false
  }
}

/** Default bound on distinct sessions with a pending write (SessionWrites). */
const SESSION_WRITES_MAX_PENDING = 10_000

/** Per-session puts and deletes, one batch at a time in call order. Operations arriving while a batch
 *  runs join the next one, where the last operation per session wins: exactly the state applying them in
 *  order produces, so a deletion is only ever superseded by a later write of the same session, never
 *  dropped. Past `maxPending` distinct sessions a new one is refused with StoreBusy (callers retry; an owed
 *  logout is retried by Auth); updates to an already pending session are always accepted. Every operation
 *  in a batch shares the batch's acknowledgement, so pending state is bounded by `maxPending` sessions
 *  and two acknowledgements, however often one session is written or revoked behind a stalled flush. */
export class SessionWrites {
  private pending = new Map<string, StoredSession | null>()
  private ack = new Generation()
  private running = false
  constructor(private readonly flush: (ops: ReadonlyMap<string, StoredSession | null>) => Promise<void>,
    private readonly maxPending = SESSION_WRITES_MAX_PENDING) {}
  put(id: string, s: StoredSession): Promise<void> { return this.enqueue(id, { ...s }) }
  delete(id: string): Promise<void> { return this.enqueue(id, null) }
  private enqueue(id: string, value: StoredSession | null): Promise<void> {
    if (!this.pending.has(id) && this.pending.size >= this.maxPending) return Promise.reject(new StoreBusy('session'))
    // A re-set key keeps its place in the batch, as the last operation for that session.
    this.pending.set(id, value)
    const { done } = this.ack
    if (!this.running) void this.drain()
    return done
  }
  private async drain(): Promise<void> {
    this.running = true
    while (this.pending.size) {
      const batch = this.pending, ack = this.ack
      this.pending = new Map(); this.ack = new Generation()
      await ack.run(() => this.flush(batch))
    }
    this.running = false
  }
}

export interface Store {
  /** Create tables / directories. Called once before use. */
  init(): Promise<void>
  /** Rejects when stored state exists but cannot be read; only absent state is empty. */
  loadRooms(): Promise<Record<string, OpenRepo>>
  saveRooms(all: Record<string, OpenRepo>): Promise<void>
  /** Rejects when stored state exists but cannot be read; only absent state is empty. */
  loadSessions(): Promise<Record<string, StoredSession>>
  putSession(id: string, s: StoredSession): Promise<void>
  deleteSession(id: string): Promise<void>
  audit(e: AuditEntry): Promise<void>
  /** The newest entries at or after `since` (ms), oldest first, at most `limit`, within a scan budget. */
  readAudit(o?: AuditQuery): Promise<AuditTail>
  /** Every entry, oldest first, as evidence: incomplete past `limit` entries or `maxBytes` stored, or with any unreadable entry. */
  readAllAudit(o: { limit: number; maxBytes: number }): Promise<AuditRead>
  close(): Promise<void>
}

export interface FileStoreOptions {
  /** Directory for rooms.json, sessions.json and audit.log. Omit for in-memory. */
  dir?: string
  sessionsFile?: string
  roomsFile?: string
  auditFile?: string
  /** Start a new audit segment once the current one would pass this size (ROOM_AUDIT_ROTATE_MB). Default 64 MiB. */
  auditRotateBytes?: number
  /** Rotated segments kept; older ones are deleted and recorded as pruned (ROOM_AUDIT_KEEP_FILES). Default: all. */
  auditKeepFiles?: number
}

/** Default audit segment size before rotation. */
const AUDIT_ROTATE_BYTES = 64 * 1048576
const fileSize = (file: string): number => {
  try { return fs.statSync(file).size } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e }
}
/** Rotated segments of an audit file, oldest first. */
function auditSegments(file: string): { n: number; path: string }[] {
  const base = path.basename(file), dir = path.dirname(file)
  let names: string[]
  try { names = fs.readdirSync(dir) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  return names.flatMap(name => {
    const m = name.startsWith(base + '.') ? /^(\d+)$/.exec(name.slice(base.length + 1)) : null
    return m ? [{ n: Number(m[1]), path: path.join(dir, name) }] : []
  }).sort((a, b) => a.n - b.n)
}
/** The retention record's text, or undefined when retention never deleted a segment. */
function readPrunedText(file: string): string | undefined {
  try { return fs.readFileSync(`${file}.pruned`, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}
/** Newest last-write time (ms) of any deleted segment, or undefined when retention never deleted one. */
function prunedThrough(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  // An unreadable record still says something was pruned: assume everything was.
  try { const through = (JSON.parse(text) as { through?: unknown }).through; return typeof through === 'number' ? through : Infinity } catch { return Infinity }
}
const readPruned = (file: string) => prunedThrough(readPrunedText(file))
const inodeOf = (file: string): number | undefined => {
  try { return fs.statSync(file).ino } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}
/** Attempts at opening one consistent set of segments before a read reports the audit as rotating. */
const AUDIT_OPEN_ATTEMPTS = 3
type AuditHandle = { fd: fs.promises.FileHandle; size: number }
/** What the read saw: `rotated` when no attempt opened a consistent set (handles are then empty);
 *  `vanished` when a listed segment was deleted before it could be opened; `all` when every segment
 *  is open; `pruned` as readPruned, read after the last open. */
interface AuditGeneration { handles: AuditHandle[]; all: boolean; pruned: number | undefined; vanished: boolean; rotated: boolean }

/** Opens audit.log, then segments newest first until `budget` bytes are covered; once open, rotation and
 *  retention cannot move data out from under the read. The set is one generation only if audit.log is
 *  the same file and the retention record unchanged from before the first open to after the last; a
 *  rotation or retention in between discards the set and tries again. Retention records a deletion
 *  before making it, so the record read after the last open covers every segment missing from the set. */
async function withAuditHandles<T>(file: string, budget: number, read: (g: AuditGeneration) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const opened: (AuditHandle & { ino: number })[] = []
    let vanished = false
    const open = async (p: string, listed: boolean) => {
      let fd: fs.promises.FileHandle
      try { fd = await fs.promises.open(p, 'r') } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        if (listed) vanished = true
        return
      }
      const st = await fd.stat()
      if (opened.some(h => h.ino === st.ino)) { await fd.close(); return }
      opened.push({ fd, size: st.size, ino: st.ino })
    }
    try {
      const marker = readPrunedText(file), current = inodeOf(file)
      await open(file, false)
      const segments = auditSegments(file)
      let covered = opened[0]?.size ?? 0, i = segments.length - 1
      for (; i >= 0 && covered < budget; i--) { await open(segments[i]!.path, true); covered = opened.reduce((n, h) => n + h.size, 0) }
      const after = readPrunedText(file), now = inodeOf(file)
      const openedCurrent = current !== undefined && opened[0]?.ino === current
      const consistent = marker === after && current === now && (current === undefined || openedCurrent)
      if (!consistent && attempt < AUDIT_OPEN_ATTEMPTS) continue
      // Newest first as opened: audit.log, then segments descending. Scans want oldest first.
      return await read(consistent
        ? { handles: opened.slice().reverse(), all: i < 0, pruned: prunedThrough(after), vanished, rotated: false }
        : { handles: [], all: false, pruned: prunedThrough(after), vanished, rotated: true })
    } finally { await Promise.all(opened.map(h => h.fd.close().catch(() => undefined))) }
  }
}

export class FileStore implements Store {
  private readonly sessionsFile?: string
  private readonly roomsFile?: string
  private readonly auditFile?: string
  private sessions: Record<string, StoredSession> = {}
  private memAudit: AuditEntry[] = []
  /** Newest time among in-memory entries dropped past MEM_AUDIT_MAX. */
  private memDroppedThrough = -Infinity
  private readonly auditRotateBytes: number
  private readonly auditKeepFiles?: number
  /** Size of audit.log as this process last knew it; read on first append. */
  private auditSize?: number
  private readonly roomWrites = new SnapshotWriter<string>(async text => { if (this.roomsFile) writeAtomicFile(this.roomsFile, text) })
  /** Read, change and atomically replace the 0600 file (sessions hold GitHub tokens), once per batch. A file
   *  that cannot be read is never replaced: the batch is rejected and the file keeps what it holds. */
  private readonly sessionWrites = new SessionWrites(async ops => {
    const all = this.sessionsFile ? readTable<StoredSession>(this.sessionsFile) : this.sessions
    for (const [id, value] of ops) if (value) all[id] = value; else delete all[id]
    if (this.sessionsFile) writeAtomicFile(this.sessionsFile, JSON.stringify(all))
  })

  constructor(o: FileStoreOptions = {}) {
    this.sessionsFile = o.sessionsFile ?? (o.dir ? path.join(o.dir, 'sessions.json') : undefined)
    this.roomsFile = o.roomsFile ?? (o.dir ? path.join(o.dir, 'rooms.json') : undefined)
    this.auditFile = o.auditFile ?? (o.dir ? path.join(o.dir, 'audit.log') : undefined)
    this.auditRotateBytes = o.auditRotateBytes ?? AUDIT_ROTATE_BYTES
    this.auditKeepFiles = o.auditKeepFiles
  }

  async init(): Promise<void> {
    for (const f of [this.sessionsFile, this.roomsFile, this.auditFile]) if (f) fs.mkdirSync(path.dirname(f), { recursive: true })
  }

  async loadRooms(): Promise<Record<string, OpenRepo>> {
    const raw = this.roomsFile ? readTable<Partial<OpenRepo>>(this.roomsFile) : {}
    const out: Record<string, OpenRepo> = {}
    for (const [k, v] of Object.entries(raw)) out[k] = { ...v, by: v.by, at: v.at ?? Date.now(), branches: v.branches ?? [] }
    return out
  }
  saveRooms(all: Record<string, OpenRepo>): Promise<void> {
    return this.roomWrites.save(JSON.stringify(all))
  }

  /** The file is the source of truth (an operator may edit it); without one, this process's map is. */
  async loadSessions(): Promise<Record<string, StoredSession>> {
    return { ...(this.sessionsFile ? readTable<StoredSession>(this.sessionsFile) : this.sessions) }
  }
  putSession(id: string, s: StoredSession): Promise<void> { return this.sessionWrites.put(id, s) }
  deleteSession(id: string): Promise<void> { return this.sessionWrites.delete(id) }

  /** Appends to audit.log; once it would pass `auditRotateBytes` it is renamed to the next numbered
   *  segment (audit.log.1, .2, ...). With `auditKeepFiles`, segments past that count are deleted after
   *  audit.log.pruned records that they were and when they were last written, so later reads can say
   *  which requests the deletion affects. A failed rotation still appends the entry, then reports. */
  async audit(e: AuditEntry): Promise<void> {
    if (!this.auditFile) {
      this.memAudit.push(e)
      if (this.memAudit.length > MEM_AUDIT_MAX) {
        for (const d of this.memAudit.splice(0, this.memAudit.length - MEM_AUDIT_MAX)) this.memDroppedThrough = Math.max(this.memDroppedThrough, d.at)
      }
      return
    }
    const line = JSON.stringify(e) + '\n', bytes = Buffer.byteLength(line)
    this.auditSize ??= fileSize(this.auditFile)
    let rotateError: unknown
    if (this.auditSize > 0 && this.auditSize + bytes > this.auditRotateBytes) {
      try { this.rotateAudit(this.auditFile) } catch (err) { rotateError = err; this.auditSize = fileSize(this.auditFile) }
    }
    fs.appendFileSync(this.auditFile, line)
    this.auditSize += bytes
    if (rotateError) throw new Error(`audit rotation failed (entry appended): ${rotateError instanceof Error ? rotateError.message : rotateError}`)
  }
  private rotateAudit(file: string): void {
    const segments = auditSegments(file)
    fs.renameSync(file, `${file}.${(segments.at(-1)?.n ?? 0) + 1}`)
    this.auditSize = 0
    if (this.auditKeepFiles === undefined) return
    const drop = auditSegments(file).slice(0, -this.auditKeepFiles)
    if (!drop.length) return
    let through = readPruned(file) ?? -Infinity
    for (const d of drop) through = Math.max(through, Math.ceil(fs.statSync(d.path).mtimeMs))
    // Recorded before deleting: a crash in between over-reports pruning, never hides it.
    writeAtomicFile(`${file}.pruned`, JSON.stringify({ through, at: Date.now() }))
    for (const d of drop) fs.rmSync(d.path, { force: true })
  }
  async readAudit(o: AuditQuery = {}): Promise<AuditTail> {
    const q = { since: o.since ?? 0, limit: o.limit ?? 1000, maxScanBytes: o.maxScanBytes ?? AUDIT_SCAN_MAX_BYTES, deadlineMs: o.deadlineMs ?? AUDIT_SCAN_DEADLINE_MS }
    if (!this.auditFile) {
      const hits = this.memAudit.filter(e => e.at >= q.since)
      const gaps: AuditGap[] = hits.length < q.limit && this.memDroppedThrough >= q.since ? ['pruned'] : []
      return { entries: hits.slice(Math.max(0, hits.length - q.limit)), complete: !gaps.length, gaps }
    }
    return withAuditHandles(this.auditFile, q.maxScanBytes, async ({ handles, all, pruned, vanished, rotated }) => {
      if (rotated) return { entries: [], complete: false, gaps: ['rotated'] }
      const r = await scanAuditTail(handles, q)
      if (r.reachedStart && !all) r.gaps.add('scan-bytes')
      // Which entries a vanished segment held is unknown, so the whole read is suspect.
      if (vanished || (r.reachedStart && all && pruned !== undefined && q.since <= pruned)) r.gaps.add('pruned')
      const gaps = gapList(r.gaps)
      return { entries: r.entries, complete: !gaps.length, gaps }
    })
  }
  /** The in-memory audit drops its oldest entries past MEM_AUDIT_MAX, and retention may have deleted
   *  segments, so only a never-pruned audit file within the bounds can be complete. */
  async readAllAudit(o: { limit: number; maxBytes: number }): Promise<AuditRead> {
    if (!this.auditFile) return incomplete()
    return withAuditHandles(this.auditFile, o.maxBytes + 1, async ({ handles, all, pruned, vanished, rotated }) => {
      if (rotated || vanished || !all || pruned !== undefined || handles.reduce((n, h) => n + h.size, 0) > o.maxBytes) return incomplete()
      const r = await scanAuditTail(handles, { since: -Infinity, limit: o.limit + 1, maxScanBytes: o.maxBytes, deadlineMs: AUDIT_SCAN_DEADLINE_MS, strict: true })
      if (!r.reachedStart || r.gaps.size || r.entries.length > o.limit) return incomplete()
      return { entries: r.entries, complete: true }
    })
  }
  async close(): Promise<void> { /* nothing open */ }
}

/** Minimal shape of a `pg` Pool, so the driver is only loaded when DATABASE_URL is set. */
interface PgClientLike { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; release(): void }
interface PgLike { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; connect(): Promise<PgClientLike>; end(): Promise<void> }

export class PgStore implements Store {
  private pool?: PgLike
  // One client for the whole transaction: on a Pool each query() may use a different connection.
  private async transaction(work: (client: PgClientLike) => Promise<void>): Promise<void> {
    const client = await (await this.db()).connect()
    try {
      await client.query('BEGIN')
      await work(client)
      await client.query('COMMIT')
    } catch (e) { try { await client.query('ROLLBACK') } catch { /* connection gone */ } throw e }
    finally { client.release() }
  }
  private readonly roomWrites = new SnapshotWriter<(readonly [string, string])[]>(rows => this.transaction(async client => {
    await client.query(`DELETE FROM room_repos`)
    for (const [repo, data] of rows) await client.query(`INSERT INTO room_repos (repo, data) VALUES ($1, $2)`, [repo, data])
  }))
  private readonly sessionWrites = new SessionWrites(async ops => {
    const apply = async (db: Pick<PgLike, 'query'>, id: string, s: StoredSession | null) => {
      if (s) await db.query(`INSERT INTO room_sessions (id, data, at) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, at = EXCLUDED.at`, [id, JSON.stringify(s), s.at])
      else await db.query(`DELETE FROM room_sessions WHERE id = $1`, [id])
    }
    if (ops.size === 1) { const [[id, s]] = [...ops]; await apply(await this.db(), id!, s!); return }
    await this.transaction(async client => { for (const [id, s] of ops) await apply(client, id, s) })
  })
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
    // Serialized now: the registry may change before the write runs.
    return this.roomWrites.save(Object.entries(all).map(([repo, data]) => [repo, JSON.stringify(data)] as const))
  }

  async loadSessions(): Promise<Record<string, StoredSession>> {
    const { rows } = await (await this.db()).query(`SELECT id, data FROM room_sessions`)
    return Object.fromEntries(rows.map(r => [r.id as string, r.data as StoredSession]))
  }
  putSession(id: string, s: StoredSession): Promise<void> { return this.sessionWrites.put(id, s) }
  deleteSession(id: string): Promise<void> { return this.sessionWrites.delete(id) }

  async audit(e: AuditEntry): Promise<void> {
    await (await this.db()).query(`INSERT INTO room_audit (at, data) VALUES ($1, $2)`, [e.at, JSON.stringify(e)])
  }
  /** Indexed and LIMITed in the database, so no scan budget applies; the table has no retention. */
  async readAudit(o: AuditQuery = {}): Promise<AuditTail> {
    const { rows } = await (await this.db()).query(`SELECT data FROM room_audit WHERE at >= $1 ORDER BY id DESC LIMIT $2`, [o.since ?? 0, o.limit ?? 1000])
    return { entries: rows.map(r => r.data as AuditEntry).reverse(), complete: true, gaps: [] }
  }
  /** Counted before it is fetched, so an oversized audit is refused without loading it; LIMIT bounds rows added in between. */
  async readAllAudit(o: { limit: number; maxBytes: number }): Promise<AuditRead> {
    const db = await this.db()
    const { rows: [size] } = await db.query(`SELECT count(*) AS n, coalesce(sum(octet_length(data::text)), 0) AS bytes FROM room_audit`)
    if (!(Number(size?.n) <= o.limit && Number(size?.bytes) <= o.maxBytes)) return incomplete()
    const { rows } = await db.query(`SELECT data FROM room_audit ORDER BY id LIMIT $1`, [o.limit + 1])
    if (rows.length > o.limit || !rows.every(r => isEntry(r.data))) return incomplete()
    return { entries: rows.map(r => r.data as AuditEntry), complete: true }
  }
  async close(): Promise<void> { await this.pool?.end(); this.pool = undefined }
}

/** FileStore under YPERSISTENCE (or in memory), unless DATABASE_URL points at Postgres. */
export function storeFromEnv(env: NodeJS.ProcessEnv = process.env): Store {
  const url = env.DATABASE_URL?.trim()
  if (url) return new PgStore(url)
  return new FileStore({ dir: env.YPERSISTENCE?.trim() || undefined,
    auditRotateBytes: envMegabytes(env, 'ROOM_AUDIT_ROTATE_MB', 64), auditKeepFiles: auditKeepFiles(env) })
}
