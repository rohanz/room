/** Durable, process-owned files in the git common directory. All mutations after creation
 * are serialized by a sibling guard, so a stale owner cannot remove its successor. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { privateStateDirectory } from './private-state.js'
import { privateDirectoryPath } from './private-core.js'
import { pidAlive, probeOwnProcess, probeProcess, probeProcessConfirm, sameStartTime, type ProcessProbe } from './process.js'

export interface ProcessIdentity { pid: number; startTime: string; executable: string }
export interface InstanceToken extends ProcessIdentity { sessionId: string; nonce: string }
export type Liveness = 'alive' | 'dead' | 'unknown'

/**
 * Whether the recorded process still runs. A "dead" verdict from the shared probe on a pid that is still alive is
 * confirmed afresh (once per record, see CachedProcessProbe.confirm): the cache may hold a predecessor's identity
 * for a reused pid, and callers reclaim guards and leases from the dead. A vanished pid needs no confirmation.
 */
export function liveness(identity: ProcessIdentity, probe: ProcessProbe = probeProcess): Liveness {
  const verdict = livenessBy(identity, probe)
  return verdict === 'dead' && probe === probeProcess && pidAlive(identity.pid)
    ? livenessBy(identity, pid => probeProcessConfirm(pid, identity)) : verdict
}

function livenessBy(identity: ProcessIdentity, probe: ProcessProbe): Liveness {
  const observed = probe(identity.pid)
  if (!observed) return 'dead'
  if (observed.startTime && identity.startTime && !sameStartTime(observed.startTime, identity.startTime)) return 'dead'
  if (observed.executable && identity.executable && observed.executable !== identity.executable) return 'dead'
  if (!observed.startTime || !observed.executable || !identity.startTime || !identity.executable) return 'unknown'
  return 'alive'
}

function syncDirectory(dir: string): void {
  // Directory fsync is unsupported by some filesystems; the file itself was fsynced.
  let fd: number | undefined
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd) }
  catch (e) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

/**
 * Rewalk the current namespace on every publication. A leaf dev/ino memo cannot prove that its
 * ancestors' entries are durable: another process may rename an ancestor, replace it and reinsert
 * the original leaf (or reuse a removed inode). Even a surviving leaf must sync every parent.
 * We do not own/exclude namespace changes, so there is no sound cross-publication memo here.
 * For Room state the owned namespace starts at room/: sync its entry in the existing common
 * directory, but not the user's repository location above it. Other writers retain the root walk.
 */
function ensureDurableDirectory(dir: string, holdsFile: boolean, boundary?: string, durable = true): void {
  const parent = path.dirname(dir)
  // A drive/share root already exists; Windows rejects mkdir on it with EPERM.
  // The existing common directory is also a boundary; Room never creates or publishes it.
  if (parent === dir || dir === boundary) {
    if (!fs.statSync(dir).isDirectory()) throw Object.assign(new Error(`Not a directory: ${dir}`), { code: 'ENOTDIR' })
    return
  }
  ensureDurableDirectory(parent, false, boundary, durable)
  try {
    // Every atomic writer uses the same creation/Windows ACL policy as daemon startup.
    if (process.platform === 'win32' && !holdsFile) fs.mkdirSync(dir) // ancestors hold no private files
    else if (!fs.existsSync(dir)) privateStateDirectory(dir)
    else fs.mkdirSync(dir, { mode: 0o700 }) // EEXIST below; existing OS ancestors may be canonical aliases
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  // EEXIST may mean another writer created this directory but has not fsynced its parent yet.
  if (durable) syncDirectory(parent)
}

const startMarker = (startTime: string): string => createHash('sha256').update(startTime).digest('hex').slice(0, 24)
const tempPattern = /\.roomtmp-p(\d+)-s([a-f0-9]{24}|u)-n[0-9a-f-]{36}\.tmp$/

/** Opportunistic maintenance: a pid must be gone before its temp is removed.
 * A failed or disagreeing identity probe alone cannot prove the writer exited. */
export function cleanupOrphanTemps(dir: string, probe: ProcessProbe = probeProcess, durable = true): number {
  let removed = 0
  for (const name of fs.readdirSync(dir)) {
    const match = tempPattern.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    const observed = probe(pid)
    if (observed && (match[2] === 'u' || !observed.startTime || startMarker(observed.startTime) === match[2])) continue
    // A mismatched or absent probe is not proof of death: the writer might still
    // be alive when ps or sysctl cannot give us the same marker it recorded.
    if (pidAlive(pid)) continue
    try { fs.unlinkSync(path.join(dir, name)); removed++ }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  if (removed && durable) syncDirectory(dir)
  return removed
}

/** Durability is the default. Use false only for live-process coordination whose recovery
 * authority is held in separate durable records; publication is still complete and atomic. */
export interface AtomicOptions { durable?: boolean }

function writeTemp(file: string, content: object, durable: boolean): string {
  const dir = path.resolve(path.dirname(file))
  const namespace = privateDirectoryPath(dir)
  ensureDurableDirectory(dir, true, namespace.inState ? path.dirname(namespace.root) : undefined, durable)
  cleanupOrphanTemps(dir, probeProcess, durable)
  const start = probeOwnProcess()?.startTime
  const temp = `${file}.roomtmp-p${process.pid}-s${start ? startMarker(start) : 'u'}-n${randomUUID()}.tmp`
  const fd = fs.openSync(temp, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(content) + '\n'); if (durable) fs.fsyncSync(fd) }
  catch (e) { fs.closeSync(fd); fs.rmSync(temp, { force: true }); if (durable) syncDirectory(dir); throw e }
  fs.closeSync(fd)
  return temp
}

/** Atomic exclusive create: link a fully written temp file so no reader sees a partial JSON value. */
export function createExclusive(file: string, content: object, { durable = true }: AtomicOptions = {}): boolean {
  const temp = writeTemp(file, content, durable)
  try {
    try { fs.linkSync(temp, file) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e }
    if (durable) syncDirectory(path.dirname(file))
    return true
  } finally { fs.rmSync(temp, { force: true }); if (durable) syncDirectory(path.dirname(file)) }
}

/** Atomic replacement for single-writer records or files held under a guard; durable by default. */
export function writeAtomic(file: string, content: object, { durable = true }: AtomicOptions = {}): void {
  const temp = writeTemp(file, content, durable)
  try { renameAtomic(temp, file); if (durable) syncDirectory(path.dirname(file)) }
  finally { fs.rmSync(temp, { force: true }); if (durable) syncDirectory(path.dirname(file)) }
}

/** Windows can temporarily deny replacement while another writer or scanner holds the destination.
 * Keep the fully written temp and retry only those sharing/permission errors, bounded to two seconds. */
function renameAtomic(temp: string, file: string): void {
  const until = performance.now() + 2000
  let sleeper: Int32Array | undefined
  let attempts = 0
  for (;;) {
    try { fs.renameSync(temp, file); return }
    catch (error) {
      const remaining = until - performance.now()
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || remaining <= 0) throw error
      const delay = Math.min(remaining, Math.min(100, ++attempts * 10) + Math.random() * 10)
      Atomics.wait(sleeper ??= new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
    }
  }
}

function read(file: string): Record<string, unknown> | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}

/** Leases with payloads store a holder field; a run writer is itself the token. */
function leaseToken(value: Record<string, unknown>): InstanceToken | undefined {
  const candidate = (value.holder ?? value) as Partial<InstanceToken> | null
  return candidate && typeof candidate.pid === 'number' && typeof candidate.startTime === 'string'
    && typeof candidate.executable === 'string' && typeof candidate.sessionId === 'string' && typeof candidate.nonce === 'string'
    ? candidate as InstanceToken : undefined
}

function ownToken(): InstanceToken {
  const current = probeOwnProcess()
  return { pid: process.pid, startTime: current?.startTime ?? '', executable: current?.executable ?? '', sessionId: `mcp:${process.pid}:${current?.startTime ?? 'unknown'}`, nonce: randomUUID() }
}

/** Guard acquisition recovers a dead guard through its own guard; a live or unreadable holder blocks. */
function acquireGuard(file: string, probe: ProcessProbe, depth = 0, durable = true): InstanceToken {
  if (depth > 12) throw new Error(`too many stale lease guards at ${file}`)
  const token = ownToken()
  if (createExclusive(file, token, { durable })) return token
  const previous = read(file)
  const previousHolder = previous && leaseToken(previous)
  if (!previousHolder || liveness(previousHolder, probe) !== 'dead') throw new Error(`lease guard busy: ${file}`)
  const outer = acquireGuard(`${file}.guard`, probe, depth + 1, durable)
  try {
    const latest = read(file)
    const latestHolder = latest && leaseToken(latest)
    if (latestHolder && liveness(latestHolder, probe) === 'dead') {
      fs.unlinkSync(file)
      if (durable) syncDirectory(path.dirname(file))
    }
  } finally { releaseGuard(`${file}.guard`, outer, durable) }
  if (createExclusive(file, token, { durable })) return token
  throw new Error(`lease guard busy: ${file}`)
}

function releaseGuard(file: string, token: InstanceToken, durable: boolean): void {
  const current = read(file)
  if (current && leaseToken(current)?.nonce === token.nonce) {
    fs.unlinkSync(file)
    if (durable) syncDirectory(path.dirname(file))
  }
}

export function withGuard<T>(file: string, fn: () => T extends PromiseLike<unknown> ? never : T, probe: ProcessProbe = probeProcess, { durable = true }: AtomicOptions = {}): T {
  const guard = `${file}.guard`
  const token = acquireGuard(guard, probe, 0, durable)
  try {
    const result = fn()
    if (result && typeof (result as { then?: unknown }).then === 'function') throw new TypeError('lease guard callback must be synchronous')
    return result
  }
  finally { releaseGuard(guard, token, durable) }
}

export function replace(file: string, expect: (content: Record<string, any>) => boolean, next: object): boolean {
  return withGuard(file, () => {
    const current = read(file)
    if (!current || !expect(current)) return false
    writeAtomic(file, next)
    return true
  })
}

export function compareAndRelease(file: string, token: InstanceToken): boolean {
  return withGuard(file, () => {
    const current = read(file)
    if (!current || leaseToken(current)?.nonce !== token.nonce) return false
    fs.unlinkSync(file)
    syncDirectory(path.dirname(file))
    return true
  })
}

export function recover(file: string, orphan: (content: Record<string, any>) => boolean, probe: ProcessProbe = probeProcess): boolean {
  return withGuard(file, () => {
    const current = read(file)
    const owner = current && leaseToken(current)
    if (!current || !owner || liveness(owner, probe) !== 'dead' || !orphan(current)) return false
    fs.unlinkSync(file)
    syncDirectory(path.dirname(file))
    return true
  })
}
