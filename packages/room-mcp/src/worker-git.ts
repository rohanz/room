/** Worker worktrees, carry snapshots, links, and cleanup. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isRegenerableBuildPath, type Worker } from '@room/shared'
import { LINK_INPUT_PATH, RECORDED_PATH, carryRecord, carryRecordSync, containedRepoPath, isInsideRoot, realGitCommonDir, validRepoPath } from '@room/roomd'
import { git, UNKNOWN_WHOLE_TREE_PATHS } from '@room/roomd/git'
import { boundedGitSync, carriedContentHash, carriedUnchangedPaths, workerBaseline } from '@room/roomd/baseline'
import { decideDiscard, roomWorkerPathMatchesBranch, workerRealState, ROOM_CARRY_IDENTITY, type WorktreeOwnershipRecord } from './worker-state.js'
import { terminateWorktreeProcesses } from './worker-process.js'

const WORKERS_DIR = path.join('.room', 'workers')

/** Inputs Room installed itself, rather than worker output. */
export function workerOwnedPaths(w?: Pick<Worker, 'link'>) {
  const paths = w?.link ?? []
  return {
    includes: (p: string) => paths.some(l => p === l || p.startsWith(l + '/')),
    exclusions: paths.map(l => ':(exclude,literal)' + l),
  }
}

/** Ignored output that a discard patch cannot recover. */
export async function ignoredWorkerArtifacts(w: Worker): Promise<string[]> {
  const raw = await git(w.dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', '.', ...workerOwnedPaths(w).exclusions])
  return raw.split('\0').filter(Boolean)
    .filter(p => p !== '.room' && p !== '.room/' && !p.startsWith('.room/'))
    .filter(p => !isRegenerableBuildPath(p))
    .sort()
}

/** One worktree cannot be collected, discarded and auto-retired at the same time. */
export function workerOperationKey(w: Pick<Worker, 'dir'>): string { return 'worker:' + path.resolve(w.dir) }

/** Prune a vanished Room checkout, preserving any branch commits absent from the lead HEAD. */
export async function pruneMissingWorkerWorktree(leadDir: string, w: Worker, manageBranch = true): Promise<string | undefined> {
  if (!roomWorkerPathMatchesBranch(leadDir, w.dir, w.branch, true)) {
    throw new Error(`worker ${w.dir} is not an owned Room worktree`)
  }
  try { fs.lstatSync(w.dir); throw new Error(`worktree ${w.dir} still exists`) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
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
  const run = (args: string[], wholeTreePaths?: number) => boundedGitSync(dir, ['-c', 'core.hooksPath=/dev/null', ...args], { env, wholeTreePaths }).toString().trim()
  try {
    for (const entry of paths) {
      const stat = fs.lstatSync(path.join(dir, entry.path))
      const mode = stat.isSymbolicLink() ? '120000' : (stat.mode & 0o111) ? '100755' : '100644'
      run(['update-index', '--add', '--cacheinfo', `${mode},${entry.sha},${entry.path}`])
    }
    const tree = run(['write-tree'], paths.length)
    run(['update-ref', carriedUntrackedRef(tag), tree])
    return tree
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}
type CarryRecord = Pick<PreparedWorktree, 'base' | 'carriedBase' | 'carried' | 'carriedUntracked' | 'skippedCarry'> & { ownerId?: string }

/** The relay can disappear with the lead; keep the intentional stop reason beside the carry record. */
export function persistWorkerStopReason(repoDir: string, tag: string, reason: Worker['stopReason'], workerId?: string): void {
  const recordFile = carryRecordSync(repoDir, tag)
  const record = recordFile.read<CarryRecord & { stopReason?: Worker['stopReason'] }>() ?? {}
  recordFile.write({ ...record, stopReason: reason, stopWorkerId: workerId })
}

export function persistedWorkerStopReason(repoDir: string, tag: string, workerId?: string): Worker['stopReason'] | undefined {
  const record = carryRecordSync(repoDir, tag).read<{ stopReason?: Worker['stopReason']; stopWorkerId?: string }>()
  if (record === undefined || (workerId && record.stopWorkerId && record.stopWorkerId !== workerId)) return undefined
  return record.stopReason === 'lead-session-ended' || record.stopReason === 'message-delivered-cancelled' || record.stopReason === 'message-delivered-failed' ? record.stopReason : undefined
}

/** Clear only the stop state for this process generation after resume has started successfully. */
export function clearWorkerStopState(repoDir: string, tag: string, workerId?: string): void {
  const recordFile = carryRecordSync(repoDir, tag)
  const record = recordFile.read<CarryRecord & { stopReason?: Worker['stopReason']; stopWorkerId?: string }>()
  if (record === undefined) return
  if (workerId && record.stopWorkerId && record.stopWorkerId !== workerId) return
  delete record.stopReason
  delete record.stopWorkerId
  recordFile.write(record)
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
  await fs.promises.rm((await carryRecord(repoDir, prepared.branch.slice(5))).file, { force: true })
}

/** A worktree for the worker, with tracked WIP in its base and untracked bytes outside Git. */
export async function prepareWorktree(repoDir: string, tag: string, leadName = 'lead', linkExclusions?: string[], ownerId?: string, retry = 0, carry = true): Promise<PreparedWorktree> {
  const dir = path.join(repoDir, WORKERS_DIR, tag)
  const branch = `room/${tag}`
  const gitDir = (await git(repoDir, ['rev-parse', '--absolute-git-dir'])).trim()
  if (['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].some(p => fs.existsSync(path.join(gitDir, p)))) throw new Error('finish the merge or rebase before spawning workers')
  const record = await (await carryRecord(repoDir, tag)).read<CarryRecord>()
  if (record?.ownerId && ownerId && record.ownerId !== ownerId) throw new Error(`worktree ${tag} is owned by another room or worker`)
  if (fs.existsSync(path.join(dir, '.git'))) {
    if (!carry) throw new Error(`worktree ${tag} already exists; choose a new tag for carry=false`)
    if (ownerId && !record?.ownerId) throw new Error(`worktree ${tag} has unknown ownership; choose another tag`)
    const actualBranch = (await git(dir, ['branch', '--show-current'])).trim()
    if (actualBranch !== branch) throw new Error(`worktree ${tag} is on branch ${actualBranch || '(detached)'}, expected ${branch}; choose another tag`)
    if (await realGitCommonDir(repoDir) !== await realGitCommonDir(dir)) throw new Error(`worktree ${tag} is not a worktree of this repository; choose another tag`)
    return { dir, branch, created: false, ...record }
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  // A worker directory may have been deleted without removing its worktree registration.
  // Prune before add so Git does not reject the same path as already registered.
  await internalGit(repoDir, ['worktree', 'prune'])
  let hasBranch = false
  try { await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); hasBranch = true } catch { /* new branch */ }
  if (hasBranch && ownerId && !record?.ownerId) throw new Error(`branch ${branch} has unknown ownership; choose another tag`)
  if (hasBranch && !carry) throw new Error(`branch ${branch} already exists; choose a new tag for carry=false`)
  const previousCarryRefs: Record<string, string> = {}
  if (!hasBranch) for (const ref of [carryRef(tag), carriedUntrackedRef(tag)]) {
    try { previousCarryRefs[ref] = (await git(repoDir, ['rev-parse', '--verify', ref])).trim() } catch { /* absent */ }
  }
  let base: string | undefined
  if (!hasBranch) {
    try { base = (await git(repoDir, ['rev-parse', '--verify', 'HEAD'])).trim() }
    catch { throw new Error('make a first commit before spawning workers') }
  }
  await internalGit(repoDir, hasBranch ? ['worktree', 'add', '-q', dir, branch] : ['worktree', 'add', '-q', '-b', branch, dir, base!])
  if (!base) return { dir, branch, created: true, branchCreated: false, ...record }
  if (!carry) {
    const result: PreparedWorktree = { dir, branch, created: true, branchCreated: true, previousCarryRefs, base }
    await (await carryRecord(repoDir, tag)).write({ base, ownerId })
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
      const sha = carriedContentHash(dir, rel, true)
      carriedUntracked.push({ path: rel, sha, mode: stat.mode & 0o777 })
    }
    const snapshotStable = async () => {
      const latestPatch = await internalGit(repoDir, patchArgs(base, excluded))
      const latestUntracked = (await git(repoDir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).room'])).split('\0').filter(Boolean)
      const copiedStable = carriedUntracked.every(({ path: rel, sha }) => {
        try { return carriedContentHash(repoDir, rel) === sha }
        catch (error) { if (error instanceof Error && error.message.includes('timed out')) throw error; return false }
      })
      return (await git(repoDir, ['rev-parse', 'HEAD'])).trim() === base && latestPatch === patch && latestUntracked.join('\0') === untracked.join('\0') && copiedStable
    }
    if (!await snapshotStable()) throw new Error('lead changed during carry; retrying snapshot')
    const staged = (await internalGit(dir, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
    if (staged.length) await git(dir, ['-c', 'core.hooksPath=/dev/null', '-c', `user.name=${ROOM_CARRY_IDENTITY.authorName}`, '-c', `user.email=${ROOM_CARRY_IDENTITY.authorEmail}`, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', carriedSubject(leadName)])
    const commit = (await git(dir, ['rev-parse', 'HEAD'])).trim()
    const paths = [...new Set([...staged, ...carriedUntracked.map(x => x.path)])].sort()
    if (paths.length) await internalGit(repoDir, ['update-ref', carryRef(tag), commit])
    retainUntrackedTree(repoDir, tag, carriedUntracked)
    if (!await snapshotStable()) throw new Error('lead changed during carry; retrying snapshot')
    const result: PreparedWorktree = { dir, branch, created: true, branchCreated: true, previousCarryRefs, base: commit, carriedBase: staged.length ? commit : undefined, carried: paths.length ? { count: paths.length, commit, paths } : undefined, carriedUntracked, skippedCarry }
    await (await carryRecord(repoDir, tag)).write({ base: result.base, carriedBase: result.carriedBase, carried: result.carried, carriedUntracked, skippedCarry, ownerId })
    return result
  } catch (e) {
    if ((e as Error).message === 'lead changed during carry; retrying snapshot') {
      await cleanupPreparedWorktree(repoDir, { dir, branch, created: true, branchCreated: true, previousCarryRefs })
      if (retry >= 2) throw new Error('lead changed repeatedly during carry; try spawning again when HEAD is stable')
      return prepareWorktree(repoDir, tag, leadName, linkExclusions, ownerId, retry + 1, carry)
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
export async function cleanupWorker(leadDir: string, w: Worker, collected = false, discarded = false, terminatedProcesses: string[] = [], processOptions: Parameters<typeof terminateWorktreeProcesses>[1] = {}, leadName?: string, workers: Iterable<WorktreeOwnershipRecord> = []): Promise<boolean> {
  if (!discarded && (w.status === 'failed' || w.exitCode !== 0)) return false
  if (decideDiscard(await workerRealState(leadDir, w, { ownership: true, leadName, workers })) !== 'cleanup') return false
  const nested = (await git(leadDir, ['worktree', 'list', '--porcelain'])).split('\n')
    .filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
    .filter(dir => dir !== w.dir && isInsideRoot(fs.realpathSync(w.dir), dir))
  if (nested.length) throw new Error(`nested worker worktrees still present under ${w.tag}: ${nested.join(', ')}`)
  const head = (await git(w.dir, ['rev-parse', 'HEAD'])).trim()
  const recordFile = (await carryRecord(leadDir, w.tag)).file
  const record = await fs.promises.readFile(recordFile).catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e })
  const refs = new Map<string, string>()
  for (const ref of [carryRef(w.tag), carriedUntrackedRef(w.tag)]) {
    try { refs.set(ref, (await git(leadDir, ['rev-parse', '--verify', ref])).trim()) } catch { /* absent on older workers */ }
  }
  terminatedProcesses.push(...await terminateWorktreeProcesses(w.dir, processOptions))
  // A lead may have discarded a child earlier. Its recovery patches must outlive this worktree.
  const nestedPatches = path.join(w.dir, '.room', 'discarded')
  if (fs.existsSync(nestedPatches)) {
    const dest = path.join(leadDir, '.room', 'discarded')
    for (const name of fs.readdirSync(nestedPatches)) {
      const source = path.join(nestedPatches, name)
      if (!name.endsWith('.patch') || !fs.lstatSync(source).isFile()) continue
      fs.mkdirSync(dest, { recursive: true })
      let target = path.join(dest, name), suffix = 1
      while (fs.existsSync(target)) target = path.join(dest, `${w.tag}-${suffix++}-${name}`)
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
      const stat = fs.statSync(source)
      fs.utimesSync(target, stat.atime, stat.mtime)
    }
  }
  try {
    await internalGit(leadDir, ['worktree', 'remove', ...(collected ? ['--force'] : []), w.dir])
    await internalGit(leadDir, ['branch', '-D', w.branch])
    for (const ref of refs.keys()) await internalGit(leadDir, ['update-ref', '-d', ref])
    await fs.promises.rm(recordFile, { force: true })
  } catch (error) {
    const recoveryDir = path.join(leadDir, '.room', 'discarded')
    const recovery = discarded && fs.existsSync(recoveryDir)
      ? fs.readdirSync(recoveryDir).filter(name => name.startsWith(w.tag + '-') && name.endsWith('.patch')).sort().at(-1)
      : undefined
    const recoveryNote = recovery ? `actual worker edits are in ${path.join(recoveryDir, recovery)}` : `collected edits are in ${leadDir}`
    try {
      let branchExists = true
      try { await git(leadDir, ['rev-parse', '--verify', `refs/heads/${w.branch}`]) } catch { branchExists = false }
      if (!branchExists) await internalGit(leadDir, ['branch', w.branch, head])
      if (!fs.existsSync(path.join(w.dir, '.git'))) await internalGit(leadDir, ['worktree', 'add', '-q', w.dir, w.branch])
      for (const [ref, sha] of refs) await internalGit(leadDir, ['update-ref', ref, sha])
      if (record && !fs.existsSync(recordFile)) await fs.promises.writeFile(recordFile, record, { mode: 0o600 })
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
export function cleanupWorkerLogs(leadDir: string, w: Pick<Worker, 'dir' | 'tag'>): void {
  const parent = path.basename(path.dirname(w.dir)) === 'workers' && path.basename(path.dirname(path.dirname(w.dir))) === '.room'
    ? path.resolve(w.dir, '../../..') : leadDir
  for (const suffix of ['.log', '.mcp.log']) {
    try { fs.rmSync(path.join(parent, WORKERS_DIR, w.tag + suffix), { force: true }) } catch { /* keep the log if the OS locks it */ }
  }
  for (const dir of [path.join(parent, WORKERS_DIR), path.join(parent, '.room')]) {
    try { fs.rmdirSync(dir) } catch { /* another worker or a locked log keeps the directory */ }
  }
}

/** One binary-capable snapshot against the fork, without modifying the worker's index. */
export async function saveDiscardPatch(leadDir: string, w: Worker): Promise<string | undefined> {
  const dir = path.join(leadDir, '.room', 'discarded'), now = Date.now()
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), stat = fs.lstatSync(file)
      if (name.endsWith('.patch') && stat.isFile() && stat.mtimeMs < now - 7 * 86400_000) fs.unlinkSync(file)
    }
    try { fs.rmdirSync(dir) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw e }
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'room-discard-'))
  try {
    const run = (args: string[], wholeTreePaths?: number) => boundedGitSync(w.dir, args, { env: { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') }, wholeTreePaths })
    const base = w.base ?? (await git(leadDir, ['merge-base', 'HEAD', w.branch])).trim()
    run(['read-tree', 'HEAD'], UNKNOWN_WHOLE_TREE_PATHS)
    const unchanged = carriedUnchangedPaths(workerBaseline(w))
    const exclusions = [...workerOwnedPaths(w).exclusions, ...[...unchanged].map(p => ':(exclude,literal)' + p)]
    run(['add', '-A', '--', '.', ...exclusions], UNKNOWN_WHOLE_TREE_PATHS)
    const patch = run(patchArgs(base, exclusions, true), UNKNOWN_WHOLE_TREE_PATHS)
    if (!patch.length) return undefined
    // The recovery artifact is useful only if it applies to a fresh checkout of this base.
    const verifyDir = path.join(scratch, 'verify')
    const verifyPatch = path.join(scratch, 'verify.patch')
    fs.writeFileSync(verifyPatch, patch, { mode: 0o600 })
    await internalGit(leadDir, ['worktree', 'add', '-q', '--detach', verifyDir, base])
    try { boundedGitSync(verifyDir, ['apply', '--binary', verifyPatch]) }
    finally { await internalGit(leadDir, ['worktree', 'remove', '--force', verifyDir]) }
    fs.mkdirSync(dir, { recursive: true })
    const local = new Date(now)
    const stamp = `${local.getFullYear()}${String(local.getMonth() + 1).padStart(2, '0')}${String(local.getDate()).padStart(2, '0')}-${String(local.getHours()).padStart(2, '0')}${String(local.getMinutes()).padStart(2, '0')}${String(local.getSeconds()).padStart(2, '0')}`
    const file = path.join(dir, `${w.tag}-${stamp}.patch`)
    fs.writeFileSync(file, patch, { flag: 'wx', mode: 0o600 })
    return file
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}
