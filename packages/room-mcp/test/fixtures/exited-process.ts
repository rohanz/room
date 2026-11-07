import { execFileSync } from 'node:child_process'

/** Real ESRCH evidence for lifecycle fixtures that need an exited host, not an invalid PID. */
export function exitedProcessPid(): number {
  const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }))
  try { process.kill(pid, 0) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    throw error
  }
  throw new Error(`exited fixture PID ${pid} was reused before it could be recorded`)
}
