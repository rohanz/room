import { displayName, type Worker } from '@room/shared'
import type { Presence } from '@room/shared'
import type { Session } from './session.js'

const PRESENCE_FRESH_MS = 20_000

export interface CompanyState {
  company: boolean
  /** Display names for the people or workers that make this a shared room. */
  others: string[]
}

/** Company means another participant present now (fresh awareness, excluding browser viewers),
 * or this session's running workers. Offline claims and edits do not count: offline work
 * is covered passively by the conflict watcher and merge previews. */
export function hasCompany(s: Session, runningWorkers: readonly Worker[] = [], now = Date.now()): CompanyState {
  const names = new Map<string, string>()
  for (const [clientId, value] of s.awareness.getStates()) {
    const p = value as Partial<Presence>
    if (!p.user || clientId === s.awareness.clientID || p.user.name === s.me.name) continue
    const activeAt = typeof p.lastActive === 'number' ? p.lastActive : s.awareness.meta.get(clientId)?.lastUpdated ?? 0
    if (now - activeAt > PRESENCE_FRESH_MS) continue
    if (p.user.kind === 'human' && p.status === 'viewing') continue
    names.set(p.user.name, displayName(p.user))
  }
  for (const worker of runningWorkers) names.set(worker.name, names.get(worker.name) ?? worker.name)
  const others = Array.from(names.values()).sort((a, b) => a.localeCompare(b))
  return { company: others.length > 0, others }
}
