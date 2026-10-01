/** Worker worktrees, carry snapshots, links, and cleanup. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isRegenerableBuildPath } from '@room/shared'
import type { LocalWorker } from './worker-status.js'
import { LINK_INPUT_PATH, RECORDED_PATH, containedRepoPath, isInsideRoot, realGitCommonDir, validRepoPath } from '@room/roomd'
import { git, UNKNOWN_WHOLE_TREE_PATHS } from '@room/roomd/git'
import { boundedGit, boundedGitSync, carriedContentHashes, carriedUnchangedPaths, workerBaseline } from '@room/roomd/baseline'
import { decideDiscard, roomWorkerPathMatchesBranch, workerRealState, ROOM_CARRY_IDENTITY, type WorktreeOwnershipRecord } from './worker-state.js'
import { terminateWorktreeProcesses } from './worker-process.js'
import { linkWorkspaceDeps } from './worker-deps.js'
import type { PrepJournal, PrepStep } from './worker-status.js'

const WORKERS_DIR = path.join('.room', 'workers')

/** Inputs Room installed itself, rather than worker output. */
export function workerOwnedPaths(w?: { link?: readonly string[] }) {
  const paths = w?.link ?? []
  return {
    includes: (p: string) => paths.some(l => p === l || p.startsWith(l + '/')),
    exclusions: paths.map(l => ':(exclude,literal)' + l),
  }
}

/** Ignored output that a discard patch cannot recover. */
export async function ignoredWorkerArtifacts(w: LocalWorker): Promise<string[]> {
  const raw = await git(w.dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', '.', ...workerOwnedPaths(w).exclusions])
  return raw.split('\0').filter(Boolean)
    .filter(p => p !== '.room' && p !== '.room/' && !p.startsWith('.room/'))
    .filter(p => !isRegenerableBuildPath(p))
    .sort()
}

export type WorkerCleanupPreservation = {
  ignored: string[]; uncollected: string[]
  commitsAfterCollection?: { sha: string; paths: string[] }
  recoveryRef?: string
}

export const collectHeadRef = (tag: string, id: string) => `refs/room/collect-head/${tag}/${id}`
export const collectBaseRef = (tag: string, id: string) => `refs/room/collect-base/${tag}/${id}`

/** Compare checkout output against the lead, including commits after collection's captured HEAD. */
async function uncollectedWorkerPaths(leadDir: string, w: LocalWorker, capturedHead?: string): Promise<string[]> {
  const exclusions = workerOwnedPaths(w).exclusions
  const [changed, untracked, committed] = await Promise.all([
    git(w.dir, ['diff', '--name-only', '-z', 'HEAD', '--', '.', ...exclusions]),
    git(w.dir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...exclusions]),
    capturedHead ? git(w.dir, ['diff', '--name-only', '-z', capturedHead, 'HEAD', '--', '.', ...exclusions]) : '',
  ])
  const paths = [...new Set((changed + untracked + committed).split('\0').filter(Boolean))]
  const same = async (rel: string): Promise<boolean> => {
    const left = path.join(w.dir, rel), right = path.join(leadDir, rel)
    const stat = (file: string) => { try { return fs.lstatSync(file) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e } }
    const a = stat(left), b = stat(right)
    if (!a || !b) return !a && !b
    if (a.isSymbolicLink() || b.isSymbolicLink()) return a.isSymbolicLink() && b.isSymbolicLink() && fs.readlinkSync(left) === fs.readlinkSync(right)
    if (!a.isFile() || !b.isFile() || a.size !== b.size || (a.mode & 0o111) !== (b.mode & 0o111)) return false
    const x = await fs.promises.open(left, 'r'), y = await fs.promises.open(right, 'r')
    try {
      const one = Buffer.alloc(64 * 1024), two = Buffer.alloc(one.length)
      for (let offset = 0; offset < a.size; offset += one.length) {
        const length = Math.min(one.length, a.size - offset)
        const [first, second] = await Promise.all([x.read(one, 0, length, offset), y.read(two, 0, length, offset)])
        if (first.bytesRead !== length || second.bytesRead !== length || !one.subarray(0, length).equals(two.subarray(0, length))) return false
      }
      return true
    } finally { await Promise.all([x.close(), y.close()]) }
  }
  const remaining: string[] = []
  for (const rel of paths) if (!await same(rel)) remaining.push(rel)
  return remaining.sort()
}

/** Prune a vanished Room checkout, preserving any branch commits absent from the lead HEAD. */
export async function pruneMissingWorkerWorktree(leadDir: string, w: LocalWorker, manageBranch = true): Promise<string | undefined> {
  if (!roomWorkerPathMatchesBranch(leadDir, w.dir, w.branch, true)) {
    throw new Error(`worker ${w.dir} is not an owned Room worktree`)
  }
  try { fs.lstatSync(w.dir); throw new Error(`worktree ${w.dir} still exists`) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  // Dynamic import avoids a module-initialization cycle: preview tools read workerOwnedPaths from here.
  const { removePreviewCache } = await import('./tools/files.js')
  await removePreviewCache(w.dir, leadDir)
  await git(leadDir, ['worktree', 'prune'])
  if (!manageBranch) return undefined
  const state = await workerRealState(leadDir, w, { branch: true })
  if (state.branch === 'absent') return `branch ${w.branch} was already absent`
  const count = state.branchAhead!
  if (count) return `branch ${w.branch} kept: it has ${count} commit${count === 1 ? '' : 's'} not in your HEAD`
  await git(leadDir, ['branch', '-D', w.branch])
  return `branch ${w.branch} deleted (it has no commits of its own beyond your HEAD)`
}

/** Porcelain entries missing from a fresh worktree; Room's own directory is excluded. */
export async function uncommittedCount(dir: string): Promise<number> {
  const out = await git(dir, ['status', '--porcelain', '--untracked-files=normal'])
  return out.split('\n').filter(line => line.trim() && !/^..\s+"?\.room\//.test(line)).length
}

/** Resolve link paths before creating a worker worktree, so carry can exclude them. */
export function resolveWorkerLinks(repoDir: string, requested?: unknown): string[] {
  let input = requested
  if (input === undefined) {
    try { input = fs.readFileSync(path.join(repoDir, '.roomlinks'), 'utf8').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; input = [] }
  }
  if (!Array.isArray(input) || input.some(p => typeof p !== 'string')) throw new Error('link must be an array of repo-relative paths')
  if (!input.length) return []
  const root = fs.realpathSync(repoDir)
  const paths = (input as string[]).map(raw => {
    const p = raw.trim()
    if (!validRepoPath(p, LINK_INPUT_PATH)) throw new Error(`invalid link path: ${raw}`)
    const source = fs.realpathSync(path.join(root, p))
    if (!isInsideRoot(root, source)) throw new Error(`link source escapes repo: ${p}`)
    const stat = fs.statSync(source)
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`link source must be a file or directory: ${p}`)
    return p
  })
  for (const [i, a] of paths.entries()) for (const b of paths.slice(i + 1)) {
    if (a === b || b.startsWith(a + '/') || a.startsWith(b + '/')) throw new Error(`overlapping link paths: ${a}, ${b}`)
  }
  return paths
}

/** Validate destinations, then install links without modifying any pre-existing worker path. */
export function prepareWorkerLinks(repoDir: string, workerDir: string, requested?: unknown): string[] {
  const input = resolveWorkerLinks(repoDir, requested)
  if (!input.length) return []
  const root = fs.realpathSync(repoDir), destRoot = fs.realpathSync(workerDir)
  const links = input.map(p => {
    const source = fs.realpathSync(path.join(root, p))
    if (!isInsideRoot(root, source)) throw new Error(`link source escapes repo: ${p}`)
    const stat = fs.statSync(source)
    const target = path.join(destRoot, p)
    for (let at = target; at !== destRoot; at = path.dirname(at)) {
      let entry
      try { entry = fs.lstatSync(at) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (entry && (at === target || entry.isSymbolicLink() || !entry.isDirectory())) throw new Error(`link destination already present or traverses a non-directory: ${p}`)
    }
    return { p, source, target, directory: stat.isDirectory() }
  })
  const made: string[] = []
  try {
    for (const link of links) {
      fs.mkdirSync(path.dirname(link.target), { recursive: true })
      fs.symlinkSync(link.source, link.target, link.directory ? 'dir' : 'file')
      made.push(link.target)
    }
  } catch (e) { for (const target of made.reverse()) fs.unlinkSync(target); throw e }
  return links.map(l => l.p)
}

export interface PreparedWorktree {
  dir: string
  branch: string
  created: boolean
  /** The branch may predate a newly created checkout. */
  branchCreated?: boolean
  /** Ref values to restore if preparation is rolled back; absent refs were created here. */
  previousCarryRefs?: Record<string, string>
  base?: string
  carried?: { count: number; commit: string; paths: string[] }
  carriedBase?: string
  carriedUntracked?: { path: string; sha: string; mode?: number }[]
  skippedCarry?: { path: string; reason: string }[]
  carryFailed?: boolean
  carryError?: string
}

const carriedSubject = (leadName: string) => `${ROOM_CARRY_IDENTITY.subjectPrefix}${leadName}`

/** A worktree for the worker, created from the lead's HEAD on branch room/<tag>; reused if it already exists. */
const internalGit = (dir: string, args: string[]) => git(dir, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args])
const carryRef = (tag: string) => `refs/room/carry/${tag}`
const carriedUntrackedRef = (tag: string) => `refs/room/carry-untracked/${tag}`
const pathExcluded = (rel: string, exclusions: string[]) => exclusions.some(p => rel === p || rel.startsWith(p.replace(/\/$/, '') + '/'))
/** Stable, apply-compatible patch policy for both carry and discard. */
function patchArgs(base: string, exclusions: string[], staged = false): string[] {
  return ['diff', ...(staged ? ['--cached'] : []), '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', base, '--', '.', ...exclusions]
}
function retainUntrackedTree(dir: string, tag: string, paths: { path: string; sha: string }[]): string | undefined {
  if (!paths.length) return undefined
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'room-carry-index-'))
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') }
  const run = (args: string[], wholeTreePaths?: number, stdinFile?: string) => boundedGitSync(dir, ['-c', 'core.hooksPath=/dev/null', ...args], { env, wholeTreePaths, stdinFile }).toString().trim()
  try {
    const entries = paths.map(entry => {
      const stat = fs.lstatSync(path.join(dir, entry.path))
      const mode = stat.isSymbolicLink() ? '120000' : (stat.mode & 0o111) ? '100755' : '100644'
      return `${mode} blob ${entry.sha}\t${entry.path}\0`
    })
    // One process for every entry, read from a file rather than a pipe (see boundedGitSync).
    const info = path.join(scratch, 'index-info')
    fs.writeFileSync(info, entries.join(''), { mode: 0o600 })
    run(['update-index', '-z', '--index-info'], paths.length, info)
    const tree = run(['write-tree'], paths.length)
    run(['update-ref', carriedUntrackedRef(tag), tree])
    return tree
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}
/** Roll back only a newly prepared worktree; do not remove reused worker output. */
export async function cleanupPreparedWorktree(repoDir: string, prepared: PreparedWorktree): Promise<void> {
  if (!prepared.created) return
  await internalGit(repoDir, ['worktree', 'remove', '--force', prepared.dir])
  if (!prepared.branchCreated) return
  await internalGit(repoDir, ['branch', '-D', prepared.branch])
  for (const ref of [carryRef(prepared.branch.slice(5)), carriedUntrackedRef(prepared.branch.slice(5))]) {
    const previous = prepared.previousCarryRefs?.[ref]
    if (previous) await internalGit(repoDir, ['update-ref', ref, previous])
    else try { await internalGit(repoDir, ['update-ref', '-d', ref]) } catch { /* no ref was created */ }
  }
}

/** A worktree for the worker, with tracked WIP in its base and untracked bytes outside Git. */
export async function prepareWorktree(repoDir: string, tag: string, leadName = 'lead', linkExclusions?: string[],
  onStep?: (step: PrepStep, facts: Partial<PrepJournal>) => Promise<void>, retry = 0, carry = true): Promise<PreparedWorktree> {
  const dir = path.join(repoDir, WORKERS_DIR, tag)
  const branch = `room/${tag}`
  const gitDir = (await git(repoDir, ['rev-parse', '--absolute-git-dir'])).trim()
  if (['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].some(p => fs.existsSync(path.join(gitDir, p)))) throw new Error('finish the merge or rebase before spawning workers')
  if (fs.existsSync(path.join(dir, '.git'))) {
    throw new Error(`worktree ${tag} is unmanaged; discard it by tag first`)
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  // A worker directory may have been deleted without removing its worktree registration.
  // Prune before add so Git does not reject the same path as already registered.
  await internalGit(repoDir, ['worktree', 'prune'])
  let hasBranch = false
  try { await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); hasBranch = true } catch { /* new branch */ }
  if (hasBranch) throw new Error(`branch ${branch} is unmanaged; discard it by tag first`)
  const previousCarryRefs: Record<string, string> = {}
  if (!hasBranch) for (const ref of [carryRef(tag), carriedUntrackedRef(tag)]) {
    try { previousCarryRefs[ref] = (await git(repoDir, ['rev-parse', '--verify', ref])).trim() } catch { /* absent */ }
  }
  let base: string | undefined
  if (!hasBranch) {
    try { base = (await git(repoDir, ['rev-parse', '--verify', 'HEAD'])).trim() }
    catch { throw new Error('make a first commit before spawning workers') }
  }
  await onStep?.('plan', { worktreeExisted: false, branchExisted: false,
    previousCarryRefs: Object.fromEntries([carryRef(tag), carriedUntrackedRef(tag)].map(ref => [ref, previousCarryRefs[ref] ?? null])) })
  await onStep?.('worktree', { created: true, branchCreated: true })
  await internalGit(repoDir, ['worktree', 'add', '-q', '-b', branch, dir, base!])
  if (!base) return { dir, branch, created: true, branchCreated: false }
  if (!carry) {
    const result: PreparedWorktree = { dir, branch, created: true, branchCreated: true, previousCarryRefs, base }
    await onStep?.('prepared', { created: true, branchCreated: true })
    return result
  }
  try {
    const exclusions = [...linkExclusions ?? []]
    if (linkExclusions === undefined) {
      try { exclusions.push(...fs.readFileSync(path.join(repoDir, '.roomlinks'), 'utf8').split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean)) }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    const excluded = ['.room', ...exclusions].map(p => `:(exclude,literal)${p.replace(/\/$/, '')}`)
    const patch = await internalGit(repoDir, patchArgs(base, excluded))
    if (patch) {
      // Applied from a file, not stdin: a synchronous child fed a multi-megabyte patch can wait for EOF forever.
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'room-carry-patch-'))
      try {
        const file = path.join(scratch, 'carry.patch')
        fs.writeFileSync(file, patch, { mode: 0o600 })
        boundedGitSync(dir, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', 'apply', '--index', '--binary', file])
      } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
    }
    const untracked = (await git(repoDir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).room'])).split('\0').filter(Boolean)
    const carriedUntracked: { path: string; sha: string; mode?: number }[] = []
    const skippedCarry: { path: string; reason: string }[] = []
    let totalBytes = 0
    const carryRoot = fs.realpathSync(repoDir)
    const copied: { path: string; mode: number }[] = []
    for (const rel of untracked) {
      if (pathExcluded(rel, exclusions)) { skippedCarry.push({ path: rel, reason: 'linked input' }); continue }
      const source = path.join(repoDir, rel), target = path.join(dir, rel)
      const stat = fs.lstatSync(source)
      if (stat.isDirectory()) { skippedCarry.push({ path: rel, reason: 'nested repository or directory' }); continue }
      if (!stat.isFile() && !stat.isSymbolicLink()) { skippedCarry.push({ path: rel, reason: 'special file' }); continue }
      let containment: ReturnType<typeof containedRepoPath>
      try {
        containment = containedRepoPath(carryRoot, path.join(carryRoot, rel), { leaf: 'read-contained-link' })
      }
      catch { skippedCarry.push({ path: rel, reason: 'unresolvable path' }); continue }
      if (!containment.ok) { skippedCarry.push({ path: rel, reason: 'path leaves repository' }); continue }
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(source)
        if (path.isAbsolute(link)) { skippedCarry.push({ path: rel, reason: 'absolute link' }); continue }
      }
      if (stat.isFile() && (stat.size > 5 * 1024 * 1024 || totalBytes + stat.size > 50 * 1024 * 1024)) { skippedCarry.push({ path: rel, reason: 'size budget' }); continue }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target)
      else {
        await fs.promises.copyFile(source, target)
        fs.chmodSync(target, stat.mode)
        totalBytes += stat.size
      }
      copied.push({ path: rel, mode: stat.mode & 0o777 })
    }
    // One hash-object for every copied file: per-file processes made a large carry take seconds.
    const copiedShas = carriedContentHashes(dir, copied.map(c => c.path), true)
    copied.forEach((c, i) => carriedUntracked.push({ path: c.path, sha: copiedShas[i], mode: c.mode }))
    const snapshotStable = async () => {
      const latestPatch = await internalGit(repoDir, patchArgs(base, excluded))
      const latestUntracked = (await git(repoDir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).room'])).split('\0').filter(Boolean)
      let copiedStable: boolean
      try {
        const latest = carriedContentHashes(repoDir, carriedUntracked.map(c => c.path))
        copiedStable = carriedUntracked.every(({ sha }, i) => latest[i] === sha)
      } catch (error) { if (error instanceof Error && error.message.includes('timed out')) throw error; copiedStable = false }
      return (await git(repoDir, ['rev-parse', 'HEAD'])).trim() === base && latestPatch === patch && latestUntracked.join('\0') === untracked.join('\0') && copiedStable
    }
    if (!await snapshotStable()) throw new Error('lead changed during carry; retrying snapshot')
    const staged = (await internalGit(dir, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
    if (staged.length) {
      await onStep?.('carry-commit', {})
      await git(dir, ['-c', 'core.hooksPath=/dev/null', '-c', `user.name=${ROOM_CARRY_IDENTITY.authorName}`, '-c', `user.email=${ROOM_CARRY_IDENTITY.authorEmail}`, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', carriedSubject(leadName)])
    }
    const commit = (await git(dir, ['rev-parse', 'HEAD'])).trim()
    const paths = [...new Set([...staged, ...carriedUntracked.map(x => x.path)])].sort()
    if (paths.length) await onStep?.('carry-refs', {})
    if (paths.length) await internalGit(repoDir, ['update-ref', carryRef(tag), commit])
    retainUntrackedTree(repoDir, tag, carriedUntracked)
    if (!await snapshotStable()) throw new Error('lead changed during carry; retrying snapshot')
    const result: PreparedWorktree = { dir, branch, created: true, branchCreated: true, previousCarryRefs, base: commit, carriedBase: staged.length ? commit : undefined, carried: paths.length ? { count: paths.length, commit, paths } : undefined, carriedUntracked, skippedCarry }
    await onStep?.('prepared', { created: true, branchCreated: true })
    return result
  } catch (e) {
    if ((e as Error).message === 'lead changed during carry; retrying snapshot') {
      await cleanupPreparedWorktree(repoDir, { dir, branch, created: true, branchCreated: true, previousCarryRefs })
      if (retry >= 2) throw new Error('lead changed repeatedly during carry; try spawning again when HEAD is stable')
      return prepareWorktree(repoDir, tag, leadName, linkExclusions, onStep, retry + 1, carry)
    }
    try {
      await internalGit(dir, ['reset', '--hard', base])
      await internalGit(dir, ['clean', '-fdx'])
      for (const ref of [carryRef(tag), carriedUntrackedRef(tag)]) {
        if (previousCarryRefs[ref]) await internalGit(repoDir, ['update-ref', ref, previousCarryRefs[ref]])
        else try { await internalGit(repoDir, ['update-ref', '-d', ref]) } catch { /* ref was never written */ }
      }
    } catch {
      await cleanupPreparedWorktree(repoDir, { dir, branch, created: true, branchCreated: true, previousCarryRefs })
      await internalGit(repoDir, ['worktree', 'add', '-q', '-b', branch, dir, base])
    }
    return { dir, branch, created: true, branchCreated: true, previousCarryRefs, base, carryFailed: true, carryError: (e as Error).message }
  }
}

/** Remove only owned Room worktrees; failures require explicit discard. */
export async function cleanupWorker(leadDir: string, w: LocalWorker, collected = false, discarded = false, terminatedProcesses: string[] = [], processOptions: Parameters<typeof terminateWorktreeProcesses>[1] = {}, leadName?: string, workers: Iterable<WorktreeOwnershipRecord> = [], preservation?: WorkerCleanupPreservation): Promise<boolean> {
  // All lifecycle paths converge here. The owner operation lease must be held by
  // callers while checking this snapshot and removing the checkout.
  const available = async () => {
    if (!w.id) return true // Legacy direct callers have no registry capability.
    const { registryForDir } = await import('./worker-registry.js')
    const registry = await registryForDir(leadDir)
    const record = registry.read(w.id)
    if (!record) return w.branch === `room/${w.tag}` && registry.list().every(peer =>
      path.resolve(peer.dir) !== path.resolve(w.dir) || peer.tag === w.tag)
    return !record.sharedWith && !registry.worktreeOwner(record)
      && registry.checkoutUsers(record).length === 0
  }
  if (!await available()) return false
  if (!discarded && (w.status === 'failed' || w.exitCode !== 0)) return false
  if (decideDiscard(await workerRealState(leadDir, w, { ownership: true, leadName, workers })) !== 'cleanup') return false
  const nested = (await git(leadDir, ['worktree', 'list', '--porcelain'])).split('\n')
    .filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
    .filter(dir => dir !== w.dir && isInsideRoot(fs.realpathSync(w.dir), dir))
  if (nested.length) throw new Error(`nested worker worktrees still present under ${w.tag}: ${nested.join(', ')}`)
  const head = (await git(w.dir, ['rev-parse', 'HEAD'])).trim()
  const refs = new Map<string, string>()
  for (const ref of [carryRef(w.tag), carriedUntrackedRef(w.tag)]) {
    try { refs.set(ref, (await git(leadDir, ['rev-parse', '--verify', ref])).trim()) } catch { /* absent on older workers */ }
  }
  if (!await available()) return false
  terminatedProcesses.push(...await terminateWorktreeProcesses(w.dir, processOptions))
  try {
    // Remove the worker's reusable preview checkout while its own worktree still exists.
    const { removePreviewCache } = await import('./tools/files.js')
    await removePreviewCache(w.dir, leadDir)
    if (!await available()) return false
    // A shared checkout kept after its owner was collected can gain work later (a borrower, or anything
    // writing there); ordinary collection already applied the worker's final tree under its operation lease.
    let retainedOwner = false
    if (!discarded && w.id) {
      const { registryForDir } = await import('./worker-registry.js')
      const owner = (await registryForDir(leadDir)).read(w.id)
      retainedOwner = owner?.phase === 'retired' && !!owner.keptWorktree && !!owner.archive?.keptReason?.startsWith('shared checkout: ')
    }
    if (retainedOwner) {
      let capturedHead: string | undefined
      try { capturedHead = (await git(leadDir, ['rev-parse', '--verify', collectHeadRef(w.tag, w.id)])).trim() } catch { /* legacy collection */ }
      const currentHead = (await git(w.dir, ['rev-parse', 'HEAD'])).trim()
      const [ignored, uncollected] = await Promise.all([ignoredWorkerArtifacts(w), uncollectedWorkerPaths(leadDir, w, capturedHead)])
      const committedPaths = capturedHead && capturedHead !== currentHead
        ? (await git(w.dir, ['diff', '--name-only', '-z', capturedHead, currentHead, '--', '.', ...workerOwnedPaths(w).exclusions])).split('\0').filter(Boolean).sort()
        : undefined
      if (preservation) {
        preservation.ignored = ignored; preservation.uncollected = uncollected
        if (committedPaths) preservation.commitsAfterCollection = { sha: currentHead.slice(0, 12), paths: committedPaths }
      }
      if (ignored.length || uncollected.length || committedPaths) return false
    }
    if (!await available()) return false
    // Deleting a branch must not strand a commit absent from the lead's history.
    // Discard already has a patch, but a named Git ref also preserves the exact tip.
    const tip = (await git(w.dir, ['rev-parse', 'HEAD'])).trim()
    if (tip !== head && !discarded) {
      if (preservation) preservation.commitsAfterCollection = {
        sha: tip.slice(0, 12),
        paths: (await git(w.dir, ['diff', '--name-only', '-z', head, tip, '--', '.', ...workerOwnedPaths(w).exclusions])).split('\0').filter(Boolean).sort(),
      }
      return false
    }
    // Only the worker's own commits need a handle: a tip that is the lead's carry commit or the base is the lead's.
    const ownCommits = tip !== refs.get(carryRef(w.tag)) && tip !== w.base
    let reachable = true
    if (ownCommits) try { await git(leadDir, ['merge-base', '--is-ancestor', tip, 'HEAD']) } catch { reachable = false }
    if (!reachable) {
      const ref = `refs/room/recovery/${w.tag}/${tip}`
      await internalGit(leadDir, ['update-ref', ref, tip])
      if (preservation) preservation.recoveryRef = ref
      else console.info(`worker ${w.tag} branch recovery ref: ${ref}`)
    }
    await internalGit(leadDir, ['worktree', 'remove', ...(collected ? ['--force'] : []), w.dir])
    await internalGit(leadDir, ['branch', '-D', w.branch])
    for (const ref of refs.keys()) await internalGit(leadDir, ['update-ref', '-d', ref])
    for (const ref of [collectHeadRef(w.tag, w.id), collectBaseRef(w.tag, w.id)]) {
      try { await internalGit(leadDir, ['update-ref', '-d', ref]) } catch { /* legacy collection */ }
    }
  } catch (error) {
    const recovery = w.id ? path.join(await realGitCommonDir(leadDir), 'room', 'registry', 'patches', `${w.id}.patch`) : undefined
    const recoveryNote = recovery && fs.existsSync(recovery) ? `actual worker edits are in ${recovery}` : `collected edits are in ${leadDir}`
    try {
      let branchExists = true
      try { await git(leadDir, ['rev-parse', '--verify', `refs/heads/${w.branch}`]) } catch { branchExists = false }
      if (!branchExists) await internalGit(leadDir, ['branch', w.branch, head])
      if (!fs.existsSync(path.join(w.dir, '.git'))) {
        await internalGit(leadDir, ['worktree', 'add', '-q', w.dir, w.branch])
        await linkWorkspaceDeps(leadDir, w.dir)
      }
      for (const [ref, sha] of refs) await internalGit(leadDir, ['update-ref', ref, sha])
      for (const entry of w.carriedUntracked ?? []) {
        if (!validRepoPath(entry.path, RECORDED_PATH)) continue
        const file = path.join(w.dir, entry.path)
        if (fs.existsSync(file)) continue
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const mode = (await git(leadDir, ['ls-tree', carriedUntrackedRef(w.tag), '--', entry.path])).split(' ')[0]
        if (mode === '120000') fs.symlinkSync(boundedGitSync(leadDir, ['cat-file', 'blob', entry.sha]).toString(), file)
        else {
          const bytes = boundedGitSync(leadDir, ['cat-file', '--filters', '--path=' + entry.path, entry.sha])
          fs.writeFileSync(file, bytes, { mode: entry.mode ?? 0o644 })
          fs.chmodSync(file, entry.mode ?? 0o644)
        }
      }
    } catch (restore) { throw new Error(`cleanup failed: ${(error as Error).message}; could not restore ${w.dir}: ${(restore as Error).message}; ${recoveryNote}`) }
    throw new Error(`cleanup failed: ${(error as Error).message}; reconstructed base at ${w.dir}; ${recoveryNote}`)
  }
  cleanupWorkerLogs(leadDir, w)
  return true
}

/** Remove a worker's local logs after either checkout cleanup or vanished-checkout pruning. */
export function cleanupWorkerLogs(leadDir: string, w: Pick<LocalWorker, 'dir' | 'tag'>): void {
  const parent = path.basename(path.dirname(w.dir)) === 'workers' && path.basename(path.dirname(path.dirname(w.dir))) === '.room'
    ? path.resolve(w.dir, '../../..') : leadDir
  for (const suffix of ['.log', '.mcp.log', '.env.sh']) {
    try { fs.rmSync(path.join(parent, WORKERS_DIR, w.tag + suffix), { force: true }) } catch { /* keep the log if the OS locks it */ }
  }
  for (const dir of [path.join(parent, WORKERS_DIR), path.join(parent, '.room')]) {
    try { fs.rmdirSync(dir) } catch { /* another worker or a locked log keeps the directory */ }
  }
}

/** One binary-capable snapshot against the fork, without modifying the worker's index. */
export async function saveDiscardPatch(leadDir: string, w: LocalWorker,
  publish: (bytes: Buffer) => Promise<string>): Promise<string | undefined> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'room-discard-'))
  try {
    const run = (args: string[], wholeTreePaths?: number) => boundedGit(w.dir, args, wholeTreePaths, { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') })
    const base = w.base ?? (await git(leadDir, ['merge-base', 'HEAD', w.branch])).trim()
    await run(['read-tree', 'HEAD'], UNKNOWN_WHOLE_TREE_PATHS)
    const unchanged = carriedUnchangedPaths(workerBaseline(w))
    const exclusions = [...workerOwnedPaths(w).exclusions, ...[...unchanged].map(p => ':(exclude,literal)' + p)]
    // Exclusions apply to the diff only: `git add` refuses any pathspec naming an ignored path, even an
    // exclude, and a carried or linked path may lie under a directory the worker's .gitignore ignores.
    await run(['add', '-A', '--', '.'], UNKNOWN_WHOLE_TREE_PATHS)
    const patch = await run(patchArgs(base, exclusions, true), UNKNOWN_WHOLE_TREE_PATHS)
    if (!patch.length) return undefined
    // The recovery artifact is useful only if it applies to a fresh checkout of this base.
    const verifyDir = path.join(scratch, 'verify')
    const verifyPatch = path.join(scratch, 'verify.patch')
    fs.writeFileSync(verifyPatch, patch, { mode: 0o600 })
    await internalGit(leadDir, ['worktree', 'add', '-q', '--detach', verifyDir, base])
    try { boundedGitSync(verifyDir, ['apply', '--binary', verifyPatch]) }
    finally { await internalGit(leadDir, ['worktree', 'remove', '--force', verifyDir]) }
    return publish(patch)
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}
