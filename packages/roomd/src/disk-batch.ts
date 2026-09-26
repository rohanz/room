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

  constructor(private run: (paths: Map<string, boolean>) => void | Promise<void>, private debounceMs = 300, private now = Date.now, private hotThrottleMs = 30_000, private onError: (error: unknown) => void = () => {}) {}

  get size(): number { return this.pending.size }
  knownPaths(): string[] { return [...new Set([...this.pending.keys(), ...this.active.keys()])] }

  published(path: string): void {
    const now = this.now()
    const times = (this.publications.get(path) ?? []).filter(at => now - at < 120_000)
    times.push(now)
    this.publications.set(path, times)
    if (times.length > 5) this.hot.add(path)
  }

  add(path: string, isNew: boolean): void {
    if (this.stopped) return
    const now = this.now()
    this.pending.set(path, isNew || this.pending.get(path) === true)
    this.arrivals.set(path, now)
    for (const [p, at] of this.arrivals) if (now - at >= 1000) this.arrivals.delete(p)
    this.settleAt = Math.max(this.settleAt, now + (this.arrivals.size > 20 ? 2000 : this.debounceMs))
    this.arm()
  }

  /** Recheck when queued work executes: another publish may have made the path hot. */
  deferHot(path: string): boolean {
    if (!this.hot.has(path) || this.due(path) <= this.now()) return false
    this.add(path, true)
    return true
  }

  private due(path: string): number {
    return this.hot.has(path) ? (this.publications.get(path)?.at(-1) ?? 0) + this.hotThrottleMs : 0
  }

  private arm(): void {
    clearTimeout(this.timer)
    if (!this.pending.size || this.stopped) return
    const next = Math.max(this.settleAt, Math.min(...Array.from(this.pending.keys(), p => this.due(p))))
    this.timer = setTimeout(() => {
      const ready = new Map<string, boolean>()
      for (const [p, fresh] of this.pending) if (this.due(p) <= this.now()) { ready.set(p, fresh); this.pending.delete(p) }
      if (ready.size) {
        for (const p of ready.keys()) this.active.set(p, (this.active.get(p) ?? 0) + 1)
        void Promise.resolve().then(() => this.run(ready)).catch(error => {
          try { this.onError(error) } catch { /* error reporting must not strand a batch */ }
        }).finally(() => {
          for (const p of ready.keys()) {
            const count = this.active.get(p) ?? 0
            if (count <= 1) this.active.delete(p)
            else this.active.set(p, count - 1)
          }
        })
      }
      this.arm()
    }, Math.max(0, next - this.now()))
  }

  stop(): void { this.stopped = true; clearTimeout(this.timer); this.pending.clear() }
}
