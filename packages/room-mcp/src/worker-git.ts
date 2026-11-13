import type { WorkerRegistry } from './worker-registry.js'
import { privateStateDirectory } from '@room/relay'
import { workerTagFile, withWorkerTag } from './worker-tags.js'
import { requireWorkerInventory } from './worker-store.js'
import { requireWorkerEvidence } from './worker-store.js'
/** Worker worktrees, carry snapshots, links, and cleanup. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isRegenerableBuildPath } from '@room/shared'
import type { LocalWorker, WorkerRecord } from './worker-status.js'
import { LINK_INPUT_PATH, MATERIALIZED_PATH, RECORDED_PATH, commonGitDirFromDotGit, containedRepoPath, isInsideRoot, realGitCommonDir, validRepoPath } from '@room/roomd'
import { git, UNKNOWN_WHOLE_TREE_PATHS, withGitWorktreeOperation } from '@room/roomd/git'
import { boundedGit, boundedGitSync, carriedContentHashes } from '@room/roomd/baseline'
import { isOwnedWorkerWorktree, roomWorkerPathMatchesBranch, workerRealState, ROOM_CARRY_IDENTITY, type WorktreeOwnershipRecord } from './worker-state.js'
import { terminateWorktreeProcesses } from './worker-process.js'
import { linkWorkspaceDeps } from './worker-deps.js'
import type { PrepJournal, PrepStep } from './worker-status.js'

import { clearRetainedWorkerItem, retainWorkerItem, retainedWorkerLines } from './worker-retained.js'
import { writeWorkerRef, deleteWorkerRef, deleteWorkerRecordRef, restoreWorkerRef, preserveWorkerBranch, deletePreservedWorkerBranch, recoveryRefCovers, recoveryRefDescription, operationBranchReceipt } from './worker-refs.js'
import { canonicalMissingWorkerPath, rootIdentity, verifyWorkerCheckout, retainCheckout, removeWorkerRegistration, PREPARATION_WITNESS_FILE, preparationIdentity, witnessPreparation, removePreparation, verifyPreparation, type PreparationIdentity, type PreparationWitness } from './worker-preparation.js'

const WORKERS_DIR = path.join('.room', 'workers')

/** Existing paths/branches are never preparation resources, even when they look like ours. */
export function assertNewWorkerWorktree(repoDir: string, tag: string): void {
  const rel = path.join(WORKERS_DIR, tag)
  // lstat: a dangling link at the path is also something Room did not create.
  if (fs.lstatSync(path.join(repoDir, rel), { throwIfNoEntry: false }))
    throw new Error(`${rel} already exists and Room has no record of creating it, so it is left alone; move or delete it yourself, or use another worker name`)
  const branch = `refs/heads/room/${tag}`
  const refs = boundedGitSync(repoDir, ['for-each-ref', '--format=%(refname)', branch]).toString().split('\n')
  if (refs.includes(branch)) throw new Error(`branch room/${tag} already exists and Room has no record of creating it, so it is left alone; delete it yourself (git branch -D room/${tag}), or use another worker name`)
}

/** A Git discovery failure is definite only when no ancestor has even a damaged .git entry. */
function hasGitEntry(dir: string): boolean {
  for (let at = fs.realpathSync.native(dir);;) {
    try { fs.lstatSync(path.join(at, '.git')); return true }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
    const parent = path.dirname(at)
    if (parent === at) return false
    at = parent
  }
}

/** realpath alone can preserve caller casing on macOS; resolve each existing component's stored name. */
function filesystemPath(value: string): string {
  const resolved = fs.realpathSync.native(value), root = path.parse(resolved).root
  let current = root
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    const entries = fs.readdirSync(current)
    const name = entries.includes(part) ? part : entries.find(entry => entry.toLowerCase() === part.toLowerCase())
    if (!name) throw new Error(`cannot resolve filesystem spelling of ${value}`)
    current = path.join(current, name)
  }
  return current
}

function inWorkerNamespace(value: string): boolean {
  const actual = filesystemPath(value), root = path.parse(actual).root
  const parts = actual.slice(root.length).split(path.sep)
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i].toLowerCase() !== '.room' || parts[i + 1].toLowerCase() !== 'workers') continue
    const parent = path.join(root, ...parts.slice(0, i))
    try {
      if (filesystemPath(path.join(parent, '.room', 'workers')) === path.join(parent, parts[i], parts[i + 1])) return true
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  }
  return false
}

/** Inspect the supplied directory itself: it may be a subdirectory, moved worktree, or another clone. */
export function suppliedWorkerCheckout(dir: string, records: readonly WorkerRecord[]): { root: string; atRoot: boolean; branch: string; owner?: WorkerRecord; refusal?: string } {
  const read = (args: string[]) => boundedGitSync(dir, args, { env: { ...process.env, LC_ALL: 'C' } }).toString().replace(/\r?\n$/, '')
  let root: string, branch: string
  try { root = filesystemPath(read(['rev-parse', '--show-toplevel'])); branch = read(['branch', '--show-current']) || 'HEAD' }
  catch (error) {
    const failed = error as { status?: number; signal?: string; stderr?: Buffer }
    if (failed.status !== 128 || failed.signal || !/^fatal: (?:not a git repository|this operation must be run in a work tree)/.test(String(failed.stderr)) || hasGitEntry(dir)) throw error
    // A definite non-worktree is an allowed outside user directory, unless it is in Room's namespace.
    root = filesystemPath(dir)
    branch = '?'
  }
  const owner = records.find(record => !record.outside && !record.sharedWith
    && !['retiring', 'retired', 'abandoned'].includes(record.phase) && (branch === '?' || record.branch === branch)
    && fs.existsSync(record.dir) && filesystemPath(record.dir) === root)
  const supplied = filesystemPath(dir)
  const namespace = inWorkerNamespace(root) || inWorkerNamespace(supplied)
  const refusal = owner ? undefined : namespace && (branch === '?' || !inWorkerNamespace(root))
    ? `directory ${supplied} is in Room's worker namespace; Room has no live record of it. Inspect and preserve its files, or choose another directory. Room will not adopt it.`
    : branch.startsWith('room/') || namespace
      ? `worktree ${root} on branch ${branch} already exists; Room has no live record of it. Inspect it and preserve any work you need, then remove it with git worktree remove <path> and git branch -D <branch>, or choose another tag and omit dir. Room will not adopt this checkout.`
      : undefined
  return { root, atRoot: supplied === root, branch, owner, refusal }
}

/** Recognize an environment, not merely a directory named .venv. Unexpected
 * top-level files are local state and must retain the worktree for inspection. */
function generatedPythonEnvironment(root: string, rel: string): boolean {
  const dir = path.join(root, rel)
  try {
    if (!fs.lstatSync(dir).isDirectory() || !isInsideRoot(fs.realpathSync(root), fs.realpathSync(dir))) return false
    const config = path.join(dir, 'pyvenv.cfg')
    const configStat = fs.lstatSync(config)
    if (!configStat.isFile() || configStat.size > 16 * 1024) return false
    const text = fs.readFileSync(config, 'utf8')
    if (!/^home\s*=\s*\S/m.test(text) || !/^version(?:_info)?\s*=\s*\d+\.\d+/m.test(text)) return false
    const directories = new Set(['bin', 'Scripts', 'lib', 'Lib', 'include', 'Include', 'share'])
    const files = new Set(['pyvenv.cfg', '.gitignore', 'CACHEDIR.TAG', '.lock'])
    for (const name of fs.readdirSync(dir)) {
      const entry = path.join(dir, name), stat = fs.lstatSync(entry)
      if (directories.has(name) && stat.isDirectory() || files.has(name) && stat.isFile()) continue
      if (name === 'lib64' && (stat.isDirectory() || stat.isSymbolicLink() && isInsideRoot(fs.realpathSync(dir), fs.realpathSync(entry)) && fs.statSync(entry).isDirectory())) continue
      return false
    }
    // Interpreters are normally symlinks; inspect their existence without following
    // them. Cleanup removes the owned worktree, never the interpreter target.
    return ['bin/python', 'Scripts/python.exe'].some(name => {
      try {
        const parent = path.dirname(path.join(dir, name))
        if (!fs.lstatSync(parent).isDirectory()) return false
        const stat = fs.lstatSync(path.join(dir, name))
        return stat.isFile() || stat.isSymbolicLink()
      } catch { return false }
    })
  } catch { return false }
}

/** Inputs Room installed itself, rather than worker output. */
export function workerOwnedPaths(w?: { link?: readonly string[] }) {
  const paths = w?.link ?? []
  return {
    includes: (p: string) => paths.some(l => p === l || p.startsWith(l + '/')),
    exclusions: paths.map(l => ':(exclude,literal)' + l),
  }
}

const lstatOrUndefined = (file: string) => {
  try { return fs.lstatSync(file) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}

/** Whether a worker path matches the lead's at the same place: both absent, equal links, or
 * regular files with the same executable bits and bytes (compared in chunks). */
async function sameAsLead(left: string, right: string): Promise<boolean> {
  const a = lstatOrUndefined(left), b = lstatOrUndefined(right)
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

/** An ignored path carries information only if it is a non-empty file, link or special file the
 * lead lacks or holds differently; a directory, only if something inside it does. Links are not followed. */
async function informativeIgnored(workerDir: string, leadDir: string, rel: string): Promise<boolean> {
  const left = path.join(workerDir, rel)
  const stat = lstatOrUndefined(left)
  if (!stat) return false
  if (stat.isDirectory()) {
    for (const name of await fs.promises.readdir(left)) {
      if (await informativeIgnored(workerDir, leadDir, path.posix.join(rel, name))) return true
    }
    return false
  }
  if (stat.isFile() && stat.size === 0) return false
  return !await sameAsLead(left, path.join(leadDir, rel))
}

/** Ignored output that a discard snapshot cannot recover and the lead checkout does not already hold. */
export async function ignoredWorkerArtifacts(w: LocalWorker, leadDir: string): Promise<string[]> {
  const raw = await git(w.dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', '.', ...workerOwnedPaths(w).exclusions])
  const environments = new Map<string, boolean>()
  const generatedEnvironment = (p: string) => {
    const parts = p.split('/')
    const i = parts.findIndex(part => part === '.venv' || part === 'venv')
    if (i < 0) return false
    const rel = parts.slice(0, i + 1).join('/')
    if (!environments.has(rel)) environments.set(rel, generatedPythonEnvironment(w.dir, rel))
    return environments.get(rel)!
  }
  const candidates = raw.split('\0').filter(Boolean)
    .filter(p => p !== '.room' && p !== '.room/' && !p.startsWith('.room/'))
    .filter(p => !isRegenerableBuildPath(p))
    .filter(p => !generatedEnvironment(p))
  const artifacts: string[] = []
  for (const p of candidates) if (await informativeIgnored(w.dir, leadDir, p.replace(/\/$/, ''))) artifacts.push(p)
  return artifacts.sort()
}

export type WorkerCleanupPreservation = {
  ignored: string[]; uncollected: string[]
  commitsAfterCollection?: { sha: string; paths: string[] }
  recoveryRefs?: string[]
}

export const collectHeadRef = (tag: string, id: string) => `refs/room/collect-head/${tag}/${id}`
export const collectBaseRef = (tag: string, id: string) => `refs/room/collect-base/${tag}/${id}`

const privateWorkerRefs = (w: Pick<LocalWorker, 'tag' | 'id'>) => [
  carryRef(w.tag), carriedUntrackedRef(w.tag), collectHeadRef(w.tag, w.id), collectBaseRef(w.tag, w.id),
]

/** Pin the same carry/kept objects under a borrower's identity. The owner lane must be held. */
export function inheritWorkerRefs(commonDir: string, owner: Pick<LocalWorker, 'tag' | 'id'>, retry: Pick<LocalWorker, 'tag' | 'id'>): void {
  const sources = privateWorkerRefs(owner), targets = privateWorkerRefs(retry)
  const refs = boundedGitSync(commonDir, ['--git-dir', commonDir, 'for-each-ref', '--format=%(refname) %(objectname)', ...sources]).toString()
  const values = new Map(refs.trim().split('\n').filter(Boolean).map(line => line.split(' ') as [string, string]))
  for (const [index, ref] of sources.entries()) {
    const value = values.get(ref)
    if (value) {
      try { writeWorkerRef(commonDir, targets[index], value, retry.id, '0'.repeat(value.length)) }
      catch (error) { retainWorkerItem(commonDir, { kind: 'ref', path: targets[index], id: retry.id, reason: `inheritance target was occupied or could not be created; retained without overwriting: ${String(error)}` }) }
    }
    // A missing source has no output to inherit, and grants no deletion authority.
  }
}

/** A detached borrower owns only its pins; never delete its owner's refs or checkout. */
export function removeWorkerRefs(commonDir: string, worker: WorkerRecord): void {
  for (const ref of privateWorkerRefs(worker)) deleteWorkerRecordRef(commonDir, ref, worker)
}

/** Compare checkout output against the lead, including commits after collection's captured HEAD. */
export async function uncollectedWorkerPaths(leadDir: string, w: LocalWorker, capturedHead?: string): Promise<string[]> {
  const exclusions = workerOwnedPaths(w).exclusions
  const [changed, untracked, committed] = await Promise.all([
    git(w.dir, ['diff', '--no-renames', '--name-only', '-z', 'HEAD', '--', '.', ...exclusions]),
    git(w.dir, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...exclusions]),
    capturedHead ? git(w.dir, ['diff', '--no-renames', '--name-only', '-z', capturedHead, 'HEAD', '--', '.', ...exclusions]) : '',
  ])
  const paths = [...new Set((changed + untracked + committed).split('\0').filter(Boolean))]
  const remaining: string[] = []
  for (const rel of paths) if (!await sameAsLead(path.join(w.dir, rel), path.join(leadDir, rel))) remaining.push(rel)
  return remaining.sort()
}

/** Prune a vanished Room checkout, preserving any branch commits absent from the lead HEAD. */
export async function pruneMissingWorkerWorktree(leadDir: string, w: LocalWorker, manageBranch = true, store?: Pick<WorkerRegistry, 'read'>): Promise<string | undefined> {
  const common = await realGitCommonDir(leadDir)
  const { registryForDir } = await import('./worker-registry.js')
  const record = await (store ?? await registryForDir(leadDir)).read(w.id)
  const branchCleanup = manageBranch ? preserveWorkerBranch(common, w, operationBranchReceipt(common, w.id) ?? record?.branchCleanup) : undefined
  if (!roomWorkerPathMatchesBranch(leadDir, w.dir, w.branch, true)) {
    throw new Error(`worker ${w.dir} is not an owned Room worktree`)
  }
  try { fs.lstatSync(w.dir); throw new Error(`worktree ${w.dir} still exists`) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  // Dynamic import avoids a module-initialization cycle: preview tools read workerOwnedPaths from here.
  const { removePreviewCache } = await import('./tools/files.js')
  await removePreviewCache(w.dir, leadDir)
  const witness = w.prep?.witness
  if (witness) {
    try {
      if (witness.id !== w.id || w.creationNonce && witness.nonce !== w.creationNonce) throw new Error('registration witness belongs to another worker/run')
      await removeWorkerRegistration(common, witness.adminDir, witness, w.dir)
    }
    catch (error) { retainWorkerItem(common, { kind: 'registration', path: witness.adminDir, id: w.id, tag: w.tag, reason: String(error) }) }
  } else {
    // No markerless missing registration is guessed from a reused pathname.
    for (const admin of workerAdminsAt(common, w.dir)) retainWorkerItem(common, { kind: 'registration', path: admin, id: w.id, tag: w.tag, reason: 'no recorded worktree marker; inspect and remove manually' })
  }
  let branchDetail: string | undefined
  if (manageBranch) {
    const state = await workerRealState(leadDir, w, { branch: true })
    if (state.branch === 'absent') branchDetail = `branch ${w.branch} was already absent`
    else if (state.branchAhead) branchDetail = retainWorkerItem(common, { kind: 'branch', path: `refs/heads/${w.branch}`, id: w.id, tag: w.tag, reason: `has ${state.branchAhead} commit${state.branchAhead === 1 ? '' : 's'} not in your HEAD; inspect before removing` })
    else branchDetail = deletePreservedWorkerBranch(common, w, branchCleanup!) ?? `branch ${w.branch} cleanup checked against its preserved operation tip`
  }
  return [branchDetail, ...(branchCleanup?.recoveryRef ? [`branch recovery ref: ${recoveryRefDescription(common, branchCleanup.recoveryRef)}`] : []), ...retainedWorkerLines(common)].filter(Boolean).join('\n') || undefined
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
  const attempted: string[] = []
  try {
    for (const link of links) {
      attempted.push(link.target)
      fs.mkdirSync(path.dirname(link.target), { recursive: true })
      fs.symlinkSync(link.source, link.target, link.directory ? 'dir' : 'file')
    }
  } catch (e) {
    for (const target of attempted) retainWorkerItem(commonGitDirFromDotGit(repoDir), { kind: 'file', path: target, reason: 'input-link setup did not complete; output retained in place' })
    throw e
  }
  for (const target of attempted) clearRetainedWorkerItem(commonGitDirFromDotGit(repoDir), 'file', target)
  return links.map(l => l.p)
}

export interface PreparedWorktree {
  dir: string
  branch: string
  created: boolean
  witness?: PreparationWitness
  branchOid?: string
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
export const carryRef = (tag: string) => `refs/room/carry/${tag}`
const carriedUntrackedRef = (tag: string) => `refs/room/carry-untracked/${tag}`
const pathExcluded = (rel: string, exclusions: string[]) => exclusions.some(p => rel === p || rel.startsWith(p.replace(/\/$/, '') + '/'))
/** Stable, apply-compatible patch policy for carry. */
function patchArgs(base: string, exclusions: string[]): string[] {
  return ['diff', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', base, '--', '.', ...exclusions]
}
function retainUntrackedTree(dir: string, tag: string, paths: { path: string; sha: string }[], owner: string): string | undefined {
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
    writeWorkerRef(commonGitDirFromDotGit(dir), carriedUntrackedRef(tag), tree, owner)
    return tree
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}
/** Roll back only a newly prepared worktree; do not remove reused worker output. */
export async function cleanupPreparedWorktree(repoDir: string, prepared: PreparedWorktree): Promise<void> {
  if (!prepared.created) return
  const common = await realGitCommonDir(repoDir)
  if (!prepared.witness) throw new Error(retainCheckout(common, prepared, 'no worktree identity witness'))
  try { await removePreparation(common, prepared.dir, { ...prepared.witness, branchOid: prepared.branchOid ?? prepared.witness.branchOid }, !!prepared.branchCreated) }
  catch (error) { throw new Error(retainCheckout(common, prepared, String(error))) }
  for (const ref of [carryRef(prepared.branch.slice(5)), carriedUntrackedRef(prepared.branch.slice(5))])
    restoreWorkerRef(common, ref, prepared.previousCarryRefs?.[ref], prepared.witness.id)
}

export interface PrepareWorktreeOptions {
  /** Paths linked rather than carried; undefined reads `.roomlinks`. */
  linkExclusions?: string[]
  /** Journal hook: plans before mutation, creation facts only after Git succeeds. */
  onStep?: (step: PrepStep, facts: Partial<PrepJournal>) => Promise<void>
  /** Carry the lead's uncommitted work into the worktree (default true). */
  carry?: boolean
  identity?: PreparationIdentity
}

/** Validate a commit where it is read, before using it as a checkout base or ref value. */
async function preparationCommit(dir: string, revision: string, label: string): Promise<string> {
  let value: string
  try { value = (await git(dir, ['rev-parse', '--verify', `${revision}^{commit}`])).trim() }
  catch (error) {
    const unborn = label === 'HEAD' ? '; make a first commit before spawning workers if HEAD is unborn' : ''
    throw new Error(`${label} is not a commit or could not be read: ${String(error)}${unborn}`, { cause: error })
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error(`${label} returned an invalid commit OID`)
  return value
}

/** A worktree for the worker, with tracked WIP in its base and untracked bytes outside Git. */
export function prepareWorktree(repoDir: string, tag: string, leadName = 'lead', options: PrepareWorktreeOptions = {}): Promise<PreparedWorktree> {
  return prepareWorktreeAttempt(repoDir, tag, leadName, { ...options, identity: options.identity ?? preparationIdentity() }, 0)
}

/** Admin entries are found by their own backlink, never removed through a reusable checkout path. */
function workerAdminsAt(common: string, dir: string): string[] {
  let names: string[]
  try { names = fs.readdirSync(path.join(common, 'worktrees')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const target = path.join(canonicalMissingWorkerPath(dir), '.git')
  return names.map(name => path.join(common, 'worktrees', name)).filter(admin => {
    try { return path.resolve(admin, fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim()) === target } catch { return false }
  })
}
async function removeAbsentWorkerRegistration(repoDir: string, dir: string): Promise<void> {
  if (lstatOrUndefined(dir)) return
  // Preserve listing errors and reappearance checks; prunable is observation, never authority.
  await git(repoDir, ['worktree', 'list', '--porcelain', '-z'])
  if (lstatOrUndefined(dir)) throw new Error(`worker path reappeared: ${dir}`)
  const common = await realGitCommonDir(repoDir)
  const { registryForDir } = await import('./worker-registry.js')
  const records = requireWorkerInventory(await (await registryForDir(repoDir)).list())
  for (const admin of workerAdminsAt(common, dir)) {
    try {
      const marker = path.join(admin, PREPARATION_WITNESS_FILE), stat = fs.lstatSync(marker)
      if (!stat.isFile() || stat.size > 4096) throw new Error('not a small regular worktree marker')
      const witness = JSON.parse(fs.readFileSync(marker, 'utf8')) as PreparationWitness
      const owner = records.find(record => record.id === witness.id)
      if (owner && !['retired', 'abandoned'].includes(owner.phase)) throw new Error('marker owner is still live')
      if (lstatOrUndefined(dir)) throw new Error('checkout reappeared')
      await removeWorkerRegistration(common, admin, witness, dir)
    } catch (error) {
      const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'"
      const reason = `cannot verify ended/absent Room owner (${String(error)}); inspect it, then run git -C ${quote(repoDir)} worktree remove ${quote(dir)} only after confirming the checkout is still absent`
      throw new Error(retainWorkerItem(common, { kind: 'registration', path: admin, reason }))
    }
  }
}

async function prepareWorktreeAttempt(repoDir: string, tag: string, leadName: string, options: PrepareWorktreeOptions, retry: number): Promise<PreparedWorktree> {
  const { linkExclusions, onStep, carry = true } = options
  const dir = path.join(repoDir, WORKERS_DIR, tag)
  const branch = `room/${tag}`
  const gitDir = (await git(repoDir, ['rev-parse', '--absolute-git-dir'])).trim()
  if (['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].some(p => fs.existsSync(path.join(gitDir, p)))) throw new Error('finish the merge or rebase before spawning workers')
  assertNewWorkerWorktree(repoDir, tag)
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  await removeAbsentWorkerRegistration(repoDir, dir)
  const previousCarryRefs: Record<string, string> = {}
  for (const ref of [carryRef(tag), carriedUntrackedRef(tag)]) {
    try { previousCarryRefs[ref] = (await git(repoDir, ['rev-parse', '--verify', ref])).trim() } catch { /* absent */ }
  }
  const base = await preparationCommit(repoDir, 'HEAD', 'HEAD')
  await onStep?.('plan', { branchExisted: false,
    previousCarryRefs: Object.fromEntries([carryRef(tag), carriedUntrackedRef(tag)].map(ref => [ref, previousCarryRefs[ref] ?? null])) })
  // Git accepts an existing empty directory: only our exclusive mkdir proves root creation.
  privateStateDirectory(dir, { exclusive: true })
  const root = rootIdentity(dir)
  await onStep?.('root', { root, identityRequired: true })
  let witness = await withGitWorktreeOperation(repoDir, async () => {
    await internalGit(repoDir, ['worktree', 'add', '-q', '-b', branch, dir, base])
    return witnessPreparation(dir, branch, options.identity!, root, base)
  })
  let branchOid = base
  // Journal successful writes, never infer them at cleanup time.
  await onStep?.('worktree', { created: true, branchCreated: true, witness, branchOid })
  if (!carry) {
    const result: PreparedWorktree = { dir, branch, created: true, branchCreated: true, witness, branchOid, previousCarryRefs, base }
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
      if (stat.isFile() && (stat.size > CARRY_FILE_LIMIT || totalBytes + stat.size > 50 * 1024 * 1024)) { skippedCarry.push({ path: rel, reason: 'size budget' }); continue }
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
      return await preparationCommit(repoDir, 'HEAD', 'HEAD') === base && latestPatch === patch && latestUntracked.join('\0') === untracked.join('\0') && copiedStable
    }
    if (!await snapshotStable()) throw new Error('lead changed during carry; retrying snapshot')
    const staged = (await internalGit(dir, ['diff', '--cached', '--no-renames', '--name-only', '-z'])).split('\0').filter(Boolean)
    let commit = branchOid
    if (staged.length) {
      await onStep?.('carry-commit', {})
      const tree = (await internalGit(dir, ['write-tree'])).trim()
      // commit-tree returns the exact object Room produced; do not adopt a later public HEAD read.
      const produced = (await git(dir, ['-c', `user.name=${ROOM_CARRY_IDENTITY.authorName}`, '-c', `user.email=${ROOM_CARRY_IDENTITY.authorEmail}`, '-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', branchOid, '-m', carriedSubject(leadName)])).trim()
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(produced)) throw new Error('carry commit returned an invalid commit OID')
      commit = await preparationCommit(dir, produced, 'carry commit')
      if (commit !== produced) throw new Error('carry commit is not a commit object')
      writeWorkerRef(await realGitCommonDir(repoDir), `refs/heads/${branch}`, commit, options.identity!.id, branchOid)
      branchOid = commit
      await onStep?.('carry-commit', { branchOid })
    }
    const paths = [...new Set([...staged, ...carriedUntracked.map(x => x.path)])].sort()
    if (paths.length) await onStep?.('carry-refs', {})
    if (paths.length) writeWorkerRef(await realGitCommonDir(repoDir), carryRef(tag), commit, options.identity!.id)
    retainUntrackedTree(repoDir, tag, carriedUntracked, options.identity!.id)
    if (!await snapshotStable()) throw new Error('lead changed during carry; retrying snapshot')
    const result: PreparedWorktree = { dir, branch, created: true, branchCreated: true, witness, branchOid, previousCarryRefs, base: commit, carriedBase: staged.length ? commit : undefined, carried: paths.length ? { count: paths.length, commit, paths } : undefined, carriedUntracked, skippedCarry }
    await onStep?.('prepared', { created: true, branchCreated: true })
    return result
  } catch (e) {
    if ((e as Error).message === 'lead changed during carry; retrying snapshot') {
      // Relinquish the old checkout before removing it: a retry may find a replacement.
      await onStep?.('plan', { created: false, branchCreated: false })
      await cleanupPreparedWorktree(repoDir, { dir, branch, created: true, branchCreated: true, witness, branchOid, previousCarryRefs })
      if (retry >= 2) throw new Error('lead changed repeatedly during carry; try spawning again when HEAD is stable')
      return prepareWorktreeAttempt(repoDir, tag, leadName, options, retry + 1)
    }
    try {
      verifyPreparation(dir, witness)
      writeWorkerRef(await realGitCommonDir(repoDir), `refs/heads/${branch}`, base, options.identity!.id, branchOid)
      branchOid = base
      verifyPreparation(dir, witness)
      await internalGit(dir, ['read-tree', '--reset', '-u', base])
      verifyPreparation(dir, witness)
      await internalGit(dir, ['clean', '-fdx'])
      branchOid = base
      await onStep?.('carry-commit', { branchOid })
      for (const ref of [carryRef(tag), carriedUntrackedRef(tag)])
        restoreWorkerRef(await realGitCommonDir(repoDir), ref, previousCarryRefs[ref], options.identity!.id)
    } catch {
      // Relinquish the old checkout before removing it: a retry may find a replacement.
      await onStep?.('plan', { created: false, branchCreated: false })
      await cleanupPreparedWorktree(repoDir, { dir, branch, created: true, branchCreated: true, witness, branchOid, previousCarryRefs })
      privateStateDirectory(dir, { exclusive: true })
      const retryRoot = rootIdentity(dir)
      await onStep?.('root', { root: retryRoot, identityRequired: true })
      witness = await withGitWorktreeOperation(repoDir, async () => {
        await internalGit(repoDir, ['worktree', 'add', '-q', '-b', branch, dir, base])
        return witnessPreparation(dir, branch, options.identity!, retryRoot, base)
      })
      branchOid = base
      await onStep?.('worktree', { created: true, branchCreated: true, witness, branchOid })
    }
    return { dir, branch, created: true, branchCreated: true, witness, branchOid, previousCarryRefs, base, carryFailed: true, carryError: (e as Error).message }
  }
}

export interface CleanupWorkerOptions {
  /** Collection already applied the output: remove the worktree with --force. */
  collected?: boolean
  /** Discard: a failed worker or moved tip does not block removal. */
  discarded?: boolean
  /** Receives descriptions of processes terminated in the worktree. */
  terminatedProcesses?: string[]
  processOptions?: Parameters<typeof terminateWorktreeProcesses>[1]
  leadName?: string
  workers?: Iterable<WorktreeOwnershipRecord>
  /** Receives what kept the worktree, instead of logging a recovery ref. */
  preservation?: WorkerCleanupPreservation
  /** Recovery must not re-enter registryForDir while this store is still opening. */
  registry?: Pick<WorkerRegistry, 'read' | 'list' | 'worktreeOwner' | 'checkoutUsers' | 'markDiscardStep'>
}

/** Confirm and renew the sole snapshot immediately before destructive removal. */
function readyDiscardRecovery(common: string, w: LocalWorker, plan: NonNullable<WorkerRecord['discard']>, refs: ReadonlySet<string>): void {
  const ref = plan.recoveryRef, prefix = `refs/room/recovery/${w.tag}/`
  const tip = ref?.startsWith(prefix) ? ref.slice(prefix.length) : ''
  if (!/^[a-f0-9]{40,64}$/.test(tip)) throw new Error('discard recovery ref missing or invalid; checkout retained')
  try { boundedGitSync(common, ['--git-dir', common, 'cat-file', '-e', `${tip}^{commit}`]) }
  catch { throw new Error(`discard recovery commit ${tip} is missing; checkout retained`) }
  const [checkoutHead, capturedHead] = boundedGitSync(w.dir, ['rev-parse', 'HEAD', plan.unchanged ? tip : `${tip}^`]).toString().trim().split('\n')
  if (checkoutHead !== capturedHead) throw new Error('checkout HEAD changed after discard snapshot; checkout retained')
  const pin = preserveWorkerBranch(common, w, { tip }, true)
  if (pin.recoveryRef !== ref) throw new Error(pin.reason ?? 'cannot confirm discard recovery ref; checkout retained')
  for (const branchRef of refs) if (!recoveryRefCovers(common, ref, branchRef)) {
    const renewed = preserveWorkerBranch(common, w, { tip: branchRef.split('/').at(-1)! }, true)
    if (renewed.recoveryRef !== branchRef) throw new Error(renewed.reason ?? 'cannot confirm branch recovery ref; checkout retained')
  }
}

/** Remove only owned Room worktrees; failures require explicit discard. */
export async function cleanupWorker(leadDir: string, w: LocalWorker, options: CleanupWorkerOptions = {}): Promise<boolean> {
  const { collected = false, discarded = false, terminatedProcesses = [], processOptions = {}, leadName, workers = [], preservation } = options
  // All lifecycle paths converge here. The owner operation lease must be held by
  // callers while checking this snapshot and removing the checkout.
  const common = await realGitCommonDir(leadDir)
  const { registryForDir } = await import('./worker-registry.js')
  const registry = options.registry ?? await registryForDir(leadDir)
  let ownerRecord: WorkerRecord | undefined
  const available = async () => {
    if (!w.id) return true // Legacy direct callers have no registry capability.
    const record = (await registry.read(w.id))
    ownerRecord = record
    if (!record) return w.branch === `room/${w.tag}` && (requireWorkerInventory(await registry.list())).every(peer =>
      path.resolve(peer.dir) !== path.resolve(w.dir) || peer.tag === w.tag)
    return !record.sharedWith && !(await registry.worktreeOwner(record))
      && requireWorkerEvidence(await registry.checkoutUsers(record)).length === 0
  }
  if (!await available()) return false
  if (!roomWorkerPathMatchesBranch(filesystemPath(leadDir), filesystemPath(w.dir), w.branch, true)) return false
  const verify = () => {
    try {
      if (!ownerRecord) throw new Error('no authoritative local worker record')
      if (ownerRecord.tag !== w.tag || ownerRecord.branch !== w.branch || filesystemPath(ownerRecord.dir) !== filesystemPath(w.dir)) throw new Error('cleanup target differs from its authoritative record')
      verifyWorkerCheckout(common, ownerRecord, discarded)
    } catch (error) { throw new Error(retainCheckout(common, w, error instanceof Error ? error.message : String(error))) }
  }
  verify()
  const branchCleanup = preserveWorkerBranch(common, w, operationBranchReceipt(common, w.id) ?? ownerRecord?.branchCleanup)
  if (!discarded && (w.status === 'failed' || w.exitCode !== 0)) return false
  if (!await isOwnedWorkerWorktree(leadDir, w, leadName, workers, discarded)) return false
  const nested = (await git(leadDir, ['worktree', 'list', '--porcelain'])).split('\n')
    .filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
    .filter(dir => dir !== w.dir && isInsideRoot(fs.realpathSync(w.dir), dir))
  if (nested.length) throw new Error(`nested worker worktrees still present under ${w.tag}: ${nested.join(', ')}`)
  const head = (await git(w.dir, ['rev-parse', 'HEAD'])).trim()
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
      const owner = await registry.read(w.id)
      retainedOwner = owner?.phase === 'retired' && !!owner.keptWorktree && !!owner.archive?.keptReason?.startsWith('shared checkout: ')
    }
    if (retainedOwner) {
      let capturedHead: string | undefined
      try { capturedHead = (await git(leadDir, ['rev-parse', '--verify', collectHeadRef(w.tag, w.id)])).trim() } catch { /* legacy collection */ }
      const currentHead = (await git(w.dir, ['rev-parse', 'HEAD'])).trim()
      const [ignored, uncollected] = await Promise.all([ignoredWorkerArtifacts(w, leadDir), uncollectedWorkerPaths(leadDir, w, capturedHead)])
      const committedPaths = capturedHead && capturedHead !== currentHead
        ? (await git(w.dir, ['diff', '--no-renames', '--name-only', '-z', capturedHead, currentHead, '--', '.', ...workerOwnedPaths(w).exclusions])).split('\0').filter(Boolean).sort()
        : undefined
      if (preservation) {
        preservation.ignored = ignored; preservation.uncollected = uncollected
        if (committedPaths) preservation.commitsAfterCollection = { sha: currentHead.slice(0, 12), paths: committedPaths }
      }
      if (ignored.length || uncollected.length || committedPaths) return false
    }
    if (!await available()) return false
    // Deleting a branch must not strand a commit absent from the lead's history.
    // Discard has a worktree snapshot; branch cleanup separately preserves its captured tip.
    const tip = (await git(w.dir, ['rev-parse', 'HEAD'])).trim()
    if (tip !== head && !discarded) {
      if (preservation) preservation.commitsAfterCollection = {
        sha: tip.slice(0, 12),
        paths: (await git(w.dir, ['diff', '--no-renames', '--name-only', '-z', head, tip, '--', '.', ...workerOwnedPaths(w).exclusions])).split('\0').filter(Boolean).sort(),
      }
      return false
    }
    // The operation's single read is already pinned, including any foreign commit
    // found there. CAS can erase only that exact name/value; a later move survives.
    const recoveryRefs = new Set(branchCleanup.recoveryRef ? [branchCleanup.recoveryRef] : [])
    await withGitWorktreeOperation(common, async () => {
      verify()
      if (discarded) {
        if (!ownerRecord?.discard) throw new Error('discard recovery plan missing; checkout retained')
        if (!ownerRecord.discard.steps.removing) {
          readyDiscardRecovery(common, w, ownerRecord.discard, recoveryRefs)
          await registry.markDiscardStep(w.id, 'removing')
          // Journaling yields; keep the final checks and removal adjacent and synchronous.
          verify()
        }
        readyDiscardRecovery(common, w, ownerRecord.discard, recoveryRefs)
      }
      boundedGitSync(common, ['--git-dir', common, '-c', 'core.hooksPath=/dev/null', 'worktree', 'remove', ...(collected ? ['--force'] : []), w.dir])
    })
    deletePreservedWorkerBranch(common, w, branchCleanup)
    for (const ref of privateWorkerRefs(w)) deleteWorkerRecordRef(common, ref, ownerRecord!, recoveryRefs)
    if (preservation) preservation.recoveryRefs = [...recoveryRefs]
    else for (const ref of recoveryRefs) console.info(`worker ${w.tag} branch recovery ref: ${recoveryRefDescription(common, ref)}`)
  } catch (error) {
    // Reconstructing/resetting the public path can overwrite a different checkout after partial cleanup.
    // The pin was written before removal was attempted: say so, or it expires in seven days unannounced.
    // First, because callers shorten long reasons from the end.
    const snapshot = ownerRecord?.discard?.recoveryRef
    const pinned = (snapshot ? `recovery ref: ${recoveryRefDescription(common, snapshot)}; ` : '')
      + (branchCleanup.recoveryRef && !recoveryRefCovers(common, snapshot, branchCleanup.recoveryRef)
        ? `branch recovery ref: ${recoveryRefDescription(common, branchCleanup.recoveryRef)}; ` : '')
    throw new Error(pinned + retainCheckout(common, w, `cleanup incomplete: ${error instanceof Error ? error.message : String(error)}; inspect retained files and refs before retrying`))
  }
  if (w.id) {
    const record = await registry.read(w.id)
    if (record) cleanupWorkerLogs(leadDir, record)
  }
  return true
}

/** The log and shell files Room wrote beside a worker's checkout; undefined when their folder cannot be told from the checkout. */
function workerSidecars(leadDir: string, { tag, dir, outside, logFile }: Pick<WorkerRecord, 'dir' | 'tag' | 'outside' | 'logFile'>): string[] | undefined {
  const logRoot = outside && logFile && path.basename(logFile) === `${tag}.log`
    && path.basename(path.dirname(logFile)) === 'workers' && path.basename(path.dirname(path.dirname(logFile))) === '.room'
    ? path.resolve(logFile, '../../..') : leadDir
  const parent = !outside && path.basename(path.dirname(dir)) === 'workers' && path.basename(path.dirname(path.dirname(dir))) === '.room'
    ? path.resolve(dir, '../../..') : logRoot
  if (outside && (path.resolve(parent) === path.resolve(dir) || path.resolve(parent).startsWith(path.resolve(dir) + path.sep))) return undefined
  return ['.log', '.mcp.log', '.env.sh', '.shell-env.mjs'].map(suffix => path.join(parent, WORKERS_DIR, tag + suffix))
}

/** Whether cleanupWorkerLogs would find anything to delete. Costs a few stats and takes no lock. */
export function hasWorkerLogs(leadDir: string, record: Pick<WorkerRecord, 'dir' | 'tag' | 'outside' | 'logFile'>): boolean {
  return !!workerSidecars(leadDir, record)?.some(file => fs.existsSync(file))
}

/** Record identity and sidecar ownership are mandatory; LocalWorker is insufficient for outside checkouts.
 * The optional readiness check runs synchronously under the same guard as every reservation creation/reuse. */
export function cleanupWorkerLogs(leadDir: string, record: Pick<WorkerRecord, 'id' | 'dir' | 'tag' | 'outside' | 'logFile'>,
  ready: () => boolean = () => true): boolean {
  const root = path.join(commonGitDirFromDotGit(leadDir), 'room', 'registry')
  return withWorkerTag(root, record.tag, () => {
    const tagFile = workerTagFile(root, record.tag)
    if (fs.existsSync(tagFile)) {
      // Corrupt reservations are evidence, never permission to delete files.
      const reservation = JSON.parse(fs.readFileSync(tagFile, 'utf8')) as { id?: string } | null
      if (!reservation || reservation.id !== record.id) return false
    }
    if (!ready()) return false
    const sidecars = workerSidecars(leadDir, record)
    if (!sidecars) return false
    for (const file of sidecars) {
      try { fs.rmSync(file, { force: true }) } catch { /* keep the log if the OS locks it */ }
    }
    // Public parent directories have no creation receipt. Leave them routinely;
    // they are not cleanup candidates or retained worker items.
    return true
  })
}

/** Snapshot tracked and non-ignored untracked content without touching the worker's index or files. */
export async function saveDiscardRecovery(leadDir: string, w: LocalWorker): Promise<{ recoveryRef: string; unchanged: boolean }> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'room-discard-'))
  try {
    const common = await realGitCommonDir(leadDir)
    const branch = operationBranchReceipt(common, w.id)
    if (branch?.reason) throw new Error(branch.reason)
    const run = (args: string[]) => boundedGit(w.dir, args, UNKNOWN_WHOLE_TREE_PATHS, { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') })
    const head = (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).toString().trim()
    await run(['read-tree', head])
    // Add first: Git rejects even exclusion pathspecs naming ignored linked inputs.
    await run(['add', '-A', '--', '.'])
    // The real index can track new files now ignored by working-tree rules.
    const trackedIgnored = (await git(w.dir, ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    const candidates = new Set([...trackedIgnored, ...(w.carriedUntracked ?? []).map(p => p.path)])
    const explicit = [...candidates].filter(p => {
      if (workerOwnedPaths(w).includes(p)) return false
      try { const stat = fs.lstatSync(path.join(w.dir, p)); return stat.isFile() || stat.isSymbolicLink() }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error }
    })
    if (explicit.length) {
      const paths = path.join(scratch, 'paths')
      fs.writeFileSync(paths, explicit.map(p => ':(literal)' + p + '\0').join(''), { mode: 0o600 })
      await run(['add', '-f', '--pathspec-from-file=' + paths, '--pathspec-file-nul'])
    }
    if (w.link?.length) await run(['rm', '-r', '-f', '--cached', '--ignore-unmatch', '--', ...w.link.map(p => ':(literal)' + p)])
    const tree = (await run(['write-tree'])).toString().trim()
    const unchanged = tree === (await run(['rev-parse', `${head}^{tree}`])).toString().trim()
    const tip = unchanged ? head : (await run(['-c', 'user.name=Room', '-c', 'user.email=room@localhost', '-c', 'commit.gpgsign=false',
      'commit-tree', tree, '-p', head, '-m', 'Room discard recovery'])).toString().trim()
    const pin = preserveWorkerBranch(common, w, { tip })
    if (!pin.recoveryRef) throw new Error(pin.reason ?? 'could not preserve discard recovery commit')
    return { recoveryRef: pin.recoveryRef, unchanged }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}

/** Per-file cap for carry at spawn; collection (collect.ts) uses the same ceiling. */
export const CARRY_FILE_LIMIT = 5 * 1024 * 1024

/** Carry's limits bound saved scratch too. */
const SCRATCH_FILE_LIMIT = CARRY_FILE_LIMIT, SCRATCH_TOTAL_LIMIT = 50 * 1024 * 1024
const SCRATCH_DIR = path.join('.room', 'scratch')
// Scratch from an earlier process has no current creation receipt: retain it rather than guess.
const scratchRoots = new Map<string, ReturnType<typeof rootIdentity>>()

/**
 * Copy workers' scratch (untracked logs and temp files collect does not bring in) to <lead>/.room/scratch/<tag>/
 * before their worktrees are removed; a re-collect of a tag replaces its folder. No link is followed on either side:
 * a linked .room, .room/scratch or source path is refused and named, as is a file over carry's limits.
 */
export function saveWorkerScratch(leadRoot: string, workers: readonly { tag: string; root: string; paths: Iterable<string> }[]): { saved: Map<string, string[]>; skipped: { tag: string; path: string; reason: string }[] } {
  const saved = new Map<string, string[]>(), skipped: { tag: string; path: string; reason: string }[] = []
  let total = 0
  const realDir = (dir: string) => {
    try { if (!fs.lstatSync(dir).isDirectory()) return false } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; fs.mkdirSync(dir) }
    return fs.lstatSync(dir).isDirectory()
  }
  for (const { tag, root, paths } of workers) {
    const list = [...paths].sort()
    if (!list.length) continue
    const refuse = (reason: string) => { for (const p of list) skipped.push({ tag, path: p, reason }) }
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(tag)) { refuse('invalid worker tag'); continue }
    if (!realDir(path.join(leadRoot, '.room')) || !realDir(path.join(leadRoot, SCRATCH_DIR))) { refuse('.room or .room/scratch is not a plain folder'); continue }
    const target = path.join(leadRoot, SCRATCH_DIR, tag)
    try { if (fs.lstatSync(target).isSymbolicLink()) { refuse(`${SCRATCH_DIR}/${tag} is a link`); continue } }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    if (fs.existsSync(target)) {
      const known = scratchRoots.get(target), actual = rootIdentity(target)
      if (!known || known.dev !== actual.dev || known.ino !== actual.ino || known.birthtimeNs !== actual.birthtimeNs) {
        const reason = `scratch ownership receipt is unknown or changed; kept ${target}`
        const common = commonGitDirFromDotGit(leadRoot)
        if (fs.existsSync(path.join(common, 'HEAD'))) retainWorkerItem(common, { kind: 'directory', path: target, tag, reason })
        refuse(reason); continue
      }
      fs.rmSync(target, { recursive: true })
    }
    fs.mkdirSync(target)
    if (scratchRoots.size >= 1024) scratchRoots.delete(scratchRoots.keys().next().value!)
    scratchRoots.set(target, rootIdentity(target))
    for (const p of list) {
      const skip = (reason: string) => skipped.push({ tag, path: p, reason })
      if (!validRepoPath(p, MATERIALIZED_PATH)) { skip('unsafe path'); continue }
      let fd: number
      try {
        if (!containedRepoPath(root, path.join(root, p), { leaf: 'reject-link' }).ok) { skip('link'); continue }
        fd = fs.openSync(path.join(root, p), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      } catch (e) { skip((e as NodeJS.ErrnoException).code === 'ELOOP' ? 'link' : 'unreadable'); continue }
      try {
        const stat = fs.fstatSync(fd)
        if (!stat.isFile()) { skip('not a file'); continue }
        if (stat.size > SCRATCH_FILE_LIMIT) { skip('over 5 MB'); continue }
        if (total + stat.size > SCRATCH_TOTAL_LIMIT) { skip('over the 50 MB total'); continue }
        const bytes = Buffer.alloc(stat.size)
        let read = 0
        while (read < bytes.length) { const n = fs.readSync(fd, bytes, read, bytes.length - read, read); if (!n) break; read += n }
        const destination = path.join(target, p)
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.writeFileSync(destination, bytes.subarray(0, read), { flag: 'wx', mode: stat.mode & 0o777 })
        total += read
        saved.set(tag, [...saved.get(tag) ?? [], p])
      } finally { fs.closeSync(fd) }
    }
  }
  return { saved, skipped }
}
