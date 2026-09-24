/** File-level coordination evidence, excluding the current participant. */
export interface NearPath { by: string; path: string; reason: 'scope' | 'claim' | 'changed' }

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
