import { displayName, type Worker } from '@room/shared'
import type { Presence } from '@room/shared'
import type { Session } from './session.js'

import { isFresh } from './presence.js'

export interface CompanyState {
  company: boolean
  /** Participant names for the people or workers that make this a shared room. */
  others: string[]
}

/** Another Room process can watch this exact physical checkout under a different name. */
export function sameCheckoutSession(s: Session, name: string): boolean {
  const mine = s.awareness.getLocalState()?.watchedDirectory
  if (!mine || name === s.me.name) return false
  const peers = [...s.awareness.getStates()].filter(([id, value]) => id !== s.awareness.clientID && (value as Partial<Presence>).user?.name === name && isFresh(s.awareness, id, Date.now()))
  return peers.length > 0 && peers.every(([, value]) => (value as Partial<Presence>).watchedDirectory === mine)
}

/** Company means another participant present now (fresh awareness, excluding browser viewers),
 * or this session's running workers. Offline claims and edits do not count: offline work
 * is covered passively by the conflict watcher and merge previews. */
export function hasCompany(s: Session, runningWorkers: readonly Worker[] = [], now = Date.now()): CompanyState {
  const names = new Map<string, string>()
  for (const [clientId, value] of s.awareness.getStates()) {
    const p = value as Partial<Presence>
    if (!p.user || clientId === s.awareness.clientID || p.user.name === s.me.name || sameCheckoutSession(s, p.user.name)) continue
    if (!isFresh(s.awareness, clientId, now)) continue
    if (p.user.kind === 'human' && p.status === 'viewing') continue
    names.set(p.user.name, p.user.name)
  }
  for (const worker of runningWorkers) names.set(worker.name, names.get(worker.name) ?? worker.name)
  const others = Array.from(names.values()).sort((a, b) => a.localeCompare(b))
  return { company: others.length > 0, others }
}

/** One announcement carries the work that makes company relevant. */
export function describeCompany(s: Session, company: CompanyState): string {
  const scopes = s.room.allScopes()
  const current = [...s.awareness.getStates().values()] as Partial<Presence>[]
  const entries = company.others.map(name => {
    const scope = scopes.find(sc => name === sc.by)
    const presence = current.find(p => p.user?.name === name && p.user.kind === 'agent') ?? current.find(p => p.user?.name === name)
    const who = displayName({ name, kind: presence?.user?.kind ?? scope?.byKind ?? 'agent' })
    return scope ? `${who} is here, on ${scope.area}: ${scope.paths.join(', ')}` : `${who} is here`
  })
  return '[room] ' + entries.join('; ') + '.'
}
