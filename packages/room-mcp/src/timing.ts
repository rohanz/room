import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import { setGitObserver } from '@room/roomd/git'

const SLOW_TOOL_MS = 2_000
const EVENT_LOOP_SAMPLE_MS = 500
const EVENT_LOOP_LAG_MS = 2_000

type Clock = () => number
type Logger = (line: string) => void
const context = new AsyncLocalStorage<ToolTiming>()
const ms = (value: number) => `${Math.round(value)}ms`

/** One recorder per request; AsyncLocalStorage keeps nested worker Git calls on that request. */
export class ToolTiming {
  readonly started: number
  private readonly phases = new Map<string, number>()
  private gitCalls = 0
  private gitMs = 0
  private worktreeAddMs = 0
  private readonly activePhases = new Set<string>()
  private queueStarted?: number

  constructor(readonly name: string, private readonly now: Clock = () => performance.now()) { this.started = now() }

  add(name: string, elapsed: number): void { this.phases.set(name, (this.phases.get(name) ?? 0) + elapsed) }

  begin(name: string): () => void {
    const start = this.now()
    this.activePhases.add(name)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.activePhases.delete(name)
      this.add(name, this.now() - start)
    }
  }

  isPhaseActive(name: string): boolean { return this.activePhases.has(name) }

  /** Time from dispatch into tools.call until the spawn handler obtains control. */
  startQueue(): void { this.queueStarted = this.now() }
  endQueue(): void {
    if (this.queueStarted === undefined) return
    this.add('queue', this.now() - this.queueStarted)
    this.queueStarted = undefined
  }

  async phase<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    const end = this.begin(name)
    try { return await work() }
    finally { end() }
  }

  recordGit(args: readonly string[], elapsed: number): void {
    this.gitCalls++
    this.gitMs += elapsed
    if (args.includes('worktree') && args.includes('add')) this.worktreeAddMs += elapsed
  }

  slowLine(total = this.now() - this.started, threshold = SLOW_TOOL_MS): string | undefined {
    if (this.name === 'room_wait' || this.name === 'room_login') {
      const waitingPhases = ['settle', 'queue'].filter(name => this.phases.has(name))
      if (waitingPhases.every(name => (this.phases.get(name) ?? 0) < threshold)) return undefined
      return `slow tool ${this.name} ${ms(total)}: ${waitingPhases.map(name => `${name} ${ms(this.phases.get(name)!)}`).join(', ')}`
    }
    if (total < threshold && [...this.phases.values()].every(value => value < threshold)) return undefined
    const pieces: string[] = []
    const spawnPhases = this.phases.has('prepare') || this.phases.has('launch') || this.phases.has('lease')
    const joinPhases = (this.name === 'room_join' || this.name === 'room_create') && ['resolve', 'preflight', 'connect', 'sync', 'daemon start'].some(name => this.phases.has(name))
    const names = spawnPhases ? ['settle', 'queue', 'lease', 'prepare', 'launch'] : joinPhases ? ['settle', 'resolve', 'preflight', 'connect', 'sync', 'daemon start'] : ['settle', 'body']
    for (const name of names) {
      const elapsed = name === 'body' ? Math.max(0, (this.phases.get('body') ?? 0) - (this.phases.get('settle') ?? 0)) : this.phases.get(name)
      if (elapsed === undefined) continue
      let piece = `${name} ${ms(elapsed)}`
      if (name === 'prepare' && this.gitCalls) {
        piece += ` (git ${this.gitCalls} calls ${ms(this.gitMs)}`
        if (this.worktreeAddMs) piece += `, worktree add ${ms(this.worktreeAddMs)}`
        piece += ')'
      }
      pieces.push(piece)
    }
    if (spawnPhases || joinPhases) {
      const accounted = names.reduce((sum, name) => sum + (this.phases.get(name) ?? 0), 0)
      const other = Math.max(0, total - accounted)
      if (Math.round(other) > 0) pieces.push(`other ${ms(other)}`)
    }
    if (!pieces.length) pieces.push(`body ${ms(total)}`)
    return `slow tool ${this.name} ${ms(total)}: ${pieces.join(', ')}`
  }
}

export function currentToolTiming(): ToolTiming | undefined { return context.getStore() }

/** Install once in the MCP process; roomd observes Git regardless of which module launched it. */
export function registerPrepareGitTiming(): void {
  setGitObserver((args, elapsed) => {
    const timing = currentToolTiming()
    if (timing?.isPhaseActive('prepare')) timing.recordGit(args, elapsed)
  })
}

export class ToolTimingTracker {
  private readonly active = new Set<ToolTiming>()
  private readonly now: Clock
  private readonly log: Logger
  constructor({ now = () => performance.now(), log }: { now?: Clock; log: Logger }) {
    this.now = now; this.log = log
  }
  async run<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    const timing = new ToolTiming(name, this.now)
    this.active.add(timing)
    try { return await context.run(timing, () => timing.phase('body', work)) }
    finally {
      this.active.delete(timing)
      const line = timing.slowLine(this.now() - timing.started)
      if (line) this.log(line)
    }
  }
  runningAt(now = this.now()): string[] { return [...this.active].map(timing => `${timing.name} ${ms(now - timing.started)}`) }
}

export function startEventLoopWatchdog(tracker: ToolTimingTracker, {
  now = () => performance.now(), log, every = setInterval, clear = clearInterval,
}: { now?: Clock; log: Logger; every?: typeof setInterval; clear?: typeof clearInterval }): { stop(): void } {
  let expected = now() + EVENT_LOOP_SAMPLE_MS
  const timer = every(() => {
    const at = now()
    const lag = at - expected
    expected = at + EVENT_LOOP_SAMPLE_MS
    if (lag >= EVENT_LOOP_LAG_MS) log(`event loop lag ${ms(lag)}: in flight ${tracker.runningAt(at).join(', ') || 'none'}`)
  }, EVENT_LOOP_SAMPLE_MS)
  timer.unref()
  return { stop: () => clear(timer) }
}
