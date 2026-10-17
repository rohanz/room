/** Refresh: rebase a stopped worker's branch onto the lead's HEAD, keeping its uncommitted edits uncommitted. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { git, observeGit, timeoutMs } from '@room/roomd/git'
import { carryRef, collectBaseRef, collectHeadRef } from './worker-git.js'
import { boundedGit, boundedGitSync } from '@room/roomd/baseline'
import { ROOM_CARRY_IDENTITY, roomWorkerPathMatchesBranch } from './worker-state.js'
import type { WorkerRecord } from './worker-status.js'

type RefreshSource = Pick<WorkerRecord, 'id' | 'tag' | 'dir' | 'branch' | 'base' | 'carriedBase' | 'carriedUntracked' | 'link'>

export type RefreshOutcome =
  | { kind: 'refused'; reason: string }
  | { kind: 'current'; head: string; kept?: boolean; collectedUncommitted?: boolean }
  | { kind: 'rebased'; to: string; commits: string[]; base: string; carriedBase?: string; carriedUntracked?: WorkerRecord['carriedUntracked']; carryDropped: boolean; kept: boolean }

const MAX_LISTED = 10
const OPERATIONS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
const internalGit = (dir: string, args: string[]) => git(dir, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args])
const identity = ['-c', `user.name=${ROOM_CARRY_IDENTITY.authorName}`, '-c', `user.email=${ROOM_CARRY_IDENTITY.authorEmail}`, '-c', 'commit.gpgsign=false']
const lines = (out: string, sep = '\n') => out.split(sep).filter(Boolean)
const short = (sha: string) => sha.slice(0, 10)
const isAncestor = (dir: string, a: string, b: string) => git(dir, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false)

/** Keep Git's conflict paths even on exit 1; every other failure leaves containment unproven. */
async function containmentDetails(dir: string, deltaBase: string, target: string, delivered: string) {
  const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', 'merge-tree', '--write-tree', '--merge-base', deltaBase,
    '--name-only', '--no-messages', '-z', target, delivered]
  const done = observeGit(args)
  try {
    return await new Promise<{ tree: string; revised: string[] }>((resolve, reject) => {
      execFile('git', args, { cwd: dir, timeout: timeoutMs(), maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        if (error && (error as { code?: unknown }).code !== 1) { reject(error); return }
        const [tree, ...revised] = stdout.split('\0').filter(Boolean)
        if (!/^[0-9a-f]{40,64}$/.test(tree ?? '')) { reject(new Error('no containment tree')); return }
        resolve({ tree, revised })
      })
    })
  } finally { done() }
}

/** Replay post-keep commits on the private delivered tree before rebasing. Kept bytes were
 * often uncommitted in the original branch, so replaying its old full snapshot would deliver
 * them twice. Each commit changes only the paths it actually changed since the kept HEAD. */
async function keptHistory(w: RefreshSource, base: string, parent: string, from: string, workingTree: string, marker: string): Promise<{ tip: string; snapshot: boolean }> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'room-refresh-index-'))
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: path.join(temp, 'index') }
  const run = async (args: string[], override = env) => (await boundedGit(w.dir, ['-c', 'core.hooksPath=/dev/null', ...identity, ...args], undefined, override)).toString().trim()
  try {
    await run(['read-tree', base])
    let tip = base, previous = parent
    for (const commit of lines(await git(w.dir, ['rev-list', '--reverse', `${parent}..${from}`]))) {
      const paths = lines(await git(w.dir, ['diff', '--name-only', '--no-renames', '-z', previous, commit]), '\0')
      // Read the exact tree entry, including symlink/executable modes; removals have mode zero.
      const entries: string[] = []
      for (const file of paths) {
        const treeEntry = async (sha: string) => (await boundedGit(w.dir, ['ls-tree', '-z', sha, '--', `:(literal)${file}`])).toString()
        let entry = await treeEntry(commit)
        const old = await treeEntry(previous), kept = await treeEntry(tip)
        const blob = (value: string) => /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(value)?.[1]
        const before = blob(old), ours = blob(kept), theirs = blob(entry)
        if (before && ours && theirs && before !== ours && ours !== theirs) {
          // Partial staging can omit delivered hunks that were uncommitted at keep.
          // Carry those hunks forward, taking this commit for genuinely overlapping edits.
          const files = ['ours', 'base', 'theirs'].map(name => path.join(temp, name))
          for (const [index, sha] of [ours, before, theirs].entries()) fs.writeFileSync(files[index], await boundedGit(w.dir, ['cat-file', 'blob', sha]))
          const binary = files.some(file => fs.readFileSync(file).includes(0))
          if (!binary) {
            const merged = await boundedGit(w.dir, ['merge-file', '--theirs', '-p', ...files])
            fs.writeFileSync(files[0], merged)
            const sha = (await git(w.dir, ['hash-object', '-w', '--', files[0]])).trim()
            entry = entry.replace(` blob ${theirs}\t`, ` blob ${sha}\t`)
          }
        }
        entries.push(entry ? entry.replace(/^([0-7]+) (?:blob|commit) /, '$1 ') : `0 ${'0'.repeat(base.length)}\t${file}\0`)
      }
      const info = path.join(temp, 'entries')
      fs.writeFileSync(info, entries.join(''), { mode: 0o600 })
      boundedGitSync(w.dir, ['update-index', '-z', '--index-info'], { env, stdinFile: info })
      const tree = await run(['write-tree'])
      const [name, email, date] = (await git(w.dir, ['log', '-1', '--format=%an%x00%ae%x00%aI', commit])).trim().split('\0')
      const message = path.join(temp, 'message')
      fs.writeFileSync(message, await git(w.dir, ['log', '-1', '--format=%B', commit]), { mode: 0o600 })
      tip = await run(['commit-tree', tree, '-p', tip, '-F', message], { ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date })
      previous = commit
    }
    const committedTree = (await git(w.dir, ['rev-parse', `${tip}^{tree}`])).trim()
    const snapshot = workingTree !== committedTree
    if (snapshot) tip = await run(['commit-tree', workingTree, '-p', tip, '-m', marker])
    return { tip, snapshot }
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

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
  const base = w.base!
  let keptParent: string | undefined
  try {
    if ((await git(leadDir, ['rev-parse', '--verify', collectHeadRef(w.tag, w.id)])).trim() === base &&
      (await git(w.dir, ['log', '-1', '--format=%s', base])).trim() === 'room: kept collection baseline') {
      const parent = (await git(w.dir, ['rev-parse', `${base}^`])).trim()
      if (await isAncestor(w.dir, parent, from)) keptParent = parent
    }
  } catch { /* ordinary stopped worker */ }
  // A keep's delta base covers only that round. The snapshot's parent is the real
  // worker HEAD, so its shared ancestor with target predates every net delivered
  // edit not already shared by both histories (including pre-keep worker commits
  // and carried WIP). Require one ancestor rather than choose arbitrarily
  // between criss-cross merge bases.
  const cumulativeBase = async () => {
    const bases = lines(await git(w.dir, ['merge-base', '--all', target, keptParent!]))
    if (bases.length !== 1) throw new Error('no unique shared ancestor')
    return bases[0]
  }
  // A no-op resume cannot drop delivered work: retain S1 and its collection ref.
  if (await isAncestor(w.dir, target, from)) {
    let collectedUncommitted: boolean | undefined
    if (keptParent) {
      try {
        const deltaBase = await cumulativeBase()
        const targetTree = (await git(w.dir, ['rev-parse', `${target}^{tree}`])).trim()
        const merged = await internalGit(w.dir, ['merge-tree', '--write-tree', '--merge-base', deltaBase, target, base])
        collectedUncommitted = merged.trim() !== targetTree
      } catch { /* no-op remains safe when containment cannot be verified */ }
    }
    return { kind: 'current', head: target, kept: !!keptParent, collectedUncommitted }
  }
  if (keptParent) {
    let deltaBase: string
    try { deltaBase = await cumulativeBase() }
    catch { return refuse('cannot verify a unique cumulative snapshot base; send without refresh') }
    const targetTree = (await git(w.dir, ['rev-parse', `${target}^{tree}`])).trim()
    const merged = await internalGit(w.dir, ['merge-tree', '--write-tree', '--merge-base', deltaBase, target, base]).catch(() => '')
    if (merged.trim() !== targetTree) {
      // Only exact containment permits a rebase. Conflicts may mix revised delivery
      // with other uncommitted delivered hunks, so never accept them heuristically.
      const delivered = lines(await git(w.dir, ['diff', '--name-only', '--no-renames', '-z', deltaBase, base]), '\0')
      const listed = (paths: string[]) => `${paths.slice(0, MAX_LISTED).join(', ')}${paths.length > MAX_LISTED ? ` and ${paths.length - MAX_LISTED} more` : ''}`
      try {
        let details = await containmentDetails(w.dir, deltaBase, target, base)
        if (details.revised.length) {
          // Git can conflict when HEAD contains an earlier replacement and the
          // latest round extends it. Refine diagnostics only after proving that
          // the entire earlier snapshot is contained; this never permits a rebase.
          try {
            const previous = (await git(leadDir, ['rev-parse', '--verify', collectBaseRef(w.tag, w.id)])).trim()
            if (previous !== deltaBase && (await internalGit(w.dir,
              ['merge-tree', '--write-tree', '--merge-base', deltaBase, target, previous])).trim() === targetTree) {
              details = await containmentDetails(w.dir, previous, target, base)
            }
          } catch { /* retain the cumulative conflict diagnostics */ }
        }
        const revised = details.revised.filter(file => delivered.includes(file))
        const different = new Set(lines(await git(w.dir, ['diff', '--name-only', '--no-renames', '-z', target, details.tree]), '\0'))
        const uncontained = delivered.filter(file => different.has(file) && !revised.includes(file))
        return refuse(`snapshot changes not contained in your HEAD${uncontained.length ? `: ${listed(uncontained)}` : ''}${revised.length ? `; your HEAD revises snapshot lines in ${listed(revised)}` : ''}${!uncontained.length && !revised.length ? `; cannot prove containment of snapshot paths: ${listed(delivered)}` : ''}; send without refresh`)
      } catch {
        return refuse(`cannot verify containment of snapshot changes in your HEAD: ${listed(delivered)}; send without refresh`)
      }
    }
  }
  if (!keptParent && !await isAncestor(w.dir, base, from)) return refuse(`${w.branch} no longer contains its recorded base ${short(base)}`)
  const carried = !!w.carriedBase && w.carriedBase === base
  const start = keptParent ?? (carried ? (await git(w.dir, ['rev-parse', `${base}^`])).trim() : base)
  // A rebase replays only non-merge commits: edits made in a merge commit would vanish.
  const merges = lines(await git(w.dir, ['rev-list', '--merges', `${start}..${from}`]))
  if (merges.length) return refuse(`${w.branch} has ${merges.length === 1 ? 'a merge commit' : `${merges.length} merge commits`} (${merges.slice(0, 3).map(short).join(', ')}), which a rebase would drop; merge your HEAD in the worker yourself, or respawn it`)

  // A checkout overwrites an ignored file without a word, and an abort cannot bring it back.
  const ignored = lines(await git(w.dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']), '\0')
  if (ignored.length) {
    // Overlap either way: a commit path at or under an ignored entry, or an ignored entry under a commit path.
    // Compared case- and normalization-folded everywhere: on macOS and Windows build.log and BUILD.log are one file.
    const fold = (p: string) => p.normalize('NFC').toLowerCase()
    const entries = ignored.map(p => fold(p.replace(/\/+$/, '')))
    const covered = new Set(entries)
    const holdsIgnored = new Set(entries.flatMap(p => p.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))
    // Every path the rebase can write: all your HEAD tracks (the worker may have untracked a file, staged, or
    // replaced it with a folder, unstaged) and all its replayed commits touch, even ones added and later removed.
    // The snapshot itself never holds an ignored path.
    const written = new Set([
      ...lines(await git(w.dir, ['ls-tree', '-r', '-z', '--name-only', target]), '\0'),
      ...lines(await git(w.dir, ['log', '--format=', '--name-only', '--no-renames', '-z', `${start}..${from}`]), '\0'), // NUL-terminated names, no framing: never trim a path
    ])
    const clobbered = [...written].filter(name => {
      const p = fold(name)
      return covered.has(p) || holdsIgnored.has(p) || p.split('/').slice(0, -1).some((_, i, parts) => covered.has(parts.slice(0, i + 1).join('/')))
    })
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
    if (keptParent) {
      const workingTree = (await git(w.dir, ['write-tree'])).trim()
      const history = await keptHistory(w, base, keptParent, from, workingTree, marker)
      snapshot = history.snapshot
      await internalGit(w.dir, ['reset', '-q', '--soft', history.tip])
    } else {
      snapshot = lines(await git(w.dir, ['diff', '--cached', '--name-only', '-z']), '\0').length > 0
      if (snapshot) await internalGit(w.dir, [...identity, 'commit', '-q', '--no-verify', '-m', marker])
    }
  } catch (error) {
    await restore()
    return refuse(`could not snapshot its uncommitted edits: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }

  let ident: string[] = []
  try { await git(w.dir, ['var', 'GIT_COMMITTER_IDENT']) } catch { ident = identity }
  try {
    await internalGit(w.dir, [...ident, 'rebase', '-q', '--no-autostash', '--empty=drop', '--onto', target, keptParent ? base : start])
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
  return { kind: 'rebased', to: target, commits, base: newBase, carriedBase, carriedUntracked, carryDropped: carried && !carriedBase, kept: !!keptParent }
}

/** The commits that came in, for the lead's reply and the worker's note. */
export function refreshedCommits(commits: string[]): string {
  const listed = commits.slice(0, MAX_LISTED).join('; ')
  return `${commits.length} commit${commits.length === 1 ? '' : 's'} came in${listed ? `: ${listed}` : ''}${commits.length > MAX_LISTED ? `; +${commits.length - MAX_LISTED} more` : ''}`
}
