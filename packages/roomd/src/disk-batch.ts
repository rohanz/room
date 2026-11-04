/** Distinct pending paths retained before the batch collapses further arrivals into one full reconcile. */
export const MAX_PENDING_PATHS = 10_000
/** Continuous arrivals cannot postpone a batch longer than this after its first pending path. */
export const MAX_SETTLE_MS = 10_000
/** Distinct paths in the last second that mark a burst (and a longer settle). */
const BURST_PATHS = 20

/** Watcher batching and hot-path rate limiting; all times are milliseconds. */
export class DiskBatch {
  private pending = new Map<string, boolean>()
  /** Arrivals were dropped at MAX_PENDING_PATHS: the next run must reconcile everything. */
  private overflow = false
  private firstPendingAt?: number
  private active = new Map<string, number>()
  private arrivals = new Map<string, number>()
  private publications = new Map<string, number[]>()
  private hot = new Set<string>()
  private timer?: ReturnType<typeof setTimeout>
  private settleAt = 0
  private stopped = false
  private running = false

  /** `overflow`: some changed paths were not retained; the callback must run a full reconcile. */
  constructor(private run: (paths: Map<string, boolean>, overflow: boolean) => void | Promise<void>, private debounceMs = 300, private now = Date.now, private hotThrottleMs = 30_000, private onError: (error: unknown) => void = () => {}) {}

  get size(): number { return this.pending.size + (this.overflow ? 1 : 0) }
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
    if (this.pending.has(path) || this.pending.size < MAX_PENDING_PATHS) this.pending.set(path, isNew || this.pending.get(path) === true)
    else this.overflow = true
    this.firstPendingAt ??= now
    // Arrival order is time order (re-inserted on repeat); only the burst threshold matters, so keep a few more than it.
    this.arrivals.delete(path)
    this.arrivals.set(path, now)
    for (const [p, at] of this.arrivals) {
      if (now - at < 1000 && this.arrivals.size <= BURST_PATHS + 1) break
      this.arrivals.delete(p)
    }
    const wanted = Math.max(this.settleAt, now + (this.arrivals.size > BURST_PATHS ? 2000 : this.debounceMs))
    this.settleAt = Math.min(wanted, this.firstPendingAt + MAX_SETTLE_MS)
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
    if (!this.size || this.stopped || this.running) return
    // A loop, not a spread: a wide checkout's pending set exceeds the engine's argument limit.
    let earliest = this.overflow ? 0 : Infinity
    for (const p of this.pending.keys()) {
      if (earliest <= 0) break
      earliest = Math.min(earliest, this.due(p))
    }
    const next = Math.max(this.settleAt, earliest)
    this.timer = setTimeout(() => {
      this.timer = undefined
      // Paths still pending after this point wait on their hot-path throttle, not on the settle window.
      this.firstPendingAt = undefined
      const ready = new Map<string, boolean>()
      const now = this.now()
      for (const [p, fresh] of this.pending) if (this.due(p, now) <= now) { ready.set(p, fresh); this.pending.delete(p) }
      const overflow = this.overflow
      if (ready.size || overflow) {
        this.overflow = false
        this.running = true
        for (const p of ready.keys()) this.active.set(p, 1)
        void Promise.resolve().then(() => this.stopped ? undefined : this.run(ready, overflow)).catch(error => {
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
    this.overflow = false
    this.firstPendingAt = undefined
    this.arrivals.clear()
    this.publications.clear()
    this.hot.clear()
  }
}
