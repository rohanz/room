import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export const DEFAULT_GIT_TIMEOUT_MS = 30_000

export function missingGitCwd(dir: string, error: NodeJS.ErrnoException): Error | undefined {
  return error.code === 'ENOENT' && !existsSync(dir) ? new Error(`worktree ${dir} no longer exists`) : undefined
}

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
        const missing = missingGitCwd(dir, stopped)
        if (missing) {
          reject(missing)
          return
        }
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

/** UTF-8 blob at base, or undefined when the path did not exist at that commit. Throws when the commit itself is not in this clone. */
export async function gitShow(dir: string, base: string, relpath: string): Promise<string | undefined> {
  try {
    return await git(dir, ['show', `${base}:${relpath}`])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/does not exist|exists on disk, but not in|path .* not in/i.test(message)) throw error
    // git words a path under an unknown commit the same way as a path the commit lacks.
    try { await git(dir, ['cat-file', '-e', `${base}^{commit}`]) } catch { throw new Error(`commit ${base} is not in this clone`) }
    return undefined
  }
}

/**
 * UTF-8 blobs of many paths at one commit from a single `git cat-file --batch`; a path absent at
 * that commit maps to undefined. Paths git's batch format cannot carry (newlines) are read one by one.
 */
export async function gitShowMany(dir: string, base: string, relpaths: Iterable<string>, configuredTimeoutMs?: number): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>()
  const batch: string[] = []
  for (const p of relpaths) {
    if (/[\r\n]/.test(p)) out.set(p, await gitShow(dir, base, p))
    else batch.push(p)
  }
  if (!batch.length) return out
  const timeout = timeoutMs(configuredTimeoutMs)
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`git cat-file --batch failed: timed out after ${timeout}ms`)) }, timeout)
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => { stderr += c })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git cat-file --batch failed: ${stderr.trim() || `exit ${code}`}`)) })
    child.stdin.on('error', () => { /* reported by close */ })
    child.stdin.end(batch.map(p => `${base}:${p}\n`).join(''))
  })
  let at = 0
  for (const p of batch) {
    const eol = raw.indexOf(0x0a, at)
    const header = raw.subarray(at, eol).toString()
    at = eol + 1
    const [, type, size] = header.split(' ')
    if (header.endsWith(' missing') || header.endsWith(' ambiguous') || size === undefined) { out.set(p, undefined); continue }
    const n = Number(size)
    out.set(p, type === 'blob' ? raw.subarray(at, at + n).toString('utf8') : undefined)
    at += n + 1
  }
  return out
}

export interface GitBlobInfo { hash: string; size: number }

/** Blob ids and sizes at one commit, without reading the blobs. NUL framing also permits newline paths. */
export async function gitBlobInfoMany(dir: string, base: string, relpaths: Iterable<string>, configuredTimeoutMs?: number): Promise<Map<string, GitBlobInfo | undefined>> {
  const paths = Array.from(relpaths)
  const out = new Map<string, GitBlobInfo | undefined>()
  if (!paths.length) return out
  const timeout = timeoutMs(configuredTimeoutMs)
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch-check', '-Z'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`git cat-file --batch-check failed: timed out after ${timeout}ms`)) }, timeout)
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => { stderr += c })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error(`git cat-file --batch-check failed: ${stderr.trim() || `exit ${code}`}`)) })
    child.stdin.on('error', () => { /* reported by close */ })
    child.stdin.end(paths.map(p => `${base}:${p}\0`).join(''))
  })
  const headers = raw.split('\0')
  if (headers.length !== paths.length + 1) throw new Error(`git cat-file --batch-check returned ${headers.length - 1} results for ${paths.length} paths`)
  for (const [i, p] of paths.entries()) {
    const [hash, type, size] = headers[i].split(' ')
    out.set(p, type === 'blob' ? { hash, size: Number(size) } : undefined)
  }
  return out
}

/** Paths whose worktree or index differs from HEAD, untracked non-ignored files included: what an overlay seed must look at. */
export async function gitChanged(dir: string): Promise<string[]> {
  const out = await git(dir, ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all'])
  return out.split('\0').filter(Boolean).map(entry => entry.slice(3))
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
  git(dir, ['diff', '--name-only', '-z', from, to]).then(s => s.split('\0').filter(Boolean))
export const gitSubject = (dir: string, rev: string) =>
  git(dir, ['log', '-1', '--format=%s', rev]).then(s => s.trim())

/** Newest commit in HEAD that has reached the room branch's origin tracking ref. */
export async function gitPushedRoomHead(dir: string, head: string, branch: string): Promise<string | undefined> {
  const ref = `refs/remotes/origin/${branch}`
  try {
    await git(dir, ['rev-parse', '--verify', `${ref}^{commit}`])
    return (await git(dir, ['merge-base', head, ref])).trim() || undefined
  } catch { return undefined }
}

/** Whether the room branch has an origin tracking ref, which makes push advice meaningful. */
export async function gitRoomRemoteBranchExists(dir: string, branch: string): Promise<boolean> {
  try { await git(dir, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]); return true }
  catch (error) {
    if (error instanceof Error && error.message.includes('timed out')) throw error
    return false
  }
}
