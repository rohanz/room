import { privateStateDirectory } from '@room/relay'
import { realGitCommonDir, validRepoPath, MATERIALIZED_PATH } from '@room/roomd'
import { gitWholeTree, wholeTreeTimeoutMs } from '@room/roomd/git'
import { boundedGitSync } from '@room/roomd/baseline'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withGuard } from './leases.js'

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
}
type PreviewCompletion = Pick<PreviewEvidence, 'complete' | 'exitCode' | 'passed' | 'reason'>
type Observations = { root: string; paths: string[]; files: { rel: string; before: fs.Stats | null }[] }
const observationsOf = new WeakMap<TreeFingerprint, Observations>()
const MAX_RECORD_BYTES = 8 * 1024 * 1024
const split = (text: string) => text.split('\0').filter(Boolean)
const evidenceLimits = 'same files, same command only; Git state (HEAD, refs, index), environment and ignored files are not compared; rerun commands that read Git state on the collected tree; files written by another process during collect are outside the guarantee'

const listArgs = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
const sortedPaths = (text: string) => [...new Set(split(text))].sort()

/**
 * The actual materialized checkout, including new non-ignored paths written by a command.
 * A private ancestor index makes enumeration identical for cached and repository-free trees,
 * without consulting or changing the lead's staging area. The index lives outside the tree.
 */
export async function createPreviewTreePaths(repo: string, ancestor: string, dir: string, signal?: AbortSignal) {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'room-preview-paths-'))
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') }
  const prefix = [`--work-tree=${dir}`, '-c', 'core.sparseCheckout=false', '-c', 'core.sparseCheckoutCone=false', '-c', 'core.splitIndex=false', '-c', 'index.sparse=false', '-c', 'core.untrackedCache=false', '-c', 'core.fsmonitor=false']
  const run = (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile('git', [...prefix, ...args], { cwd: repo, env, signal, timeout: wholeTreeTimeoutMs(), maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout))
  })
  const dispose = () => fs.promises.rm(temporary, { recursive: true, force: true })
  try { await run(['read-tree', ancestor]) }
  catch (error) { await dispose(); throw error }
  return {
    paths: async () => sortedPaths(await run(listArgs)),
    pathsSync: () => sortedPaths(boundedGitSync(repo, [...prefix, ...listArgs], { env, wholeTreePaths: 10_000 }).toString()),
    dispose,
  }
}

/** Read-only enumeration: staged contents are irrelevant; fingerprint the files actually on disk. */
async function collectedTreePaths(dir: string): Promise<string[]> {
  return sortedPaths(await gitWholeTree(dir, listArgs))
}

/**
 * Hash raw bytes and all permission bits, rather than Git blobs: clean filters, CRLF conversion and
 * core.fileMode can otherwise make different check inputs look identical. Memory is bounded by four
 * streaming reads plus the path/hash manifest; no index, object, stash or ref is written. Unsupported
 * entries (e.g. submodule directories), unsafe ancestors and files moving during a read fail closed.
 */
export async function fingerprintTree(dir: string, paths: readonly string[], signal?: AbortSignal): Promise<TreeFingerprint> {
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
  files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const tree = { hash: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files }
  observationsOf.set(tree, { root, paths: [...paths].sort(), files: observations })
  return tree
}

/** No await between this final gate and the caller's launch/report decision. External writers need quiescence. */
export function validateFingerprintSync(tree: TreeFingerprint, paths: readonly string[]): void {
  const observed = observationsOf.get(tree)
  if (!observed || JSON.stringify(observed.paths) !== JSON.stringify([...paths].sort())) throw new Error('included path set changed')
  for (const { rel, before } of observed.files) {
    const file = path.join(observed.root, rel)
    let after: fs.Stats | null
    try { after = fs.lstatSync(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') after = null; else throw error }
    if (before === null ? after !== null : after === null || !sameFile(before, after)) throw new Error('file changed during fingerprint: ' + rel)
    if (after && fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error('fingerprint path has a linked ancestor: ' + rel)
  }
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
    try { return withGuard<T>(path.join(root, prefix + 'publication'), (() => { entered = true; return fn() }) as () => T extends PromiseLike<unknown> ? never : T) }
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

function writeEvidenceSync(file: string, record: PreviewEvidence): void {
  const text = JSON.stringify(record)
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error('preview evidence exceeds 8 MiB; validate the collected tree')
  const temporary = `${file}.${randomUUID()}.tmp`
  try { fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file) }
  finally { fs.rmSync(temporary, { force: true }) }
}

/** The guarded pending publication starts the attempt, before any asynchronous preview setup. */
export async function beginPreviewAttempt(clone: string, command: string, at = new Date().toISOString()) {
  const { root, prefix } = await location(clone)
  const file = evidenceFile(root, prefix)
  const pending: PreviewEvidence = { version: 3, nonce: randomUUID(), tree: null, head: null, command, at, complete: false, exitCode: null, passed: false }
  await guardedPublisher(root, prefix, () => writeEvidenceSync(file, pending))
  return (tree: TreeFingerprint | null, completion: PreviewCompletion, head: string | null = null): Promise<boolean> => guardedPublisher(root, prefix, () => {
    if (readEvidenceSync(file)?.nonce !== pending.nonce) return false
    writeEvidenceSync(file, { ...pending, tree, head, ...completion })
    return true
  })
}

/** A diagnostic must never turn an already-applied collection into an apparent failure. */
export async function collectedTreeEvidence(clone: string): Promise<string> {
  try {
    const { root, prefix } = await location(clone)
    const paths = await collectedTreePaths(clone)
    const tree = await fingerprintTree(clone, paths)
    if (JSON.stringify(paths) !== JSON.stringify(await collectedTreePaths(clone))) throw new Error('paths changed during fingerprint')
    // No guard, wait or fsync: one immutable record snapshot, then the non-yielding file gate/decision.
    const record = readEvidenceSync(evidenceFile(root, prefix))
    const limits = evidenceLimits
    if (!record) return `no preview ran a command on this tree; validate it; ${limits}`
    const info = `${JSON.stringify(record.command)} (preview at ${record.at})`
    if (record.tree === null) return `the most recent preview was incomplete ${info}; no preview result is recorded for this tree; validate it; ${limits}`
    const head = boundedGitSync(clone, ['rev-parse', 'HEAD']).toString().trim()
    validateFingerprintSync(tree, sortedPaths(boundedGitSync(clone, listArgs, { wholeTreePaths: paths.length }).toString()))
    if (record.tree.hash === tree.hash) {
      const reason = record.reason ? `; ${record.reason}` : ''
      if (record.head !== head) return `collected tree has identical files to the most recent preview ${info}; HEAD moved from ${record.head} to ${head}; ${passed(record) ? 'command exited 0' : record.complete ? 'preview failed' : 'preview was incomplete'}${reason}; validate it; ${limits}`
      if (passed(record)) return `collected tree is identical to the tree that passed ${info}: the most recent preview of this checkout; ${limits}`
      if (record.complete === true) return `collected tree is identical to the tree whose preview failed ${info}: exit ${record.exitCode}${reason}; validate it; ${limits}`
      return `collected tree is identical to the tree whose preview was incomplete ${info}${reason}; validate it; ${limits}`
    }
    const previous = new Map(record.tree.files.map(([rel, mode, hash]) => [rel, `${mode}:${hash}`]))
    const current = new Map(tree.files.map(([rel, mode, hash]) => [rel, `${mode}:${hash}`]))
    const changed = [...new Set([...previous.keys(), ...current.keys()])].filter(rel => previous.get(rel) !== current.get(rel)).sort()
    return `no preview result is recorded for this tree; validate it; collected tree differs from the most recent preview in ${changed.length} file(s): ${changed.slice(0, 8).map(rel => /[\n\r\t]/.test(rel) ? JSON.stringify(rel) : rel).join(', ')}${changed.length > 8 ? ', …' : ''}; ${limits}`
  } catch (error) {
    return `collected tree equivalence unavailable: ${error instanceof Error ? error.message : String(error)}; validate it; ${evidenceLimits}`
  }
}
