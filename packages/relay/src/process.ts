/** Process identity: the kernel's birth marker and executable for a pid (moved from room-mcp's worker-process.ts). */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export interface ProcessInfo { startTime?: string; executable?: string }
/** Undefined means the pid is gone; an empty object means it is live but its identity is unreadable. */
export type ProcessProbe = (pid: number) => ProcessInfo | undefined
export interface ProcessReaders {
  platform: NodeJS.Platform
  readFile(file: string): string
  readLink(file: string): string
  exec(file: string, args: string[], options?: { timeout: number; maxBuffer: number }): string
}
const systemProcessReaders: ProcessReaders = {
  platform: process.platform,
  readFile: file => fs.readFileSync(file, 'utf8'),
  readLink: file => fs.readlinkSync(file),
  exec: (file, args, options) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, ...options,
    ...(file === 'ps' ? { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } } : {}) }),
}

/** Windows uses case-insensitive executable basenames; only the terminal .exe suffix is removed. */
export function windowsProcessName(name: string): string {
  return path.win32.basename(name).toLowerCase().replace(/\.exe$/, '')
}

export interface WindowsProcessInfo extends ProcessInfo { ppid: number }

/** CIM JSON projected by readWindowsProcessTable; preserve all seven fractional birth digits. */
export function parseWindowsProcessTable(output: string): Map<number, WindowsProcessInfo> {
  const table = new Map<number, WindowsProcessInfo>()
  let parsed: unknown
  try { parsed = JSON.parse(output.replace(/^\uFEFF/, '').trim()) } catch { return table }
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!row || typeof row !== 'object') continue
    const { pid, ppid, creationDate, name } = row as Record<string, unknown>
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !Number.isSafeInteger(ppid) || (ppid as number) < 0) continue
    let startTime: string | undefined
    if (typeof creationDate === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(creationDate)) {
      // Date.parse truncates precision and normalizes impossible days; validate without using it as the token.
      const millis = Date.parse(creationDate)
      if (Number.isFinite(millis) && new Date(millis).toISOString() === creationDate.slice(0, 23) + 'Z') startTime = `windows:${creationDate}`
    }
    const executable = typeof name === 'string' && name ? windowsProcessName(name) || undefined : undefined
    table.set(pid as number, { ppid: ppid as number, startTime, executable })
  }
  return table
}

/** No WMIC dependency, command lines or environments. A PID filter bounds per-worker queries. */
export function readWindowsProcessTable(readers: Pick<ProcessReaders, 'exec'>, pid?: number): Map<number, WindowsProcessInfo> {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) return new Map()
  const query = `Get-CimInstance Win32_Process${pid === undefined ? '' : ` -Filter "ProcessId = ${pid}"`}`
  const script = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
    + `@(${query} | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; `
    + "creationDate = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o', [System.Globalization.CultureInfo]::InvariantCulture) } else { $null }); name = $_.Name } }) | ConvertTo-Json -Compress"
  return parseWindowsProcessTable(readers.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }))
}

/**
 * Whether two recorded start times name one process start. macOS has no fixed boot time: `kern.boottime` is the
 * wall clock minus uptime, so a clock correction can move it by a second while every process keeps its absolute
 * start (`ps` lstart). Compare macOS starts by lstart, with the boot part allowed to drift by up to a minute.
 */
export function sameStartTime(a: string, b: string): boolean {
  if (a === b) return true
  const x = /^darwin:(\d+):(\d+)$/.exec(a), y = /^darwin:(\d+):(\d+)$/.exec(b)
  return !!x && !!y && x[2] === y[2] && Math.abs(Number(x[1]) - Number(y[1])) <= 60
}

/** Parse the C-locale `ps` start line as UTC, independent of the MCP process's timezone. */
export function parsePsLstartUtc(line: string): number | undefined {
  const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(line.trim())
  if (!match) return undefined
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[1])
  const seconds = Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000
  return Number.isInteger(seconds) ? seconds : undefined
}

/** The files a Linux process name is read from; a reader throws when its file is unreadable. */
export interface LinuxNameFiles { comm(): string; cmdline(): string; exe(): string }

/**
 * Name a Linux process as invoked, as macOS `ps -o comm=` does, not by the file it runs: the native
 * Claude installer links `claude` to `.../claude/versions/<version>`, so the executable is named
 * `2.1.286`, and a binary replaced by an update reads as `<path> (deleted)`. Order: comm (the
 * execve basename); argv[0] when comm is missing or may be cut at the kernel's 15 characters; a
 * Claude version file counts as `claude`; else the executable. Node-hosted scripts stay `node`.
 * plugins/room/hooks/common.mjs keeps a copy of this rule: `session.ts` compares records from both.
 */
export function linuxProcessName(files: LinuxNameFiles): string | undefined {
  const read = (file: () => string) => { try { return file() } catch { return undefined } }
  let name = read(files.comm)?.replace(/\n$/, '') || undefined
  if (!name || name.length >= 15) {
    const argv0 = read(files.cmdline)?.split('\0')[0]
    const invoked = argv0 ? path.basename(argv0) : undefined
    if (invoked && (!name || invoked.startsWith(name))) name = invoked
  }
  if (name && !/^\d+(?:\.\d+)+/.test(name)) return name
  const exe = read(files.exe)?.replace(/ \(deleted\)$/, '')
  if (exe && /[\\/]claude[\\/]versions[\\/][^\\/]+$/.test(exe)) return 'claude'
  return name ?? (exe ? path.basename(exe) : undefined)
}

/** Read the kernel's process birth marker and executable name, without inspecting environment.
 * macOS gives Node one-second start-time resolution. Reuse of the same pid in that same second is
 * not a practical risk: pids increment and wrap only after about 99,999, and the executable must also match. */
export function probeProcess(pid: number, readers?: ProcessReaders): ProcessInfo | undefined {
  return readers ? probeUncached(pid, readers) : systemProbe(pid)
}

function probeUncached(pid: number, readers: ProcessReaders, boottime = () => readers.exec('sysctl', ['-n', 'kern.boottime'])): ProcessInfo | undefined {
  if (!pid || pid <= 0) return undefined
  const unreadable = () => pidAlive(pid) ? {} : undefined
  try {
    if (readers.platform === 'linux') {
      const stat = readers.readFile(`/proc/${pid}/stat`)
      const close = stat.lastIndexOf(')')
      if (close < 0) return unreadable()
      const startTicks = stat.slice(close + 1).trim().split(/\s+/)[19]
      if (!/^\d+$/.test(startTicks ?? '')) return unreadable()
      const bootId = readers.readFile('/proc/sys/kernel/random/boot_id').trim()
      if (!bootId) return unreadable()
      const executable = linuxProcessName({ comm: () => readers.readFile(`/proc/${pid}/comm`),
        cmdline: () => readers.readFile(`/proc/${pid}/cmdline`), exe: () => readers.readLink(`/proc/${pid}/exe`) })
      return { startTime: `linux:${bootId}:${startTicks}`, executable }
    }
    if (readers.platform === 'win32') {
      const info = readWindowsProcessTable(readers, pid).get(pid)
      return info ? { startTime: info.startTime, executable: info.executable } : unreadable()
    }
    if (readers.platform === 'darwin') {
      const lstart = readers.exec('ps', ['-o', 'lstart=', '-p', String(pid)]).trim()
      const startSeconds = parsePsLstartUtc(lstart)
      if (startSeconds === undefined) return unreadable()
      const boot = boottime().match(/sec\s*=\s*(\d+)/)?.[1]
      if (!boot) return unreadable()
      let executable: string | undefined
      try { executable = path.basename(readers.exec('ps', ['-o', 'comm=', '-p', String(pid)]).trim()) } catch { /* start time is still useful to record */ }
      return { startTime: `darwin:${boot}:${startSeconds}`, executable }
    }
  } catch { /* process exited or the OS did not allow the read */ }
  return unreadable()
}

/** How long a live process's identity is reused: briefly while young enough to still `exec` (nice, sh), longer once settled. */
const PROBE_TTL_MS = 2_000, YOUNG_TTL_MS = 250, SETTLED_AFTER_S = 5, BOOTTIME_TTL_MS = 60_000, CONFIRMED_TTL_MS = 60_000

/** A probe that can also confirm a negative verdict about a recorded process. */
export interface CachedProcessProbe extends ProcessProbe {
  /**
   * Reads afresh for a recorded process the cache disagrees with: the cache may describe a predecessor on a reused
   * pid, or an executable from before an `exec`. A fresh read that still disagrees is kept for that record alone
   * (a recorded process that was gone stays gone); one that agrees is never reused.
   */
  confirm(pid: number, recorded: { startTime?: string; executable?: string }): ProcessInfo | undefined
  /** Always reads afresh (the boot time stays cached), and refreshes the cache. */
  fresh(pid: number): ProcessInfo | undefined
}

const startSeconds = (startTime: string | undefined) => startTime?.startsWith('windows:')
  ? Date.parse(startTime.slice('windows:'.length)) / 1000 : Number(/^darwin:\d+:(\d+)$/.exec(startTime ?? '')?.[1])
const agrees = (info: ProcessInfo, recorded: { startTime?: string; executable?: string }) =>
  (!info.startTime || !recorded.startTime || sameStartTime(info.startTime, recorded.startTime))
  && (!info.executable || !recorded.executable || info.executable === recorded.executable)

/**
 * A probe bounded to one identity read per live pid per PROBE_TTL_MS (YOUNG_TTL_MS for a process younger than
 * SETTLED_AFTER_S, which may not have exec'd into its host yet), however many callers ask: on macOS a read is three
 * synchronous processes (`ps`, `sysctl`, `ps`); Windows reads CIM via one bounded PowerShell process. Unreadable
 * Windows identities get only the short TTL and never establish ownership. Status reads probe every worker on each room change. A dead pid
 * is answered at once by `kill(pid, 0)`. Lifetimes run on the monotonic clock. Linux reads /proc and is not cached.
 */
export function createProcessProbe(readers: ProcessReaders & { alive?(pid: number): boolean }, options: { now?: () => number; wall?: () => number } = {}): CachedProcessProbe {
  if (readers.platform !== 'darwin' && readers.platform !== 'win32') {
    const read = (pid: number) => probeUncached(pid, readers)
    return Object.assign(read, { confirm: read, fresh: read })
  }
  const now = options.now ?? (() => performance.now()), wall = options.wall ?? Date.now, alive = readers.alive ?? pidAlive
  const cache = new Map<number, { info: ProcessInfo; until: number }>()
  const confirmed = new Map<string, { info: ProcessInfo; until: number }>()
  let boot: { text: string; at: number } | undefined
  const boottime = () => {
    if (!boot || now() - boot.at >= BOOTTIME_TTL_MS) boot = { text: readers.exec('sysctl', ['-n', 'kern.boottime']), at: now() }
    return boot.text
  }
  const fresh = (pid: number) => {
    const info = probeUncached(pid, readers, boottime)
    const started = startSeconds(info?.startTime)
    if (info && (readers.platform === 'win32' || info.executable && Number.isFinite(started))) {
      if (cache.size >= 1024) cache.clear()
      cache.set(pid, { info, until: now() + (info.executable && Number.isFinite(started) && wall() / 1000 - started >= SETTLED_AFTER_S ? PROBE_TTL_MS : YOUNG_TTL_MS) })
    } else cache.delete(pid)
    return info
  }
  const probe = (pid: number) => {
    const hit = cache.get(pid)
    if (!pid || pid <= 0 || !alive(pid)) { cache.delete(pid); return undefined }
    return hit && now() < hit.until ? hit.info : fresh(pid)
  }
  const confirm = (pid: number, recorded: { startTime?: string; executable?: string }) => {
    if (!pid || pid <= 0 || !alive(pid)) return undefined
    const key = `${pid}\0${recorded.startTime ?? ''}\0${recorded.executable ?? ''}`
    const hit = confirmed.get(key)
    if (hit && now() < hit.until) return hit.info
    const info = fresh(pid)
    // A young process may not have exec'd into its host yet: its mismatch is not kept.
    if (info && !agrees(info, recorded) && wall() / 1000 - startSeconds(info.startTime) >= SETTLED_AFTER_S) {
      if (confirmed.size >= 1024) confirmed.clear()
      confirmed.set(key, { info, until: now() + CONFIRMED_TTL_MS })
    } else confirmed.delete(key)
    return info
  }
  return Object.assign(probe, { confirm, fresh })
}

const systemProbe = createProcessProbe(systemProcessReaders)

/** An uncached identity read, for decisions a reused pid must never pass: signalling or recording a process. */
export function probeProcessNow(pid: number): ProcessInfo | undefined { return systemProbe.fresh(pid) }

/** The shared probe's confirmation of a negative verdict about a recorded process (see CachedProcessProbe.confirm). */
export function probeProcessConfirm(pid: number, recorded: { startTime?: string; executable?: string }): ProcessInfo | undefined { return systemProbe.confirm(pid, recorded) }
