/**
 * One notion of a worker's own changes, used by preview, collect, the conflict watcher, contract
 * notices and graph observations: its tree against its recorded base commit, with the lead's
 * carried untracked files counting as base (their spawn-time blobs, kept under a private ref).
 */
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import nodePath from 'node:path'
import type { Worker } from '@room/shared'

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

export function workerBaseline(worker: Worker | undefined): Baseline | undefined {
  if (!worker?.base) return undefined
  return {
    worker: worker.name, sha: worker.base, dir: worker.dir, carriedCommit: !!worker.carriedBase && worker.carriedBase === worker.base,
    untracked: new Map((worker.carriedUntracked ?? []).map(file => [file.path, { sha: file.sha, mode: file.mode }])),
  }
}

/** Whether the baseline holds any of the lead's uncommitted work. */
export const carriesWork = (baseline: Baseline | undefined): baseline is Baseline => !!baseline && (baseline.carriedCommit || baseline.untracked.size > 0)

const committedPaths = new Map<string, Promise<string[]>>()
/** Paths the lead's carried work touched: the carried commit's own changes and carried untracked files. */
export async function carriedPaths(baseline: Baseline): Promise<string[]> {
  let tracked: Promise<string[]> = Promise.resolve([])
  if (baseline.carriedCommit) {
    tracked = committedPaths.get(baseline.sha) ?? run(baseline.dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', baseline.sha]).then(out => out.toString().split('\0').filter(Boolean))
    committedPaths.set(baseline.sha, tracked)
  }
  return [...await tracked, ...baseline.untracked.keys()]
}

/**
 * The three-way base for merging `other` into `me`'s tree: a worker's own baseline when either
 * side is a worker with a recorded base (the other side first), in either direction; otherwise
 * the shared ancestor. A baseline that does not descend from the ancestor is not used.
 */
export async function pairBaseline(me: Worker | undefined, other: Worker | undefined, ancestor: string, descends: (ancestor: string, sha: string) => Promise<boolean>): Promise<Baseline | undefined> {
  for (const baseline of [workerBaseline(other), workerBaseline(me)]) {
    if (baseline && (baseline.sha === ancestor || await descends(ancestor, baseline.sha))) return baseline
  }
  return undefined
}

function run(dir: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`git ${args.join(' ')} failed: ${String(stderr).trim() || error.message}`), { stderr: String(stderr) }))
      else resolve(stdout)
    })
  })
}

/**
 * A blob (`<sha>:<path>` or a blob id) in checkout representation for `path` (core.autocrlf, eol
 * attributes and smudge filters applied), so it compares equal to an unchanged file on disk.
 * Undefined when the commit has no such path.
 */
export async function checkoutText(dir: string, object: string, path: string, encoding: BufferEncoding = 'utf8'): Promise<string | undefined> {
  try { return (await run(dir, ['cat-file', '--filters', `--path=${path}`, object])).toString(encoding) }
  catch (error) {
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

/** The blob id Git gives the file or link at `path` in checkout `dir` (clean filters applied, as `git status` compares); `write` stores the blob. */
export function carriedContentHash(dir: string, path: string, write = false): string {
  const source = nodePath.join(dir, path), stat = fs.lstatSync(source)
  const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(source)) : fs.readFileSync(source)
  return execFileSync('git', ['hash-object', ...(write ? ['-w'] : []), '--path=' + path, '--stdin'], { cwd: dir, input: bytes }).toString().trim()
}

/**
 * Whether carried untracked `path` is, in the worker's tree, still what spawn carried: the same blob
 * and, for a regular file, the same permission bits. Then it is the lead's, not the worker's change.
 * A path that is missing, not carried, or reaches outside the tree is not unchanged.
 */
export function carriedUnchanged(baseline: Baseline, path: string): boolean {
  const carried = baseline.untracked.get(path)
  if (!carried || nodePath.isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) return false
  try {
    const root = fs.realpathSync(baseline.dir), parent = fs.realpathSync(nodePath.dirname(nodePath.join(root, path)))
    if (parent !== root && !parent.startsWith(root + nodePath.sep)) return false
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
