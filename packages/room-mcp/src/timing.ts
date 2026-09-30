import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { setGitObserver } from '@room/roomd/git'

const SLOW_TOOL_MS = 2_000
const EVENT_LOOP_SAMPLE_MS = 500
const EVENT_LOOP_LAG_MS = 2_000
const PREVIEW_CHECK_MAX_AGE_MS = 6 * 60_000 // five-minute command timeout plus one minute for setup and teardown
const PREVIEW_CHECK_ENTRY_LIMIT = 500
// Without a uid (Windows) the directory's owner cannot be checked, so the overlap is not sampled there.
const PREVIEW_CHECK_MARKERS = process.getuid ? path.join(os.tmpdir(), `room-preview-checks-${process.getuid()}`) : undefined

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
  private overlappingPreviewChecks?: number
  private previewCheckOverlapUnknown = false

  constructor(readonly name: string, private readonly now: Clock = () => performance.now()) { this.started = now() }

  add(name: string, elapsed: number): void { this.phases.set(name, (this.phases.get(name) ?? 0) + elapsed) }
  notePreviewCheckOverlap(others: number | undefined): void {
    if (others === undefined) { this.previewCheckOverlapUnknown = true; this.overlappingPreviewChecks = undefined }
    else if (!this.previewCheckOverlapUnknown) this.overlappingPreviewChecks = Math.max(this.overlappingPreviewChecks ?? 0, others)
  }

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
    const joinPhases = (this.name === 'room_join' || this.name === 'room_create') && ['resolve', 'preflight', 'connect', 'sync', 'name', 'daemon start', 'share', 'disclosure', 'state', 'view token'].some(name => this.phases.has(name))
    const previewPhases = this.name === 'room_preview_merge' && ['merge', 'setup', 'check', 'collect'].some(name => this.phases.has(name))
    const collectPhases = this.name === 'room_collect' && ['lease', 'inspect', 'merge', 'copy', 'prepare', 'cleanup'].some(name => this.phases.has(name))
    const names = collectPhases ? ['settle', 'lease', 'inspect', 'merge', 'copy', 'prepare', 'cleanup'] : spawnPhases ? ['settle', 'queue', 'lease', 'prepare', 'launch'] : joinPhases ? ['settle', 'resolve', 'preflight', 'connect', 'sync', 'name', 'daemon start', 'share', 'disclosure', 'state', 'view token'] : previewPhases ? ['settle', 'merge', 'setup', 'check', 'collect'] : ['settle', 'body']
    for (const name of names) {
      const elapsed = name === 'body' ? Math.max(0, (this.phases.get('body') ?? 0) - (this.phases.get('settle') ?? 0)) : name === 'state' && this.phases.has('state') ? Math.max(0, this.phases.get('state')! - (this.phases.get('view token') ?? 0)) : this.phases.get(name)
      if (elapsed === undefined) continue
      let piece = `${name} ${ms(elapsed)}`
      if (name === 'prepare' && this.gitCalls) {
        piece += ` (git ${this.gitCalls} calls ${ms(this.gitMs)}`
        if (this.worktreeAddMs) piece += `, worktree add ${ms(this.worktreeAddMs)}`
        piece += ')'
      }
      pieces.push(piece)
      if (name === 'check' && previewPhases && this.overlappingPreviewChecks !== undefined) pieces.push(`overlapped ${this.overlappingPreviewChecks} other preview check(s)`)
    }
    if (spawnPhases || joinPhases || previewPhases || collectPhases) {
      const accounted = names.reduce((sum, name) => sum + (name === 'state' ? Math.max(0, (this.phases.get(name) ?? 0) - (this.phases.get('view token') ?? 0)) : (this.phases.get(name) ?? 0)), 0)
      const other = Math.max(0, total - accounted)
      if (Math.round(other) > 0) pieces.push(`other ${ms(other)}`)
    }
    if (!pieces.length) pieces.push(`body ${ms(total)}`)
    return `slow tool ${this.name} ${ms(total)}: ${pieces.join(', ')}`
  }
}

export function currentToolTiming(): ToolTiming | undefined { return context.getStore() }

/** Marker files identify checks across MCP processes without scanning the large system temp directory. The count is
 *  approximate: a crashed check's marker counts until it is 6 minutes old if its pid is reused. Only our own marker is
 *  ever removed. */
export function countOtherPreviewChecks(ownMarker: string, markerDir: string, now = Date.now(), readStat: (file: string) => fs.Stats = file => fs.lstatSync(file)): number | undefined {
  try {
    const ownName = path.basename(ownMarker)
    let count = 0
    const dir = fs.opendirSync(markerDir)
    try {
      for (let scanned = 0; scanned < PREVIEW_CHECK_ENTRY_LIMIT; scanned++) {
        const entry = dir.readSync()
        if (!entry) return count
        if (!entry.isFile() || entry.name === ownName) continue
        const match = /^(\d+)-[0-9a-f]+$/.exec(entry.name)
        if (!match) continue
        const file = path.join(markerDir, entry.name)
        try {
          const stat = readStat(file)
          if (!stat.isFile()) continue
          if (stat.mtimeMs > now + 1_000 || now - stat.mtimeMs > PREVIEW_CHECK_MAX_AGE_MS) continue
          try { process.kill(Number(match[1]), 0) }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue }
          count++
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue // Another check removed its marker after the directory read.
          return undefined
        }
      }
      return undefined // Entry budget exhausted; overlap is unknown.
    } finally { try { dir.closeSync() } catch { /* Diagnostics must not fail the preview. */ } }
  } catch { return undefined }
}

/** Samples overlap on either side of the command timer, never inside it. */
export async function previewCheck<T>(work: () => Promise<T> | T, { markerDir = PREVIEW_CHECK_MARKERS, sample = countOtherPreviewChecks }: { markerDir?: string; sample?: (ownMarker: string, markerDir: string) => number | undefined } = {}): Promise<T> {
  const timing = currentToolTiming()
  let marker: string | undefined
  if (timing?.name === 'room_preview_merge') {
    try {
      if (!markerDir || !process.getuid) throw new Error('marker directory owner cannot be checked')
      fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 })
      // Only our own real directory: a symlink or another user's directory is not used.
      const stat = fs.lstatSync(markerDir)
      if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error('unsafe marker directory')
      const file = path.join(markerDir, `${process.pid}-${randomBytes(8).toString('hex')}`)
      fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
      marker = file
    } catch { timing.notePreviewCheckOverlap(undefined) }
  }
  const observe = () => {
    if (timing?.name !== 'room_preview_merge' || !marker) return
    try { timing.notePreviewCheckOverlap(sample(marker, markerDir!)) }
    catch { timing.notePreviewCheckOverlap(undefined) }
  }
  observe()
  try { return await previewPhase('check', work) }
  finally {
    observe()
    if (marker) try { fs.unlinkSync(marker) } catch { /* Diagnostics must not fail the preview. */ }
  }
}

/** Name preview internals without changing timing or output for collection callers. */
export async function previewPhase<T>(name: 'merge' | 'setup' | 'check' | 'collect', work: () => Promise<T> | T): Promise<T> {
  const timing = currentToolTiming()
  return timing?.name === 'room_preview_merge' ? timing.phase(name, work) : work()
}

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
