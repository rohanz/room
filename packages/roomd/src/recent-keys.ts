/** Keys seen within the last `ttlMs`, at most `max` of them: a bounded, expiring replacement for a lifetime set. */
export class RecentKeys {
  // Insertion order is time order: a key is only (re)inserted after it expired or was evicted.
  private readonly at = new Map<string, number>()
  constructor(private readonly ttlMs: number, private readonly max: number, private readonly now: () => number = Date.now) {}

  get size(): number { return this.at.size }

  /** True when `key` was marked within the window; otherwise marks it now and returns false. */
  hit(key: string): boolean {
    const now = this.now()
    for (const [old, at] of this.at) {
      if (now - at < this.ttlMs) break
      this.at.delete(old)
    }
    if (this.at.has(key)) return true
    this.at.set(key, now)
    if (this.at.size > this.max) this.at.delete(this.at.keys().next().value!)
    return false
  }

  clear(): void { this.at.clear() }
}
