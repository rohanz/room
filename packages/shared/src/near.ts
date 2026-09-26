import type { RoomDoc } from './doc.js'
import { isAgentic } from './identity.js'

/** File-level coordination evidence, excluding the current participant. */
export interface NearPath { by: string; path: string; reason: 'scope' | 'claim' | 'changed' }

/** Owns the room's scope, claim, and changed-path evidence for proximity decisions. */
export function coordinationPaths(room: RoomDoc, excludingParticipant: string, options: { includeOwnNonAgentClaims?: boolean } = {}): NearPath[] {
  return [
    ...room.allScopes().filter(scope => scope.by !== excludingParticipant)
      .flatMap(scope => scope.paths.map(path => ({ by: scope.by, path, reason: 'scope' as const }))),
    ...room.openClaims().filter(claim => claim.by !== excludingParticipant || (options.includeOwnNonAgentClaims && !isAgentic(claim.byKind)))
      .map(claim => ({ by: claim.by, path: claim.path, reason: 'claim' as const })),
    ...[...new Set([...room.overlays.keys(), ...room.deleted.keys()])]
      .filter(by => by !== excludingParticipant)
      .flatMap(by => room.changedPaths(by).map(path => ({ by, path, reason: 'changed' as const }))),
  ]
}

/** Canonical coordination path (a path can name a file or a directory). */
export function normalizeCoordinationPath(p: string): string {
  const parts: string[] = []
  for (const part of p.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/') || '.'
}

/** Directional containment: `parent` covers itself and its descendants. */
export function containsPath(parent: string, child: string): boolean {
  const valid = (p: string) => p.trim().length > 0 && !/^(?:[\\/]|[a-z]:)/i.test(p) &&
    (normalizeCoordinationPath(p) !== '.' || p === '.' || p === './')
  if (!valid(parent) || !valid(child)) return false
  const a = normalizeCoordinationPath(parent), b = normalizeCoordinationPath(child)
  return a === '.' || a === b || b.startsWith(a + '/')
}

/** Paths overlap only at a directory boundary, in either direction. */
export function coversPath(a: string, b: string): boolean {
  return containsPath(a, b) || containsPath(b, a)
}

/** The same proximity rule drives claim decisions and before-edit guidance. */
export function nearPath(path: string, others: readonly NearPath[]): NearPath[] {
  return others.filter(other => coversPath(path, other.path))
}
