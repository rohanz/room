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

/**
 * Set of syncable paths: git-tracked files plus untracked files that are not ignored
 * (forward-slash, relative to the repo root). Untracked files must sync too: an agent that
 * creates api/notify.py rarely stages it, and a teammate's tests still need it.
 */
export async function gitTracked(dir: string): Promise<Set<string>> {
  const out = await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return new Set(out.split('\0').filter(Boolean))
}

/** Paths with staged, unstaged, or untracked work (porcelain -z avoids quoting). */
export async function gitDirtyPaths(dir: string): Promise<Set<string>> {
  const out = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const records = out.split('\0').filter(Boolean)
  const paths = new Set<string>()
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    const status = record.slice(0, 2)
    paths.add(record.slice(3))
    if (/[RC]/.test(status) && records[i + 1]) paths.add(records[++i])
  }
  return paths
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
