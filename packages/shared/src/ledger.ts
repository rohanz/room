import type { Msg, Plan, ReleaseMsg, Scope } from './types.js'

export type LedgerEntry = Msg
const LEDGER_TYPES = new Set<Msg['type']>(['scope', 'claim', 'changed', 'release', 'conflict', 'base', 'plan'])

/** Compact history retained after old bus entries are removed. */
export interface LedgerArchive {
  messages: number
  counts: Partial<Record<Msg['type'], number>>
  lastSeen: Record<string, number>
  lastAt: number
  unfulfilled: { message: ReleaseMsg; plans: Plan[] }[]
}

export function emptyLedgerArchive(): LedgerArchive {
  return { messages: 0, counts: {}, lastSeen: {}, lastAt: 0, unfulfilled: [] }
}

/** Paths a bus message touches. */
export function msgPaths(m: Msg): string[] {
  if ('paths' in m) return m.paths
  if ('path' in m) return [m.path]
  return []
}

/** A scope covers a path when the path equals a scope path or lives under a scope directory. */
export function scopeCovers(scope: Pick<Scope, 'paths'>, path: string): boolean {
  return scope.paths.some(p => path === p || path.startsWith(p.replace(/\/?$/, '/')))
}

export interface LedgerQuery { area?: string; path?: string; since?: number; limit?: number }

/** Areas touched by a message, using the current scope index. */
export function messageAreas(m: Msg, scopes: readonly Scope[]): string[] {
  const out = new Set<string>()
  if (m.type === 'scope') out.add(m.area)
  for (const path of msgPaths(m)) for (const scope of scopes) if (scopeCovers(scope, path)) out.add(scope.area)
  return Array.from(out).sort()
}

/** Fold messages into an existing archive without retaining routine message bodies. */
export function foldLedger(previous: LedgerArchive | undefined, messages: readonly Msg[]): LedgerArchive {
  const out: LedgerArchive = previous
    ? { messages: previous.messages, counts: { ...previous.counts }, lastSeen: { ...previous.lastSeen }, lastAt: previous.lastAt, unfulfilled: [...previous.unfulfilled] }
    : emptyLedgerArchive()
  for (const m of messages) {
    out.messages++
    out.counts[m.type] = (out.counts[m.type] ?? 0) + 1
    out.lastSeen[m.from] = Math.max(out.lastSeen[m.from] ?? 0, m.at)
    out.lastAt = Math.max(out.lastAt, m.at)
    if (m.type === 'release' && m.unfulfilled?.length && !out.unfulfilled.some(x => x.message.id === m.id)) {
      out.unfulfilled.push({ message: m, plans: m.unfulfilled })
    }
  }
  return out
}

/**
 * Derived view over the bus: entries that record work (scope, claim, changed, release,
 * conflict), filtered by area (via the scopes that name it) and/or path.
 */
export function ledger(messages: readonly Msg[], scopes: readonly Scope[], q: LedgerQuery = {}): LedgerEntry[] {
  const areaScopes = q.area ? scopes.filter(s => s.area === q.area) : []
  const out: LedgerEntry[] = []
  for (const m of messages) {
    if (!LEDGER_TYPES.has(m.type)) continue
    if (q.since && m.at < q.since) continue
    const paths = msgPaths(m)
    if (q.path && !paths.includes(q.path)) continue
    if (q.area) {
      const inArea = (m.type === 'scope' && m.area === q.area)
        || paths.some(p => areaScopes.some(s => scopeCovers(s, p)))
      if (!inArea) continue
    }
    out.push(m)
  }
  return q.limit ? out.slice(-q.limit) : out
}

/** One line per area: activity in the window and who did it. */
export function areaSummary(messages: readonly Msg[], scopes: readonly Scope[], windowMs = 10 * 60 * 1000, now = Date.now()): string[] {
  const areas = Array.from(new Set(scopes.map(s => s.area))).sort()
  return areas.map(area => {
    const recent = ledger(messages, scopes, { area, since: now - windowMs }).filter(m => m.type === 'changed')
    const who = Array.from(new Set(recent.map(m => m.from)))
    const owners = scopes.filter(s => s.area === area).map(s => s.by)
    return `${area} (${owners.join(', ')}): ${recent.length} change${recent.length === 1 ? '' : 's'} in the last ${Math.round(windowMs / 60000)} min${who.length ? ` by ${who.join(', ')}` : ''}`
  })
}
