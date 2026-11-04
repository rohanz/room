import fs from 'node:fs'
import path from 'node:path'

/** An idle Room server uses about 1% of a core; half a core with no tool call running is background work gone wrong. */
const CPU_HIGH_SHARE = 0.5
/** Long enough that a graph rebuild or a preview's tail does not count, short enough to catch a loop the same hour. */
const CPU_WINDOW_MS = 60_000
/** Ten seconds of a sustained loop shows its frames; the profiler's own cost stays bounded. */
const CPU_PROFILE_MS = 10_000
/** 5 ms samples give ~2000 samples per profile, enough to rank frames, at a fraction of the 1 ms default's overhead and size. */
const CPU_PROFILE_SAMPLE_US = 5_000
/** A loop that lasts hours needs one profile, not one a minute. */
const CPU_PROFILE_COOLDOWN_MS = 60 * 60_000
/** Profiles are a few hundred KB; five keep recent history without growing the git dir. */
const CPU_PROFILE_KEEP = 5

/** The subset of a V8 CPU profile (Profiler.stop) the summary reads. */
export interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber?: number }; hitCount?: number }[]
  samples?: number[]
  timeDeltas?: number[]
  startTime?: number
  endTime?: number
}

/** Profile this process for `ms` without blocking its event loop (node:inspector's Profiler domain). */
export async function captureCpuProfile(ms: number): Promise<CpuProfile> {
  const { Session } = await import('node:inspector/promises')
  const session = new Session()
  session.connect()
  try {
    await session.post('Profiler.enable')
    await session.post('Profiler.setSamplingInterval', { interval: CPU_PROFILE_SAMPLE_US })
    await session.post('Profiler.start')
    await new Promise(resolve => setTimeout(resolve, ms).unref())
    const { profile } = await session.post('Profiler.stop') as { profile: CpuProfile }
    return profile
  } finally { session.disconnect() }
}

/** The heaviest frames by self time, in ms, excluding idle. */
export function topSelfFrames(profile: CpuProfile, n = 5): { frame: string; ms: number }[] {
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const selfMicros = new Map<number, number>()
  if (profile.samples?.length && profile.timeDeltas?.length === profile.samples.length) {
    // timeDeltas[i] precedes samples[i]; the time a sample stands for is the gap to the next one.
    for (let i = 0; i < profile.samples.length; i++) {
      const next = profile.timeDeltas[i + 1] ?? 0
      selfMicros.set(profile.samples[i]!, (selfMicros.get(profile.samples[i]!) ?? 0) + Math.max(0, next))
    }
  } else {
    const total = (profile.endTime ?? 0) - (profile.startTime ?? 0)
    const hits = profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0)
    for (const node of profile.nodes) if (node.hitCount) selfMicros.set(node.id, hits && total > 0 ? node.hitCount * total / hits : node.hitCount * 1000)
  }
  const byFrame = new Map<string, number>()
  for (const [id, micros] of selfMicros) {
    const frame = byId.get(id)?.callFrame
    if (!frame || frame.functionName === '(idle)') continue
    const where = frame.url ? ` ${path.basename(frame.url)}:${frame.lineNumber + 1}` : ''
    const key = `${frame.functionName || '(anonymous)'}${where}`
    byFrame.set(key, (byFrame.get(key) ?? 0) + micros)
  }
  return [...byFrame].map(([frame, micros]) => ({ frame, ms: micros / 1000 })).sort((a, b) => b.ms - a.ms).slice(0, n)
}

/** Write the profile with mode 0600 and keep the newest `keep` profiles; asynchronous throughout. */
export async function writeCpuProfile(dir: string, profile: CpuProfile, at: Date, keep = CPU_PROFILE_KEEP): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${at.toISOString().replace(/[:.]/g, '-')}.cpuprofile`)
  await fs.promises.writeFile(file, JSON.stringify(profile), { mode: 0o600, flag: 'wx' })
  const names = (await fs.promises.readdir(dir)).filter(name => name.endsWith('.cpuprofile')).sort()
  for (const old of names.slice(0, Math.max(0, names.length - keep))) await fs.promises.rm(path.join(dir, old), { force: true })
  return file
}

export interface CpuWatchdogOptions {
  /** `<git common dir>/room/profiles`, or undefined before the session knows its repository. */
  profileDir: () => string | undefined
  log: (line: string) => void
  /** Whether any tool call is in flight now. */
  busy: () => boolean
  /** A counter that moves whenever a tool call started; a call completed between two samples still resets the window. */
  activity?: () => number
  now?: () => number
  wallClock?: () => Date
  cpuUsage?: () => NodeJS.CpuUsage
  capture?: (ms: number) => Promise<CpuProfile>
  write?: (dir: string, profile: CpuProfile, at: Date) => Promise<string>
}

/**
 * Sampled on the event-loop watchdog's tick. The window restarts whenever a tool call is in flight, so it only ever
 * measures background work; a profile runs at most once an hour, never concurrently, and never blocks the loop.
 */
export class CpuWatchdog {
  private samples: { at: number; micros: number }[] = []
  private profiling = false
  private lastProfileAt = -Infinity
  private lastProfile?: string
  private lastActivity: number | undefined
  private readonly now: () => number
  private readonly cpuUsage: () => NodeJS.CpuUsage

  constructor(private readonly o: CpuWatchdogOptions) {
    this.now = o.now ?? (() => performance.now())
    this.cpuUsage = o.cpuUsage ?? (() => process.cpuUsage())
  }

  /** The most recent profile written, for diagnostics. */
  get latest(): string | undefined { return this.lastProfile }

  /** One tick. Returns the running profile's promise when this tick started one (tests await it). */
  sample(): Promise<void> | undefined {
    const at = this.now()
    const activity = this.o.activity?.()
    const ran = activity !== undefined && this.lastActivity !== undefined && activity !== this.lastActivity
    this.lastActivity = activity
    if (this.o.busy() || ran) { this.samples = []; return undefined }
    const usage = this.cpuUsage()
    const micros = usage.user + usage.system
    this.samples.push({ at, micros })
    while (this.samples.length > 1 && at - this.samples[1]!.at >= CPU_WINDOW_MS) this.samples.shift()
    const first = this.samples[0]!
    const span = at - first.at
    if (span < CPU_WINDOW_MS || this.profiling || at - this.lastProfileAt < CPU_PROFILE_COOLDOWN_MS) return undefined
    const share = (micros - first.micros) / 1000 / span
    if (share <= CPU_HIGH_SHARE) return undefined
    return this.profile(share, span)
  }

  private async profile(share: number, span: number): Promise<void> {
    this.profiling = true
    this.lastProfileAt = this.now()
    const percent = `${Math.round(share * 100)}% of one core over ${Math.round(span / 1000)} s with no tool call in flight`
    try {
      const dir = this.o.profileDir()
      if (!dir) { this.o.log(`cpu high: ${percent}; no repository to write a profile into`); return }
      const profile = await (this.o.capture ?? captureCpuProfile)(CPU_PROFILE_MS)
      const file = await (this.o.write ?? writeCpuProfile)(dir, profile, (this.o.wallClock ?? (() => new Date()))())
      this.lastProfile = file
      const top = topSelfFrames(profile).map(f => `${f.frame} ${Math.round(f.ms)}ms`).join(', ')
      this.o.log(`cpu high: ${percent}; ${CPU_PROFILE_MS / 1000} s profile ${file}; top self time: ${top || 'none sampled'}`)
    } catch (error) {
      this.o.log(`cpu high: ${percent}; profile failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.profiling = false
      this.samples = []
    }
  }
}

let latestProfile: () => string | undefined = () => undefined
/** The server's watchdog registers its latest profile for the setup check. */
export function setLatestCpuProfile(latest: () => string | undefined): void { latestProfile = latest }

/** room_state(check=true): this server process's own cost. */
export function formatProcessHealth({ cpu = process.cpuUsage(), rss = process.memoryUsage.rss(), uptime = process.uptime(), latest = latestProfile() }: { cpu?: NodeJS.CpuUsage; rss?: number; uptime?: number; latest?: string } = {}): string {
  const seconds = (cpu.user + cpu.system) / 1e6
  const hours = Math.floor(uptime / 3600), minutes = Math.floor(uptime % 3600 / 60)
  return `INFO  Room server process: pid ${process.pid}; CPU ${seconds.toFixed(1)} s (user ${(cpu.user / 1e6).toFixed(1)}, system ${(cpu.system / 1e6).toFixed(1)}); RSS ${Math.round(rss / 1048576)} MB; up ${hours ? `${hours} h ` : ''}${minutes} min${latest ? `; last CPU profile ${latest}` : ''}`
}
