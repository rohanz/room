/** Bound sustained Git trouble to one probe per minute, while retaining the normal fast cadence. */
export const MAX_POLL_BACKOFF_MS = 60_000
export const POLL_DIAGNOSTIC_MS = 5 * 60_000

/** A periodic, level-triggered poll: skipped ticks produce one pending run. */
export class CoalescedPoll {
  private timer?: NodeJS.Timeout
  private summaryTimer?: NodeJS.Timeout
  private running = false
  private dirty = false
  private stopped = false
  private failures = 0
  private windowFailures = 0
  private lastFailure = ''

  constructor(
    private readonly kind: string,
    private readonly baseMs: number,
    private readonly run: () => Promise<void>,
    private readonly log: (line: string) => void,
  ) {
    if (baseMs > 0) this.schedule(baseMs)
  }

  private schedule(delay: number): void {
    if (this.timer) clearInterval(this.timer)
    if (this.stopped || delay <= 0) return
    this.timer = setInterval(() => this.request(true), delay)
    this.timer.unref?.()
  }

  trigger(): void { this.request(false) }

  private request(timerTick: boolean): void {
    if (this.stopped) return
    if (this.running) { this.dirty = true; return }
    if (this.failures && this.baseMs > 0 && !timerTick) { this.dirty = true; return }
    if (timerTick) this.dirty = false
    void this.execute()
  }

  private async execute(): Promise<void> {
    this.running = true
    let succeeded = false
    try {
      await this.run()
      succeeded = true
      if (this.stopped) return
      if (this.failures) {
        this.log(`${this.kind} recovered after ${this.failures} failed poll(s)`)
        this.failures = 0
        this.windowFailures = 0
        this.lastFailure = ''
        if (this.summaryTimer) clearInterval(this.summaryTimer)
        this.summaryTimer = undefined
        this.schedule(this.baseMs)
      }
    } catch (error) {
      if (this.stopped) return
      const message = error instanceof Error ? error.message : String(error)
      const description = message.replace(/ failed: timed out after \d+ms.*/, ' timed out')
      this.lastFailure = description
      this.failures++
      this.windowFailures++
      if (this.failures === 1) {
        this.log(`warn: ${message} (${this.kind})`)
        this.summaryTimer = setInterval(() => {
          if (this.windowFailures > 1) this.log(`warn: ${this.lastFailure} ${this.windowFailures} times in the last 5 min (${this.kind})`)
          this.windowFailures = 0
        }, POLL_DIAGNOSTIC_MS)
        this.summaryTimer.unref?.()
      }
      this.schedule(Math.min(MAX_POLL_BACKOFF_MS, this.baseMs * 2 ** Math.min(this.failures, 30)))
    } finally {
      this.running = false
      if (this.stopped) return
      // On failure, the next tick is the single retry and respects backoff.
      if (succeeded && this.dirty) {
        this.dirty = false
        this.trigger()
      } else if (!succeeded) this.dirty = false
    }
  }

  stop(): void {
    this.stopped = true
    this.dirty = false
    if (this.timer) clearInterval(this.timer)
    if (this.summaryTimer) clearInterval(this.summaryTimer)
    this.timer = undefined
    this.summaryTimer = undefined
  }
}
