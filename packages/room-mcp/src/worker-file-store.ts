import { deleteWorkerRef, restoreWorkerRef, preserveWorkerBranch, captureWorkerBranch, operationBranchReceipt } from './worker-refs.js'
import { removePreparation, verifyWorkerCheckout, retainCheckout } from './worker-preparation.js'
import { workerTagFile, withWorkerTag } from './worker-tags.js'
import { retainedSessionMissing } from './hosts/lifecycle.js'
import type { HostId } from './hosts/types.js'
/** The local source of truth for worker operations. No replicated document grants local authority. */
import { privateStateDirectory } from '@room/relay'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { boundedGitSync } from '@room/roomd/baseline'
import { performance } from 'node:perf_hooks'
import * as Y from 'yjs'
import { completionId, completionMessage, RoomDoc, ROOM_DOC_MAX_BYTES } from '@room/shared'
import { compareAndRelease, createExclusive, liveness, recover, replace, withGuard, writeAtomic, type InstanceToken } from './leases.js'
import { scanRunLog, runLogIdentity } from './run-log-facts.js'
import { followUpAnswer, hostFailure, hostFailureLine, mcpStopReason, probeOwnProcess, probeProcess, probeProcessNow, unawaitedBackgroundTasks, workerLogTail } from './worker-process.js'
import { HOST_ENDED, statusOf, type ExitObservation, type LivenessProbe, type Run, type RunReport, type WorkerRecord, type WorkerStatusResult } from './worker-status.js'
import type { RetiredWorker } from '@room/shared'
import { isOwnedWorkerWorktree, roomWorkerPathMatchesBranch } from './worker-state.js'
import { realStateInput } from './worker-status.js'
import { cleanupWorker, cleanupWorkerLogs, ignoredWorkerArtifacts, inheritWorkerRefs, removeWorkerRefs, pruneMissingWorkerWorktree, saveDiscardPatch } from './worker-git.js'
import { pidAlive, quiesceWorktreeProcesses, signalWorker, stopWorkerWithEscalation } from './worker-process.js'
import { safeId, safeTag, object, tokenShape, keptPublicationShape, recordShape, reportShape, exitShape, admittedHost, laterDone } from './worker-codecs.js'
import { ended, WorkerEvidenceBlocked, requireWorkerInventory, recordStatus, type WorkerInventory, applyWorkerCommand, type WorkerCommand, type WorkerSnapshot, type WorkerQuery } from './worker-store.js'
import { sameStartTime } from '@room/relay/process'
import { withCollectLeaseAssertion } from './collect-lease.js'
import { readBoundedFileSync } from '@room/roomd'

export interface RegistryOptions {
  liveness?: LivenessProbe; now?: () => number; identity?: InstanceToken; watch?: boolean
}
const readJson = <T>(file: string): T | undefined => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T }
  catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return undefined; throw e }
}
const files = (dir: string, suffix: string): string[] => {
  try { return fs.readdirSync(dir).filter(n => n.endsWith(suffix)).map(n => path.join(dir, n)) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
}
/**
 * Worker records, tag reservations and the record listing are read through a process-wide cache keyed by
 * path and validated by a stat on every call (device, inode, size, mtime and ctime). An unchanged file is not
 * read again, but only once the cached text was read after the file's last timestamp tick had certainly ended.
 *
 * A stat cannot prove that two writes got different timestamps: nanosecond fields do not establish nanosecond
 * resolution, and a file system may keep whole seconds (or two, as FAT does). So an entry is "racy" when the
 * file's newer timestamp was within RACY_NS of the clock at the time it was read: a later write in that same
 * tick could leave an identical stat. A racy entry is never a hit; the next call reads the file again, and the
 * first read made after the window has passed is trusted, because any write after it lands in a later tick.
 * A full reread is the content check here: record text is small, and a head/tail sample would miss an edit in
 * the middle of a JSON record. Each hit parses the cached text, so callers own the value they receive.
 */
const READ_CACHE_MAX = 4096
const RACY_NS = 2_000_000_000n
// One synchronous snapshot attempt owns this memo; snapshot() never yields while it is installed.
// A new call always rechecks racy files; repeated uses within the same attempt share one decoded input.
let snapshotReads: Map<string, { key: string; value: string | string[] }> | undefined
const readCache = new Map<string, { key: string; value: string | string[]; racy: boolean }>()
const statKey = (file: string): { key: string; newest: bigint } | undefined => {
  try {
    const s = fs.statSync(file, { bigint: true })
    return { key: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`, newest: s.mtimeNs > s.ctimeNs ? s.mtimeNs : s.ctimeNs }
  } catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return undefined; throw e }
}
function cached<T extends string | string[]>(file: string, load: () => T, slot = file, validate = false): T | undefined {
  // Decoding consumes exactly the inputs captured by the revision pass. Only the boundary passes
  // revalidate them; a replacement during decoding is caught by the second revision pass.
  const local = snapshotReads?.get(slot)
  if (local && !validate) return local.value as T
  // Stat before reading: a write racing the read leaves a key that no longer matches, never a stale hit.
  const stat = statKey(file)
  if (stat === undefined) { readCache.delete(slot); snapshotReads?.delete(slot); return undefined }
  if (local?.key === stat.key) return local.value as T
  const hit = readCache.get(slot)
  if (hit?.key === stat.key && !hit.racy) { snapshotReads?.set(slot, hit); return hit.value as T }
  // The clock is read just before the read it qualifies, so a hit never reads it. A timestamp ahead of this
  // clock (another host's clock on a shared file system) is racy too.
  const racy = BigInt(Date.now()) * 1_000_000n - stat.newest <= RACY_NS
  const value = load()
  readCache.delete(slot)
  if (readCache.size >= READ_CACHE_MAX) readCache.delete(readCache.keys().next().value as string)
  readCache.set(slot, { key: stat.key, value, racy })
  snapshotReads?.set(slot, { key: stat.key, value })
  return value
}
const readCachedJson = <T>(file: string): T | undefined => {
  let text: string | undefined
  try { text = cached(file, () => fs.readFileSync(file, 'utf8')) }
  catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return undefined; throw e }
  return text === undefined ? undefined : JSON.parse(text) as T
}
/** Decode only: preserve malformed bytes and let the owning caller decide how to handle evidence. */
function decodeFact<T>(file: string, valid: (value: unknown) => value is T, why: string):
  { ok: true; value: T | undefined } | { ok: false; error: unknown } {
  try {
    const value = readCachedJson<unknown>(file)
    if (value === undefined) return { ok: true, value: undefined }
    return valid(value) ? { ok: true, value } : { ok: false, error: why }
  } catch (error) { return { ok: false, error } }
}
const cachedFiles = (dir: string, suffix: string): string[] =>
  [...cached(dir, () => files(dir, suffix), `${dir}\0*${suffix}`) ?? []]
const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function base32(value: bigint, length: number): string {
  let out = ''
  for (let n = 0; n < length; n++) { out = crockford[Number(value & 31n)] + out; value >>= 5n }
  return out
}
const id = (): string => `w_${base32(BigInt(Date.now()), 10)}${base32(BigInt(`0x${randomBytes(10).toString('hex')}`), 16)}`
const synthetic = (): InstanceToken => ({ pid: process.pid, startTime: '', executable: '', sessionId: `mcp:${process.pid}`, nonce: randomBytes(16).toString('hex') })
/** Where the host writes the worker's log; an older record's owned worktree sits beside it in `.room/workers`. */
export function workerLogFile(record: Pick<WorkerRecord, 'dir' | 'tag' | 'logFile'>): string {
  return record.logFile ?? path.join(path.dirname(record.dir), `${record.tag}.log`)
}

/** " — background work was still running (…)" when the run's exit killed background shell tasks, else ''. */
export function backgroundAtExit(record: Pick<WorkerRecord, 'dir' | 'tag' | 'host' | 'logFile'>, run: Pick<Run, 'logStart'>): string {
  const killed = unawaitedBackgroundTasks(workerLogFile(record), run.logStart, record.host, runLogIdentity(record, run))
  return killed ? ` — background work was still running (${killed} background task(s) killed at exit)` : ''
}

/**
 * A run that exited cleanly without room_done gets the evidence from its log: the no-report summary names the
 * log path and the model's own parsed final text (never raw lines, see workerLogTail), and either form names
 * background shell tasks its exit killed (count only).
 */
function unreportedExit(record: WorkerRecord, status: WorkerStatusResult): WorkerStatusResult {
  const run = status.run
  const resumedWithoutDone = status.status === 'failed' && status.exitCode === 0 && run?.mode === 'resume'
  if (!run || !status.noReport && !resumedWithoutDone) return status
  const logFile = workerLogFile(record)
  const background = backgroundAtExit(record, run)
  if (status.noReport) {
    // This summary is published to the room: only structured facts, the log path and the model's own parsed text.
    const said = workerLogTail(logFile, run.logStart, runLogIdentity(record, run))
    return { ...status, summary: `ended without a report${background}; log: ${logFile}${said ? `; its last words: ${said}` : ''}` }
  }
  return background ? { ...status, note: `${status.note ?? 'exited without room_done'}${background}` } : status
}

/** The worker MCP's own log, beside the host's (worker-config.ts ROOM_LOG_FILE). */
const workerMcpLogFile = (record: Pick<WorkerRecord, 'dir' | 'tag' | 'logFile'>): string => workerLogFile(record).replace(/\.log$/, '.mcp.log')

/** A host that ended with neither code nor signal: the worker MCP's log may show it saw its stdin close. */
function hostEnded(record: WorkerRecord, status: WorkerStatusResult): WorkerStatusResult {
  if (status.status !== 'failed' || status.note !== HOST_ENDED || !status.run) return status
  const reason = mcpStopReason(workerMcpLogFile(record), status.run.intentAt)
  return reason?.startsWith('stdin') ? { ...status, note: 'host process ended (stdin closed)' } : status
}

/** A message resumes the retained host session; without one, only a respawn retries. */
const resumable = (record: WorkerRecord): boolean => record.capabilities.resume && !!record.hostSessionId

/** A failed run is summarized by its host's own error (room_state, collect), not by whatever stderr printed. */
function failedByHost(record: WorkerRecord, status: WorkerStatusResult): WorkerStatusResult {
  const run = status.run
  if (status.status !== 'failed' || status.summary || run?.launch?.outcome !== 'launched') return status
  const failure = hostFailure(workerLogFile(record), record.host, run.logStart, runLogIdentity(record, run))
  return failure ? { ...status, summary: hostFailureLine(failure, record.host, resumable(record)) } : status
}

const missing = (file: string): boolean => !fs.existsSync(file)
const GUARD_WAIT_MS = 30_000
const GUARD_POLL_MS = 25
const guardBusy = (error: unknown): boolean => error instanceof Error && error.message.startsWith('lease guard busy: ')
const pauseForGuard = async (deadline: number, error: unknown): Promise<void> => {
  if (!guardBusy(error)) throw error
  const remaining = deadline - performance.now()
  if (remaining <= 0) throw new Error(`registry guard wait exceeded ${GUARD_WAIT_MS} ms: ${(error as Error).message}`)
  await new Promise<void>(resolve => setTimeout(resolve, Math.min(GUARD_POLL_MS, remaining)))
}
/** Retry acquisition only; a callback that entered its guard is never replayed. */
async function guarded<T>(file: string, fn: () => T, deadline = performance.now() + GUARD_WAIT_MS): Promise<T> {
  for (;;) {
    let entered = false
    try { return withGuard<T>(file, (() => { entered = true; return fn() }) as () => T extends PromiseLike<unknown> ? never : T) }
    catch (error) { if (entered) throw error; await pauseForGuard(deadline, error) }
  }
}
/** The lease primitives each acquire their own guard before touching their file. */
async function leaseRetry<T>(fn: () => T, deadline = performance.now() + GUARD_WAIT_MS): Promise<T> {
  for (;;) {
    try { return fn() }
    catch (error) { await pauseForGuard(deadline, error) }
  }
}

export class FileWorkerStore {
  readonly root: string
  private readonly alive: LivenessProbe
  private readonly now: () => number
  private readonly identity: InstanceToken
  private readonly listeners = new Set<(id?: string) => void>()
  private observed = new Map<string, string>()
  private readonly watchers: fs.FSWatcher[] = []
  private readonly heldOperations = new Map<string, string>()
  private timer?: ReturnType<typeof setInterval>
  private watchQueued = false
  private constructor(readonly commonDir: string, options: RegistryOptions, private readonly readOnly = false) {
    this.root = path.join(commonDir, 'room', 'registry')
    this.alive = options.liveness ?? liveness
    this.now = options.now ?? Date.now
    this.identity = options.identity ?? synthetic()
  }

  static async open(commonDir: string, options: RegistryOptions = {}): Promise<FileWorkerStore> {
    const registry = new FileWorkerStore(commonDir, options)
    privateStateDirectory(registry.root)
    await registry.reconcile()
    if (options.watch !== false) registry.watch()
    return registry
  }

  /** No lifecycle initialization, recovery or background work for display readers. */
  static async openReader(commonDir: string, options: RegistryOptions = {}): Promise<FileWorkerStore> {
    return new FileWorkerStore(commonDir, { ...options, watch: false }, true)
  }
  close(): void { clearInterval(this.timer); this.timer = undefined; for (const watcher of this.watchers.splice(0)) watcher.close() }
  private watch(): void {
    for (const dir of [this.root, path.join(this.root, 'runs')]) {
      privateStateDirectory(dir)
      try {
        const watcher = fs.watch(dir, { persistent: false }, () => {
          if (this.watchQueued) return
          this.watchQueued = true
          queueMicrotask(() => {
            this.watchQueued = false
            void this.reconcile().catch(e => { process.stderr.write(`[room] registry reconcile: ${e}\n`) })
          })
        })
        watcher.on('error', e => { watcher.close(); process.stderr.write(`[room] registry watch: ${e}; polling remains active\n`) })
        watcher.unref()
        this.watchers.push(watcher)
      } catch (e) { process.stderr.write(`[room] registry watch: ${e}; polling remains active\n`) }
    }
    this.timer = setInterval(() => {
      void this.reconcile().catch(e => { process.stderr.write(`[room] registry reconcile: ${e}\n`) })
    }, 30_000)
    this.timer.unref()
  }
  private workerFile(id: string): string { if (!safeId(id)) throw new Error('invalid worker id'); return path.join(this.root, 'workers', `${id}.json`) }
  private opFile(id: string): string { if (!safeId(id)) throw new Error('invalid worker id'); return path.join(this.root, 'workers', `${id}.op`) }
  private tagFile(tag: string): string { return workerTagFile(this.root, tag) }
  private adoptionFile(id: string): string { if (!safeId(id)) throw new Error('invalid worker id'); return path.join(this.root, 'adoptions', `${id}.json`) }
  private runDir(id: string, n: number): string {
    if (!safeId(id) || !Number.isSafeInteger(n) || n < 1) throw new Error('invalid worker run')
    return path.join(this.root, 'runs', id)
  }
  private reportFile(id: string, n: number): string { return path.join(this.runDir(id, n), `${n}.report.json`) }
  private exitFile(id: string, n: number): string { return path.join(this.runDir(id, n), `${n}.exit.json`) }
  private writerFile(id: string, n: number): string { return path.join(this.runDir(id, n), `${n}.writer`) }
  get instance(): InstanceToken { return this.identity }
  newId(): string { return id() }
  private quarantine(file: string, why: unknown): void {
    if (this.readOnly) throw new Error('read-only worker store cannot quarantine evidence')
    const dir = path.join(this.root, 'quarantine')
    privateStateDirectory(dir)
    const dest = path.join(dir, `${path.basename(file)}.bad-${Date.now()}-${randomBytes(4).toString('hex')}`)
    try { fs.renameSync(file, dest); process.stderr.write(`[room] quarantined ${file}: ${why}\n`) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  private hasQuarantinedRecord(id: string): boolean {
    try { return fs.readdirSync(path.join(this.root, 'quarantine')).some(name => name.startsWith(`${id}.json.bad-`)) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
  }
  private decodeBlockers?: Set<string>
  private quarantineCandidates?: Map<string, { key?: string; text?: string; why: unknown }>
  private invalid(file: string, why: unknown, malformed = false): void {
    if (malformed && this.quarantineCandidates) {
      const observed = snapshotReads?.get(file) ?? readCache.get(file)
      this.quarantineCandidates.set(file, { key: observed?.key ?? statKey(file)?.key,
        text: typeof observed?.value === 'string' ? observed.value : undefined, why })
    }
    const blocker = `${path.relative(this.root, file)}: ${String(why)}`
    if (this.decodeBlockers) this.decodeBlockers.add(blocker)
    else throw new WorkerEvidenceBlocked([blocker])
  }
  // Raw file scans are runtime-private: every external read goes through snapshot() and its blockers.
  #readFact<T>(file: string, valid: (value: unknown) => value is T, why = 'invalid registry fact'): T | undefined {
    const decoded = decodeFact(file, valid, why)
    if (decoded.ok) return decoded.value
    this.invalid(file, decoded.error, true)
    return undefined
  }
  /** `id` names the one worker that changed; none means any may have (another instance's writes). */
  private changed(id?: string): void { for (const listener of this.listeners) listener(id) }
  onChange(listener: (id?: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  #read(id: string): WorkerRecord | undefined {
    const record = this.#readFact(this.workerFile(id), (record): record is WorkerRecord => {
      // Optional diagnostic corruption cannot hide an otherwise valid worker or
      // certify freshness. Unknown required paths stay pending until refresh.
      if (object(record) && record.keptPublication !== undefined && !keptPublicationShape(record.keptPublication))
        record.keptPublication = { paths: [], pending: true, overflow: true }
      return recordShape(record, id)
    }, 'invalid worker record')
    if (!record && this.hasQuarantinedRecord(id)) this.invalid(this.workerFile(id), 'quarantined worker record')
    return record
  }
  /** Decoding never renames files. Only reconcile(), the writer, owns quarantine. */
  #inventory<T>(scan: () => T[]): WorkerInventory<T> {
    const previous = this.decodeBlockers
    this.decodeBlockers = new Set()
    try {
      const records = scan()
      // The enclosing inventory (or snapshot) owns the global quarantine check. Nested
      // record/run scans propagate their decode blockers without relisting it per worker.
      if (!previous) for (const file of files(path.join(this.root, 'quarantine'), '')) this.decodeBlockers.add(path.basename(file))
      return { records, blockers: [...this.decodeBlockers] }
    } finally {
      for (const blocker of this.decodeBlockers) previous?.add(blocker)
      this.decodeBlockers = previous
    }
  }
  #list(recordOnly = false, orphanTags?: Set<string>): WorkerInventory<WorkerRecord> {
    return this.#inventory(() => {
      const records = cachedFiles(path.join(this.root, 'workers'), '.json').flatMap(file => {
        const id = path.basename(file, '.json')
        if (!safeId(id)) { this.invalid(file, 'invalid worker filename', true); return [] }
        const blocked = this.decodeBlockers!.size
        const record = this.#read(id)
        if (!record && this.decodeBlockers!.size === blocked) this.invalid(file, 'missing listed worker record')
        return record ? [record] : []
      })
      // A reservation with no payload remains evidence, including before the writer quarantines it.
      // Record-only projections explicitly omit reservation authority (WorkerQuery.recordOnly).
      if (!recordOnly) {
        const known = new Set(records.map(record => record.id))
        // An ended borrower's reference to an owner that retention removed is history, not missing evidence.
        for (const record of records) if (record.sharedWith && !known.has(record.sharedWith) && !ended(record))
          this.invalid(this.workerFile(record.sharedWith), 'unavailable shared owner record')
      }
      const byId = new Map(records.map(record => [record.id, record]))
      if (!recordOnly) for (const file of files(path.join(this.root, 'tags'), '.json')) {
        const tag = path.basename(file, '.json')
        if (!safeTag(tag)) this.invalid(file, 'invalid reservation filename', true)
        else this.#reserved(tag, orphanTags, byId)
      }
      return records
    })
  }
  /** The reservation, rather than record ordering, selects the current incarnation of a tag. */
  #reserved(tag: string, orphanTags?: Set<string>, records?: ReadonlyMap<string, WorkerRecord>): WorkerRecord | undefined {
    if (!safeTag(tag)) return undefined
    const reservation = this.#readFact(this.tagFile(tag), (value): value is { id: string } => object(value) && typeof value.id === 'string' && safeId(value.id))
    // Missing entries still need the direct read's quarantine evidence (and may
    // have appeared since enumeration); reuse only successfully decoded records.
    const record = reservation ? records?.get(reservation.id) ?? this.#read(reservation.id) : undefined
    if (reservation && !record) orphanTags?.add(tag)
    if (reservation && (!record || record.tag !== tag)) this.invalid(this.tagFile(tag), 'unavailable reserved record')
    return record
  }
  #reservedByTagOrName(tagOrName: string): WorkerRecord | undefined {
    const direct = this.#reserved(tagOrName)
    if (direct) return direct
    return requireWorkerInventory(this.#list()).find(record => record.name === tagOrName && this.#reserved(record.tag)?.id === record.id)
  }
  /** Infer ownership for records written before sharedWith existed from the checkout's canonical tag. */
  #worktreeOwner(record: WorkerRecord, records?: readonly WorkerRecord[]): WorkerRecord | undefined {
    if (record.sharedWith) return records ? records.find(peer => peer.id === record.sharedWith) : this.#read(record.sharedWith)
    if (path.basename(record.dir) === record.tag && record.branch === `room/${record.tag}`) return undefined
    return (records ?? requireWorkerInventory(this.#list())).find(peer => peer.id !== record.id && !peer.sharedWith
      && path.resolve(peer.dir) === path.resolve(record.dir)
      && path.basename(peer.dir) === peer.tag && peer.branch === `room/${peer.tag}`)
  }
  #status(id: string): WorkerStatusResult | undefined {
    const record = this.#read(id)
    if (!record) return undefined
    const reports = requireWorkerInventory(this.#reports(id)), exits = requireWorkerInventory(this.#exits(id))
    const status = failedByHost(record, hostEnded(record, unreportedExit(record, statusOf(record, record.runs, reports, exits, this.alive, this.now()))))
    const run = status.run
    if (status.noReport) return status
    if (status.status !== 'done' || run?.mode !== 'resume' || reports.some(report => report.run === run.n && report.done)
      || !exits.some(exit => exit.run === run.n && exit.witnessed && exit.code === 0)) return status
    // A follow-up that ended without its own room_done is "done" by the earlier report; its exit may still have killed work.
    const logFile = workerLogFile(record)
    const background = backgroundAtExit(record, run)
    return { ...status, followUp: followUpAnswer(logFile, record.host, run.logStart, runLogIdentity(record, run)),
      ...(background ? { note: `follow-up ended without room_done${background}` } : {}) }
  }
  /** No room view or remote presence can turn into a local worktree capability. */
  async trusted(lead: { participant: string; room: string; dir: string }, tagOrName: string, allowVanished = false): Promise<{ record: WorkerRecord; status: WorkerStatusResult } | undefined> {
    let candidate = this.#reservedByTagOrName(tagOrName)
    if (candidate?.legacy?.unowned) candidate = await this.adoptLegacy(candidate, lead)
    if (!candidate || candidate.lead.participant !== lead.participant || candidate.lead.room !== lead.room
      || ['retiring', 'retired', 'abandoned'].includes(candidate.phase)) return undefined
    const reservation = readJson<{ id?: string }>(this.tagFile(candidate.tag))
    if (reservation?.id !== candidate.id) return undefined
    const status = this.#status(candidate.id)
    if (!status) return undefined
    const workers = requireWorkerInventory(this.#list()).flatMap(record => {
      const state = this.#status(record.id)
      if (!state) return []
      const worker = realStateInput(record, state)
      try { return [{ ...worker, dir: fs.realpathSync(worker.dir) }] } catch { return [worker] }
    })
    let leadDir: string
    try { leadDir = fs.realpathSync(lead.dir) } catch { return undefined }
    let workerDir: string
    try { workerDir = fs.realpathSync(candidate.dir) }
    catch {
      if (allowVanished && !candidate.legacy?.unowned && !fs.existsSync(candidate.dir)
        && roomWorkerPathMatchesBranch(leadDir, candidate.dir, candidate.branch, true)) return { record: candidate, status }
      return undefined
    }
    const worktreeRecord = this.#worktreeOwner(candidate) ?? candidate
    if (!worktreeRecord || worktreeRecord.lead.participant !== lead.participant
      || path.resolve(worktreeRecord.dir) !== path.resolve(candidate.dir)
      || worktreeRecord.sharedWith) return undefined
    if (!await isOwnedWorkerWorktree(leadDir, { ...realStateInput(worktreeRecord, this.#status(worktreeRecord.id) ?? status), dir: workerDir }, lead.participant, workers)) return undefined
    try { verifyWorkerCheckout(this.commonDir, worktreeRecord) }
    catch (error) { retainCheckout(this.commonDir, worktreeRecord, String(error)); return undefined }
    return { record: candidate, status }
  }
  /** Only process/record management: an outside checkout never grants a worktree capability. */
  async trustedOutside(lead: { participant: string; room: string }, tagOrName: string): Promise<{ record: WorkerRecord; status: WorkerStatusResult } | undefined> {
    const record = this.#reservedByTagOrName(tagOrName)
    if (!record?.outside || record.capabilities.collect !== 'none' || record.legacy?.unowned
      || record.lead.participant !== lead.participant || record.lead.room !== lead.room
      || ['retiring', 'retired', 'abandoned'].includes(record.phase)) return undefined
    const status = this.#status(record.id)
    return status && { record, status }
  }
  /** Any operation lease, including an unreadable one, blocks automatic claim release. */
  #operationInProgress(id: string): boolean {
    try { fs.lstatSync(this.opFile(id)); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  }
  private async adoptLegacy(record: WorkerRecord, lead: { participant: string; room: string; dir: string }): Promise<WorkerRecord | undefined> {
    if (!lead.participant || !lead.room || record.phase !== 'active') return undefined
    let leadDir: string
    try { leadDir = fs.realpathSync(lead.dir) } catch { return undefined }
    const status = this.#status(record.id)
    if (!status) return undefined
    const worker = { ...realStateInput(record, status), name: `${lead.participant}+${record.tag}`, lead: lead.participant }
    if (!await isOwnedWorkerWorktree(leadDir, worker, lead.participant)) return undefined
    const file = this.adoptionFile(record.id)
    createExclusive(file, { participant: lead.participant, room: lead.room, name: worker.name })
    // An unreadable adoption is still a reservation: never let corruption turn it into a new owner.
    let adopted: { participant?: string; room?: string; name?: string } | undefined
    try { adopted = readJson(file) } catch { return undefined }
    if (adopted?.participant !== lead.participant || adopted.room !== lead.room || adopted.name !== worker.name) return undefined
    return guarded(this.workerFile(record.id), () => {
      const current = this.#read(record.id)
      if (!current) return undefined
      if (!current.legacy?.unowned) return current
      const next: WorkerRecord = { ...current, name: worker.name, room: lead.room,
        lead: { ...current.lead, participant: lead.participant, room: lead.room },
        legacy: { ...current.legacy, unowned: false }, seq: current.seq + 1 }
      writeAtomic(this.workerFile(record.id), next)
      this.changed(record.id)
      return next
    })
  }
  #occupancy(): number {
    // Capacity and tag authority need a complete record/reservation inventory and quarantine
    // evidence. Only launched runs need reports/exits to decide occupancy; prepared, terminal
    // and ambiguous records have a complete answer already. Share the status reducer's rule.
    const inventory = this.#inventory(() => requireWorkerInventory(this.#list()).flatMap(record => {
      const status = recordStatus({ record, reports: [], exits: [], busy: true,
        liveness: this.#statusLiveness(record, true) }) ?? this.#status(record.id)
      if (!status) { this.invalid(this.workerFile(record.id), 'missing occupancy worker record'); return [] }
      return [status]
    }))
    return requireWorkerInventory(inventory).filter(status => ['starting', 'running', 'unknown', 'ambiguous'].includes(status.status)).length
  }
  #reports(id: string): WorkerInventory<RunReport> { if (!safeId(id)) throw new Error('invalid worker id'); return this.#inventory(() => files(path.join(this.root, 'runs', id), '.report.json').flatMap(f => {
    const blocked = this.decodeBlockers!.size
    const report = this.#readFact(f, reportShape)
    if (!report && this.decodeBlockers!.size === blocked) this.invalid(f, 'missing listed run report')
    if (report && path.basename(f) !== `${report.run}.report.json`) { this.invalid(f, 'run report filename mismatch', true); return [] }
    return report ? [report] : []
  })) }
  #exits(id: string): WorkerInventory<ExitObservation> { if (!safeId(id)) throw new Error('invalid worker id'); return this.#inventory(() => files(path.join(this.root, 'runs', id), '.exit.json').flatMap(f => {
    const blocked = this.decodeBlockers!.size
    const observation = this.#readFact(f, exitShape)
    if (!observation && this.decodeBlockers!.size === blocked) this.invalid(f, 'missing listed exit observation')
    if (observation && path.basename(f) !== `${observation.run}.exit.json`) { this.invalid(f, 'exit filename mismatch', true); return [] }
    return observation ? [observation] : []
  })) }

  /** Direct write-ahead seam for the wave-2 spawner; never spawns by itself. */
  async writeIntent(record: WorkerRecord, capacity = Number.POSITIVE_INFINITY): Promise<void> {
    if (!safeId(record.id) || !recordShape(record, record.id) || record.runs[0].launch) throw new Error('invalid worker intent')
    // A borrower joins the owner's operation lane before it becomes visible.
    // Collection holds this lane through its final cleanup decision.
    if (record.sharedWith) await this.beginOperation(record.sharedWith, 'resume')
    try {
    if (record.sharedWith) {
      const owner = this.#read(record.sharedWith)
      if (!owner || owner.sharedWith || path.resolve(owner.dir) !== path.resolve(record.dir)
        || owner.lead.participant !== record.lead.participant || owner.lead.room !== record.lead.room
        || ['retiring', 'retired', 'abandoned'].includes(owner.phase)) throw new Error('shared worktree owner is no longer available')
      // dir= continues the owner's tree, including carried WIP or a kept snapshot.
      // Capture it in the same lane as collect/refresh, before exposing the borrower.
      record = { ...record, base: owner.base, carriedBase: owner.carriedBase,
        carriedUntracked: owner.carriedUntracked, collectedKeep: owner.collectedKeep,
        keptPublication: owner.keptPublication, capabilities: { ...record.capabilities, collect: owner.capabilities.collect } }
    }
    const deadline = performance.now() + GUARD_WAIT_MS
    for (;;) {
      try {
        await guarded(path.join(this.root, 'capacity'), () => {
          if (this.#occupancy() >= capacity) throw new Error('worker capacity reached')
          withWorkerTag(this.root, record.tag, () => {
            const tagFile = this.tagFile(record.tag)
            if (fs.existsSync(tagFile)) {
              const reservation = readJson<{ id?: string; holder?: InstanceToken }>(tagFile)
              const bound = reservation?.id && safeId(reservation.id) && tokenShape(reservation.holder) ? this.#read(reservation.id) : undefined
              if (!bound) throw new WorkerEvidenceBlocked([`tags/${record.tag}.json: unavailable reserved record`])
              const reusable = bound.phase === 'abandoned' || (bound.phase === 'retired' && !bound.keptWorktree
                && !!bound.cleanup && Object.values(bound.cleanup).every(state => state === 'done'))
              if (!reusable) throw new Error(`tag in use: ${record.tag}`)
              // Already under the tag guard; no nested compareAndRelease of the same guard.
              writeAtomic(tagFile, { id: record.id, holder: record.lead.instance, at: this.now() })
            } else if (!createExclusive(tagFile, { id: record.id, holder: record.lead.instance, at: this.now() })) throw new Error(`tag in use: ${record.tag}`)
            if (!createExclusive(this.opFile(record.id), { op: 'spawn', holder: record.runs[0].launcher, at: this.now() })) throw new Error('worker operation lease busy')
            if (!createExclusive(this.workerFile(record.id), record)) throw new Error(`worker already exists: ${record.id}`)
          })
        }, deadline)
        break
      } catch (error) { await pauseForGuard(deadline, error) }
    }
    this.heldOperations.set(record.id, 'spawn')
    if (record.sharedWith) {
      try { inheritWorkerRefs(this.commonDir, this.#read(record.sharedWith)!, record) }
      catch (error) {
        try { await this.abandonPreparation(record.id) }
        finally { await this.finishOperation(record.id) }
        throw error
      }
    }
    this.changed(record.id)
    } finally { if (record.sharedWith) await this.finishOperation(record.sharedWith) }
  }

  /** One operation writer per worker; the next rollout step uses this for preparation and launch facts. */
  async command(id: string, command: WorkerCommand, expectedSeq?: number): Promise<WorkerRecord> {
    return this.update(id, old => {
      if (expectedSeq !== undefined && old.seq !== expectedSeq) throw new Error('worker seq changed')
      if (command.type === 'prepare-finish' && !old.outside && !old.sharedWith) {
        try { verifyWorkerCheckout(this.commonDir, { ...old, prep: { ...old.prep, witness: command.witness ?? old.prep.witness, branchOid: command.branchOid ?? old.prep.branchOid } }) }
        catch (error) { throw new Error(retainCheckout(this.commonDir, old, error instanceof Error ? error.message : String(error))) }
      }
      return applyWorkerCommand(old, command)
    })
  }

  /** Read twice around decoding. Any cross-process file replacement invalidates the whole fact set. */
  async snapshot(query?: WorkerQuery): Promise<WorkerSnapshot> {
    if (query && !query.workerId && !query.tag && !query.recordOnly) query = undefined
    const previousReads = snapshotReads
    const previousBlockers = this.decodeBlockers
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        snapshotReads = new Map()
        this.decodeBlockers = new Set()
        const before = this.#factRevision(query)
        const reservation = query?.tag ? this.#readFact(this.tagFile(query.tag), (value): value is { id: string } => object(value) && typeof value.id === 'string' && safeId(value.id), 'invalid reservation') : undefined
        const reservationId = object(reservation) && typeof reservation.id === 'string' && safeId(reservation.id) ? reservation.id : undefined
        if (reservation !== undefined && !reservationId) this.decodeBlockers.add(`tags/${query!.tag}.json: invalid reservation`)
        const selectedId = query?.workerId ?? reservationId
        const selected = query?.workerId || query?.tag
        const records = selected ? selectedId && safeId(selectedId) ? [this.#read(selectedId)].filter((record): record is WorkerRecord => !!record) : [] : this.#list(!!query?.recordOnly).records
        if (query?.tag && records.some(record => record.tag !== query.tag)) this.decodeBlockers.add(`tags/${query.tag}.json: record tag mismatch`)
        const workers = records.map(record => ({ record, reports: query?.recordOnly ? [] : this.#reports(record.id).records, exits: query?.recordOnly ? [] : this.#exits(record.id).records, busy: query?.recordOnly ? true : this.#operationInProgress(record.id),
          ...(query?.captureLiveness ? { liveness: this.#statusLiveness(record, query.recordOnly) } : {}) }))
        const reservations: Record<string, string> = Object.create(null)
        const selectedTag = query?.tag
        const tagFiles = query ? selectedTag ? [this.tagFile(selectedTag)] : [] : files(path.join(this.root, 'tags'), '.json')
        for (const file of tagFiles) {
          const tag = path.basename(file, '.json')
          if (!safeTag(tag)) { this.invalid(file, 'invalid reservation filename', true); continue }
          const reservation = this.#readFact(file, (value): value is { id: string } => object(value)
            && typeof value.id === 'string' && safeId(value.id), 'invalid reservation')
          if (!reservation) continue
          reservations[tag] = reservation.id
          if (!records.some(record => record.id === reservation.id && record.tag === tag)) this.invalid(file, 'unavailable reserved record')
        }
        const operations = query?.recordOnly ? [] : query ? selectedId && safeId(selectedId) && this.#operationInProgress(selectedId) ? [selectedId] : []
          : files(path.join(this.root, 'workers'), '.op').map(file => path.basename(file, '.op')).filter(safeId)
        const orphanRuns: Record<string, { reports: RunReport[]; exits: ExitObservation[] }> = Object.create(null)
        let runOwners: string[] = []
        if (query?.recordOnly) { /* No run facts requested. */ }
        else if (query) { if (selectedId && safeId(selectedId)) runOwners = [selectedId] }
        else try { runOwners = fs.readdirSync(path.join(this.root, 'runs')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        const known = new Set(workers.map(fact => fact.record.id))
        for (const id of runOwners) if (safeId(id) && !known.has(id)) orphanRuns[id] = { reports: this.#reports(id).records, exits: this.#exits(id).records }
        if (reservationId && !records.length) this.decodeBlockers.add(`workers/${reservationId}.json: unavailable reserved record`)
        // Record projections omit run evidence, but cannot turn a quarantined worker into an
        // empty inventory. A genuinely absent unreserved ID is still distinct from blocked state.
        const quarantine = !query?.recordOnly || !selected || !records.length
          ? files(path.join(this.root, 'quarantine'), '').map(file => path.basename(file)) : []
        const blockers = [...new Set([...this.decodeBlockers, ...quarantine.filter(name => !query?.recordOnly || !selected
          || !!selectedId && name.startsWith(`${selectedId}.json.bad-`))])]
        const after = this.#factRevision(query)
        if (before === after) return { available: true, revision: after, workers, reservations, blockers, operations, orphanRuns }
      }
      return { available: false, reason: 'unavailable', detail: 'worker facts changed during snapshot' }
    } catch (error) { return { available: false, reason: 'unavailable', detail: String(error) } }
    finally { snapshotReads = previousReads; this.decodeBlockers = previousBlockers }
  }
  #factRevision(query?: WorkerQuery): string {
    const hash = createHash('sha256').update(this.commonDir).update(JSON.stringify(query ?? {}))
    const addFile = (file: string): void => {
      let text: string | undefined
      try { text = cached(file, () => fs.readFileSync(file, 'utf8'), file, true) }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
      hash.update(file).update('\0').update(snapshotReads?.get(file)?.key ?? '-').update('\0').update(text ?? '').update('\0')
    }
    const visit = (dir: string): void => {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) { visit(file); continue }
        if (!entry.isFile() || !(entry.name.endsWith('.json') || entry.name.endsWith('.op') || entry.name.endsWith('.writer') || dir === path.join(this.root, 'quarantine'))) continue
        // Hash exact content as well as incarnation so rapid equal-timestamp writes cannot be missed.
        // Quarantine evidence is immutable and may contain large recovery bytes. Its incarnation is
        // sufficient for invalidation; normal lifecycle facts also compare their exact small payloads.
        if (dir === path.join(this.root, 'quarantine')) hash.update(file).update('\0').update(statKey(file)?.key ?? '-').update('\0')
        else addFile(file)
      }
    }
    if (query) {
      if (query.workerId && !safeId(query.workerId) || query.tag && !safeTag(query.tag) || query.workerId && query.tag) throw new Error('invalid worker snapshot query')
      let workerId = query.workerId
      if (query.tag) {
        const file = this.tagFile(query.tag)
        addFile(file)
        const reservation = decodeFact(file, (value): value is { id: string } => object(value) && typeof value.id === 'string' && safeId(value.id), 'invalid reservation')
        workerId = reservation.ok ? reservation.value?.id : undefined
      }
      if (workerId && safeId(workerId)) {
        addFile(this.workerFile(workerId))
        if (!query.recordOnly) { addFile(this.opFile(workerId)); addFile(this.adoptionFile(workerId)); visit(path.join(this.root, 'runs', workerId)) }
      }
      if (!query.workerId && !query.tag) {
        const dir = path.join(this.root, 'workers'), slot = `${dir}\0*.json`
        const entries = cached(dir, () => files(dir, '.json'), slot, true) ?? []
        hash.update(snapshotReads?.get(slot)?.key ?? '-').update('\0')
        for (const file of [...entries].sort()) addFile(file)
      }
      if (!query.recordOnly) visit(path.join(this.root, 'quarantine'))
    } else for (const family of ['workers', 'tags', 'adoptions', 'runs', 'quarantine']) visit(path.join(this.root, family))
    return hash.digest('hex')
  }

  /** Host/log evidence is enriched asynchronously after the immutable fact read. */
  async enrichedStatus(fact: import('./worker-store.js').WorkerFacts): Promise<WorkerStatusResult> {
    const { record, reports, exits } = fact
    const latest = record.runs.at(-1)
    if (latest) await scanRunLog(workerLogFile(record), latest.logStart, runLogIdentity(record, latest))
    const probes = this.#statusLiveness(record)
    const status = failedByHost(record, hostEnded(record, unreportedExit(record,
      statusOf(record, record.runs, reports, exits, identity => probes.find(probe => probe.identity === identity)?.state ?? 'unknown', this.now()))))
    const run = status.run
    if (status.noReport || status.status !== 'done' || run?.mode !== 'resume'
      || reports.some(report => report.run === run.n && report.done)
      || !exits.some(exit => exit.run === run.n && exit.witnessed && exit.code === 0)) return status
    const background = backgroundAtExit(record, run)
    return { ...status, followUp: followUpAnswer(workerLogFile(record), record.host, run.logStart, runLogIdentity(record, run)),
      ...(background ? { note: `follow-up ended without room_done${background}` } : {}) }
  }

  /** Probe outside the pure reducer; snapshots capture these answers before validating their revision. */
  #statusLiveness(record: WorkerRecord, recordOnly = false): NonNullable<import('./worker-store.js').WorkerFacts['liveness']> {
    const ordered = [...record.runs].sort((a, b) => a.n - b.n)
    let index = ordered.length - 1
    while (ordered[index]?.mode === 'resume' && ordered[index]?.launch?.outcome === 'never') index--
    const current = ordered[index]
    // A launched run needs report/exit facts; its full enrichment will capture the probes once.
    if (recordOnly && current?.launch?.outcome === 'launched') return []
    const probes = new Map<import('./leases.js').ProcessIdentity, ReturnType<LivenessProbe>>()
    if (current && !['retired', 'abandoned', 'collecting', 'discarding', 'retiring'].includes(record.phase)) {
      if (!current.launch || current.launch.outcome === 'launched') probes.set(current.launcher, this.alive(current.launcher))
      if (current.launch?.outcome === 'launched' && current.launch.process) probes.set(current.launch.process, this.alive(current.launch.process))
    }
    return [...probes].map(([identity, state]) => ({ identity, state }))
  }

  private async update(id: string, edit: (record: WorkerRecord) => WorkerRecord): Promise<WorkerRecord> {
    const priorOp = readJson<{ holder: InstanceToken }>(this.opFile(id))
    if (priorOp && priorOp.holder.nonce !== this.identity.nonce && this.alive(priorOp.holder) === 'dead') await leaseRetry(() => recover(this.opFile(id), () => true))
    const value = await guarded(this.opFile(id), () => {
      const op = readJson<{ holder: InstanceToken }>(this.opFile(id))
      if (op && op.holder.nonce !== this.identity.nonce) throw new Error(`worker operation lease held by another instance: ${id}`)
      const old = this.#read(id)
      if (!old) throw new Error(`unknown worker ${id}`)
      const next = edit(old)
      if (next.id !== old.id || next.seq !== old.seq + 1 || !recordShape(next, id)) throw new Error('worker update must retain id, advance seq and remain valid')
      writeAtomic(this.workerFile(id), next)
      return next
    })
    this.changed(id)
    return value
  }
  async finishOperation(id: string): Promise<boolean> {
    const released = await leaseRetry(() => compareAndRelease(this.opFile(id), this.identity))
    if (released) this.heldOperations.delete(id)
    return released
  }

  async beginOperation(id: string, op: 'resume' | 'stop' | 'collect' | 'discard' | 'prune'): Promise<boolean> {
    const file = this.opFile(id)
    const acquired = async () => {
      this.heldOperations.set(id, op)
      try {
        const record = this.#read(id)
        if (record && ['collect', 'discard'].includes(op) && !record.outside && !record.sharedWith
          && !['intent', 'preparing', 'abandoned'].includes(record.phase)) {
          // A restarted discard is the same durable operation, not permission to
          // adopt a moved tip. A new user attempt starts from active instead.
          const branchCleanup = record.phase === 'discarding' && record.branchCleanup
            ? record.branchCleanup : captureWorkerBranch(this.commonDir, record)
          // Lease admission must not advance the worker's revision: retirement
          // validates that its pre-lease record still matches. Normal phase
          // transitions below copy this receipt into v1 facts for crash replay.
          const current = this.#readFact(file, (value): value is { holder: InstanceToken } => object(value) && tokenShape(value.holder))
          if (current?.holder.nonce !== this.identity.nonce) throw new Error('worker operation lease changed before branch receipt publication')
          writeAtomic(file, { op, holder: this.identity, at: this.now(), branchCleanup })
        }
        return true
      } catch (error) { await this.finishOperation(id); throw error }
    }
    if (createExclusive(file, { op, holder: this.identity, at: this.now() })) return acquired()
    const existing = this.#readFact(file, (value): value is { op: string; holder: InstanceToken; at: number } =>
      object(value) && typeof value.op === 'string' && tokenShape(value.holder) && typeof value.at === 'number')
    if (existing?.holder.nonce === this.identity.nonce) {
      if (existing.op === 'discard' && op === 'stop' && this.heldOperations.get(id) === 'discard') return false
      throw new Error(`worker operation lease held by another call: ${id}`)
    }
    if (existing && this.alive(existing.holder) === 'dead') {
      await leaseRetry(() => recover(file, () => true))
      if (createExclusive(file, { op, holder: this.identity, at: this.now() })) return acquired()
    }
    throw new Error(`worker operation lease held by another instance: ${id}`)
  }

  async withCollectLease<T>(worktree: string, work: () => Promise<T>): Promise<T> {
    const canonical = fs.realpathSync(worktree)
    const key = createHash('sha256').update(canonical).digest('hex')
    const file = path.join(this.root, 'collect', `${key}.json`)
    const deadline = performance.now() + GUARD_WAIT_MS
    for (;;) {
      if (createExclusive(file, { holder: this.identity, worktree: canonical, at: this.now() })) break
      if (await leaseRetry(() => recover(file, () => true), deadline)) continue
      if (performance.now() >= deadline) throw new Error('another collection is in progress')
      await new Promise<void>(resolve => setTimeout(resolve, GUARD_POLL_MS))
    }
    const assertOwned = () => {
      try {
        const current = JSON.parse(readBoundedFileSync(file, 16 * 1024)) as { holder?: InstanceToken; worktree?: string }
        const holder = current.holder
        if (!holder || current.worktree !== canonical || holder.nonce !== this.identity.nonce || holder.pid !== this.identity.pid
          || holder.sessionId !== this.identity.sessionId || holder.startTime !== this.identity.startTime || holder.executable !== this.identity.executable)
          throw new Error('holder changed')
      } catch { throw new Error('destination collect lease ownership lost') }
    }
    try { return await withCollectLeaseAssertion(canonical, assertOwned, work) }
    finally { await leaseRetry(() => compareAndRelease(file, this.identity)) }
  }

  /** Append the next run while the same capacity guard used by fresh spawn is held. */
  async resume(id: string, capacity: number, input: { nonce: string; busFrontier: number; promptMsgIds?: string[]; logStart: number; logFile?: string }): Promise<WorkerRecord> {
    const candidate = this.#read(id)
    const owner = candidate && this.#worktreeOwner(candidate)
    if (owner) await this.beginOperation(owner.id, 'resume')
    try {
    await this.beginOperation(id, 'resume')
    try {
      const next = await guarded(path.join(this.root, 'capacity'), () => {
        const old = this.#read(id)
        if (!old || !old.capabilities.resume || !old.hostSessionId) throw new Error('worker has no resumable host session')
        const status = this.#status(id)?.status
        if (!status || !['done', 'failed', 'ambiguous', 'imported', 'stopped'].includes(status)) throw new Error(`worker is ${status ?? 'missing'}; cannot resume`)
        if (status === 'stopped' && !['lead-session-ended', 'message-delivered-cancelled', 'message-delivered-failed'].includes(old.stop?.reason ?? '')) throw new Error('discarded worker cannot resume')
        if (this.#occupancy() >= capacity) throw new Error('worker capacity reached')
        const run = { n: old.runs.at(-1)!.n + 1, mode: 'resume' as const, intentAt: this.now(),
          nonce: input.nonce, busFrontier: input.busFrontier, promptMsgIds: input.promptMsgIds ?? [],
          launcher: this.identity, logStart: input.logStart }
        // The resuming session's log, which this run's logStart measures, is where the host writes now.
        const record: WorkerRecord = { ...old, ...(input.logFile ? { logFile: input.logFile } : {}), phase: 'prepared', stop: undefined, runs: [...old.runs, run], seq: old.seq + 1 }
        writeAtomic(this.workerFile(id), record)
        return record
      })
      this.changed(id)
      return next
    } catch (error) { await this.finishOperation(id); throw error }
    } finally { if (owner) await this.finishOperation(owner.id) }
  }

  /** The child proves the launch nonce and its checkout before it receives report authority. */
  async admit(input: { id: string; run: number; nonce: string; dir: string;
    chain: RunReport['chain']; hostProcess?: RunReport['hostProcess']; hostSessionId?: string }): Promise<RunReport> {
    const record = this.#read(input.id)
    const run = record?.runs.at(-1)
    let actual: string, expected: string
    try { actual = fs.realpathSync(input.dir); expected = fs.realpathSync(record?.dir ?? '') }
    catch { throw new Error('worker run not admitted: checkout missing') }
    if (!run || run.n !== input.run || run.nonce !== input.nonce || actual !== expected
      || !['prepared', 'active'].includes(record!.phase)) throw new Error('worker run not admitted')
    const existingSession = record!.hostSessionId ?? requireWorkerInventory(this.#reports(input.id)).find(value => value.run === run.n)?.hostSessionId
    if (input.hostSessionId && (input.hostSessionId.startsWith('mcp:')
      || existingSession && existingSession !== input.hostSessionId)) throw new Error('worker host session mismatch')
    const report: RunReport = { run: run.n, nonce: run.nonce, chain: input.chain,
      ...(input.hostProcess !== undefined ? { hostProcess: input.hostProcess } : {}),
      joinedAt: this.now(), ...(input.hostSessionId ? { hostSessionId: input.hostSessionId } : {}) }
    await this.writeReport(input.id, report)
    const persisted = requireWorkerInventory(this.#reports(input.id)).find(value => value.run === run.n)!
    if (persisted.hostSessionId && !record!.hostSessionId && !fs.existsSync(this.opFile(input.id))) await this.update(input.id, old => {
      const latest = old.runs.at(-1)
      if (latest?.n !== input.run || latest.nonce !== input.nonce || !['prepared', 'active'].includes(old.phase)) throw new Error('worker run not admitted')
      return { ...old, hostSessionId: old.hostSessionId ?? persisted.hostSessionId, seq: old.seq + 1 }
    })
    return persisted
  }

  async reportDone(id: string, n: number, summary: string, changed: string[]): Promise<RunReport> {
    const record = this.#read(id), run = record?.runs.at(-1)
    const prior = requireWorkerInventory(this.#reports(id)).find(report => report.run === n)
    if (!run || run.n !== n || !prior) throw new Error('worker run not admitted')
    // A report after a posted one is the run's next; one whose post failed is replaced (room_done's retry).
    const k = !prior.done ? 1 : (prior.done.k ?? 1) + (prior.posted === completionId(id, n, prior.done.k) ? 1 : 0)
    await this.writeReport(id, { ...prior, done: { at: this.now(), summary, changed, ...k > 1 ? { k } : {} } })
    return requireWorkerInventory(this.#reports(id)).find(report => report.run === n)!
  }

  /** The post callback must use the deterministic id with RoomDoc.post. */
  /** `post` resolves once the hub took the message (a refusal throws), so `posted` is recorded only for a message that exists. */
  async postCompletion(id: string, n: number, post: (id: string, record: WorkerRecord, report: RunReport) => Promise<void>): Promise<boolean> {
    const record = this.#read(id), run = record?.runs.find(value => value.n === n)
    const report = requireWorkerInventory(this.#reports(id)).find(value => value.run === n)
    if (!record || !run || !report?.done) throw new Error('worker completion not reported')
    // A clean exit may have produced a no-report notice. The late real report has its
    // own deterministic ID and supersedes that fallback in the registry projection.
    const messageId = completionId(id, n, report.done.k)
    if (report.posted === messageId || run.posted && !run.posted.endsWith(':no-report')) return false
    await post(messageId, record, report)
    // A retiring record admits no report write; its run carries the posted id, so retirement can complete.
    if (['prepared', 'active'].includes(record.phase)) await this.writeReport(id, { ...report, posted: messageId })
    else await this.update(id, old => ({ ...old, runs: old.runs.map(value => value.n === n ? { ...value, posted: messageId } : value), seq: old.seq + 1 }))
    return true
  }

  async postObservedFailure(id: string, n: number, post: (message: NonNullable<ReturnType<typeof completionMessage>>) => Promise<void>): Promise<boolean> {
    // Bring this run's log facts up to date in yielding chunks before reading any state the decision depends on.
    const scanned = this.#read(id), scannedRun = scanned?.runs.find(value => value.n === n)
    if (scanned && scannedRun?.mode === 'resume') await scanRunLog(workerLogFile(scanned), scannedRun.logStart, runLogIdentity(scanned, scannedRun))
    const record = this.#read(id), run = record?.runs.find(value => value.n === n)
    const exit = requireWorkerInventory(this.#exits(id)).find(value => value.run === n)
    const report = requireWorkerInventory(this.#reports(id)).find(value => value.run === n)
    const current = this.#status(id)
    const status = record?.phase === 'retiring' && !record.stop
      ? hostEnded(record, unreportedExit(record, statusOf({ ...record, phase: 'active' }, record.runs, requireWorkerInventory(this.#reports(id)), requireWorkerInventory(this.#exits(id)), this.alive, this.now())))
      : current
    if (!record || !run || !status || !exit?.witnessed || run.posted || report?.posted
      || (status.status !== 'failed' && !status.noReport && !(record.phase === 'retiring' && !record.stop) && !report?.done)) return false
    const logFile = workerLogFile(record)
    const missing = retainedSessionMissing(record, run, logFile)
    // Only facts Room can vouch for: the exit reason, the host's own error event or follow-up answer, and the
    // log's path. Raw log lines are never quoted: a killed worker's tail is whatever its last command printed.
    const failure = missing ? undefined : hostFailure(logFile, record.host, run.logStart, runLogIdentity(record, run))
    const answer = run.mode === 'resume' && !failure ? followUpAnswer(logFile, record.host, run.logStart, runLogIdentity(record, run)) : ''
    const reason = status.note ?? 'exited before reporting done'
    const detail = missing
      ? `its retained conversation ${record.hostSessionId} no longer exists; the message stays owed`
      : failure ? `${reason}; ${hostFailureLine(failure, record.host, resumable(record))}`
      : answer ? `${reason}; ${answer}` : `${reason}; log: ${logFile}`
    const message = completionMessage(record, run, { ...status, note: detail }, report)
    if (!message) return false
    const posted = status.noReport ? { ...message, id: `${message.id}:no-report` } : message
    await post(posted)
    await this.update(id, old => ({ ...old, runs: old.runs.map(value => value.n === n ? { ...value, posted: posted.id } : value), seq: old.seq + 1 }))
    return true
  }

  async beginStop(id: string, reason: NonNullable<WorkerRecord['stop']>['reason'], cause?: NonNullable<WorkerRecord['stop']>['cause']): Promise<WorkerRecord> {
    return this.update(id, old => ({ ...old, stop: { reason, at: this.now(), run: old.runs.at(-1)!.n, ...(cause ? { cause } : {}) }, seq: old.seq + 1 }))
  }

  private pinOperationBranch(record: WorkerRecord): import('./worker-refs.js').BranchCleanupReceipt | undefined {
    if (record.outside || record.sharedWith || ['intent', 'preparing', 'abandoned'].includes(record.phase)) return undefined
    const receipt = preserveWorkerBranch(this.commonDir, record, operationBranchReceipt(this.commonDir, record.id))
    const lease = readJson<{ holder: InstanceToken; op: string; at: number }>(this.opFile(record.id))
    if (lease?.holder.nonce === this.identity.nonce) writeAtomic(this.opFile(record.id), { ...lease, branchCleanup: receipt })
    return receipt
  }
  async beginCollect(id: string): Promise<WorkerRecord> {
    return this.update(id, old => ({ ...old, prep: ['intent', 'preparing'].includes(old.phase) ? { ...old.prep, identityRequired: true } : old.prep, phase: 'collecting', interrupted: undefined, seq: old.seq + 1 }))
  }
  /** A collection that did not finish returns the worker to `active`; a finished one retires it (beginRetirement). */
  async abortCollect(id: string): Promise<WorkerRecord> {
    return this.update(id, old => ({ ...old, phase: 'active', seq: old.seq + 1 }))
  }
  /** Output was applied but the host's clean exit is unconfirmed: stay live, never retired, until cleanup finishes. */
  async deferCollectCleanup(id: string, reason: string): Promise<WorkerRecord> {
    return this.update(id, old => ({ ...old, phase: 'active', collectPending: { at: old.collectPending?.at ?? this.now(), reason }, seq: old.seq + 1 }))
  }

  /**
   * Retirement step 1 (§12): `retiring`, with cleanup pending in every room the worker joined or was projected
   * into, and the archive entry each room's projector appends. From here no projector writes the worker.
   */
  async beginRetirement(id: string, archive: RetiredWorker, extra: Pick<WorkerRecord, 'keptWorktree'> = {}): Promise<WorkerRecord> {
    return this.update(id, old => ({ ...old, ...extra, phase: 'retiring', archive: { ...archive, id },
      cleanup: Object.fromEntries([old.room, ...(old.projectedInto ? [old.projectedInto] : [])].map(room => [room, 'pending' as const])),
      seq: old.seq + 1 }))
  }

  /**
   * End mail only for this lead's known workers with no live tag in this clone. The capacity guard
   * excludes tag creation/reuse through the inventory check and the synchronous document transaction.
   * Room history supplies names after record pruning; only the complete local registry proves no successor.
   */
  async retireWorkerMail(room: RoomDoc, lead: string, roomName: string): Promise<void> {
    await guarded(path.join(this.root, 'capacity'), () => {
      const records = requireWorkerInventory(this.#list())
      const liveTags = new Set(records.filter(record => !ended(record)).map(record => record.tag))
      const workers = [
        ...records.filter(record => record.lead.participant === lead && (record.room === roomName || record.projectedInto === roomName)),
        ...room.retiredWorkers().filter(record => record.lead === lead),
      ].filter(record => !liveTags.has(record.tag))
      room.retireWorkerMail(workers, this.now())
    })
  }

  /** An archive entry from local facts, for retirements whose caller has nothing more specific. */
  archiveOf(record: WorkerRecord, facts: Partial<RetiredWorker> & Pick<RetiredWorker, 'summary'>): RetiredWorker {
    requireWorkerInventory(this.#list())
    const status = this.#status(record.id), at = this.now()
    return { id: record.id, name: record.name, tag: record.tag, lead: record.lead.participant, host: record.host,
      ...(record.model ? { model: record.model } : {}), task: record.task, files: [], fileCount: 0,
      startedAt: record.createdAt, finishedAt: status?.finishedAt ?? at, retiredAt: at, outcome: 'dismissed',
      ...(record.stop && record.stop.reason !== 'discarded' ? { stopReason: record.stop.reason } : {}), ...facts }
  }

  /**
   * Retention: remove retired and abandoned records older than `maxAgeMs` (their room archive entry is the durable
   * copy), with their run facts, adoption and the tag reservation that still names them. A record whose kept
   * worktree still exists, or whose checkout a live record borrows, stays. Old import journals are not used by this registry.
   */
  async pruneRetired(maxAgeMs: number): Promise<WorkerRecord[]> {
    const borrowers = (records: WorkerRecord[]) => new Set(records.filter(record => !ended(record))
      .flatMap(record => [record.sharedWith, this.#worktreeOwner(record, records)?.id]).filter(Boolean))
    /** Every retention predicate, on one reading of the registry; undefined keeps the record. */
    const expiredAt = (record: WorkerRecord, borrowed: Set<string | undefined>): number | undefined => {
      if (!ended(record) || borrowed.has(record.id)) return undefined
      if (record.keptWorktree && fs.existsSync(record.keptWorktree)) return undefined
      let at = record.phase === 'retired' ? record.archive?.retiredAt : undefined
      if (at === undefined) try { at = fs.statSync(this.workerFile(record.id)).mtimeMs } catch { return undefined }
      return this.now() - at >= maxAgeMs ? at : undefined
    }
    // This first reading only selects candidates; nothing is removed on its strength.
    const records = requireWorkerInventory(this.#list()), removed: WorkerRecord[] = []
    const snapshotBorrowed = borrowers(records)
    for (const candidate of records) {
      if (expiredAt(candidate, snapshotBorrowed) === undefined || this.#operationInProgress(candidate.id)) continue
      // Retention is a lifecycle operation on the record: it holds the same operation lease as resume, collect
      // and discard. A borrower's spawn or resume takes its owner's lease first, so none can start meanwhile,
      // and another instance's update() refuses while the lease is held.
      try { if (!await this.beginOperation(candidate.id, 'prune')) continue } catch { continue }
      try {
        const record = this.#read(candidate.id)
        const at = record && expiredAt(record, borrowers(requireWorkerInventory(this.#list())))
        if (!record || at === undefined) continue
        // Delete under the guard update() uses, after checking the lease is still this call's and the record
        // unchanged: an in-process update serialized before this point advanced seq.
        const gone = await guarded(this.opFile(record.id), () => {
          const op = readJson<{ op?: string; holder?: InstanceToken }>(this.opFile(record.id))
          if (op?.op !== 'prune' || op.holder?.nonce !== this.identity.nonce) return false
          const current = this.#read(record.id)
          if (current?.seq !== record.seq || current.phase !== record.phase) return false
          fs.rmSync(this.workerFile(record.id), { force: true })
          return true
        })
        if (!gone) continue
        // The record is gone before its reservation: an interrupted prune leaves a reservation naming no record
        // (recovered once its holder is dead), never a surviving record without its reservation.
        await guarded(this.tagFile(record.tag), () => {
          if (readJson<{ id?: string }>(this.tagFile(record.tag))?.id === record.id) fs.rmSync(this.tagFile(record.tag), { force: true })
        }).catch(error => process.stderr.write(`[room] worker record ${record.id} removed; its tag reservation stays: ${error}\n`))
        fs.rmSync(path.join(this.root, 'runs', record.id), { recursive: true, force: true })
        fs.rmSync(this.adoptionFile(record.id), { force: true })
        process.stderr.write(`[room] removed ${record.phase} worker record ${record.tag} (${record.id}) from ${new Date(at).toISOString()}: older than the room's ${Math.round(maxAgeMs / 86_400_000)}-day expiry\n`)
        removed.push(record)
      } finally { await this.finishOperation(candidate.id) }
    }
    if (removed.length) this.changed()
    return removed
  }

  /** Retirement step 4: a room's projector finished its cleanup; the last room makes the record `retired`. */
  async finishCleanup(id: string, roomKey: string): Promise<WorkerRecord | undefined> {
    const current = this.#read(id)
    if (current?.phase !== 'retiring' || current.cleanup?.[roomKey] !== 'pending') return current
    return this.update(id, old => {
      const cleanup = { ...old.cleanup, [roomKey]: 'done' as const }
      if (old.sharedWith && Object.values(cleanup).every(state => state === 'done')) removeWorkerRefs(this.commonDir, old)
      return { ...old, cleanup, ...(Object.values(cleanup).every(state => state === 'done') ? { phase: 'retired' as const } : {}), seq: old.seq + 1 }
    })
  }

  async beginDiscard(id: string, force: boolean, children: string[]): Promise<WorkerRecord> {
    return this.update(id, old => ({ ...old, branchCleanup: this.pinOperationBranch(old), prep: ['intent', 'preparing'].includes(old.phase) ? { ...old.prep, identityRequired: true } : old.prep, phase: 'discarding',
      discard: { force, children, steps: {} }, interrupted: undefined, seq: old.seq + 1 }))
  }
  async markDiscardStep(id: string, step: keyof NonNullable<WorkerRecord['discard']>['steps']): Promise<WorkerRecord> {
    return this.update(id, old => {
      if (!old.discard) throw new Error('discard plan missing')
      return { ...old, discard: { ...old.discard, steps: { ...old.discard.steps, [step]: true } }, seq: old.seq + 1 }
    })
  }
  async interruptDiscard(id: string, detail: string): Promise<WorkerRecord> {
    return this.update(id, old => ({ ...old, phase: 'active',
      interrupted: { op: 'discard', at: this.now(), detail }, seq: old.seq + 1 }))
  }

  /** Store the hash before linking a stable patch; replay validates the published bytes. */
  async recordDiscardPatch(id: string, bytes: Buffer): Promise<string> {
    const file = path.join(this.root, 'patches', `${id}.patch`)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const record = this.#read(id)
    if (!record?.discard || record.phase !== 'discarding') throw new Error('discard plan missing')
    if (record.discard.patch && record.discard.patch.path !== file) throw new Error('discard patch path changed')
    if (record.discard.patch && record.discard.patch.sha256 !== sha256) throw new Error('discard patch changed after identity was recorded')
    if (!record.discard.patch) await this.update(id, old => ({ ...old,
      discard: { ...old.discard!, patch: { path: file, sha256 } }, seq: old.seq + 1 }))
    privateStateDirectory(path.dirname(file))
    let existing: fs.Stats | undefined
    try { existing = fs.lstatSync(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (existing) {
      if (existing.isFile() && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha256) return file
      this.quarantine(file, 'discard patch hash mismatch')
    }
    const scratch = path.join(this.root, 'patches', `${id}.${randomBytes(8).toString('hex')}.tmp`)
    try {
      const fd = fs.openSync(scratch, 'wx', 0o600)
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.linkSync(scratch, file)
      const dir = fs.openSync(path.dirname(file), 'r')
      try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
      return file
    } finally { fs.rmSync(scratch, { force: true }) }
  }

  /** Replay only durable discard steps. A missing capability leaves the plan for a later retry. */
  async replayDiscard(id: string, publishPatch: (workerId: string, bytes: Buffer) => Promise<string> = (workerId, bytes) => this.recordDiscardPatch(workerId, bytes)): Promise<void> {
    requireWorkerInventory(this.#list())
    let record = this.#read(id)
    if (record?.phase !== 'discarding' || !record.discard) return
    let acquired = false
    if (!this.heldOperations.has(id)) {
      try { await this.beginOperation(id, 'discard'); acquired = true }
      catch { return }
    }
    try {
    record = this.#read(id)
    if (record?.phase !== 'discarding' || !record.discard) return
    // A writer killed between creating and linking a patch leaves its private
    // scratch file behind. It has no committed identity and replay rebuilds it.
    for (const scratch of files(path.join(this.root, 'patches'), '.tmp')) {
      const suffix = path.basename(scratch).slice(id.length + 1)
      if (!path.basename(scratch).startsWith(`${id}.`) || !/^[0-9a-f]{16}\.tmp$/.test(suffix)) continue
      if (fs.lstatSync(scratch).isFile()) fs.rmSync(scratch)
    }
    const leadDir = record.outside ? path.dirname(this.commonDir) : path.dirname(path.dirname(path.dirname(record.dir)))
    const status = this.#status(id)
    if (!status) return
    const { WorkerRegistry } = await import('./worker-registry.js')
    const cleanupRegistry = WorkerRegistry.fromStore(this)
    const own = realStateInput(record, status)
    const workers = requireWorkerInventory(this.#list()).flatMap(value => {
      const current = this.#status(value.id)
      return current ? [realStateInput(value, current)] : []
    })
    const borrowed = !!record.sharedWith || !!this.#worktreeOwner(record)
    const shared = !record.outside && !borrowed && fs.existsSync(record.dir) ? requireWorkerInventory(this.#list()).filter(value => value.id !== id && !['retiring', 'retired', 'abandoned'].includes(value.phase)
      && path.resolve(value.dir) === path.resolve(record!.dir)) : []
    for (const user of shared) {
      const userStatus = this.#status(user.id)
      if (!userStatus || (user.phase !== 'discarding' && !['done', 'failed', 'stopped'].includes(userStatus.status))) return
      if (user.phase !== 'discarding') await this.beginDiscard(user.id, true, [])
      await this.replayDiscard(user.id, publishPatch)
      if (!['retiring', 'retired'].includes(this.#read(user.id)?.phase ?? '')) return
    }
    if (!record.outside && !borrowed && fs.existsSync(record.dir)) {
      try { verifyWorkerCheckout(this.commonDir, record) }
      catch (error) { throw new Error(retainCheckout(this.commonDir, record, String(error))) }
    }
    const owned = !record.outside && !borrowed && await isOwnedWorkerWorktree(leadDir, own, record.lead.participant, workers)
    if (!record.outside && !borrowed && !owned && fs.existsSync(record.dir)) throw new Error(`discard replay lost ownership of ${record.dir}`)
    if (!record.discard.steps.children) {
      for (const childId of record.discard.children) {
        const child = this.#read(childId)
        if (!child || ['retiring', 'retired'].includes(child.phase)) continue
        if (child.phase !== 'discarding') await this.beginDiscard(childId, true, [])
        await this.replayDiscard(childId, publishPatch)
        if (!['retiring', 'retired'].includes(this.#read(childId)?.phase ?? '')) return
      }
      await this.markDiscardStep(id, 'children')
      record = this.#read(id)!
    }
    // The launch PID names the host. Admission's process chain is MCP first, host
    // second; selecting its first live entry can stop only the MCP and lose edits.
    const run = record.runs.at(-1)!
    const launch = run.launch
    const report = requireWorkerInventory(this.#reports(id)).find(value => value.run === run.n && value.nonce === run.nonce)
    const chain = report?.chain ?? []
    const reportedHost = launch?.outcome === 'launched' ? chain.find(value => value.pid === launch.pid) : undefined
    if (launch?.outcome === 'launched' && launch.process && reportedHost
      && (!sameStartTime(launch.process.startTime, reportedHost.startTime) || launch.process.executable !== reportedHost.executable)) return
    const host = launch?.outcome === 'launched' ? launch.process ?? reportedHost : undefined
    const identities = [host, ...(record.outside ? [] : chain.filter(value => value.pid !== host?.pid))]
      .filter((value): value is NonNullable<typeof value> => !!value)
    if (!record.discard!.steps.stop) await this.beginStop(id, 'discarded')
    // A PID-only launch without a matching admitted host has no verified signal
    // authority. Keep the directory even if another chain member has exited.
    if (launch?.outcome === 'launched' && !host && !requireWorkerInventory(this.#exits(id)).some(value => value.run === run.n)
      && pidAlive(launch.pid)) return
    for (const identity of identities) {
      const alive = this.alive(identity)
      if (alive === 'unknown') return
      if (alive !== 'alive') continue
      if (!record.capabilities.signal || record.discard!.steps.stop) return
      const signalOwn = { ...own, pid: identity.pid, processStartTime: identity.startTime }
      const stopped = await stopWorkerWithEscalation({
        terminate: () => signalWorker(identity.pid, 'SIGTERM', record!.outside ? undefined : record!.dir, undefined, signalOwn, probeProcess),
        exited: () => this.alive(identity) === 'dead',
        force: () => signalWorker(identity.pid, 'SIGKILL', record!.outside ? undefined : record!.dir, undefined, signalOwn, probeProcess),
      })
      if (!stopped) return
    }
    if (identities.some(value => this.alive(value) !== 'dead')) return
    if (owned && !await quiesceWorktreeProcesses(record.dir)) return
    if (!record.discard!.steps.stop) {
      await this.markDiscardStep(id, 'stop')
      record = this.#read(id)!
    }
    if (!record.discard!.steps.patch) {
      if (owned) {
        const ignored = await ignoredWorkerArtifacts(own, leadDir)
        if (ignored.length && !record.discard!.force) {
          await this.interruptDiscard(id, `ignored artifacts appeared: ${ignored.join(', ')}`)
          return
        }
        await saveDiscardPatch(leadDir, own, bytes => publishPatch(id, bytes))
      }
      await this.markDiscardStep(id, 'patch')
      record = this.#read(id)!
    }
    const published = record.discard!.patch
    if (published) {
      const expected = path.join(this.root, 'patches', `${id}.patch`)
      if (published.path !== expected) throw new Error(`discard patch path changed for ${id}`)
      const valid = fs.existsSync(expected) && fs.lstatSync(expected).isFile()
        && createHash('sha256').update(fs.readFileSync(expected)).digest('hex') === published.sha256
      if (!valid) {
        if (!owned) throw new Error(`discard patch missing after worktree removal: ${expected}`)
        await saveDiscardPatch(leadDir, own, bytes => publishPatch(id, bytes))
      }
    }
    if (!record.discard!.steps.cleanup) {
      if (owned) {
        if (!await cleanupWorker(leadDir, own, { collected: true, discarded: true, leadName: record.lead.participant, workers, registry: cleanupRegistry })) return
      } else if (record.outside) {
        cleanupWorkerLogs(leadDir, record)
      } else if (!borrowed) {
        await pruneMissingWorkerWorktree(leadDir, own, true, cleanupRegistry)
        cleanupWorkerLogs(leadDir, record)
      } else cleanupWorkerLogs(leadDir, record)
      await this.markDiscardStep(id, 'cleanup')
    }
    await this.markDiscardStep(id, 'prune')
    await this.beginRetirement(id, this.archiveOf(this.#read(id)!, { summary: borrowed ? 'detached' : 'discarded', disposition: 'discarded' }))
    } finally { if (acquired) await this.finishOperation(id) }
  }

  /** Admission is evidence of launch only when a run writer proves the matching nonce. */
  async writeReport(id: string, report: RunReport): Promise<void> {
    const record = this.#read(id)
    const run = record?.runs.at(-1)
    if (!run || run.n !== report.run || run.nonce !== report.nonce || !['prepared', 'active'].includes(record!.phase)) throw new Error('run not admitted')
    const writer = this.writerFile(id, report.run)
    if (!fs.existsSync(writer) && !createExclusive(writer, this.identity)) throw new Error('run writer busy')
    const prior = this.#readFact(writer, tokenShape)
    if (prior && prior.nonce !== this.identity.nonce && !await leaseRetry(() => replace(writer,
      current => current.sessionId === this.identity.sessionId && this.alive(current as InstanceToken) === 'dead', this.identity))) {
      throw new Error('run writer busy')
    }
    await guarded(writer, () => {
      const owner = this.#readFact(writer, tokenShape)
      if (owner?.nonce !== this.identity.nonce) throw new Error('run writer belongs to another instance')
      const previous = this.#readFact(this.reportFile(id, report.run), reportShape)
      if (previous && previous.nonce !== report.nonce) throw new Error('run report nonce mismatch')
      // The later report wins (by number, then time); `posted` follows it when either write posted it.
      const done = !previous?.done || report.done && laterDone(report.done, previous.done) ? report.done : previous.done
      const posted = [report.posted, previous?.posted].find(value => done && value === completionId(id, report.run, done.k))
      writeAtomic(this.reportFile(id, report.run), previous ? { ...previous,
        chain: previous.chain, joinedAt: previous.joinedAt,
        hostProcess: previous.hostProcess !== undefined ? previous.hostProcess : report.hostProcess,
        hostSessionId: previous.hostSessionId ?? report.hostSessionId,
        done, posted: posted ?? previous.posted ?? report.posted } : report)
    })
    this.changed(id)
  }

  /** A witnessed child-close observation is never replaced by a later unwitnessed poll. */
  async writeExit(id: string, observation: ExitObservation): Promise<void> {
    const file = this.exitFile(id, observation.run)
    await guarded(file, () => {
      const old = this.#readFact(file, exitShape)
      if (!old || (!old.witnessed && observation.witnessed)) writeAtomic(file, observation)
    })
    this.changed(id)
  }

  private async rollbackPreparation(record: WorkerRecord): Promise<void> {
    const prep = record.prep
    if (record.sharedWith) { removeWorkerRefs(this.commonDir, record); return }
    // A supplied directory has no resources for this preparation to undo.
    if (prep.created !== true && prep.branchCreated !== true
      && !Object.keys(prep.previousCarryRefs ?? {}).length) {
      if (!record.outside) {
        if (fs.existsSync(record.dir)) retainCheckout(this.commonDir, record, 'Room has no record of creating this folder; left in place')
        deleteWorkerRef(this.commonDir, `refs/heads/${record.branch}`, record.id)
      }
      return
    }
    const leadDir = record.outside ? path.dirname(this.commonDir) : path.dirname(path.dirname(path.dirname(record.dir)))
    if (!roomWorkerPathMatchesBranch(leadDir, record.dir, record.branch, false)) throw new Error(`unsafe preparation path for ${record.id}`)
    if (prep.created !== true) {
      if (fs.existsSync(record.dir)) retainCheckout(this.commonDir, record, 'Room has no record of creating this folder; left in place')
      deleteWorkerRef(this.commonDir, `refs/heads/${record.branch}`, record.id)
      return
    }
    try {
      await removePreparation(this.commonDir, record.dir, { ...record.prep.witness, id: record.id, nonce: record.runs[0].nonce, branch: record.branch, branchOid: record.prep.branchOid, root: record.prep.root },
        prep.branchCreated === true && prep.branchExisted === false)
    } catch (error) {
      const reason = retainCheckout(this.commonDir, record, error instanceof Error ? error.message : String(error))
      process.stderr.write(`[room] ${reason}; remaining preparation resources retained\n`)
      return
    }
    const refs = prep.previousCarryRefs
    if (refs && typeof refs === 'object' && !Array.isArray(refs)) {
      for (const [ref, oid] of Object.entries(refs)) {
        if (!/^refs\/room\/(carry|carry-untracked)\/[A-Za-z0-9._/-]+$/.test(ref)) throw new Error(`unsafe preparation ref ${ref}`)
        restoreWorkerRef(this.commonDir, ref, typeof oid === 'string' ? oid : undefined, record.id)
      }
    }
  }

  async abandonPreparation(id: string): Promise<void> {
    const record = this.#read(id)
    if (!record || record.runs.at(-1)?.launch) return
    if (record.sharedWith || record.phase === 'preparing' || record.phase === 'prepared') await this.rollbackPreparation(record)
    await this.update(id, old => ({ ...old, phase: 'abandoned', seq: old.seq + 1 }))
  }

  /** Bootstrap only: a dead spawn may have published its tag/op before its payload. Inventory
   * blockers must not prevent recovery, but only genuine ENOENT can establish missing evidence. */
  private async recoverOrphanReservations(tags: ReadonlySet<string>): Promise<boolean> {
    if (this.readOnly) return false
    let recovered = false
    const absent = (file: string): boolean => {
      try { fs.lstatSync(file); return false }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
    }
    for (const tag of tags) {
      if (!safeTag(tag)) continue
      const file = this.tagFile(tag)
      try {
        const text = fs.readFileSync(file, 'utf8'), key = statKey(file)?.key
        const reservation: unknown = JSON.parse(text)
        if (!object(reservation) || typeof reservation.id !== 'string' || !safeId(reservation.id)
          || !tokenShape(reservation.holder) || !Number.isFinite(reservation.at)
          || Object.keys(reservation).some(k => !['id', 'holder', 'at'].includes(k))
          || !key || !absent(this.workerFile(reservation.id))) continue
        const { id, holder } = reservation
        const removed = await guarded(path.join(this.root, 'capacity'), () => withWorkerTag(this.root, tag, () => {
          if (statKey(file)?.key !== key || fs.readFileSync(file, 'utf8') !== text
            || !fs.lstatSync(file).isFile() || this.alive(holder) !== 'dead') return
          const opFile = this.opFile(id)
          // A filesystem guard protects the final op comparison/deletion; no operation lease is acquired.
          return withGuard(opFile, () => {
            let opText: string | undefined
            if (!absent(opFile)) {
              if (!fs.lstatSync(opFile).isFile()) return
              opText = fs.readFileSync(opFile, 'utf8')
              const op: unknown = JSON.parse(opText)
              if (!object(op) || op.op !== 'spawn' || !tokenShape(op.holder) || !Number.isFinite(op.at)
                || Object.keys(op).some(k => !['op', 'holder', 'at'].includes(k))) return
              const opHolder = op.holder
              if (!(Object.keys(holder) as (keyof InstanceToken)[]).every(k => opHolder[k] === holder[k])
                || this.alive(opHolder) !== 'dead') return
            }
            // Recheck after process probes too. A payload, dangling symlink, partial run directory,
            // adoption or quarantined evidence makes this an unknown lifecycle, never an absent spawn.
            if (statKey(file)?.key !== key || fs.readFileSync(file, 'utf8') !== text
              || !absent(this.workerFile(id)) || !absent(path.join(this.root, 'runs', id))
              || !absent(this.adoptionFile(id)) || files(path.join(this.root, 'quarantine'), '').length) return
            if (opText === undefined ? !absent(opFile) : fs.readFileSync(opFile, 'utf8') !== opText) return
            // Op first: interruption before removing the reservation leaves another recoverable bootstrap gap.
            if (opText !== undefined) fs.rmSync(opFile)
            fs.rmSync(file)
            return true
          })
        }))
        if (removed) { recovered = true; this.changed(id) }
      } catch {
        // Busy guards, malformed/unreadable evidence and uncertain filesystem state stay blocking.
        // Normal reconciliation below still inventories/quarantines evidence under its existing rules.
      }
    }
    return recovered
  }

  async reconcile(): Promise<void> {
    // Only this writer-owned pass may rename invalid facts, after its read-only inventory.
    const candidates = new Map<string, { key?: string; text?: string; why: unknown }>()
    this.quarantineCandidates = candidates
    // Capture each run family once. Recovery consumes this inventory, and a pass that
    // never yields can also use it for change detection. External writes after capture
    // are detected on the next pass, just as writes after the old final scan were.
    const orphanTags = new Set<string>()
    const scan = () => this.#inventory(() => this.#list(false, orphanTags).records.map(record => ({ record,
      reports: this.#reports(record.id).records, exits: this.#exits(record.id).records })))
    let inventory: ReturnType<typeof scan>
    try {
      inventory = scan()
    } finally { this.quarantineCandidates = undefined }
    // The normal inventory identifies candidates without a second all-tag scan. Recover only
    // proven dead, empty preparations before its missing-payload blocker can end reconciliation.
    if (orphanTags.size && await this.recoverOrphanReservations(orphanTags)) {
      candidates.clear(); orphanTags.clear()
      this.quarantineCandidates = candidates
      try { inventory = scan() } finally { this.quarantineCandidates = undefined }
    }
    if (inventory.blockers.length) {
      for (const [file, fact] of candidates) {
        if (!fact.key || statKey(file)?.key !== fact.key) continue
        // Compare captured bytes too: an in-place repair can share a coarse timestamp tick.
        if (fact.text !== undefined && fs.readFileSync(file, 'utf8') !== fact.text) continue
        this.quarantine(file, fact.why)
      }
      return
    }
    let yielded = false
    for (const { record, reports, exits } of inventory.records) {
      const run = record.runs.at(-1)
      if (!run) continue
      // The operation lease itself is deliberately not treated as launch evidence.
      const hadOp = fs.existsSync(this.opFile(record.id))
      const op = this.#readFact(this.opFile(record.id), (value): value is { holder: InstanceToken } => object(value) && tokenShape(value.holder))
      if (hadOp && !op) continue
      if (op && this.alive(op.holder) === 'dead') {
        yielded = true
        await leaseRetry(() => recover(this.opFile(record.id), () => true))
      }
      // An earlier recovery await may have let another call publish or corrupt run
      // evidence. Recheck the deciding scope rather than trusting the preflight copy.
      const currentReports = () => yielded ? requireWorkerInventory(this.#reports(record.id)) : reports
      const report = currentReports().find(value => value.run === run.n && value.nonce === run.nonce)
      if (report?.hostSessionId && !record.hostSessionId && !fs.existsSync(this.opFile(record.id))) {
        yielded = true
        await this.update(record.id, old => ({ ...old, hostSessionId: old.hostSessionId ?? report.hostSessionId, seq: old.seq + 1 }))
      }
      if (record.phase === 'collecting' && (!op || this.alive(op.holder) === 'dead')) {
        yielded = true
        await this.update(record.id, old => ({ ...old, phase: 'active',
          interrupted: old.interrupted ?? { op: 'collect', at: this.now(), detail: 'collection stopped; partial apply may remain' },
          seq: old.seq + 1 }))
        continue
      }
      if (record.phase === 'discarding' && (!op || this.alive(op.holder) === 'dead')) {
        yielded = true
        try { await this.beginOperation(record.id, 'discard'); await this.replayDiscard(record.id) }
        catch (error) { process.stderr.write(`[room] discard replay ${record.id}: ${error}\n`) }
        finally { await this.finishOperation(record.id).catch(() => {}) }
        continue
      }
      if (record.phase === 'preparing' && this.alive(run.launcher) === 'dead') {
        yielded = true
        await this.rollbackPreparation(record)
        await this.update(record.id, old => ({ ...old, phase: 'abandoned', seq: old.seq + 1 }))
        continue
      }
      if (!run.launch) {
        const report = currentReports().find(value => value.run === run.n && value.nonce === run.nonce)
        const writer = this.#readFact(this.writerFile(record.id, run.n), tokenShape)
        if (writer && report) {
          yielded = true
          await this.update(record.id, old => {
            const latest = old.runs.at(-1)!
            if (latest.launch) return { ...old, seq: old.seq + 1 }
            const process = admittedHost(report)
            return { ...old, phase: 'active', runs: [...old.runs.slice(0, -1), { ...latest,
              launch: process ? { outcome: 'launched', pid: process.pid, process } : { outcome: 'ambiguous', at: this.now() } }], seq: old.seq + 1 }
          })
        } else if (this.alive(run.launcher) === 'dead') {
          yielded = true
          await this.update(record.id, old => ({ ...old,
            runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, launch: { outcome: 'ambiguous', at: this.now() } }], seq: old.seq + 1 }))
        }
        continue
      }
      if (run.launch.outcome === 'ambiguous') {
        const report = currentReports().find(value => value.run === run.n && value.nonce === run.nonce)
        const writer = this.#readFact(this.writerFile(record.id, run.n), tokenShape)
        if (writer && report) {
          yielded = true
          await this.update(record.id, old => {
            const process = admittedHost(report)
            if (!process) return old
            return { ...old, phase: 'active', runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, launch: { outcome: 'launched', pid: process.pid, process } }], seq: old.seq + 1 }
          })
        }
      }
      if (run.launch.outcome === 'launched' && !(yielded ? requireWorkerInventory(this.#exits(record.id)) : exits).some(e => e.run === run.n)
        && this.alive(run.launcher) === 'dead' && run.launch.process && this.alive(run.launch.process) === 'dead') {
        yielded = true
        await this.writeExit(record.id, { run: run.n, code: null, at: this.now(), witnessed: false })
      }
    }
    for (const file of files(path.join(this.root, 'patches'), '.patch')) {
      const workerId = path.basename(file, '.patch')
      const owner = this.#read(workerId)
      if (owner && owner.phase !== 'retired') continue
      if (this.now() - fs.statSync(file).mtimeMs >= 7 * 24 * 60 * 60 * 1000) fs.rmSync(file, { force: true })
    }
    const next = new Map<string, string>()
    // Recovery may have changed records/runs or allowed another in-process writer to
    // run. Refresh after any await; never carry this memo into another reconcile call.
    for (const { record, reports, exits } of requireWorkerInventory(yielded ? scan() : inventory))
      next.set(record.id, JSON.stringify([record, reports, exits]))
    const externalChange = next.size !== this.observed.size || [...next].some(([key, value]) => this.observed.get(key) !== value)
    this.observed = next
    if (externalChange) this.changed()
  }

}
