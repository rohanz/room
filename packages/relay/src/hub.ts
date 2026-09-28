/**
 * The local relay's side of the hub (docs/superpowers/specs/2026-09-28-hub.md §5): one authority per clone,
 * held as `<common>/room/hub/authority.lock`, with the durable incarnation record next to it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { serializedStore, type HolderIn, type IncarnationStore } from '@room/hub-core'
import { compareAndRelease, createExclusive, liveness, recover, writeAtomic, type InstanceToken } from './leases.js'
import { pidAlive, probeProcess } from './process.js'

export const hubDir = (commonDir: string): string => path.join(commonDir, 'room', 'hub')

function readJson(file: string): Record<string, unknown> | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}

/** The clone's authority lock: a process takes it before it starts a relay, and never starts one without it. */
export class AuthorityLock {
  private constructor(readonly file: string, private readonly token: InstanceToken) {}

  /** Take the lock, recovering it from a dead holder; undefined while a live (or unknown) process holds it. */
  static take(commonDir: string): AuthorityLock | undefined {
    const file = path.join(hubDir(commonDir), 'authority.lock')
    const own = probeProcess(process.pid)
    const token: InstanceToken = { pid: process.pid, startTime: own?.startTime ?? '', executable: own?.executable ?? '', sessionId: `relay:${process.pid}`, nonce: randomUUID() }
    if (createExclusive(file, token)) return new AuthorityLock(file, token)
    try { if (recover(file, () => true) && createExclusive(file, token)) return new AuthorityLock(file, token) }
    catch { /* its guard is busy: another process is recovering it */ }
    return undefined
  }

  /** The lock file still carries this lock's token (nonce included). */
  held(): boolean {
    try { return readJson(this.file)?.nonce === this.token.nonce } catch { return false }
  }

  release(): void {
    try { compareAndRelease(this.file, this.token) } catch { /* a successor recovers it from a dead holder */ }
  }
}

/** `<common>/room/hub/incarnation.json`, `{max}`, written durably (temp, fsync, rename, fsync-dir). */
export function incarnationFile(commonDir: string): IncarnationStore {
  const file = path.join(hubDir(commonDir), 'incarnation.json')
  return serializedStore({
    read: async () => { const max = readJson(file)?.max; return typeof max === 'number' ? max : undefined },
    write: async max => { writeAtomic(file, { max }) },
  })
}

const PROBE_CACHE_MS = 5_000

/**
 * `liveness(holder) === 'dead'`, as the relay judges a local holder. A vanished pid is dead at once; the
 * birth-marker probe (a `ps` on macOS) is cached briefly, since the hub asks on every lease check.
 */
export function holderDeadCheck(now: () => number = Date.now): (h: HolderIn) => boolean {
  const cache = new Map<string, { at: number; dead: boolean }>()
  return h => {
    if (!pidAlive(h.pid)) return true
    const key = `${h.pid}\u0000${h.startTime}\u0000${h.executable}`
    const hit = cache.get(key)
    if (hit && now() - hit.at < PROBE_CACHE_MS) return hit.dead
    const dead = liveness(h) === 'dead'
    cache.set(key, { at: now(), dead })
    if (cache.size > 256) for (const [k, v] of cache) if (now() - v.at >= PROBE_CACHE_MS) cache.delete(k)
    return dead
  }
}
