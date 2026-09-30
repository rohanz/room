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
