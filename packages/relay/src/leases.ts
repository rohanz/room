/** Durable, process-owned files in the git common directory. All mutations after creation
 * are serialized by a sibling guard, so a stale owner cannot remove its successor. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { privateStateDirectory } from './private-state.js'
import { validPid, pidAlive, probeOwnProcess, probeProcess, probeProcessConfirm, sameStartTime, type ProcessProbe } from './process.js'

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
  if (!validPid(identity.pid)) return 'unknown'
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

function ensureDurableDirectory(dir: string, holdsFile = true): void {
  const parent = path.dirname(dir)
  // A drive/share root already exists; Windows rejects mkdir on it with EPERM.
  // Stop only here: existing descendants still need their parent synced below.
  if (parent === dir) {
    if (!fs.statSync(dir).isDirectory()) throw Object.assign(new Error(`Not a directory: ${dir}`), { code: 'ENOTDIR' })
    return
  }
  ensureDurableDirectory(parent, false)
  try {
    // Every atomic writer uses the same creation/Windows ACL policy as daemon startup.
    if (process.platform === 'win32' && !holdsFile) fs.mkdirSync(dir) // ancestors hold no private files
    else if (!fs.existsSync(dir)) privateStateDirectory(dir)
    else fs.mkdirSync(dir, { mode: 0o700 }) // EEXIST below; existing OS ancestors may be canonical aliases
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  // EEXIST may mean another writer created this directory but has not fsynced its parent yet.
  syncDirectory(parent)
}

const startMarker = (startTime: string): string => createHash('sha256').update(startTime).digest('hex').slice(0, 24)
const tempPattern = /\.roomtmp-p(\d+)-s([a-f0-9]{24}|u)-n[0-9a-f-]{36}\.tmp$/

/** Opportunistic maintenance: a pid must be gone before its temp is removed.
 * A failed or disagreeing identity probe alone cannot prove the writer exited. */
export function cleanupOrphanTemps(dir: string, probe: ProcessProbe = probeProcess): number {
  let removed = 0
  for (const name of fs.readdirSync(dir)) {
    const match = tempPattern.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (!validPid(pid)) continue
    const observed = probe(pid)
    if (observed && (match[2] === 'u' || !observed.startTime || startMarker(observed.startTime) === match[2])) continue
    // A mismatched or absent probe is not proof of death: the writer might still
    // be alive when ps or sysctl cannot give us the same marker it recorded.
    if (pidAlive(pid)) continue
    try { fs.unlinkSync(path.join(dir, name)); removed++ }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  if (removed) syncDirectory(dir)
  return removed
}

function writeTemp(file: string, content: object): string {
  const dir = path.dirname(file)
  ensureDurableDirectory(dir)
  cleanupOrphanTemps(dir)
  const start = probeOwnProcess()?.startTime
  const temp = `${file}.roomtmp-p${process.pid}-s${start ? startMarker(start) : 'u'}-n${randomUUID()}.tmp`
  const fd = fs.openSync(temp, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(content) + '\n'); fs.fsyncSync(fd) }
  catch (e) { fs.closeSync(fd); fs.rmSync(temp, { force: true }); syncDirectory(dir); throw e }
  fs.closeSync(fd)
  return temp
}

/** Atomic exclusive create: link a fully written temp file so no reader sees a partial JSON value. */
export function createExclusive(file: string, content: object): boolean {
  const temp = writeTemp(file, content)
  try {
    try { fs.linkSync(temp, file) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e }
    syncDirectory(path.dirname(file))
    return true
  } finally { fs.rmSync(temp, { force: true }); syncDirectory(path.dirname(file)) }
}

/** Durable replacement for single-writer records or files held under a guard. */
export function writeAtomic(file: string, content: object): void {
  const temp = writeTemp(file, content)
  try { renameAtomic(temp, file); syncDirectory(path.dirname(file)) }
  finally { fs.rmSync(temp, { force: true }); syncDirectory(path.dirname(file)) }
}

/** Windows can temporarily deny replacement while another writer or scanner holds the destination.
 * Keep the fully synced temp and retry only those sharing/permission errors, bounded to two seconds. */
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
export function leaseToken(value: Record<string, unknown>): InstanceToken | undefined {
  const candidate = (value.holder ?? value) as Partial<InstanceToken> | null
  return candidate && typeof candidate.pid === 'number' && typeof candidate.startTime === 'string'
    && typeof candidate.executable === 'string' && typeof candidate.sessionId === 'string' && typeof candidate.nonce === 'string'
    ? candidate as InstanceToken : undefined
}

function ownToken(): InstanceToken {
  const current = probeOwnProcess()
  return { pid: process.pid, startTime: current?.startTime ?? '', executable: current?.executable ?? '', sessionId: `mcp:${process.pid}:${current?.startTime ?? 'unknown'}`, nonce: randomUUID() }
}

/** A failed post-link fsync or temp cleanup never returns a token to withGuard's
 * finally. Roll back our nonce here, including when an EEXIST attempt's cleanup
 * fails: a different holder must remain untouched. Share this boundary across
 * synchronous authority guards and asynchronous preview publisher guards. */
function createGuardSafely(file: string, token: InstanceToken, create: () => boolean): boolean
function createGuardSafely(file: string, token: InstanceToken, create: () => Promise<boolean>): Promise<boolean>
function createGuardSafely(file: string, token: InstanceToken, create: () => boolean | Promise<boolean>): boolean | Promise<boolean> {
  try {
    const created = create()
    return typeof created === 'boolean' ? created : created.catch(async error => {
      await releaseGuardAsync(file, token)
      throw error
    })
  } catch (error) { releaseGuard(file, token); throw error }
}

/** Guard acquisition recovers a dead guard through its own guard; a live or unreadable holder blocks. */
function acquireGuard(file: string, probe: ProcessProbe, depth = 0): InstanceToken {
  if (depth > 12) throw new Error(`too many stale lease guards at ${file}`)
  const token = ownToken()
  if (createGuardSafely(file, token, () => createExclusive(file, token))) return token
  const previous = read(file)
  const previousHolder = previous && leaseToken(previous)
  if (!previousHolder || liveness(previousHolder, probe) !== 'dead') throw new Error(`lease guard busy: ${file}`)
  const outer = acquireGuard(`${file}.guard`, probe, depth + 1)
  try {
    const latest = read(file)
    const latestHolder = latest && leaseToken(latest)
    if (latestHolder && liveness(latestHolder, probe) === 'dead') {
      fs.unlinkSync(file)
      syncDirectory(path.dirname(file))
    }
  } finally { releaseGuard(`${file}.guard`, outer) }
  if (createGuardSafely(file, token, () => createExclusive(file, token))) return token
  throw new Error(`lease guard busy: ${file}`)
}

function releaseGuard(file: string, token: InstanceToken): void {
  const current = read(file)
  if (current && leaseToken(current)?.nonce === token.nonce) {
    fs.unlinkSync(file)
    syncDirectory(path.dirname(file))
  }
}

export function withGuard<T>(file: string, fn: () => T extends PromiseLike<unknown> ? never : T, probe: ProcessProbe = probeProcess): T {
  const guard = `${file}.guard`
  const token = acquireGuard(guard, probe)
  try {
    const result = fn()
    if (result && typeof (result as { then?: unknown }).then === 'function') throw new TypeError('lease guard callback must be synchronous')
    return result
  }
  finally { releaseGuard(guard, token) }
}

// Preview publishers can await disk durability without holding the MCP event loop.
// Synchronous authority/registry callers retain synchronous durability. Both paths
// link only fully synced JSON: an unreadable guard cannot be reclaimed.
async function syncDirectoryAsync(dir: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined
  try { handle = await fs.promises.open(dir, 'r'); await handle.sync() }
  catch (e) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e }
  finally { await handle?.close() }
}

async function ensureDurableDirectoryAsync(dir: string, holdsFile = true): Promise<void> {
  const parent = path.dirname(dir)
  if (parent === dir) {
    if (!(await fs.promises.stat(dir)).isDirectory()) throw Object.assign(new Error(`Not a directory: ${dir}`), { code: 'ENOTDIR' })
    return
  }
  await ensureDurableDirectoryAsync(parent, false)
  let present = true
  try { await fs.promises.access(dir) }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; present = false }
  // Creating a directory is rare and stays with the one synchronous creation policy above;
  // only the flush of an existing directory's parent, which every call pays, is asynchronous.
  if (!present) ensureDurableDirectory(dir, holdsFile)
  else await syncDirectoryAsync(parent)
}

async function createGuardAsync(file: string, token: InstanceToken): Promise<boolean> {
  const dir = path.dirname(file)
  await ensureDurableDirectoryAsync(dir)
  // Match orphan-temp cleanup without a synchronous directory fsync on recovery.
  for (const name of await fs.promises.readdir(dir)) {
    const match = tempPattern.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (!validPid(pid)) continue
    const observed = probeProcess(pid)
    if (observed && (match[2] === 'u' || !observed.startTime || startMarker(observed.startTime) === match[2])) continue
    if (pidAlive(pid)) continue
    try { await fs.promises.unlink(path.join(dir, name)); await syncDirectoryAsync(dir) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  const start = probeOwnProcess()?.startTime
  const temp = `${file}.roomtmp-p${process.pid}-s${start ? startMarker(start) : 'u'}-n${randomUUID()}.tmp`
  try {
    const handle = await fs.promises.open(temp, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(token) + '\n'); await handle.sync() }
    finally { await handle.close() }
    try { await fs.promises.link(temp, file) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e }
    await syncDirectoryAsync(dir)
    return true
  } finally { await fs.promises.rm(temp, { force: true }); await syncDirectoryAsync(dir) }
}

async function readGuardAsync(file: string): Promise<InstanceToken | undefined> {
  try { return leaseToken(JSON.parse(await fs.promises.readFile(file, 'utf8'))) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}

async function releaseGuardAsync(file: string, token: InstanceToken): Promise<void> {
  if ((await readGuardAsync(file))?.nonce === token.nonce) {
    await fs.promises.unlink(file)
    await syncDirectoryAsync(path.dirname(file))
  }
}

async function acquireGuardAsync(file: string, probe: ProcessProbe, depth = 0): Promise<InstanceToken> {
  if (depth > 12) throw new Error(`too many stale lease guards at ${file}`)
  const token = ownToken()
  if (await createGuardSafely(file, token, () => createGuardAsync(file, token))) return token
  const previous = await readGuardAsync(file)
  if (!previous || liveness(previous, probe) !== 'dead') throw new Error(`lease guard busy: ${file}`)
  const outer = await acquireGuardAsync(`${file}.guard`, probe, depth + 1)
  try {
    const latest = await readGuardAsync(file)
    if (latest && liveness(latest, probe) === 'dead') {
      await fs.promises.unlink(file)
      await syncDirectoryAsync(path.dirname(file))
    }
  } finally { await releaseGuardAsync(`${file}.guard`, outer) }
  if (await createGuardSafely(file, token, () => createGuardAsync(file, token))) return token
  throw new Error(`lease guard busy: ${file}`)
}

/** Async durable acquisition/release; the decision itself must remain synchronous. */
export async function withGuardAsync<T>(file: string, fn: () => T extends PromiseLike<unknown> ? never : T, probe: ProcessProbe = probeProcess): Promise<T> {
  const guard = `${file}.guard`
  const token = await acquireGuardAsync(guard, probe)
  try {
    const result = fn()
    if (result && typeof (result as { then?: unknown }).then === 'function') throw new TypeError('lease guard callback must be synchronous')
    return result
  } finally { await releaseGuardAsync(guard, token) }
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
