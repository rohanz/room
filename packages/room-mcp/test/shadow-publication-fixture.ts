import { execFileSync } from 'node:child_process'

/** Immutable base objects need one tree listing, rather than a subprocess per path/publication. */
export function baseVersions() {
  const bases = new Map<string, ReadonlyMap<string, string>>()
  return (dir: string, head: string): ReadonlyMap<string, string> => {
    let entries = bases.get(head)
    if (!entries) {
      const rows = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '-z', head], { encoding: 'utf8', stdio: 'pipe' }).split('\0').filter(Boolean)
      entries = new Map(rows.flatMap(row => {
        const match = /^\d+ blob ([a-f0-9]+)\t(.*)$/s.exec(row)
        return match ? [[match[2], match[1]] as const] : []
      }))
      bases.set(head, entries)
    }
    return entries
  }
}
