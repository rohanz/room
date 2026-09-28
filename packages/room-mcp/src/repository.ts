/**
 * Room runs in a git working tree with at least one commit: rooms are named after the repository,
 * and shared work is changes on top of a commit. A folder that is not one yet is something the
 * human fixes (git init, a first commit, opening the checkout), so it is answered in plain words
 * and checked again on the next call, never retried in a loop. Anything else git reports (a
 * timeout, EAGAIN, an I/O or permission error) is left to the join, which retries or reports it.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { RoomdError } from '@room/roomd'
import { timeoutMs } from '@room/roomd/git'

export class NotARepository extends RoomdError {
  constructor(readonly dir: string, message: string) { super(message, 2); this.name = 'NotARepository' }
}

const notRepository = (dir: string) => `Room works inside a git repository, and ${dir} isn't one. Run \`git init\` and make a first commit, or open the project's repository folder, then say 'join the room' again.`
const noWorkTree = (dir: string, bare: boolean) => `Room works in a repository's working tree (the folder with your files), and ${dir} is ${bare ? 'a bare repository' : "inside a repository's .git folder"}, which has none. Open the checkout folder, then say 'join the room' again.`
const noCommit = (root: string) => `Room needs a first commit: ${root} is a git repository with no commits yet. Make a first commit (git add -A && git commit -m "first commit"), then say 'join the room' again.`

/** A git call's outcome: exit status (a number), a spawn error code (e.g. 'EAGAIN'), or 'timeout'. */
export type GitRun = (dir: string, args: string[]) => Promise<{ status: number | string | null; stdout: string; stderr: string }>
const run: GitRun = (dir, args) => new Promise(resolve => {
  execFile('git', args, { cwd: dir, timeout: timeoutMs() }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null
    resolve({ status: !e ? 0 : e.killed ? 'timeout' : e.code ?? null, stdout: String(stdout), stderr: String(stderr) })
  })
})

/** The worktree root holding dir (dir itself when it is the root), or what the human must do first. */
export async function repositoryRoot(dir: string, git: GitRun = run): Promise<{ root: string; problem?: never } | { problem: string; root?: never }> {
  const where = await git(dir, ['rev-parse', '--is-bare-repository', '--is-inside-work-tree'])
  if (where.status !== 0) return where.status === 128 && /not a git repository/i.test(where.stderr) ? { problem: notRepository(dir) } : { root: dir }
  const [bare, inside] = where.stdout.trim().split('\n')
  if (inside !== 'true') return { problem: noWorkTree(dir, bare === 'true') }
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  if (top.status !== 0) return { root: dir }
  let root = top.stdout.trim() || dir
  try { if (fs.realpathSync(dir) === fs.realpathSync(root)) root = dir } catch { /* keep git's spelling */ }
  // Unborn: HEAD is a symbolic ref to a branch that does not exist yet. An existing ref whose objects git
  // cannot read, or any failing call, is a git failure for the join to report, not a missing commit.
  const head = await git(root, ['symbolic-ref', '-q', 'HEAD'])
  const ref = head.stdout.trim()
  if (head.status === 0 && ref && (await git(root, ['show-ref', '--verify', '--quiet', ref])).status === 1) return { problem: noCommit(root) }
  return { root }
}

export async function repositoryProblem(dir: string): Promise<string | undefined> {
  return (await repositoryRoot(dir)).problem
}

/** The worktree root to join from dir; NotARepository when there is none yet. */
export async function joinableRoot(dir: string): Promise<string> {
  const r = await repositoryRoot(dir)
  if (r.problem !== undefined) throw new NotARepository(dir, r.problem)
  return r.root
}

/** Two spellings of one folder (/tmp and /private/tmp, a symlink). */
export function sameFolder(a: string, b: string): boolean {
  try { return fs.realpathSync(a) === fs.realpathSync(b) } catch { return a === b }
}
