import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Stdout alone, for output that is parsed or fed to another command. `run` merges stderr into its result,
 * and Git's line-ending warnings on Windows ("LF will be replaced by CRLF") would otherwise turn an empty
 * diff into an invalid patch.
 */
export async function capture(command: string, args: string[], cwd: string, timeoutMs = 120_000, env = cleanEnv()): Promise<string> {
  const { stdout } = await promisify(execFile)(command, args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true })
  return stdout
}

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

/** Timings include failed phases and use a monotonic clock. */
export async function timed<T>(label: string, action: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try { return await action() }
  finally { console.log(`TIMING ${label} ms=${Math.round(performance.now() - started)}`) }
}

/** Stop scheduling on failure, but drain in-flight work before its resources are removed. */
export async function boundedMap<T, R>(items: readonly T[], concurrency: number, action: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer')
  const results: R[] = new Array(items.length)
  let next = 0, failed = false, failure: unknown
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++
      try { results[index] = await action(items[index]) }
      catch (error) { if (!failed) failure = error; failed = true }
    }
  }))
  if (failed) throw failure
  return results
}
