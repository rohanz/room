/** Watcher batching and hot-path rate limiting; all times are milliseconds. */
export class DiskBatch {
  private pending = new Map<string, boolean>()
  private active = new Map<string, number>()
  private arrivals = new Map<string, number>()
  private publications = new Map<string, number[]>()
  private hot = new Set<string>()
  private timer?: ReturnType<typeof setTimeout>
  private settleAt = 0
  private stopped = false
  private running = false

  constructor(private run: (paths: Map<string, boolean>) => void | Promise<void>, private debounceMs = 300, private now = Date.now, private hotThrottleMs = 30_000, private onError: (error: unknown) => void = () => {}) {}

  get size(): number { return this.pending.size }
  knownPaths(): string[] { return [...new Set([...this.pending.keys(), ...this.active.keys()])] }

  published(path: string): void {
    if (this.stopped) return
    const now = this.now()
    this.expireHistories(now)
    const times = this.recent(path, now)
    times.push(now)
    // Six timestamps suffice to decide whether the two-minute window is hot.
    if (times.length > 6) times.shift()
    this.publications.delete(path)
    this.publications.set(path, times)
    if (times.length > 5) this.hot.add(path)
  }

  add(path: string, isNew: boolean): void {
    if (this.stopped) return
    const now = this.now()
    this.expireHistories(now)
    this.queue(path, isNew, now)
  }

  private queue(path: string, isNew: boolean, now: number): void {
    this.pending.set(path, isNew || this.pending.get(path) === true)
    this.arrivals.set(path, now)
    for (const [p, at] of this.arrivals) if (now - at >= 1000) this.arrivals.delete(p)
    this.settleAt = Math.max(this.settleAt, now + (this.arrivals.size > 20 ? 2000 : this.debounceMs))
    this.arm()
  }

  /** Recheck when queued work executes: another publish may have made the path hot. */
  deferHot(path: string): boolean {
    if (this.stopped) return false
    const now = this.now()
    this.expireHistories(now)
    if (this.due(path, now) <= now) return false
    this.queue(path, true, now)
    return true
  }

  /** Map order is last-publication order; stop at the first still-live history. */
  private expireHistories(now: number): void {
    const entries = this.publications.entries()
    for (let n = 0; n < 256; n++) {
      const oldest = entries.next().value
      if (!oldest || now - oldest[1].at(-1)! < 120_000) break
      this.publications.delete(oldest[0])
      this.hot.delete(oldest[0])
    }
  }

  private recent(path: string, now: number): number[] {
    const prior = this.publications.get(path)
    if (!prior) return []
    const times = prior.filter(at => now - at < 120_000)
    if (!times.length) this.publications.delete(path)
    else if (times.length !== prior.length) this.publications.set(path, times)
    if (times.length <= 5) this.hot.delete(path)
    return times
  }

  private due(path: string, now = this.now()): number {
    this.recent(path, now)
    return this.hot.has(path) ? (this.publications.get(path)?.at(-1) ?? 0) + this.hotThrottleMs : 0
  }

  private arm(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.pending.size || this.stopped || this.running) return
    const next = Math.max(this.settleAt, Math.min(...Array.from(this.pending.keys(), p => this.due(p))))
    this.timer = setTimeout(() => {
      this.timer = undefined
      const ready = new Map<string, boolean>()
      for (const [p, fresh] of this.pending) if (this.due(p) <= this.now()) { ready.set(p, fresh); this.pending.delete(p) }
      if (ready.size) {
        this.running = true
        for (const p of ready.keys()) this.active.set(p, 1)
        void Promise.resolve().then(() => this.stopped ? undefined : this.run(ready)).catch(error => {
          try { this.onError(error) } catch { /* error reporting must not strand a batch */ }
        }).finally(() => {
          this.active.clear()
          this.running = false
          this.expireHistories(this.now())
          this.arm()
        })
      }
      else this.arm()
    }, Math.max(0, next - this.now()))
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
    this.arrivals.clear()
    this.publications.clear()
    this.hot.clear()
  }
}
