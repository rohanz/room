/** Refresh: rebase a stopped worker's branch onto the lead's HEAD, keeping its uncommitted edits uncommitted. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { git } from '@room/roomd/git'
import { carryRef } from './worker-git.js'
import { ROOM_CARRY_IDENTITY, roomWorkerPathMatchesBranch } from './worker-state.js'
import type { WorkerRecord } from './worker-status.js'

type RefreshSource = Pick<WorkerRecord, 'tag' | 'dir' | 'branch' | 'base' | 'carriedBase' | 'carriedUntracked' | 'link'>

export type RefreshOutcome =
  | { kind: 'refused'; reason: string }
  | { kind: 'current'; head: string }
  | { kind: 'rebased'; to: string; commits: string[]; base: string; carriedBase?: string; carriedUntracked?: WorkerRecord['carriedUntracked']; carryDropped: boolean }

const MAX_LISTED = 10
const OPERATIONS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
const internalGit = (dir: string, args: string[]) => git(dir, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args])
const identity = ['-c', `user.name=${ROOM_CARRY_IDENTITY.authorName}`, '-c', `user.email=${ROOM_CARRY_IDENTITY.authorEmail}`, '-c', 'commit.gpgsign=false']
const lines = (out: string, sep = '\n') => out.split(sep).filter(Boolean)
const short = (sha: string) => sha.slice(0, 10)
const isAncestor = (dir: string, a: string, b: string) => git(dir, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false)

async function operationInProgress(dir: string): Promise<boolean> {
  const files = lines(await git(dir, ['rev-parse', ...OPERATIONS.flatMap(name => ['--git-path', name])]))
  return files.some(file => fs.existsSync(path.resolve(dir, file)))
}

/** Why a worker's checkout is not one Room may rebase, judged from its record alone; undefined when it is. */
export function refreshRefusal(leadDir: string, record: Pick<WorkerRecord, 'tag' | 'dir' | 'branch' | 'base' | 'sharedWith' | 'outside'>, borrowers: string[]): string | undefined {
  if (record.sharedWith || record.outside || !roomWorkerPathMatchesBranch(leadDir, record.dir, record.branch)) {
    return `${record.tag} works in a directory given with dir=, not a worktree Room created for it, so Room does not rebase it`
  }
  if (borrowers.length) return `${borrowers.join(', ')} also work${borrowers.length === 1 ? 's' : ''} in ${record.tag}'s checkout (dir=)`
  if (!record.base) return `${record.tag} has no recorded base`
  return undefined
}

/**
 * Rebase the worker's branch (the lead's carried commit, any worker commits, and its uncommitted edits as a
 * temporary commit) onto `leadDir`'s HEAD. The caller holds the worker's operation lease with its process
 * stopped. Any failure aborts the rebase and restores HEAD, index and files; a conflict is reported, not left.
 */
export async function refreshWorkerBase(leadDir: string, w: RefreshSource): Promise<RefreshOutcome> {
  const refuse = (reason: string): RefreshOutcome => ({ kind: 'refused', reason })
  if (await operationInProgress(leadDir)) return refuse('finish the merge or rebase in your clone first')
  if (await operationInProgress(w.dir)) return refuse(`a merge or rebase is in progress in ${w.dir}`)
  if ((await git(w.dir, ['branch', '--show-current'])).trim() !== w.branch) return refuse(`${w.dir} is not on ${w.branch}`)
  const target = (await git(leadDir, ['rev-parse', 'HEAD'])).trim()
  const from = (await git(w.dir, ['rev-parse', 'HEAD'])).trim()
  if (await isAncestor(w.dir, target, from)) return { kind: 'current', head: target }
  const base = w.base!
  if (!await isAncestor(w.dir, base, from)) return refuse(`${w.branch} no longer contains its recorded base ${short(base)}`)
  const carried = !!w.carriedBase && w.carriedBase === base
  const start = carried ? (await git(w.dir, ['rev-parse', `${base}^`])).trim() : base

  // A checkout overwrites an ignored file without a word, and an abort cannot bring it back.
  const ignored = lines(await git(w.dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']), '\0')
  if (ignored.length) {
    // Overlap either way: a commit path at or under an ignored entry, or an ignored entry under a commit path.
    const entries = ignored.map(p => p.replace(/\/+$/, ''))
    const covered = new Set(entries)
    const holdsIgnored = new Set(entries.flatMap(p => p.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))
    // Every path the rebase can write: all your HEAD tracks (the worker may have untracked a file, staged, or
    // replaced it with a folder, unstaged) and all its replayed commits touch, even ones added and later removed.
    // The snapshot itself never holds an ignored path.
    const written = new Set([
      ...lines(await git(w.dir, ['ls-tree', '-r', '-z', '--name-only', target]), '\0'),
      ...lines(await git(w.dir, ['log', '--format=', '--name-only', '--no-renames', '-z', `${start}..${from}`]), '\0'), // NUL-terminated names, no framing: never trim a path
    ])
    const clobbered = [...written].filter(p =>
      covered.has(p) || holdsIgnored.has(p) || p.split('/').slice(0, -1).some((_, i, parts) => covered.has(parts.slice(0, i + 1).join('/'))))
    if (clobbered.length) return refuse(`the rebase would write ${clobbered.slice(0, MAX_LISTED).join(', ')}${clobbered.length > MAX_LISTED ? ` and ${clobbered.length - MAX_LISTED} more` : ''} (tracked in your HEAD or the worker's commits), where the worker has ignored files that it would overwrite`)
  }

  // Snapshot the worker's uncommitted edits (tracked and untracked; not Room's directory or linked inputs).
  let savedIndex: string
  try { savedIndex = (await git(w.dir, ['write-tree'])).trim() }
  catch { return refuse(`${w.dir} has unmerged files`) }
  const marker = `room: refresh snapshot ${randomUUID()}`
  const restore = async () => {
    await internalGit(w.dir, ['reset', '-q', '--soft', from])
    await internalGit(w.dir, ['read-tree', savedIndex])
  }
  let snapshot = false
  try {
    await internalGit(w.dir, ['add', '-A', '--', '.'])
    await internalGit(w.dir, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', '.room', ...w.link ?? []])
    snapshot = lines(await git(w.dir, ['diff', '--cached', '--name-only', '-z']), '\0').length > 0
    if (snapshot) await internalGit(w.dir, [...identity, 'commit', '-q', '--no-verify', '-m', marker])
  } catch (error) {
    await restore()
    return refuse(`could not snapshot its uncommitted edits: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }

  let ident: string[] = []
  try { await git(w.dir, ['var', 'GIT_COMMITTER_IDENT']) } catch { ident = identity }
  try {
    await internalGit(w.dir, [...ident, 'rebase', '-q', '--no-autostash', '--empty=drop', '--onto', target, start])
  } catch (error) {
    const conflicts = lines(await git(w.dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
    await internalGit(w.dir, ['rebase', '--abort']).catch(() => { /* the rebase never started */ })
    await restore()
    const detail = conflicts.length ? `its edits conflict with your commits in ${conflicts.join(', ')}`
      : `git rebase failed: ${error instanceof Error ? error.message.split('\n').find(line => line.trim() && !line.startsWith('Command failed')) ?? error.message : String(error)}`
    return refuse(detail)
  }
  if (snapshot && (await git(w.dir, ['log', '-1', '--format=%s'])).trim() === marker) await internalGit(w.dir, ['reset', '-q', '--mixed', 'HEAD~1'])

  // The lead's carried commit survives the rebase unless your commits already hold all of it.
  let carriedBase: string | undefined
  if (carried) {
    const first = lines(await git(w.dir, ['rev-list', '--reverse', `${target}..HEAD`]))[0]
    const [name, email, subject] = first ? (await git(w.dir, ['log', '-1', '--format=%an%x00%ae%x00%s', first])).trim().split('\0') : []
    if (first && ROOM_CARRY_IDENTITY.isRoomCarryCommit(name, email, subject)) carriedBase = first
  }
  const newBase = carriedBase ?? target
  if (carriedBase) await internalGit(leadDir, ['update-ref', carryRef(w.tag), carriedBase])
  else if (carried) await internalGit(leadDir, ['update-ref', '-d', carryRef(w.tag)]).catch(() => { /* never written */ })
  // A carried untracked file your commits now track is part of the base, no longer carried.
  const tracked = new Set(lines(await git(w.dir, ['ls-tree', '-r', '-z', '--name-only', newBase]), '\0'))
  const carriedUntracked = w.carriedUntracked?.filter(entry => !tracked.has(entry.path))
  const commits = lines(await git(leadDir, ['log', '--format=%h %s', `${start}..${target}`]))
  return { kind: 'rebased', to: target, commits, base: newBase, carriedBase, carriedUntracked, carryDropped: carried && !carriedBase }
}

/** The commits that came in, for the lead's reply and the worker's note. */
export function refreshedCommits(commits: string[]): string {
  const listed = commits.slice(0, MAX_LISTED).join('; ')
  return `${commits.length} commit${commits.length === 1 ? '' : 's'} came in${listed ? `: ${listed}` : ''}${commits.length > MAX_LISTED ? `; +${commits.length - MAX_LISTED} more` : ''}`
}
