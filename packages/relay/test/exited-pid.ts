import { spawnSync } from 'node:child_process'

/** A real reaped child, with kernel-confirmed death rather than a sentinel PID. */
export function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(child.stderr)
  const pid = Number(child.stdout.trim())
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('child did not print a pid')
  try { process.kill(pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    throw error
  }
  throw new Error('exited child pid was reused')
}
