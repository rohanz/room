import { execFile } from 'node:child_process'

export const DEFAULT_GIT_TIMEOUT_MS = 30_000

function timeoutMs(configured?: number): number {
  const fromEnv = Number(process.env.ROOM_GIT_TIMEOUT_MS)
  return Number.isFinite(configured) && configured! > 0 ? configured! : Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_GIT_TIMEOUT_MS
}

export function git(dir: string, args: string[], configuredTimeoutMs?: number): Promise<string> {
  const timeout = timeoutMs(configuredTimeoutMs)
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) {
        const stopped = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        const detail = stopped.killed || stopped.signal ? `timed out after ${timeout}ms` : String(stderr || err.message).trim()
        reject(new Error(`git ${args.join(' ')} failed: ${detail}`))
      }
      else resolve(stdout)
    })
  })
}

export const gitHead = (dir: string) => git(dir, ['rev-parse', 'HEAD']).then(s => s.trim())
export const gitBranch = (dir: string) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).then(s => s.trim())

export function normalizeGitOrigin(origin: string): string | undefined {
  const value = origin.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  const scp = value.match(/^(?:[^@]+@)?([^:/]+):(.+)$/)
  if (scp && !value.includes('://')) return `${scp[1]}/${scp[2].replace(/^\/+/, '')}`
  try {
    const url = new URL(value)
    if (!url.hostname) return undefined
    return `${url.hostname}/${url.pathname.replace(/^\/+/, '')}`
  } catch {
    return undefined
  }
}

export async function gitOrigin(dir: string): Promise<string | undefined> {
  try {
    return normalizeGitOrigin(await git(dir, ['remote', 'get-url', 'origin']))
  } catch (error) {
    if (error instanceof Error && error.message.includes('timed out')) throw error
    return undefined
  }
}

/** UTF-8 blob at base, or undefined when the path did not exist at that commit. */
export async function gitShow(dir: string, base: string, relpath: string): Promise<string | undefined> {
  try {
    return await git(dir, ['show', `${base}:${relpath}`])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/does not exist|exists on disk, but not in|path .* not in/i.test(message)) return undefined
    throw error
  }
}

/**
 * Set of syncable paths: git-tracked files plus untracked files that are not ignored
 * (forward-slash, relative to the repo root). Untracked files must sync too: an agent that
 * creates api/notify.py rarely stages it, and a teammate's tests still need it.
 */
export async function gitTracked(dir: string): Promise<Set<string>> {
  const out = await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return new Set(out.split('\0').filter(Boolean))
}

/** True when git would ignore this path (so it must not be synced). */
export async function gitIgnored(dir: string, rel: string, configuredTimeoutMs?: number): Promise<boolean> {
  const timeout = timeoutMs(configuredTimeoutMs)
  return new Promise((resolve, reject) => {
    execFile('git', ['check-ignore', '-q', '--', rel], { cwd: dir, timeout }, err => {
      const stopped = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null
      if (stopped?.killed || stopped?.signal) reject(new Error(`git check-ignore timed out after ${timeout}ms`))
      else resolve(!err)
    })
  })
}
