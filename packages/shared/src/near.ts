/** File-level coordination evidence, excluding the current participant. */
export interface NearPath { by: string; path: string; reason: 'scope' | 'claim' | 'changed' }

/** Paths overlap only at a directory boundary, in either direction. */
export function coversPath(a: string, b: string): boolean {
  const normalize = (p: string): string => {
    const parts: string[] = []
    for (const part of p.replaceAll('\\', '/').split('/')) {
      if (!part || part === '.') continue
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop()
      else parts.push(part)
    }
    return parts.join('/') || '.'
  }
  const left = normalize(a), right = normalize(b)
  return left === '.' || right === '.' || left === right || left.startsWith(right + '/') || right.startsWith(left + '/')
}

/** The same proximity rule drives claim decisions and before-edit guidance. */
export function nearPath(path: string, others: readonly NearPath[]): NearPath[] {
  return others.filter(other => coversPath(path, other.path))
}
