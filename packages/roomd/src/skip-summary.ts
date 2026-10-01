/** Skip-set reason for a gitignored folder the watcher prunes; the key ends with `/`. */
export const IGNORED_FOLDER = 'ignored folder'

/** One summary for each skip-set change, then no more than one hourly reminder. */
export class SkipSummaryGate {
  private previous = new Map<string, string>()
  private lastLogged = -Infinity
  constructor(private readonly now: () => number = Date.now) {}

  shouldLog(next: ReadonlyMap<string, string>): boolean {
    const changed = next.size !== this.previous.size || [...next].some(([path, reason]) => this.previous.get(path) !== reason)
    this.previous = new Map(next)
    if (!next.size) return false
    if (!changed && this.now() - this.lastLogged < 60 * 60_000) return false
    this.lastLogged = this.now()
    return true
  }
}

const fileLabel = (reason: string) => reason === 'size' ? 'over size cap' : reason === 'budget' ? 'over total budget' : reason === 'untracked lockfile' ? reason : 'ignore'

/** "2 file(s) (1 over size cap, 1 ignore), e.g. a.txt, and 1 gitignored folder, not watched: libs/JUCE/"; '' for an empty set. */
export function formatSkips(skips: ReadonlyMap<string, string>): string {
  const counts = new Map<string, number>()
  const folders: string[] = []
  let example: string | undefined
  for (const [entry, reason] of skips) {
    if (reason === IGNORED_FOLDER) { folders.push(entry); continue }
    example ??= entry
    const label = fileLabel(reason)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const files = skips.size - folders.length
  const parts: string[] = []
  if (files) parts.push(`${files} file(s) (${[...counts].map(([label, count]) => `${count} ${label}`).join(', ')}), e.g. ${example}`)
  if (folders.length) {
    folders.sort()
    const shown = folders.slice(0, 3).join(', ') + (folders.length > 3 ? `, +${folders.length - 3} more` : '')
    parts.push(`${folders.length} gitignored folder${folders.length === 1 ? '' : 's'}, not watched: ${shown}`)
  }
  return parts.join(', and ')
}
