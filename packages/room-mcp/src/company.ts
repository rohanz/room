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
  return [...s.awareness.getStates().values()].some(value => {
    const p = value as Partial<Presence>
    return p.user?.name === name && p.watchedDirectory === mine
  })
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
  const entries = company.others.map(name => {
    const scope = scopes.find(sc => name === sc.by || name === displayName({ name: sc.by, kind: sc.byKind }))
    return scope ? `${scope.by} is here, on ${scope.area}: ${scope.paths.join(', ')}` : `${name} is here`
  })
  return '[room] ' + entries.join('; ') + '.'
}
