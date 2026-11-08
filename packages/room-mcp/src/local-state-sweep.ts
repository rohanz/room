import fs from 'node:fs'
import path from 'node:path'
import { ROOM_STALE_MS } from '@room/shared'
import { liveness, type InstanceToken } from './leases.js'
import type { ProcessProbe } from '@room/relay/process'

/** An atomic write never takes this long; an older `.tmp` belongs to a writer that died mid-write. */
export const SWEEP_TEMP_AGE_MS = 60 * 60 * 1000
/** A dead publisher's lease file is useless at once, but a lease written in the last hour may belong to a starting process. */
const PUBLISHER_DEAD_IDLE_MS = 60 * 60 * 1000

export interface SweepOptions { now?: () => number; probe?: ProcessProbe; maxAgeMs?: number }

/**
 * Remove local Room state nothing will read again: publisher lease files of dead, idle holders; a session's
 * cursor directory untouched for the stale period (its participant expired at the same age); and abandoned
 * atomic-write temporaries. Returns what it removed. Every rule is read-only until the removal itself, and a
 * file that cannot be judged (unparsable, unknown liveness) stays.
 */
export function sweepLocalState(commonDir: string, options: SweepOptions = {}): string[] {
  const now = options.now ?? Date.now
  const maxAgeMs = options.maxAgeMs ?? ROOM_STALE_MS
  const root = path.join(commonDir, 'room')
  const removed: string[] = []
  const remove = (target: string, recursive = false) => {
    try { fs.rmSync(target, { recursive, force: true }); removed.push(target) } catch { /* another process may hold or have removed it */ }
  }
  const list = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] } }
  const mtime = (file: string) => { try { return fs.statSync(file).mtimeMs } catch { return undefined } }

  for (const entry of list(path.join(root, 'publishers'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = path.join(root, 'publishers', entry.name)
    let holder: InstanceToken | undefined, lastActive: number | undefined
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { holder?: InstanceToken; lastActive?: number }
      holder = parsed.holder; lastActive = typeof parsed.lastActive === 'number' ? parsed.lastActive : undefined
    } catch { continue }
    if (!holder || typeof holder.pid !== 'number') continue
    const idleSince = Math.max(lastActive ?? 0, mtime(file) ?? now())
    if (liveness(holder, options.probe) === 'dead' && now() - idleSince >= PUBLISHER_DEAD_IDLE_MS) remove(file)
  }

  for (const entry of list(path.join(root, 'sessions'))) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, 'sessions', entry.name)
    const newest = Math.max(mtime(dir) ?? 0, ...list(dir).map(f => mtime(path.join(dir, f.name)) ?? 0))
    if (newest && now() - newest >= maxAgeMs) remove(dir, true)
  }

  for (const sub of ['relay', 'hub-leases']) {
    for (const entry of list(path.join(root, sub))) {
      if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue
      const file = path.join(root, sub, entry.name)
      const at = mtime(file)
      if (at !== undefined && now() - at >= SWEEP_TEMP_AGE_MS) remove(file)
    }
  }
  return removed
}
