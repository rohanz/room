/**
 * One notion of a worker's own changes, used by preview, collect, the conflict watcher, contract
 * notices and graph observations: its tree against its recorded base commit, with the lead's
 * carried untracked files counting as base (their spawn-time blobs, kept under a private ref).
 */
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import nodePath from 'node:path'
import { CARRIED_PATH, containedRepoPath, validRepoPath } from './repo-path.js'
import { missingGitCwd, observeGit, timeoutMs, wholeTreeTimeoutMs, UNKNOWN_WHOLE_TREE_PATHS } from './git.js'

/** Bounded binary Git reads used by the few synchronous carry/recovery operations. */
export function boundedGitSync(dir: string, args: string[], options: { input?: Buffer; env?: NodeJS.ProcessEnv; maxBuffer?: number; wholeTreePaths?: number } = {}): Buffer {
  const { wholeTreePaths, ...execOptions } = options
  const timeout = wholeTreePaths === undefined ? timeoutMs() : wholeTreeTimeoutMs(wholeTreePaths)
  const done = observeGit(args)
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'buffer', stdio: ['pipe', 'pipe', 'pipe'], timeout, maxBuffer: execOptions.maxBuffer ?? 64 * 1024 * 1024, ...execOptions })
  } catch (error) {
    const stopped = error as NodeJS.ErrnoException & { signal?: string; killed?: boolean }
    const missing = missingGitCwd(dir, stopped)
    if (missing) throw missing
    if (stopped.signal === 'SIGTERM' || stopped.killed) throw new Error(`git ${args.join(' ')} timed out after ${timeout}ms`, { cause: error })
    throw error
  } finally {
    done()
  }
}

export interface Baseline {
  /** The worker whose own changes are measured from here. */
  worker: string
  sha: string
  /** Carried untracked path -> blob id of its spawn-time content and its spawn-time permission bits. */
  untracked: ReadonlyMap<string, { sha: string; mode?: number }>
  /** A checkout of the repository that holds `sha` and the blobs (the worker's worktree). */
  dir: string
  /** Whether `sha` is spawn's commit of the lead's uncommitted work. */
  carriedCommit: boolean
}

/** The registry facts a worker's baseline is built from: its record, or the carried facts its daemon is started with. */
export interface BaselineSource {
  name: string
  dir: string
  base?: string
  carriedBase?: string
  carriedUntracked?: readonly { path: string; sha: string; mode?: number }[]
  link?: readonly string[]
}

export function workerBaseline(worker: BaselineSource | undefined): Baseline | undefined {
  if (!worker?.base) return undefined
  return {
    worker: worker.name, sha: worker.base, dir: worker.dir, carriedCommit: !!worker.carriedBase && worker.carriedBase === worker.base,
    untracked: new Map((worker.carriedUntracked ?? []).map(file => [file.path, { sha: file.sha, mode: file.mode }])),
  }
}

/** Whether the baseline holds any of the lead's uncommitted work. */
export const carriesWork = (baseline: Baseline | undefined): baseline is Baseline => !!baseline && (baseline.carriedCommit || baseline.untracked.size > 0)

const committedPaths = new Map<string, Promise<string[]>>()
const MAX_COMMITTED_PATHS = 128
/** Paths the lead's carried work touched: the carried commit's own changes and carried untracked files. */
export async function carriedPaths(baseline: Baseline): Promise<string[]> {
  let tracked: Promise<string[]> = Promise.resolve([])
  if (baseline.carriedCommit) {
    tracked = committedPaths.get(baseline.sha) ?? boundedGit(baseline.dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', baseline.sha], UNKNOWN_WHOLE_TREE_PATHS).then(out => out.toString().split('\0').filter(Boolean))
    if (!committedPaths.has(baseline.sha)) {
      committedPaths.set(baseline.sha, tracked)
      void tracked.catch(() => { if (committedPaths.get(baseline.sha) === tracked) committedPaths.delete(baseline.sha) })
      if (committedPaths.size > MAX_COMMITTED_PATHS) committedPaths.delete(committedPaths.keys().next().value!)
    }
  }
  return [...await tracked, ...baseline.untracked.keys()]
}

/**
 * The three-way base for merging `other` into `me`'s tree: a worker's own baseline when either
 * side is a worker with a recorded base (the other side first), in either direction; otherwise
 * the shared ancestor. A baseline that does not descend from the ancestor is not used.
 */
export async function pairBaseline(me: Baseline | undefined, other: Baseline | undefined, ancestor: string, descends: (ancestor: string, sha: string) => Promise<boolean>): Promise<Baseline | undefined> {
  for (const baseline of [other, me]) {
    if (baseline && (baseline.sha === ancestor || await descends(ancestor, baseline.sha))) return baseline
  }
  return undefined
}

export function boundedGit(dir: string, args: string[], wholeTreePaths?: number, env?: NodeJS.ProcessEnv, maxBuffer = 64 * 1024 * 1024): Promise<Buffer> {
  const timeout = wholeTreePaths === undefined ? timeoutMs() : wholeTreeTimeoutMs(wholeTreePaths)
  const done = observeGit(args)
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, env, encoding: 'buffer', maxBuffer, timeout }, (error, stdout, stderr) => {
      done()
      if (error) {
        const stopped = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        const missing = missingGitCwd(dir, stopped)
        if (missing) { reject(missing); return }
        const detail = stopped.killed || stopped.signal ? `timed out after ${timeout}ms` : String(stderr).trim() || error.message
        reject(Object.assign(new Error(`git ${args.join(' ')} failed: ${detail}`), { stderr: String(stderr), code: stopped.code }))
      }
      else resolve(stdout)
    })
  })
}

/**
 * A blob (`<sha>:<path>` or a blob id) in checkout representation for `path` (core.autocrlf, eol
 * attributes and smudge filters applied), so it compares equal to an unchanged file on disk.
 * Undefined when the commit has no such path.
 */
export async function checkoutText(dir: string, object: string, path: string, encoding: BufferEncoding = 'utf8', maxBytes?: number): Promise<string | undefined> {
  if (maxBytes !== undefined) {
    const rawSize = Number((await boundedGit(dir, ['cat-file', '-s', object], undefined, undefined, 128)).toString().trim())
    if (!Number.isSafeInteger(rawSize) || rawSize < 0) throw new Error(`invalid blob size for ${object}`)
    if (rawSize > maxBytes) return undefined
  }
  try {
    const output = await boundedGit(dir, ['cat-file', '--filters', `--path=${path}`, object], undefined, undefined,
      maxBytes === undefined ? 64 * 1024 * 1024 : maxBytes + 1)
    // The buffer allows one sentinel byte past the cap: output that reaches it is over the cap.
    return maxBytes !== undefined && output.length > maxBytes ? undefined : output.toString(encoding)
  }
  catch (error) {
    // Checkout filters may expand a small blob past the raw-size bound.
    if (maxBytes !== undefined && ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
      /maxBuffer|ERR_CHILD_PROCESS_STDIO_MAXBUFFER/.test(String(error)))) return undefined
    if (/does not exist|exists on disk, but not in|path .* not in/i.test(String((error as { stderr?: string }).stderr))) return undefined
    throw error
  }
}

/** A carried untracked file whose private base blob is gone: it cannot be merged. */
export class MissingBaseBlob extends Error {
  constructor(readonly path: string) { super(`missing private base blob: ${path}`) }
}

/** The baseline text of `path`, reading the base commit's files with `read`. */
export async function baselineText<T extends string | null | undefined>(baseline: Baseline, path: string, read: (sha: string, path: string) => Promise<T>, encoding: BufferEncoding = 'utf8'): Promise<T | string | undefined> {
  const carried = baseline.untracked.get(path)
  if (carried === undefined) return read(baseline.sha, path)
  try { return await checkoutText(baseline.dir, carried.sha, path, encoding) }
  catch { throw new MissingBaseBlob(path) }
}

/** A missing path is known empty; a failed read is unknown and cannot support semantic claims. */
export type BaselineRead = { kind: 'available'; text: string } | { kind: 'absent' } | { kind: 'unavailable'; error: Error }
export async function readBaseline(baseline: Baseline, path: string, read: (sha: string, path: string) => Promise<string | null | undefined>, encoding: BufferEncoding = 'utf8'): Promise<BaselineRead> {
  try {
    const text = await baselineText(baseline, path, read, encoding)
    return text == null ? { kind: 'absent' } : { kind: 'available', text }
  } catch (error) {
    return { kind: 'unavailable', error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/** The blob id Git gives the file or link at `path` in checkout `dir` (clean filters applied, as `git status` compares); `write` stores the blob. */
export function carriedContentHash(dir: string, path: string, write = false): string {
  const source = nodePath.join(dir, path), stat = fs.lstatSync(source)
  const args = ['hash-object', ...(write ? ['-w'] : []), '--path=' + path]
  // A file is hashed by name: a synchronous child fed megabytes on stdin can leave git waiting for EOF forever
  // (Node 22 on macOS, 1 call in ~150). A link's target is a few bytes and is only hashable as stdin text.
  const out = stat.isSymbolicLink()
    ? boundedGitSync(dir, [...args, '--stdin'], { input: Buffer.from(fs.readlinkSync(source)) })
    : boundedGitSync(dir, [...args, '--', path])
  return out.toString().trim()
}

/**
 * Whether carried untracked `path` is, in the worker's tree, still what spawn carried: the same blob
 * and, for a regular file, the same permission bits. Then it is the lead's, not the worker's change.
 * A path that is missing, not carried, or reaches outside the tree is not unchanged.
 */
export function carriedUnchanged(baseline: Baseline, path: string): boolean {
  const carried = baseline.untracked.get(path)
  if (!carried || !validRepoPath(path, CARRIED_PATH)) return false
  try {
    const root = fs.realpathSync(baseline.dir)
    // Git hashes the link text itself, so only its parent must be contained.
    if (!containedRepoPath(root, nodePath.join(root, path), { leaf: 'replace-link' }).ok) return false
    const stat = fs.lstatSync(nodePath.join(root, path))
    if (!stat.isFile() && !stat.isSymbolicLink()) return false
    if (stat.isFile() && carried.mode !== undefined && (stat.mode & 0o777) !== carried.mode) return false
    return carriedContentHash(root, path) === carried.sha
  } catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return false; throw e }
}

/** The carried untracked paths the worker left as spawn carried them (carriedUnchanged). */
export function carriedUnchangedPaths(baseline: Baseline | undefined): Set<string> {
  return new Set([...baseline?.untracked.keys() ?? []].filter(path => carriedUnchanged(baseline!, path)))
}

/** Paths changed by a worker from its own recorded base, excluding unchanged carried inputs. */
export async function workerChangedPaths(worker: BaselineSource): Promise<string[]> {
  const baseline = workerBaseline(worker)
  const base = baseline?.sha ?? 'HEAD'
  const exclusions = ['.room', ...(worker.link ?? [])].map(p => `:(exclude,literal)${p}`)
  const tracked = (await boundedGit(worker.dir, ['diff', '--name-only', '-z', base, '--', '.', ...exclusions], UNKNOWN_WHOLE_TREE_PATHS)).toString().split('\0').filter(Boolean)
  const untracked = (await boundedGit(worker.dir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...exclusions], UNKNOWN_WHOLE_TREE_PATHS)).toString().split('\0').filter(Boolean)
  return [...new Set([...tracked, ...untracked, ...baseline?.untracked.keys() ?? []])].filter(p => !baseline || !carriedUnchanged(baseline, p)).sort()
}
