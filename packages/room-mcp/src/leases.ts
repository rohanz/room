/** Durable, process-owned files in the git common directory. All mutations after creation
 * are serialized by a sibling guard, so a stale owner cannot remove its successor. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { probeProcess, type ProcessProbe } from './worker-process.js'

export interface ProcessIdentity { pid: number; startTime: string; executable: string }
export interface InstanceToken extends ProcessIdentity { sessionId: string; nonce: string }
export type Liveness = 'alive' | 'dead' | 'unknown'

export function liveness(identity: ProcessIdentity, probe: ProcessProbe = probeProcess): Liveness {
  const observed = probe(identity.pid)
  if (!observed) return 'dead'
  if (observed.startTime && identity.startTime && observed.startTime !== identity.startTime) return 'dead'
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

function writeTemp(file: string, content: object): string {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  const fd = fs.openSync(temp, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(content) + '\n'); fs.fsyncSync(fd) }
  catch (e) { fs.closeSync(fd); fs.rmSync(temp, { force: true }); throw e }
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
  } finally { fs.rmSync(temp, { force: true }) }
}

/** Durable replacement for single-writer records or files held under a guard. */
export function writeAtomic(file: string, content: object): void {
  const temp = writeTemp(file, content)
  try { fs.renameSync(temp, file); syncDirectory(path.dirname(file)) }
  finally { fs.rmSync(temp, { force: true }) }
}

function read(file: string): Record<string, unknown> | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}

function holder(value: Record<string, unknown>): ProcessIdentity | undefined {
  const candidate = (value.holder ?? value) as Partial<ProcessIdentity> | null
  return candidate && typeof candidate.pid === 'number' && typeof candidate.startTime === 'string' && typeof candidate.executable === 'string'
    ? candidate as ProcessIdentity : undefined
}

function ownToken(): InstanceToken {
  const current = probeProcess(process.pid)
  return { pid: process.pid, startTime: current?.startTime ?? '', executable: current?.executable ?? '', sessionId: `mcp:${process.pid}:${current?.startTime ?? 'unknown'}`, nonce: randomUUID() }
}

/** Guard acquisition recovers a dead guard through its own guard; a live or unreadable holder blocks. */
function acquireGuard(file: string, probe: ProcessProbe, depth = 0): InstanceToken {
  if (depth > 12) throw new Error(`too many stale lease guards at ${file}`)
  const token = ownToken()
  if (createExclusive(file, { holder: token })) return token
  const previous = read(file)
  const previousHolder = previous && holder(previous)
  if (!previousHolder || liveness(previousHolder, probe) !== 'dead') throw new Error(`lease guard busy: ${file}`)
  const outer = acquireGuard(`${file}.guard`, probe, depth + 1)
  try {
    const latest = read(file)
    const latestHolder = latest && holder(latest)
    if (latestHolder && liveness(latestHolder, probe) === 'dead') {
      fs.unlinkSync(file)
      syncDirectory(path.dirname(file))
    }
  } finally { releaseGuard(`${file}.guard`, outer) }
  if (createExclusive(file, { holder: token })) return token
  throw new Error(`lease guard busy: ${file}`)
}

function releaseGuard(file: string, token: InstanceToken): void {
  const current = read(file)
  if ((current?.holder as Partial<InstanceToken> | undefined)?.nonce === token.nonce) {
    fs.unlinkSync(file)
    syncDirectory(path.dirname(file))
  }
}

export function withGuard<T>(file: string, fn: () => T, probe: ProcessProbe = probeProcess): T {
  const guard = `${file}.guard`
  const token = acquireGuard(guard, probe)
  try { return fn() }
  finally { releaseGuard(guard, token) }
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
    if ((current?.holder as Partial<InstanceToken> | undefined)?.nonce !== token.nonce) return false
    fs.unlinkSync(file)
    syncDirectory(path.dirname(file))
    return true
  })
}

export function recover(file: string, orphan: (content: Record<string, any>) => boolean, probe: ProcessProbe = probeProcess): boolean {
  return withGuard(file, () => {
    const current = read(file)
    const owner = current && holder(current)
    if (!current || !owner || liveness(owner, probe) !== 'dead' || !orphan(current)) return false
    fs.unlinkSync(file)
    syncDirectory(path.dirname(file))
    return true
  })
}
