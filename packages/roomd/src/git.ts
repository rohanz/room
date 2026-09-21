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
 * Origin URL -> repo prefix of the room name.
 *  - github.com origins:   github.com/<owner>/<repo>            (the server checks push access)
 *  - other git hosts:      git/<host>/<owner>/<repo>            (self-hosted GitLab, Gitea, Bitbucket...;
 *    nested groups are joined with '.', so gitlab.example.com/grp/sub/app -> git/gitlab.example.com/grp.sub/app;
 *    the server needs a login or shared token for these)
 *  - filesystem remotes:   local/<repo dir name>                (demo scripts, tests)
 */
export function normalizeGitOrigin(origin: string): string | undefined {
  const value = origin.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  const hosted = (host: string, rawPath: string): string | undefined => {
    const segs = rawPath.split('/').filter(Boolean)
    if (!segs.length) return undefined
    const h = host.toLowerCase()
    if (h === 'github.com') return `${h}/${segs.join('/')}`
    if (segs.length === 1) return `git/${h}/${segs[0]}`
    return `git/${h}/${segs.slice(0, -1).join('.')}/${segs[segs.length - 1]}`
  }
  const scp = value.match(/^(?:[^@]+@)?([^:/]+):(.+)$/)
  if (scp && !value.includes('://')) return hosted(scp[1], scp[2])
  // Filesystem remotes (demo scripts, tests): local/<repo dir name>.
  if (value.startsWith('/') || value.startsWith('.') || value.startsWith('file://')) {
    const name = value.replace(/^file:\/\//, '').split('/').filter(Boolean).pop()
    return name ? `local/${name}` : undefined
  }
  try {
    const url = new URL(value)
    if (!url.hostname) return undefined
    return hosted(url.hostname, url.pathname)
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
      else resolve(!err || Number(stopped?.code) !== 1)
    })
  })
}

export type BaseRelation = 'same' | 'ahead' | 'behind' | 'diverged' | 'unknown'

/** How local HEAD relates to the room base. 'unknown' when the base commit is not in this clone (fetch first). */
export async function gitRelation(dir: string, head: string, base: string): Promise<BaseRelation> {
  if (head === base) return 'same'
  try { await git(dir, ['cat-file', '-e', `${base}^{commit}`]) } catch { return 'unknown' }
  const isAncestor = async (a: string, b: string) => { try { await git(dir, ['merge-base', '--is-ancestor', a, b]); return true } catch { return false } }
  if (await isAncestor(base, head)) return 'ahead'
  if (await isAncestor(head, base)) return 'behind'
  return 'diverged'
}

export const gitCountBetween = (dir: string, from: string, to: string) =>
  git(dir, ['rev-list', '--count', `${from}..${to}`]).then(s => Number(s.trim()) || 0)
export const gitPathsBetween = (dir: string, from: string, to: string) =>
  git(dir, ['diff', '--name-only', from, to]).then(s => s.split('\n').filter(Boolean))
export const gitSubject = (dir: string, rev: string) =>
  git(dir, ['log', '-1', '--format=%s', rev]).then(s => s.trim())

/** True when the commit exists on any remote-tracking branch (i.e. it has been pushed/fetched). */
export async function gitIsOnRemote(dir: string, sha: string): Promise<boolean> {
  try { return (await git(dir, ['branch', '-r', '--contains', sha])).trim().length > 0 } catch { return false }
}
