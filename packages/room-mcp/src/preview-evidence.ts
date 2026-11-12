import { privateStateDirectory } from '@room/relay'
import { realGitCommonDir, validRepoPath, MATERIALIZED_PATH } from '@room/roomd'
import { gitWholeTree, wholeTreeTimeoutMs } from '@room/roomd/git'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withGuardAsync } from './leases.js'
import { assertCollectLease } from './collect-lease.js'
import { boundedGitSync } from '@room/roomd/baseline'
import { batchBudget, sortedCopy, normalizedPaths, boundedJson } from './preview-batches.js'

type TreeFile = [path: string, mode: number, sha256: string]
export interface TreeFingerprint { hash: string; files: TreeFile[] }
interface PreviewEvidence {
  version: 3
  nonce: string
  tree: TreeFingerprint | null
  command: string
  at: string // Display only. Ownership never depends on a clock.
  head: string | null
  complete: boolean
  exitCode: number | null
  passed: boolean
  reason?: string
  equivalence?: 'too-large'
}
type PreviewCompletion = Pick<PreviewEvidence, 'complete' | 'exitCode' | 'passed' | 'reason' | 'equivalence'>
type Observations = { root: string; paths: string[]; files: { rel: string; before: fs.Stats | null }[] }
const observationsOf = new WeakMap<TreeFingerprint, Observations>()
const MAX_RECORD_BYTES = 8 * 1024 * 1024
/** File count bounds synchronous metadata work, not time: deep paths, a slow
 * filesystem and Git traversal of untracked/ignored directories can exceed it. */
export const MAX_EQUIVALENCE_FILES = 2_000
const displayedLimit = MAX_EQUIVALENCE_FILES.toLocaleString('en-US')
export const largeTreeReply = `tree too large to compare cheaply (more than ${displayedLimit} files); validate it`
export const largeTreeReason = `equivalence was not established because the tree has more than ${displayedLimit} files`
export class EquivalenceTooLarge extends Error {
  constructor() { super(largeTreeReason) }
}
/** Count at most N+1 distinct paths before any whole-tree sort/Set/JSON work. */
function cappedPaths(text: string): string[] {
  const paths = new Set<string>()
  let start = 0
  while (start < text.length) {
    const end = text.indexOf('\0', start), next = end < 0 ? text.length : end
    if (next > start) {
      paths.add(text.slice(start, next))
      if (paths.size > MAX_EQUIVALENCE_FILES) throw new EquivalenceTooLarge()
    }
    start = next + 1
  }
  return [...paths].sort() // At most 2,000 entries, including duplicate Git stages.
}
const evidenceLimits = 'same files, same command only; Git state (HEAD, refs, index), environment and ignored files are not compared; rerun commands that read Git state on the collected tree; files written by another process during collect are outside the guarantee'

const listArgs = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
const sortedPaths = normalizedPaths

/**
 * The actual materialized checkout, including new non-ignored paths written by a command.
 * A private ancestor index makes enumeration identical for cached and repository-free trees,
 * without consulting or changing the lead's staging area. The index lives outside the tree.
 */
export async function createPreviewTreePaths(repo: string, ancestor: string, dir: string, signal?: AbortSignal) {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'room-preview-paths-'))
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') }
  const prefix = [`--work-tree=${dir}`, '-c', 'core.sparseCheckout=false', '-c', 'core.sparseCheckoutCone=false', '-c', 'core.splitIndex=false', '-c', 'index.sparse=false', '-c', 'core.untrackedCache=false', '-c', 'core.fsmonitor=false']
  const run = (args: string[], runSignal = signal) => new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof execFile> | undefined
    child = execFile('git', [...prefix, ...args], { cwd: repo, env, signal: runSignal, timeout: wholeTreeTimeoutMs(), maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      const finish = () => error ? reject(error) : resolve(stdout)
      // Abort can invoke execFile's callback before its child has closed. The
      // private index/tree must not be disposed while that reader still runs.
      if (error && child && child.exitCode === null && child.signalCode === null) child.once('close', finish)
      else finish()
    })
  })
  const dispose = () => fs.promises.rm(temporary, { recursive: true, force: true })
  try { await run(['read-tree', ancestor]) }
  catch (error) { await dispose(); throw error }
  return {
    paths: async (runSignal = signal) => sortedPaths(await run(listArgs, runSignal), runSignal),
    eligiblePaths: async (runSignal = signal) => cappedPaths(await run(listArgs, runSignal)),
    pathsSync: () => cappedPaths(boundedGitSync(repo, [...prefix, ...listArgs], { env, wholeTreePaths: MAX_EQUIVALENCE_FILES }).toString()),
    dispose,
  }
}

/** Read-only enumeration: staged contents are irrelevant; fingerprint the files actually on disk. */
async function collectedTreePaths(dir: string): Promise<string[]> {
  return cappedPaths(await gitWholeTree(dir, listArgs))
}

/**
 * Hash raw bytes and all permission bits, rather than Git blobs: clean filters, CRLF conversion and
 * core.fileMode can otherwise make different check inputs look identical. Memory is bounded by four
 * streaming reads plus the path/hash manifest; no index, object, stash or ref is written. Unsupported
 * entries (e.g. submodule directories), unsafe ancestors and files moving during a read fail closed.
 */
export async function fingerprintTree(dir: string, paths: readonly string[], signal?: AbortSignal): Promise<TreeFingerprint> {
  if (paths.length > MAX_EQUIVALENCE_FILES) throw new EquivalenceTooLarge()
  const root = await fs.promises.realpath(dir)
  const files: TreeFile[] = []
  const observations: { rel: string; before: fs.Stats | null }[] = []
  let next = 0
  const read = async () => {
    while (next < paths.length) {
      signal?.throwIfAborted()
      const rel = paths[next++]!
      // The Git helper decodes UTF-8. Refuse undecodable names instead of omitting their
      // bytes as ENOENT after a replacement character changed the path.
      if (rel.includes('\uFFFD') || !validRepoPath(rel, MATERIALIZED_PATH)) throw new Error('unsafe fingerprint path: ' + rel)
      const file = path.join(root, rel)
      let before: fs.Stats
      try { before = await fs.promises.lstat(file) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { observations.push({ rel, before: null }); continue }
        throw error
      }
      observations.push({ rel, before })
      const parent = await fs.promises.realpath(path.dirname(file))
      if (parent !== path.dirname(file)) throw new Error('fingerprint path has a linked ancestor: ' + rel)
      const hash = createHash('sha256')
      if (before.isSymbolicLink()) hash.update(await fs.promises.readlink(file, { encoding: 'buffer' }))
      else if (before.isFile()) {
        const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        try {
          const opened = await handle.stat()
          if (!sameFile(before, opened)) throw new Error('file changed during fingerprint: ' + rel)
          for await (const chunk of handle.createReadStream({ autoClose: false, signal })) hash.update(chunk)
        } finally { await handle.close() }
      } else throw new Error('unsupported fingerprint entry: ' + rel)
      if (!sameFile(before, await fs.promises.lstat(file))) throw new Error('file changed during fingerprint: ' + rel)
      files.push([rel, before.isSymbolicLink() ? 0o120000 : before.mode & 0o7777, hash.digest('hex')])
    }
  }
  // Await every reader even on failure: none may outlive cleanup of the preview tree.
  await readers(read)
  // Revalidate the entire observation after all bytes were read. A lead can change
  // an early file while a later one streams; per-file checks alone miss that race.
  let checking = 0
  await readers(async () => {
    while (checking < observations.length) {
      signal?.throwIfAborted()
      const { rel, before } = observations[checking++]!
      const file = path.join(root, rel)
      const after = await fs.promises.lstat(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (before === null ? after !== null : after === null || !sameFile(before, after)) throw new Error('file changed during fingerprint: ' + rel)
      if (after && await fs.promises.realpath(path.dirname(file)) !== path.dirname(file)) throw new Error('fingerprint path has a linked ancestor: ' + rel)
    }
  })
  const ordered = await sortedCopy(files, ([a], [b]) => a < b ? -1 : a > b ? 1 : 0, signal)
  const bytes = await boundedJson(ordered, MAX_RECORD_BYTES, signal)
  const tree = { hash: createHash('sha256').update(bytes).digest('hex'), files: ordered }
  const orderedPaths = await sortedCopy(paths, (a, b) => a < b ? -1 : a > b ? 1 : 0, signal)
  observationsOf.set(tree, { root, paths: orderedPaths, files: observations })
  return tree
}

/** Run synchronously after the final await and path listing, through the decision.
 * One stat/ancestor observation covers both byte fingerprints, including rewrites. */
export function validateFingerprintSync(tree: TreeFingerprint, paths: readonly string[], also?: TreeFingerprint): void {
  if (paths.length > MAX_EQUIVALENCE_FILES) throw new EquivalenceTooLarge()
  const observed = observationsOf.get(tree), second = also && observationsOf.get(also)
  if (!observed || also && !second) throw new Error('unobserved fingerprint')
  if (observed.paths.length !== paths.length || second && second.paths.length !== paths.length) throw new Error('included path set changed')
  // Callers supply sorted paths from Git; the direct API historically accepted
  // unsorted lists too. Sorting is capped at N before this point.
  const ordered = [...paths].sort()
  for (let i = 0; i < ordered.length; i++) {
    if (observed.paths[i] !== ordered[i] || second && second.paths[i] !== ordered[i]) throw new Error('included path set changed')
  }
  const other = second && new Map(second.files.map(entry => [entry.rel, entry.before]))
  for (const { rel, before } of observed.files) {
    const file = path.join(observed.root, rel)
    let after: fs.Stats | null
    try { after = fs.lstatSync(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') after = null; else throw error }
    const changed = (prior: fs.Stats | null) => prior === null ? after !== null : after === null || !sameFile(prior, after)
    if (changed(before) || other && (!other.has(rel) || changed(other.get(rel)!))) throw new Error('file changed during fingerprint: ' + rel)
    if (after && fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error('fingerprint path has a linked ancestor: ' + rel)
  }
}

/** Cancellation test seam retained for review regressions. Production calls the
 * synchronous gate directly after its last await, never this async convenience. */
export async function validateFingerprint(tree: TreeFingerprint, listPaths: () => Promise<readonly string[]>, signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted()
  const paths = await listPaths()
  signal?.throwIfAborted()
  validateFingerprintSync(tree, paths)
  return () => { signal?.throwIfAborted() }
}

async function readers(read: () => Promise<void>): Promise<void> {
  const results = await Promise.allSettled(Array.from({ length: 4 }, read))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

async function location(clone: string): Promise<{ root: string; prefix: string }> {
  const common = await realGitCommonDir(clone)
  const root = path.join(common, 'room', 'preview-evidence')
  const prefix = createHash('sha256').update(await fs.promises.realpath(clone)).digest('hex') + '-'
  return { root, prefix }
}

const passed = (record: PreviewEvidence) => record.tree !== null && record.complete === true && record.exitCode === 0 && record.passed === true
const evidenceFile = (root: string, prefix: string) => path.join(root, prefix + 'latest.json')

/** Only publishers acquire this guard. Readers take one atomic record snapshot. */
async function guardedPublisher<T>(root: string, prefix: string, fn: () => T): Promise<T> {
  privateStateDirectory(root)
  const deadline = performance.now() + 30_000
  for (;;) {
    let entered = false
    try { return await withGuardAsync<T>(path.join(root, prefix + 'publication'), (() => { entered = true; return fn() }) as () => T extends PromiseLike<unknown> ? never : T) }
    catch (error) {
      if (entered || !(error instanceof Error) || !error.message.startsWith('lease guard busy: ')) throw error
      if (performance.now() >= deadline) throw new Error('preview publisher guard wait exceeded 30000 ms')
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - performance.now()))))
    }
  }
}

/** Atomic rename/unlink leaves this descriptor's immutable snapshot intact. Opening it is the read's linearization point. */
function readEvidenceSync(file: string): PreviewEvidence | undefined {
  let fd: number
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error('preview evidence exceeds record limit or is not a file')
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    if (length !== stat.size) throw new Error('preview evidence changed while reading')
    const record = JSON.parse(bytes.subarray(0, length).toString('utf8')) as PreviewEvidence
    if (record.version !== 3 || typeof record.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(record.nonce) || typeof record.command !== 'string' || typeof record.at !== 'string') throw new Error('invalid preview evidence')
    if (record.tree !== null) {
      if (!Array.isArray(record.tree?.files) || createHash('sha256').update(JSON.stringify(record.tree.files)).digest('hex') !== record.tree.hash) throw new Error('invalid preview fingerprint')
      if (typeof record.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(record.head)) throw new Error('invalid preview HEAD')
    }
    return record
  } finally { fs.closeSync(fd) }
}

function writeEvidenceSync(file: string, text: Buffer): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try { fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file) }
  finally { fs.rmSync(temporary, { force: true }) }
}

/** The guarded pending publication starts the attempt, before any asynchronous preview setup. */
export async function beginPreviewAttempt(clone: string, command: string, at = new Date().toISOString()) {
  const { root, prefix } = await location(clone)
  const file = evidenceFile(root, prefix)
  const pending: PreviewEvidence = { version: 3, nonce: randomUUID(), tree: null, head: null, command, at, complete: false, exitCode: null, passed: false }
  const initial = await boundedJson(pending, MAX_RECORD_BYTES)
  await guardedPublisher(root, prefix, () => writeEvidenceSync(file, initial))
  return async (tree: TreeFingerprint | null, completion: PreviewCompletion, head: string | null = null, final?: () => void): Promise<boolean> => {
    const bytes = await boundedJson({ ...pending, tree, head, ...completion }, MAX_RECORD_BYTES)
    return guardedPublisher(root, prefix, () => {
      // Authority also governs the caller's reply when a newer record wins.
      final?.()
      if (readEvidenceSync(file)?.nonce !== pending.nonce) return false
      writeEvidenceSync(file, bytes)
      return true
    })
  }
}

/** A diagnostic must never turn an already-applied collection into an apparent failure. */
export async function collectedTreeEvidence(clone: string): Promise<string> {
  try {
    const { root, prefix } = await location(clone)
    assertCollectLease(clone)
    const paths = await collectedTreePaths(clone)
    const tree = await fingerprintTree(clone, paths)
    const head = (await gitWholeTree(clone, ['rev-parse', 'HEAD'])).trim()
    assertCollectLease(clone)
    validateFingerprintSync(tree, cappedPaths(boundedGitSync(clone, listArgs, { wholeTreePaths: MAX_EQUIVALENCE_FILES }).toString()))
    // No await between the final synchronous listing/gate, this immutable latest
    // record snapshot and the decision. No pre-await evidence can choose a pass.
    const record = readEvidenceSync(evidenceFile(root, prefix))
    assertCollectLease(clone)
    const limits = evidenceLimits
    if (!record) return `no preview ran a command on this tree; validate it; ${limits}`
    const info = `${JSON.stringify(record.command)} (preview at ${record.at})`
    if (record.equivalence === 'too-large') return `the most recent preview did not establish equivalence ${info}: ${record.reason ?? largeTreeReason}; validate it; ${limits}`
    if (record.tree === null) return `the most recent preview was incomplete ${info}; no preview result is recorded for this tree; validate it; ${limits}`
    if (record.tree.hash === tree.hash) {
      const reason = record.reason ? `; ${record.reason}` : ''
      if (record.head !== head) return `collected tree has identical files to the most recent preview ${info}; HEAD moved from ${record.head} to ${head}; ${passed(record) ? 'command exited 0' : record.complete ? 'preview failed' : 'preview was incomplete'}${reason}; validate it; ${limits}`
      if (passed(record)) return `collected tree is identical to the tree that passed ${info}: the most recent preview of this checkout; ${limits}`
      if (record.complete === true) return `collected tree is identical to the tree whose preview failed ${info}: exit ${record.exitCode}${reason}; validate it; ${limits}`
      return `collected tree is identical to the tree whose preview was incomplete ${info}${reason}; validate it; ${limits}`
    }
    // A differing-tree result cannot promote a pass; its diagnostic can yield after
    // taking the immutable evidence snapshot. Compare sorted manifests by merge.
    const changed: string[] = [], budget = batchBudget()
    let left = 0, right = 0, count = 0
    while (left < record.tree.files.length || right < tree.files.length) {
      const old = record.tree.files[left], current = tree.files[right]
      let rel: string | undefined
      if (!old || current && current[0] < old[0]) { rel = current![0]; right++ }
      else if (!current || old[0] < current[0]) { rel = old[0]; left++ }
      else { if (old[1] !== current[1] || old[2] !== current[2]) rel = old[0]; left++; right++ }
      if (rel !== undefined) { count++; if (changed.length < 8) changed.push(rel) }
      const wait = budget(); if (wait) await wait
    }
    return `no preview result is recorded for this tree; validate it; collected tree differs from the most recent preview in ${count} file(s): ${changed.map(rel => /[\n\r\t]/.test(rel) ? JSON.stringify(rel) : rel).join(', ')}${count > 8 ? ', …' : ''}; ${limits}`

  } catch (error) {
    if (error instanceof EquivalenceTooLarge) return largeTreeReply
    return `collected tree equivalence unavailable: ${error instanceof Error ? error.message : String(error)}; validate it; ${evidenceLimits}`
  }
}
