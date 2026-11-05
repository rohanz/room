import { spawn } from 'node:child_process'

export function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ROOM_|CLAUDE_|CODEX_|OIDC_|GITHUB_|YPERSISTENCE$|NODE_ENV$|PORT$|HOST$|GIT_)/.test(key)))
}
/** Own the process group so a deadline also ends grandchildren (fixture authority/client). */
export async function run(command: string, args: string[], cwd: string, timeoutMs = 120_000, input?: string, env = cleanEnv()): Promise<string> {
  if (process.exitCode === 130 || process.exitCode === 143) throw new Error('compatibility run interrupted')
  const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let failed: Error | undefined
  const stop = () => {
    if (!child.pid) return
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref()
    else { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ } }
  }
  const interrupt = (signal: string) => { process.exitCode = signal === 'SIGINT' ? 130 : 143; failed = new Error(`${command} interrupted`); stop() }
  const onInt = () => interrupt('SIGINT')
  const onTerm = () => interrupt('SIGTERM')
  process.once('SIGINT', onInt)
  process.once('SIGTERM', onTerm)
  const timer = setTimeout(() => { failed = new Error(`${command} timed out after ${timeoutMs}ms`); stop() }, timeoutMs)
  const collect = (data: Buffer) => {
    output += data.toString()
    if (Buffer.byteLength(output) > 1024 * 1024) { failed = new Error(`${command} exceeded 1 MiB output limit`); output = output.slice(-16_384); stop() }
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => {
        // Clean remaining descendants even when the direct child exited first.
        stop()
        if (failed || code !== 0) reject(new Error(`${failed?.message ?? `${command} exited ${code}`}\n${output.slice(-16_384)}`))
        else resolve()
      })
    })
    return output
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)
  }
}
