/**
 * One notion of a worker's own changes, used by preview, collect, the conflict watcher, contract
 * notices and graph observations: its tree against its recorded base commit, with the lead's
 * carried untracked files counting as base (their spawn-time blobs, kept under a private ref).
 */
import { execFile } from 'node:child_process'
import type { Worker } from '@room/shared'

export interface Baseline {
  /** The worker whose own changes are measured from here. */
  worker: string
  sha: string
  /** Carried untracked path -> blob id of its spawn-time content. */
  untracked: ReadonlyMap<string, string>
  /** A checkout of the repository that holds `sha` and the blobs (the worker's worktree). */
  dir: string
  /** Whether `sha` is spawn's commit of the lead's uncommitted work. */
  carriedCommit: boolean
}

export function workerBaseline(worker: Worker | undefined): Baseline | undefined {
  if (!worker?.base) return undefined
  const record = worker as Worker & { carriedBase?: string; carriedUntracked?: { path: string; sha: string }[] }
  return {
    worker: worker.name, sha: worker.base, dir: worker.dir, carriedCommit: !!record.carriedBase && record.carriedBase === worker.base,
    untracked: new Map((record.carriedUntracked ?? []).map(file => [file.path, file.sha])),
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
  const blob = baseline.untracked.get(path)
  if (blob === undefined) return read(baseline.sha, path)
  try { return await checkoutText(baseline.dir, blob, path, encoding) }
  catch { throw new MissingBaseBlob(path) }
}

/** Whether `text` is still the spawn-time content of carried untracked `path`: then it is the lead's, not the worker's change. */
export async function carriedUnchanged(baseline: Baseline, path: string, text: string, encoding: BufferEncoding = 'utf8'): Promise<boolean> {
  return baseline.untracked.has(path) && (await baselineText(baseline, path, async () => undefined, encoding)) === text
}
