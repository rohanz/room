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
  exec(file: string, args: string[]): string
}
const systemProcessReaders: ProcessReaders = {
  platform: process.platform,
  readFile: file => fs.readFileSync(file, 'utf8'),
  readLink: file => fs.readlinkSync(file),
  exec: (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    ...(file === 'ps' ? { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } } : {}) }),
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
export function probeProcess(pid: number, readers: ProcessReaders = systemProcessReaders): ProcessInfo | undefined {
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
    if (readers.platform === 'darwin') {
      const lstart = readers.exec('ps', ['-o', 'lstart=', '-p', String(pid)]).trim()
      const startSeconds = parsePsLstartUtc(lstart)
      if (startSeconds === undefined) return unreadable()
      const boot = readers.exec('sysctl', ['-n', 'kern.boottime']).match(/sec\s*=\s*(\d+)/)?.[1]
      if (!boot) return unreadable()
      let executable: string | undefined
      try { executable = path.basename(readers.exec('ps', ['-o', 'comm=', '-p', String(pid)]).trim()) } catch { /* start time is still useful to record */ }
      return { startTime: `darwin:${boot}:${startSeconds}`, executable }
    }
  } catch { /* process exited or the OS did not allow the read */ }
  return unreadable()
}
