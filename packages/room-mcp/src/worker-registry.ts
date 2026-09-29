/** The local source of truth for worker operations. No replicated document grants local authority. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import * as Y from 'yjs'
import { completionMessage, participantRecord, RoomDoc, ROOM_DOC_MAX_BYTES } from '@room/shared'
import { commonGitDirFromDotGit, gitCommonDir } from '@room/roomd'
import { workerBaseline, type Baseline, type BaselineSource } from '@room/roomd/baseline'
import { compareAndRelease, createExclusive, liveness, recover, replace, withGuard, writeAtomic, type InstanceToken } from './leases.js'
import { followUpAnswer, missingClaudeSession, probeProcess, workerLogTail } from './worker-process.js'
import { idleClaimsDue, statusOf, type ExitObservation, type LivenessProbe, type RunReport, type WorkerRecord, type WorkerStatusResult } from './worker-status.js'
import type { RetiredWorker } from '@room/shared'
import { isOwnedWorkerWorktree, roomWorkerPathMatchesBranch } from './worker-state.js'
import { realStateInput, type LocalWorker } from './worker-status.js'
import { cleanupWorker, cleanupWorkerLogs, ignoredWorkerArtifacts, pruneMissingWorkerWorktree, saveDiscardPatch } from './worker-git.js'
import { pidAlive, quiesceWorktreeProcesses, signalWorker, stopWorkerWithEscalation } from './worker-process.js'

export interface LegacySource {
  key: string; tag: string; dir: string; branch: string; host: 'claude' | 'codex'
  oldId?: string; model?: string; task?: string; said?: string; keptWorktree?: string; share?: WorkerRecord['share']
}
export interface RegistryOptions {
  liveness?: LivenessProbe; now?: () => number; identity?: InstanceToken
  /** An import adapter can supply decoded 0.16 snapshots; default discovery scans owned git worktrees. */
  sources?: (commonDir: string) => LegacySource[]; migrate?: boolean; watch?: boolean
}
export interface IdleClaimsAction {
  roomKey: string; sessionId: string; participant: string; idleEpoch: string; epoch?: string
  host: 'shared-app-server' | 'interactive'; lastActivityMs: number; monotonicMs: () => number
  doc: RoomDoc; postNotice: (id: string, text: string) => void | { ok: boolean; text?: string } | Promise<{ ok: boolean; text?: string }>
  /** The local name lease must still belong to this process and epoch after guard acquisition. */
  ownsParticipant?: () => boolean
}
interface IdleReleaseRecord {
  state: 'pending' | 'done'; claimIds: string[]; claimNames: string[]; hadScope: boolean
  /** Replay identity is stored in the record: a restarted presence clock need not repeat its old idle epoch. */
  roomKey?: string; sessionId?: string; participant?: string; idleEpoch?: string; scopeAt?: number
}
interface MigrationMap { v: 1; sources: Record<string, { id: string; state: 'assigned' | 'imported' }>; done: boolean }
const readJson = <T>(file: string): T | undefined => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T }
  catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return undefined; throw e }
}
const files = (dir: string, suffix: string): string[] => {
  try { return fs.readdirSync(dir).filter(n => n.endsWith(suffix)).map(n => path.join(dir, n)) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
}
const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function base32(value: bigint, length: number): string {
  let out = ''
  for (let n = 0; n < length; n++) { out = crockford[Number(value & 31n)] + out; value >>= 5n }
  return out
}
const id = (): string => `w_${base32(BigInt(Date.now()), 10)}${base32(BigInt(`0x${randomBytes(10).toString('hex')}`), 16)}`
const synthetic = (): InstanceToken => ({ pid: process.pid, startTime: '', executable: '', sessionId: `mcp:${process.pid}`, nonce: randomBytes(16).toString('hex') })
const registries = new Map<string, Promise<WorkerRegistry>>()
const MAX_PROCESS_REGISTRIES = 24
/** Synchronous durable snapshot for existing synchronous tool readers during rollout. */
export function registrySnapshotForDir(dir: string): WorkerRegistry {
  return WorkerRegistry.snapshot(commonGitDirFromDotGit(dir))
}
export async function closeRegistryForDir(dir: string): Promise<void> {
  const common = commonGitDirFromDotGit(dir)
  const pending = registries.get(common)
  registries.delete(common)
  ;(await pending?.catch(() => undefined))?.close()
}
/** One token and watcher per common dir for this MCP process. */
export async function registryForDir(dir: string, sessionId?: string): Promise<WorkerRegistry> {
  const common = await gitCommonDir(dir)
  let pending = registries.get(common)
  if (!pending) {
    if (registries.size >= MAX_PROCESS_REGISTRIES) {
      const oldest = registries.keys().next().value as string | undefined
      if (oldest) {
        const previous = registries.get(oldest)
        registries.delete(oldest)
        void previous?.then(registry => registry.close()).catch(() => {})
      }
    }
    const processInfo = probeProcess(process.pid)
    const identity: InstanceToken = { pid: process.pid, startTime: processInfo?.startTime ?? '',
      executable: processInfo?.executable ?? '', sessionId: sessionId ?? `mcp:${process.pid}:${processInfo?.startTime ?? 'unknown'}`,
      nonce: randomBytes(16).toString('hex') }
    pending = WorkerRegistry.open(common, { identity, watch: !process.env.VITEST })
    registries.set(common, pending)
    void pending.catch(() => { if (registries.get(common) === pending) registries.delete(common) })
  } else {
    // Move this checkout to the end of the bounded cache.
    registries.delete(common)
    registries.set(common, pending)
  }
  return pending
}

/** Called before roomd publishes a worker's identity or files. */
export async function admitWorkerEnvironment(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const id = env.ROOM_WORKER_ID
  if (!id) return
  const room = env.ROOM_ROOM ?? ''
  if (!id.startsWith('w_')) throw new Error('this worker runs Room 0.17 but its lead runs an older Room: update the Room plugin for the lead\'s host')
  const run = Number(env.ROOM_WORKER_RUN), nonce = env.ROOM_LAUNCH_NONCE
  if (!Number.isSafeInteger(run) || run < 1 || !nonce) throw new Error('this worker run was collected, discarded or superseded')
  const registry = await registryForDir(dir, env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID)
  if (!room || registry.read(id)?.room !== room) throw new Error('this worker run was collected, discarded or superseded')
  if (env.ROOM_REGISTRY && fs.realpathSync(path.resolve(env.ROOM_REGISTRY)) !== fs.realpathSync(registry.root)) throw new Error('this worker run was collected, discarded or superseded')
  const processInfo = probeProcess(process.pid)
  const parentInfo = probeProcess(process.ppid)
  const chain = [{ pid: process.pid, startTime: processInfo?.startTime ?? '', executable: processInfo?.executable ?? '' },
    ...(parentInfo ? [{ pid: process.ppid, startTime: parentInfo.startTime ?? '', executable: parentInfo.executable ?? '' }] : [])]
  try { await registry.admit({ id, run, nonce, dir, chain, hostProcess: chain[1] ?? null,
    hostSessionId: env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID }) }
  catch { throw new Error('this worker run was collected, discarded or superseded') }
}
/**
 * This clone's current worker under a participant name, as a carried-baseline source with its lead: a local
 * fact from the registry (registry §14), for merge bases and carried-work checks, never from the room.
 */
export function localWorkerBaseline(dir: string, participant: string): (BaselineSource & { lead: string }) | undefined {
  let record: WorkerRecord | undefined
  try { record = registrySnapshotForDir(dir).list().find(r => r.name === participant && !['retired', 'abandoned'].includes(r.phase)) } catch { return undefined }
  return record && { name: record.name, dir: record.dir, base: record.base, carriedBase: record.carriedBase,
    carriedUntracked: record.carriedUntracked, link: record.link, lead: record.lead.participant }
}

/** A lead's workers that are not retiring, by name: the wake path's own-worker set (registry §14). No process probes. */
export function ownWorkerNames(dir: string, lead: string): Set<string> {
  try {
    return new Set(registrySnapshotForDir(dir).list()
      .filter(r => r.lead.participant === lead && !['retiring', 'retired', 'abandoned'].includes(r.phase)).map(r => r.name))
  } catch { return new Set() }
}

/** This clone's workers that are not retiring, as the lifecycle helpers' input (registry §1: local facts only). */
export function localWorkers(dir: string, keep: (record: WorkerRecord) => boolean = () => true): LocalWorker[] {
  const registry = registrySnapshotForDir(dir)
  return registry.list().flatMap(record => {
    if (['retiring', 'retired', 'abandoned'].includes(record.phase) || !keep(record)) return []
    const status = registry.status(record.id)
    return status ? [realStateInput(record, status)] : []
  })
}

/** A participant's carried baseline and its lead, when it is one of this clone's workers (ConflictSet's `carriedFrom`). */
export function carriedFrom(dir: string, participant: string): { baseline: Baseline; lead: string } | undefined {
  const source = localWorkerBaseline(dir, participant)
  const baseline = workerBaseline(source)
  return source && baseline ? { baseline, lead: source.lead } : undefined
}

/** A worker daemon's carried baseline, read from its lead's registry record (F2): the room never supplies it. */
export function workerCarried(dir: string, env: NodeJS.ProcessEnv = process.env): WorkerRecord | undefined {
  const id = env.ROOM_WORKER_ID
  if (!id || !safeId(id)) return undefined
  try { return registrySnapshotForDir(dir).read(id) } catch { return undefined }
}
const missing = (file: string): boolean => !fs.existsSync(file)
const safeId = (value: string): boolean => /^w_[A-Za-z0-9_-]{1,64}$/.test(value)
const safeTag = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) && value !== '..'
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
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const tokenShape = (value: unknown): value is InstanceToken => object(value) && Number.isSafeInteger(value.pid)
  && typeof value.startTime === 'string' && typeof value.executable === 'string'
  && typeof value.sessionId === 'string' && typeof value.nonce === 'string'
const processShape = (value: unknown): boolean => object(value) && Number.isSafeInteger(value.pid)
  && typeof value.startTime === 'string' && typeof value.executable === 'string'
const runShape = (value: unknown): boolean => {
  if (!object(value) || !Number.isSafeInteger(value.n) || (value.n as number) < 1
    || !['fresh', 'resume'].includes(value.mode as string) || typeof value.intentAt !== 'number'
    || typeof value.nonce !== 'string' || !Number.isSafeInteger(value.busFrontier) || !Array.isArray(value.promptMsgIds)
    || !tokenShape(value.launcher) || typeof value.logStart !== 'number') return false
  if (value.launch === undefined) return true
  if (!object(value.launch)) return false
  switch (value.launch.outcome) {
    case 'launched': return Number.isSafeInteger(value.launch.pid) && (value.launch.process === undefined || processShape(value.launch.process))
    case 'never': return typeof value.launch.error === 'string'
    case 'ambiguous': return typeof value.launch.at === 'number'
    case 'imported': return true
    default: return false
  }
}
const recordShape = (value: unknown, id: string): value is WorkerRecord => object(value) && value.v === 1 && value.id === id
  && typeof value.tag === 'string' && safeTag(value.tag) && typeof value.name === 'string'
  && ['local', 'here'].includes(value.mode as string) && typeof value.room === 'string'
  && object(value.lead) && typeof value.lead.participant === 'string' && typeof value.lead.room === 'string' && tokenShape(value.lead.instance)
  && ['claude', 'codex'].includes(value.host as string) && object(value.budget)
  && typeof value.task === 'string' && typeof value.dir === 'string' && typeof value.branch === 'string'
  && typeof value.outside === 'boolean' && object(value.prep) && typeof value.prep.step === 'string'
  && object(value.capabilities) && typeof value.capabilities.resume === 'boolean' && typeof value.capabilities.signal === 'boolean'
  && ['delta', 'copy', 'none'].includes(value.capabilities.collect as string)
  && ['intent', 'preparing', 'prepared', 'active', 'collecting', 'discarding', 'retiring', 'retired', 'abandoned'].includes(value.phase as string)
  && Array.isArray(value.runs) && value.runs.length > 0 && value.runs.every(runShape)
  && typeof value.createdAt === 'number' && Number.isSafeInteger(value.seq)
const reportShape = (value: unknown): value is RunReport => object(value) && Number.isSafeInteger(value.run)
  && typeof value.nonce === 'string' && Array.isArray(value.chain) && value.chain.every(processShape)
  && (value.hostProcess === undefined || value.hostProcess === null || processShape(value.hostProcess))
  && typeof value.joinedAt === 'number' && (value.hostSessionId === undefined || typeof value.hostSessionId === 'string')
  && (value.posted === undefined || typeof value.posted === 'string')
  && (value.done === undefined || (object(value.done) && typeof value.done.at === 'number'
    && typeof value.done.summary === 'string' && Array.isArray(value.done.changed)))
/** Schema-2 admission explicitly distinguishes an unverified parent from the worker MCP. */
const admittedHost = (report: RunReport): RunReport['chain'][number] | undefined =>
  report.hostProcess !== undefined ? report.hostProcess ?? undefined : report.chain[1]
const exitShape = (value: unknown): value is ExitObservation => object(value) && Number.isSafeInteger(value.run)
  && (value.code === null || Number.isSafeInteger(value.code)) && typeof value.at === 'number'
  && typeof value.witnessed === 'boolean' && (value.signal === undefined || typeof value.signal === 'string')
function commitExists(commonDir: string, oid: unknown): oid is string {
  if (typeof oid !== 'string' || !/^[0-9a-f]{40,64}$/.test(oid)) return false
  try { execFileSync('git', ['--git-dir', commonDir, 'cat-file', '-e', `${oid}^{commit}`], { stdio: 'ignore' }); return true }
  catch { return false }
}
function legacySession(dir: string, oldId: string | undefined, host: LegacySource['host']): string | undefined {
  if (!oldId) return undefined
  try {
    const gitDir = execFileSync('git', ['-C', dir, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim()
    const local = readJson<{ worker_id?: string; host?: string; session_id?: string }>(path.join(gitDir, 'room-session.json'))
    return local?.worker_id === oldId && local.host === host && typeof local.session_id === 'string' ? local.session_id : undefined
  } catch { return undefined }
}

class LegacySnapshotUnavailable extends Error {}
/** The display fields of a 0.16 snapshot's tag-keyed `workers` entry. */
interface LegacyWorkerEntry { id?: string; dir?: string; host: 'claude' | 'codex'; model?: string; task?: string; summary?: string }
/** The old CRDT is display evidence only: it never supplies pid, session, base or capability. */
function legacyDisplay(commonDir: string): Map<string, Pick<LegacySource, 'oldId' | 'host' | 'model' | 'task' | 'said' | 'keptWorktree'>> {
  const found = new Map<string, Pick<LegacySource, 'oldId' | 'host' | 'model' | 'task' | 'said' | 'keptWorktree'>>()
  const canonical = (dir: string): string => { try { return fs.realpathSync(dir) } catch { return path.resolve(dir) } }
  for (const file of files(path.join(commonDir, 'room-local'), '.ydoc')) {
    const doc = new Y.Doc()
    try {
      if (fs.statSync(file).size > ROOM_DOC_MAX_BYTES) throw new Error(`snapshot exceeds ${ROOM_DOC_MAX_BYTES / 1048576} MiB`)
      Y.applyUpdate(doc, fs.readFileSync(file))
      const room = new RoomDoc(doc)
      for (const worker of doc.getMap<LegacyWorkerEntry>('workers').values()) {
        if (!worker.dir || !worker.id) continue
        found.set(canonical(worker.dir), { oldId: worker.id, host: worker.host, model: worker.model,
          task: worker.task, said: worker.summary })
      }
      for (const retired of room.retiredWorkers()) {
        if (!retired.keptWorktree) continue
        const prior = found.get(canonical(retired.keptWorktree))
        found.set(canonical(retired.keptWorktree), { ...prior, host: retired.host, model: retired.model,
          task: retired.task, said: retired.summary, keptWorktree: retired.keptWorktree })
      }
    } catch (error) {
      process.stderr.write(`[room] cannot import legacy worktrees while ${file} is unreadable: ${error}\n`)
      throw new LegacySnapshotUnavailable(`unreadable legacy snapshot: ${file}`)
    }
    finally { doc.destroy() }
  }
  return found
}

/** Conservative local discovery: only Git's own worktree list and canonical Room paths are imported. */
export function discoverLegacyWorktrees(commonDir: string): LegacySource[] {
  let output: string
  try { output = execFileSync('git', ['--git-dir', commonDir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }) }
  catch { return [] }
  const registered = new Set([...output.matchAll(/^worktree (.+)$/gm)].map(match => {
    try { return fs.realpathSync(match[1]) } catch { return path.resolve(match[1]) }
  }))
  const display = legacyDisplay(commonDir)
  const out: LegacySource[] = []
  for (const block of output.split(/\n\s*\n/)) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1]
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    if (!dir || !branch?.startsWith('room/')) continue
    const tag = branch.slice(5)
    if (path.basename(dir) !== tag || !dir.includes(`${path.sep}.room${path.sep}workers${path.sep}`)) continue
    let canonical: string
    try { canonical = fs.realpathSync(dir) } catch { continue }
    const ownerCheckout = path.dirname(path.dirname(path.dirname(canonical)))
    if (!registered.has(ownerCheckout) || !roomWorkerPathMatchesBranch(ownerCheckout, canonical, branch)) continue
    const prior = display.get(canonical)
    out.push({ key: `worktree:${canonical}`, tag, dir: canonical, branch,
      host: prior?.host ?? 'codex', ...(prior ?? {}) })
  }
  return out
}

export class WorkerRegistry {
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
  private constructor(readonly commonDir: string, private readonly options: RegistryOptions) {
    this.root = path.join(commonDir, 'room', 'registry')
    this.alive = options.liveness ?? liveness
    this.now = options.now ?? Date.now
    this.identity = options.identity ?? synthetic()
  }

  static async open(commonDir: string, options: RegistryOptions = {}): Promise<WorkerRegistry> {
    const registry = new WorkerRegistry(commonDir, options)
    if (options.migrate !== false) await registry.migrate()
    await registry.reconcile()
    if (options.watch !== false) registry.watch()
    return registry
  }
  static snapshot(commonDir: string): WorkerRegistry { return new WorkerRegistry(commonDir, { migrate: false, watch: false }) }
  close(): void { clearInterval(this.timer); this.timer = undefined; for (const watcher of this.watchers.splice(0)) watcher.close() }
  private watch(): void {
    for (const dir of [this.root, path.join(this.root, 'runs')]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
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
  private tagFile(tag: string): string { if (!safeTag(tag)) throw new Error('invalid worker tag'); return path.join(this.root, 'tags', `${tag}.json`) }
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
    const dir = path.join(this.root, 'quarantine')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const dest = path.join(dir, `${path.basename(file)}.bad-${Date.now()}-${randomBytes(4).toString('hex')}`)
    try { fs.renameSync(file, dest); process.stderr.write(`[room] quarantined ${file}: ${why}\n`) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  private hasQuarantinedRecord(id: string): boolean {
    try { return fs.readdirSync(path.join(this.root, 'quarantine')).some(name => name.startsWith(`${id}.json.bad-`)) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
  }
  private readFact<T>(file: string, valid: (value: unknown) => value is T): T | undefined {
    try {
      const value = readJson<unknown>(file)
      if (value === undefined) return undefined
      if (valid(value)) return value
      this.quarantine(file, 'invalid registry fact')
    } catch (e) { this.quarantine(file, e) }
    return undefined
  }
  /** `id` names the one worker that changed; none means any may have (another instance's writes). */
  private changed(id?: string): void { for (const listener of this.listeners) listener(id) }
  onChange(listener: (id?: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  private idleClaimsDir(sessionId: string): string {
    return path.join(this.commonDir, 'room', 'sessions', sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'), 'idle-claims')
  }

  private idleClaimsFile(roomKey: string, sessionId: string, idleEpoch: string): string {
    const key = createHash('sha256').update(`${roomKey}\0${sessionId}\0${idleEpoch}`).digest('hex')
    return path.join(this.idleClaimsDir(sessionId), `${key}.json`)
  }

  private pendingIdleClaims(roomKey: string, sessionId: string, idleEpoch: string, participant?: string): { file: string; record: IdleReleaseRecord } | undefined {
    const direct = this.idleClaimsFile(roomKey, sessionId, idleEpoch)
    const candidates = [direct, ...files(this.idleClaimsDir(sessionId), '.json').filter(file => file !== direct)]
    for (const file of candidates) {
      let record: IdleReleaseRecord | undefined
      try { record = readJson<IdleReleaseRecord>(file) } catch (error) { this.quarantine(file, error); continue }
      if (!record || record.state !== 'pending' || !Array.isArray(record.claimIds) || !Array.isArray(record.claimNames)) continue
      if (file !== direct && (record.roomKey !== roomKey || record.sessionId !== sessionId || !record.idleEpoch)) continue
      if (participant && record.participant && record.participant !== participant) continue
      return { file, record }
    }
    return undefined
  }

  hasPendingIdleClaims(roomKey: string, sessionId: string, idleEpoch: string): boolean {
    return !!this.pendingIdleClaims(roomKey, sessionId, idleEpoch)
  }

  /** Callable by the wave-4 presence loop; its durable journal makes crash replay idempotent. */
  async reconcileIdleClaims(action: IdleClaimsAction): Promise<boolean> {
    const { doc, participant } = action
    const ownsNow = (): boolean => {
      const holder = participantRecord(doc, participant)?.holder
      if (action.ownsParticipant?.() !== true) return false
      return holder ? holder.sessionId === action.sessionId && action.epoch === String(holder.epoch) : true
    }
    if (!ownsNow()) return false
    const claims = [...doc.claims.values()].filter(c => c.by === participant && c.byKind !== 'human')
    const hasScope = doc.scopes.has(participant)
    const replay = this.pendingIdleClaims(action.roomKey, action.sessionId, action.idleEpoch, participant)
    const file = replay?.file ?? this.idleClaimsFile(action.roomKey, action.sessionId, action.idleEpoch)
    if (!replay && !fs.existsSync(file) && !idleClaimsDue({ host: action.host, lastActivityMs: action.lastActivityMs,
      nowMs: action.monotonicMs(), heldClaims: claims.length, hasScope })) return false
    const pending = await guarded(file, () => {
      // Async guard acquisition may outlive this participant's name lease.
      if (!ownsNow()) return false
      let journal = readJson<IdleReleaseRecord>(file)
      if (journal?.state === 'done') return false
      if (!journal) {
        journal = { state: 'pending', claimIds: claims.map(c => c.id),
          claimNames: claims.map(c => c.path.endsWith('/') ? c.path : `${c.path}:${c.from}-${c.to}`), hadScope: hasScope,
          roomKey: action.roomKey, sessionId: action.sessionId, participant, idleEpoch: action.idleEpoch,
          ...(hasScope ? { scopeAt: doc.scope(participant)?.at } : {}) }
        writeAtomic(file, journal)
      }
      const pending = journal
      doc.doc.transact(() => {
        for (const claimId of pending.claimIds) {
          const current = doc.claims.get(claimId)
          if (current?.by === participant && current.byKind !== 'human') doc.removeClaim(claimId)
        }
        if (pending.hadScope && (pending.scopeAt === undefined || doc.scope(participant)?.at === pending.scopeAt)) doc.clearScope(participant)
      })
      return pending
    })
    if (!pending) return false
    const noticeId = `idle-claims:${pending.sessionId ?? action.sessionId}:${pending.idleEpoch ?? action.idleEpoch}`
    const names = pending.claimNames.length ? `released claims ${pending.claimNames.join(', ')}` : 'released no claims'
    const posted = await action.postNotice(noticeId, `${participant} ${names}${pending.hadScope ? ' and cleared its scope' : ''} after 8 h idle`)
    if (posted?.ok === false) return false
    return guarded(file, () => {
      const current = readJson<IdleReleaseRecord>(file)
      if (!current || current.state === 'done') return false
      writeAtomic(file, { ...current, state: 'done' })
      return true
    })
  }
  read(id: string): WorkerRecord | undefined {
    const file = this.workerFile(id)
    try {
      const record = readJson<WorkerRecord>(file)
      if (record && !recordShape(record, id)) {
        this.quarantine(file, 'invalid worker record')
        return undefined
      }
      return record
    } catch (e) { this.quarantine(file, e); return undefined }
  }
  list(): WorkerRecord[] { return files(path.join(this.root, 'workers'), '.json').flatMap(file => {
    const id = path.basename(file, '.json')
    if (!safeId(id)) { this.quarantine(file, 'invalid worker filename'); return [] }
    const record = this.read(id)
    return record ? [record] : []
  }) }
  /** The reservation, rather than record ordering, selects the current incarnation of a tag. */
  reserved(tag: string): WorkerRecord | undefined {
    if (!safeTag(tag)) return undefined
    const reservation = readJson<{ id?: string }>(this.tagFile(tag))
    const record = reservation?.id ? this.read(reservation.id) : undefined
    return record?.tag === tag ? record : undefined
  }
  reservedByTagOrName(tagOrName: string): WorkerRecord | undefined {
    const direct = this.reserved(tagOrName)
    if (direct) return direct
    return this.list().find(record => record.name === tagOrName && this.reserved(record.tag)?.id === record.id)
  }
  /** Infer ownership for records written before sharedWith existed from the checkout's canonical tag. */
  worktreeOwner(record: WorkerRecord): WorkerRecord | undefined {
    if (record.sharedWith) return this.read(record.sharedWith)
    if (path.basename(record.dir) === record.tag && record.branch === `room/${record.tag}`) return undefined
    return this.list().find(peer => peer.id !== record.id && !peer.sharedWith
      && path.resolve(peer.dir) === path.resolve(record.dir)
      && path.basename(peer.dir) === peer.tag && peer.branch === `room/${peer.tag}`)
  }
  /** Other unretired workers using an owner's checkout, including legacy dir= records. */
  checkoutUsers(owner: Pick<WorkerRecord, 'id' | 'dir'>): { record: WorkerRecord; status: WorkerStatusResult }[] {
    return this.list().flatMap(record => {
      if (record.id === owner.id || ['retiring', 'retired', 'abandoned'].includes(record.phase)
        || path.resolve(record.dir) !== path.resolve(owner.dir)) return []
      const status = this.status(record.id)
      return status ? [{ record, status }] : []
    })
  }
  status(id: string): WorkerStatusResult | undefined {
    const record = this.read(id)
    if (!record) return undefined
    const reports = this.reports(id), exits = this.exits(id)
    const status = statusOf(record, record.runs, reports, exits, this.alive, this.now())
    const run = status.run
    if (status.noReport && run) {
      const logFile = path.join(path.dirname(record.dir), `${record.tag}.log`)
      return { ...status, summary: `ended without a report; last lines of its log: ${workerLogTail(logFile, run.logStart)}` }
    }
    if (status.status !== 'done' || run?.mode !== 'resume' || reports.some(report => report.run === run.n && report.done)
      || !exits.some(exit => exit.run === run.n && exit.witnessed && exit.code === 0)) return status
    const logFile = path.join(path.dirname(record.dir), `${record.tag}.log`)
    return { ...status, followUp: followUpAnswer(logFile, record.host, run.logStart) }
  }
  /** No room view or remote presence can turn into a local worktree capability. */
  async trusted(lead: { participant: string; room: string; dir: string }, tagOrName: string, allowVanished = false): Promise<{ record: WorkerRecord; status: WorkerStatusResult } | undefined> {
    let candidate = this.reservedByTagOrName(tagOrName)
    if (candidate?.legacy?.unowned) candidate = await this.adoptLegacy(candidate, lead)
    if (!candidate || candidate.lead.participant !== lead.participant || candidate.lead.room !== lead.room
      || ['retiring', 'retired', 'abandoned'].includes(candidate.phase)) return undefined
    const reservation = readJson<{ id?: string }>(this.tagFile(candidate.tag))
    if (reservation?.id !== candidate.id) return undefined
    const status = this.status(candidate.id)
    if (!status) return undefined
    const workers = this.list().flatMap(record => {
      const state = this.status(record.id)
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
    const worktreeRecord = this.worktreeOwner(candidate) ?? candidate
    if (!worktreeRecord || worktreeRecord.lead.participant !== lead.participant
      || path.resolve(worktreeRecord.dir) !== path.resolve(candidate.dir)
      || worktreeRecord.sharedWith) return undefined
    if (!await isOwnedWorkerWorktree(leadDir, { ...realStateInput(worktreeRecord, this.status(worktreeRecord.id) ?? status), dir: workerDir }, lead.participant, workers)) return undefined
    return { record: candidate, status }
  }
  /** Any operation lease, including an unreadable one, blocks automatic claim release. */
  operationInProgress(id: string): boolean {
    try { fs.lstatSync(this.opFile(id)); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  }
  /** One worker's durable run and lease facts for a trusted caller; never probes processes or scans peers. */
  freshness(id: string): { id: string; name: string; lead: string; dir: string; status: WorkerStatusResult['status']; run: string; seq: number; busy: boolean } | undefined {
    if (!safeId(id)) return undefined
    const record = this.read(id)
    if (!record) return undefined
    const status = statusOf(record, record.runs, this.reports(id), this.exits(id), () => 'dead', this.now())
    const run = status.run ?? record.runs.at(-1)
    return { id: record.id, name: record.name, lead: record.lead.participant, dir: record.dir, status: status.status,
      run: run ? `${run.n}:${run.nonce}` : '', seq: record.seq, busy: this.operationInProgress(id) }
  }
  private async adoptLegacy(record: WorkerRecord, lead: { participant: string; room: string; dir: string }): Promise<WorkerRecord | undefined> {
    if (!lead.participant || !lead.room || record.phase !== 'active') return undefined
    let leadDir: string
    try { leadDir = fs.realpathSync(lead.dir) } catch { return undefined }
    const status = this.status(record.id)
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
      const current = this.read(record.id)
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
  occupancy(): number { return this.list().filter(r => ['starting', 'running', 'unknown', 'ambiguous'].includes(this.status(r.id)?.status ?? '')).length }
  reports(id: string): RunReport[] { if (!safeId(id)) throw new Error('invalid worker id'); return files(path.join(this.root, 'runs', id), '.report.json').flatMap(f => {
    const report = this.readFact(f, reportShape)
    if (report && path.basename(f) !== `${report.run}.report.json`) { this.quarantine(f, 'run report filename mismatch'); return [] }
    return report ? [report] : []
  }) }
  exits(id: string): ExitObservation[] { if (!safeId(id)) throw new Error('invalid worker id'); return files(path.join(this.root, 'runs', id), '.exit.json').flatMap(f => {
    const observation = this.readFact(f, exitShape)
    if (observation && path.basename(f) !== `${observation.run}.exit.json`) { this.quarantine(f, 'exit filename mismatch'); return [] }
    return observation ? [observation] : []
  }) }

  /** Direct write-ahead seam for the wave-2 spawner; never spawns by itself. */
  async writeIntent(record: WorkerRecord, capacity = Number.POSITIVE_INFINITY): Promise<void> {
    if (!safeId(record.id) || !recordShape(record, record.id) || record.runs[0].launch) throw new Error('invalid worker intent')
    // A borrower joins the owner's operation lane before it becomes visible.
    // Collection holds this lane through its final cleanup decision.
    if (record.sharedWith) await this.beginOperation(record.sharedWith, 'resume')
    try {
    if (record.sharedWith) {
      const owner = this.read(record.sharedWith)
      if (!owner || owner.sharedWith || path.resolve(owner.dir) !== path.resolve(record.dir)
        || ['retiring', 'retired', 'abandoned'].includes(owner.phase)) throw new Error('shared worktree owner is no longer available')
    }
    const deadline = performance.now() + GUARD_WAIT_MS
    for (;;) {
      try {
        await guarded(path.join(this.root, 'capacity'), () => {
          if (this.occupancy() >= capacity) throw new Error('worker capacity reached')
          const tagFile = this.tagFile(record.tag)
          if (!createExclusive(tagFile, { id: record.id, holder: record.lead.instance, at: this.now() })) {
            const reservation = readJson<{ id?: string; holder?: InstanceToken }>(tagFile)
            if (reservation?.id && safeId(reservation.id) && tokenShape(reservation.holder)) {
              const bound = this.read(reservation.id)
              const reusable = bound && (bound.phase === 'abandoned' || (bound.phase === 'retired' && !bound.keptWorktree
                && !!bound.cleanup && Object.values(bound.cleanup).every(state => state === 'done')))
              if (reusable) compareAndRelease(tagFile, reservation.holder!)
              else if (!bound && !this.hasQuarantinedRecord(reservation.id)) recover(tagFile, current => current.id === reservation.id)
            }
            if (!createExclusive(tagFile, { id: record.id, holder: record.lead.instance, at: this.now() })) throw new Error(`tag in use: ${record.tag}`)
          }
          if (!createExclusive(this.opFile(record.id), { op: 'spawn', holder: record.runs[0].launcher, at: this.now() })) throw new Error('worker operation lease busy')
          if (!createExclusive(this.workerFile(record.id), record)) throw new Error(`worker already exists: ${record.id}`)
        }, deadline)
        break
      } catch (error) { await pauseForGuard(deadline, error) }
    }
    this.heldOperations.set(record.id, 'spawn')
    this.changed(record.id)
    } finally { if (record.sharedWith) await this.finishOperation(record.sharedWith) }
  }

  /** One operation writer per worker; the next rollout step uses this for preparation and launch facts. */
  async update(id: string, edit: (record: WorkerRecord) => WorkerRecord): Promise<WorkerRecord> {
    const priorOp = readJson<{ holder: InstanceToken }>(this.opFile(id))
    if (priorOp && priorOp.holder.nonce !== this.identity.nonce && this.alive(priorOp.holder) === 'dead') await leaseRetry(() => recover(this.opFile(id), () => true))
    const value = await guarded(this.opFile(id), () => {
      const op = readJson<{ holder: InstanceToken }>(this.opFile(id))
      if (op && op.holder.nonce !== this.identity.nonce) throw new Error(`worker operation lease held by another instance: ${id}`)
      const old = this.read(id)
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

  async beginOperation(id: string, op: 'resume' | 'stop' | 'collect' | 'discard'): Promise<boolean> {
    const file = this.opFile(id)
    if (createExclusive(file, { op, holder: this.identity, at: this.now() })) { this.heldOperations.set(id, op); return true }
    const existing = this.readFact(file, (value): value is { op: string; holder: InstanceToken; at: number } =>
      object(value) && typeof value.op === 'string' && tokenShape(value.holder) && typeof value.at === 'number')
    if (existing?.holder.nonce === this.identity.nonce) {
      if (existing.op === 'discard' && op === 'stop' && this.heldOperations.get(id) === 'discard') return false
      throw new Error(`worker operation lease held by another call: ${id}`)
    }
    if (existing && this.alive(existing.holder) === 'dead') {
      await leaseRetry(() => recover(file, () => true))
      if (createExclusive(file, { op, holder: this.identity, at: this.now() })) { this.heldOperations.set(id, op); return true }
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
    try { return await work() }
    finally { await leaseRetry(() => compareAndRelease(file, this.identity)) }
  }

  /** Append the next run while the same capacity guard used by fresh spawn is held. */
  async resume(id: string, capacity: number, input: { nonce: string; busFrontier: number; promptMsgIds?: string[]; logStart: number }): Promise<WorkerRecord> {
    const candidate = this.read(id)
    const owner = candidate && this.worktreeOwner(candidate)
    if (owner) await this.beginOperation(owner.id, 'resume')
    try {
    await this.beginOperation(id, 'resume')
    try {
      const next = await guarded(path.join(this.root, 'capacity'), () => {
        const old = this.read(id)
        if (!old || !old.capabilities.resume || !old.hostSessionId) throw new Error('worker has no resumable host session')
        const status = this.status(id)?.status
        if (!status || !['done', 'failed', 'ambiguous', 'imported', 'stopped'].includes(status)) throw new Error(`worker is ${status ?? 'missing'}; cannot resume`)
        if (status === 'stopped' && !['lead-session-ended', 'message-delivered-cancelled', 'message-delivered-failed'].includes(old.stop?.reason ?? '')) throw new Error('discarded worker cannot resume')
        if (this.occupancy() >= capacity) throw new Error('worker capacity reached')
        const run = { n: old.runs.at(-1)!.n + 1, mode: 'resume' as const, intentAt: this.now(),
          nonce: input.nonce, busFrontier: input.busFrontier, promptMsgIds: input.promptMsgIds ?? [],
          launcher: this.identity, logStart: input.logStart }
        const record: WorkerRecord = { ...old, phase: 'prepared', stop: undefined, runs: [...old.runs, run], seq: old.seq + 1 }
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
    const record = this.read(input.id)
    const run = record?.runs.at(-1)
    let actual: string, expected: string
    try { actual = fs.realpathSync(input.dir); expected = fs.realpathSync(record?.dir ?? '') }
    catch { throw new Error('worker run not admitted: checkout missing') }
    if (!run || run.n !== input.run || run.nonce !== input.nonce || actual !== expected
      || !['prepared', 'active'].includes(record!.phase)) throw new Error('worker run not admitted')
    const report: RunReport = { run: run.n, nonce: run.nonce, chain: input.chain,
      ...(input.hostProcess !== undefined ? { hostProcess: input.hostProcess } : {}),
      joinedAt: this.now(), ...(input.hostSessionId ? { hostSessionId: input.hostSessionId } : {}) }
    await this.writeReport(input.id, report)
    if (input.hostSessionId && !record!.hostSessionId && !fs.existsSync(this.opFile(input.id))) await this.update(input.id, old => ({ ...old,
      hostSessionId: old.hostSessionId ?? input.hostSessionId, seq: old.seq + 1 }))
    return this.reports(input.id).find(value => value.run === run.n)!
  }

  async reportDone(id: string, n: number, summary: string, changed: string[]): Promise<RunReport> {
    const record = this.read(id), run = record?.runs.at(-1)
    const prior = this.reports(id).find(report => report.run === n)
    if (!run || run.n !== n || !prior) throw new Error('worker run not admitted')
    await this.writeReport(id, { ...prior, done: { at: this.now(), summary, changed } })
    return this.reports(id).find(report => report.run === n)!
  }

  /** The post callback must use the deterministic id with RoomDoc.post. */
  /** `post` resolves once the hub took the message (a refusal throws), so `posted` is recorded only for a message that exists. */
  async postCompletion(id: string, n: number, post: (id: string, record: WorkerRecord, report: RunReport) => Promise<void>): Promise<boolean> {
    const record = this.read(id), run = record?.runs.find(value => value.n === n)
    const report = this.reports(id).find(value => value.run === n)
    if (!record || !run || !report?.done) throw new Error('worker completion not reported')
    // A clean exit may have produced a no-report notice. The late real report has its
    // own deterministic ID and supersedes that fallback in the registry projection.
    if (report.posted || run.posted && !run.posted.endsWith(':no-report')) return false
    const messageId = `wk:${id}:${n}`
    await post(messageId, record, report)
    await this.writeReport(id, { ...report, posted: messageId })
    return true
  }

  async postObservedFailure(id: string, n: number, post: (message: NonNullable<ReturnType<typeof completionMessage>>) => Promise<void>): Promise<boolean> {
    const record = this.read(id), run = record?.runs.find(value => value.n === n)
    const exit = this.exits(id).find(value => value.run === n)
    const report = this.reports(id).find(value => value.run === n)
    const current = this.status(id)
    const terminal = record?.phase === 'retiring' && !record.stop
      ? statusOf({ ...record, phase: 'active' }, record.runs, this.reports(id), this.exits(id), this.alive, this.now())
      : current
    const status = terminal?.noReport && run
      ? { ...terminal, summary: `ended without a report; last lines of its log: ${workerLogTail(path.join(path.dirname(record!.dir), `${record!.tag}.log`), run.logStart)}` }
      : terminal
    if (!record || !run || !status || !exit?.witnessed || run.posted || report?.posted
      || (status.status !== 'failed' && !status.noReport && !(record.phase === 'retiring' && !record.stop) && !report?.done)) return false
    const logFile = path.join(path.dirname(record.dir), `${record.tag}.log`)
    const missing = record.host === 'claude' && run.mode === 'resume' && !!record.hostSessionId
      && missingClaudeSession(logFile, record.hostSessionId, run.logStart)
    const tail = workerLogTail(logFile, run.logStart)
    const answer = run.mode === 'resume' ? followUpAnswer(logFile, record.host, run.logStart) : ''
    const detail = missing
      ? `its retained conversation ${record.hostSessionId} no longer exists; the message stays owed`
      : (answer || tail !== '(log unavailable)') ? `${status.note ?? 'exited before reporting done'}; ${answer || tail}` : status.note
    const message = completionMessage(record, run, { ...status, note: detail }, report)
    if (!message) return false
    const posted = status.noReport ? { ...message, id: `${message.id}:no-report` } : message
    await post(posted)
    await this.update(id, old => ({ ...old, runs: old.runs.map(value => value.n === n ? { ...value, posted: posted.id } : value), seq: old.seq + 1 }))
    return true
  }

  async beginStop(id: string, reason: NonNullable<WorkerRecord['stop']>['reason']): Promise<WorkerRecord> {
    return this.update(id, old => ({ ...old, stop: { reason, at: this.now(), run: old.runs.at(-1)!.n }, seq: old.seq + 1 }))
  }

  async beginCollect(id: string): Promise<WorkerRecord> {
    return this.update(id, old => ({ ...old, phase: 'collecting', interrupted: undefined, seq: old.seq + 1 }))
  }
  /** A collection that did not finish returns the worker to `active`; a finished one retires it (beginRetirement). */
  async abortCollect(id: string): Promise<WorkerRecord> {
    return this.update(id, old => ({ ...old, phase: 'active', seq: old.seq + 1 }))
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

  /** An archive entry from local facts, for retirements whose caller has nothing more specific. */
  archiveOf(record: WorkerRecord, facts: Partial<RetiredWorker> & Pick<RetiredWorker, 'summary'>): RetiredWorker {
    const status = this.status(record.id), at = this.now()
    return { id: record.id, name: record.name, tag: record.tag, lead: record.lead.participant, host: record.host,
      ...(record.model ? { model: record.model } : {}), task: record.task, files: [], fileCount: 0,
      startedAt: record.createdAt, finishedAt: status?.finishedAt ?? at, retiredAt: at, outcome: 'dismissed',
      ...(record.stop && record.stop.reason !== 'discarded' ? { stopReason: record.stop.reason } : {}), ...facts }
  }

  /** Retirement step 4: a room's projector finished its cleanup; the last room makes the record `retired`. */
  async finishCleanup(id: string, roomKey: string): Promise<WorkerRecord | undefined> {
    const current = this.read(id)
    if (current?.phase !== 'retiring' || current.cleanup?.[roomKey] !== 'pending') return current
    return this.update(id, old => {
      const cleanup = { ...old.cleanup, [roomKey]: 'done' as const }
      return { ...old, cleanup, ...(Object.values(cleanup).every(state => state === 'done') ? { phase: 'retired' as const } : {}), seq: old.seq + 1 }
    })
  }

  /**
   * The level-triggered input of the lead-side writers in one room (registry §13): `write` holds this lead's
   * workers that join the room or are projected into it and are not retiring; `retire` holds retiring ones
   * whose cleanup in this room is still pending.
   */
  projectable(lead: string, roomKey: string): { write: { record: WorkerRecord; status: WorkerStatusResult }[]; retire: WorkerRecord[] } {
    const write: { record: WorkerRecord; status: WorkerStatusResult }[] = [], retire: WorkerRecord[] = []
    for (const record of this.list()) {
      if (record.lead.participant !== lead || (record.room !== roomKey && record.projectedInto !== roomKey)) continue
      if (record.phase === 'retiring') { if (record.cleanup?.[roomKey] === 'pending') retire.push(record); continue }
      if (record.phase === 'retired' || record.phase === 'abandoned') continue
      const status = this.status(record.id)
      if (status) write.push({ record, status })
    }
    return { write, retire }
  }

  async beginDiscard(id: string, force: boolean, children: string[]): Promise<WorkerRecord> {
    return this.update(id, old => ({ ...old, phase: 'discarding',
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
    const record = this.read(id)
    if (!record?.discard || record.phase !== 'discarding') throw new Error('discard plan missing')
    if (record.discard.patch && record.discard.patch.path !== file) throw new Error('discard patch path changed')
    if (record.discard.patch && record.discard.patch.sha256 !== sha256) throw new Error('discard patch changed after identity was recorded')
    if (!record.discard.patch) await this.update(id, old => ({ ...old,
      discard: { ...old.discard!, patch: { path: file, sha256 } }, seq: old.seq + 1 }))
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
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
  async replayDiscard(id: string): Promise<void> {
    let record = this.read(id)
    if (record?.phase !== 'discarding' || !record.discard) return
    let acquired = false
    if (!this.heldOperations.has(id)) {
      try { await this.beginOperation(id, 'discard'); acquired = true }
      catch { return }
    }
    try {
    record = this.read(id)
    if (record?.phase !== 'discarding' || !record.discard) return
    // A writer killed between creating and linking a patch leaves its private
    // scratch file behind. It has no committed identity and replay rebuilds it.
    for (const scratch of files(path.join(this.root, 'patches'), '.tmp')) {
      const suffix = path.basename(scratch).slice(id.length + 1)
      if (!path.basename(scratch).startsWith(`${id}.`) || !/^[0-9a-f]{16}\.tmp$/.test(suffix)) continue
      if (fs.lstatSync(scratch).isFile()) fs.rmSync(scratch)
    }
    const leadDir = path.dirname(path.dirname(path.dirname(record.dir)))
    const status = this.status(id)
    if (!status) return
    const own = realStateInput(record, status)
    const workers = this.list().flatMap(value => {
      const current = this.status(value.id)
      return current ? [realStateInput(value, current)] : []
    })
    const borrowed = !!record.sharedWith || !!this.worktreeOwner(record)
    const shared = !borrowed && fs.existsSync(record.dir) ? this.list().filter(value => value.id !== id && !['retiring', 'retired', 'abandoned'].includes(value.phase)
      && path.resolve(value.dir) === path.resolve(record!.dir)) : []
    for (const user of shared) {
      const userStatus = this.status(user.id)
      if (!userStatus || (user.phase !== 'discarding' && !['done', 'failed', 'stopped'].includes(userStatus.status))) return
      if (user.phase !== 'discarding') await this.beginDiscard(user.id, true, [])
      await this.replayDiscard(user.id)
      if (!['retiring', 'retired'].includes(this.read(user.id)?.phase ?? '')) return
    }
    const owned = !borrowed && await isOwnedWorkerWorktree(leadDir, own, record.lead.participant, workers)
    if (!borrowed && !owned && fs.existsSync(record.dir)) throw new Error(`discard replay lost ownership of ${record.dir}`)
    if (!record.discard.steps.children) {
      for (const childId of record.discard.children) {
        const child = this.read(childId)
        if (!child || ['retiring', 'retired'].includes(child.phase)) continue
        if (child.phase !== 'discarding') await this.beginDiscard(childId, true, [])
        await this.replayDiscard(childId)
        if (!['retiring', 'retired'].includes(this.read(childId)?.phase ?? '')) return
      }
      await this.markDiscardStep(id, 'children')
      record = this.read(id)!
    }
    // The launch PID names the host. Admission's process chain is MCP first, host
    // second; selecting its first live entry can stop only the MCP and lose edits.
    const run = record.runs.at(-1)!
    const launch = run.launch
    const report = this.reports(id).find(value => value.run === run.n && value.nonce === run.nonce)
    const chain = report?.chain ?? []
    const reportedHost = launch?.outcome === 'launched' ? chain.find(value => value.pid === launch.pid) : undefined
    if (launch?.outcome === 'launched' && launch.process && reportedHost
      && (launch.process.startTime !== reportedHost.startTime || launch.process.executable !== reportedHost.executable)) return
    const host = launch?.outcome === 'launched' ? launch.process ?? reportedHost : undefined
    const identities = [host, ...chain.filter(value => value.pid !== host?.pid)]
      .filter((value): value is NonNullable<typeof value> => !!value)
    if (!record.discard!.steps.stop) await this.beginStop(id, 'discarded')
    // A PID-only launch without a matching admitted host has no verified signal
    // authority. Keep the directory even if another chain member has exited.
    if (launch?.outcome === 'launched' && !host && !this.exits(id).some(value => value.run === run.n)
      && pidAlive(launch.pid)) return
    for (const identity of identities) {
      const alive = this.alive(identity)
      if (alive === 'unknown') return
      if (alive !== 'alive') continue
      if (!record.capabilities.signal || record.discard!.steps.stop) return
      const signalOwn = { ...own, pid: identity.pid, processStartTime: identity.startTime }
      const stopped = await stopWorkerWithEscalation({
        terminate: () => signalWorker(identity.pid, 'SIGTERM', record!.dir, undefined, signalOwn, probeProcess),
        exited: () => this.alive(identity) === 'dead',
        force: () => signalWorker(identity.pid, 'SIGKILL', record!.dir, undefined, signalOwn, probeProcess),
      })
      if (!stopped) return
    }
    if (identities.some(value => this.alive(value) !== 'dead')) return
    if (owned && !await quiesceWorktreeProcesses(record.dir)) return
    if (!record.discard!.steps.stop) {
      await this.markDiscardStep(id, 'stop')
      record = this.read(id)!
    }
    if (!record.discard!.steps.patch) {
      if (owned) {
        const ignored = await ignoredWorkerArtifacts(own)
        if (ignored.length && !record.discard!.force) {
          await this.interruptDiscard(id, `ignored artifacts appeared: ${ignored.join(', ')}`)
          return
        }
        await saveDiscardPatch(leadDir, own, bytes => this.recordDiscardPatch(id, bytes))
      }
      await this.markDiscardStep(id, 'patch')
      record = this.read(id)!
    }
    const published = record.discard!.patch
    if (published) {
      const expected = path.join(this.root, 'patches', `${id}.patch`)
      if (published.path !== expected) throw new Error(`discard patch path changed for ${id}`)
      const valid = fs.existsSync(expected) && fs.lstatSync(expected).isFile()
        && createHash('sha256').update(fs.readFileSync(expected)).digest('hex') === published.sha256
      if (!valid) {
        if (!owned) throw new Error(`discard patch missing after worktree removal: ${expected}`)
        await saveDiscardPatch(leadDir, own, bytes => this.recordDiscardPatch(id, bytes))
      }
    }
    if (!record.discard!.steps.cleanup) {
      if (owned) {
        if (!await cleanupWorker(leadDir, own, true, true, [], {}, record.lead.participant, workers)) return
      } else if (!borrowed) {
        await pruneMissingWorkerWorktree(leadDir, own)
        cleanupWorkerLogs(leadDir, own)
      } else cleanupWorkerLogs(leadDir, own)
      await this.markDiscardStep(id, 'cleanup')
    }
    await this.markDiscardStep(id, 'prune')
    await this.beginRetirement(id, this.archiveOf(this.read(id)!, { summary: borrowed ? 'detached' : 'discarded', disposition: 'discarded' }))
    } finally { if (acquired) await this.finishOperation(id) }
  }

  /** Admission is evidence of launch only when a run writer proves the matching nonce. */
  async writeReport(id: string, report: RunReport): Promise<void> {
    const record = this.read(id)
    const run = record?.runs.at(-1)
    if (!run || run.n !== report.run || run.nonce !== report.nonce || !['prepared', 'active'].includes(record!.phase)) throw new Error('run not admitted')
    const writer = this.writerFile(id, report.run)
    if (!fs.existsSync(writer) && !createExclusive(writer, this.identity)) throw new Error('run writer busy')
    const prior = this.readFact(writer, tokenShape)
    if (prior && prior.nonce !== this.identity.nonce && !await leaseRetry(() => replace(writer,
      current => current.sessionId === this.identity.sessionId && this.alive(current as InstanceToken) === 'dead', this.identity))) {
      throw new Error('run writer busy')
    }
    await guarded(writer, () => {
      const owner = this.readFact(writer, tokenShape)
      if (owner?.nonce !== this.identity.nonce) throw new Error('run writer belongs to another instance')
      const previous = this.readFact(this.reportFile(id, report.run), reportShape)
      if (previous && previous.nonce !== report.nonce) throw new Error('run report nonce mismatch')
      writeAtomic(this.reportFile(id, report.run), previous ? { ...previous,
        chain: previous.chain, joinedAt: previous.joinedAt,
        hostProcess: previous.hostProcess !== undefined ? previous.hostProcess : report.hostProcess,
        hostSessionId: previous.hostSessionId ?? report.hostSessionId,
        done: previous.done ?? report.done, posted: previous.posted ?? report.posted } : report)
    })
    this.changed(id)
  }

  /** A witnessed child-close observation is never replaced by a later unwitnessed poll. */
  async writeExit(id: string, observation: ExitObservation): Promise<void> {
    const file = this.exitFile(id, observation.run)
    await guarded(file, () => {
      const old = this.readFact(file, exitShape)
      if (!old || (!old.witnessed && observation.witnessed)) writeAtomic(file, observation)
    })
    this.changed(id)
  }

  private rollbackPreparation(record: WorkerRecord): void {
    const prep = record.prep
    // A supplied directory has no resources for this preparation to undo.
    if (prep.created !== true && prep.branchCreated !== true
      && !Object.keys(prep.previousCarryRefs ?? {}).length) return
    const leadDir = path.dirname(path.dirname(path.dirname(record.dir)))
    if (!roomWorkerPathMatchesBranch(leadDir, record.dir, record.branch, false)) throw new Error(`unsafe preparation path for ${record.id}`)
    const run = (...args: string[]): string => execFileSync('git', ['--git-dir', this.commonDir, ...args], { encoding: 'utf8' }).trim()
    if (prep.created === true && fs.existsSync(record.dir)) {
      const listing = run('worktree', 'list', '--porcelain')
      const canonical = fs.realpathSync(record.dir)
      const registered = listing.split('\n').filter(line => line.startsWith('worktree ')).some(line => {
        try { return fs.realpathSync(line.slice(9)) === canonical } catch { return false }
      })
      if (!registered) throw new Error(`unregistered preparation worktree ${record.dir}`)
      run('worktree', 'remove', '--force', record.dir)
    }
    if (prep.branchCreated === true && prep.branchExisted === false) {
      const ref = `refs/heads/${record.branch}`
      let exists = false
      try { run('show-ref', '--verify', '--quiet', ref); exists = true }
      catch (e) { if ((e as { status?: number }).status !== 1) throw e }
      if (exists) run('branch', '-D', record.branch)
    }
    const refs = prep.previousCarryRefs
    if (refs && typeof refs === 'object' && !Array.isArray(refs)) {
      for (const [ref, oid] of Object.entries(refs)) {
        if (!/^refs\/room\/(carry|carry-untracked)\/[A-Za-z0-9._/-]+$/.test(ref)) throw new Error(`unsafe preparation ref ${ref}`)
        if (typeof oid === 'string' && /^[0-9a-f]{40,64}$/.test(oid)) run('update-ref', ref, oid)
        else if (oid === null) {
          try { run('update-ref', '-d', ref) } catch (e) { if ((e as { status?: number }).status !== 1) throw e }
        }
      }
    }
  }

  async abandonPreparation(id: string): Promise<void> {
    const record = this.read(id)
    if (!record || record.runs.at(-1)?.launch) return
    if (record.phase === 'preparing' || record.phase === 'prepared') this.rollbackPreparation(record)
    await this.update(id, old => ({ ...old, phase: 'abandoned', seq: old.seq + 1 }))
  }

  async reconcile(): Promise<void> {
    for (const record of this.list()) {
      const run = record.runs.at(-1)
      if (!run) continue
      // The operation lease itself is deliberately not treated as launch evidence.
      const hadOp = fs.existsSync(this.opFile(record.id))
      const op = this.readFact(this.opFile(record.id), (value): value is { holder: InstanceToken } => object(value) && tokenShape(value.holder))
      if (hadOp && !op) continue
      if (op && this.alive(op.holder) === 'dead') await leaseRetry(() => recover(this.opFile(record.id), () => true))
      const report = this.reports(record.id).find(value => value.run === run.n && value.nonce === run.nonce)
      if (report?.hostSessionId && !record.hostSessionId && !fs.existsSync(this.opFile(record.id))) {
        await this.update(record.id, old => ({ ...old, hostSessionId: old.hostSessionId ?? report.hostSessionId, seq: old.seq + 1 }))
      }
      if (record.phase === 'collecting' && (!op || this.alive(op.holder) === 'dead')) {
        await this.update(record.id, old => ({ ...old, phase: 'active',
          interrupted: old.interrupted ?? { op: 'collect', at: this.now(), detail: 'collection stopped; partial apply may remain' },
          seq: old.seq + 1 }))
        continue
      }
      if (record.phase === 'discarding' && (!op || this.alive(op.holder) === 'dead')) {
        try { await this.beginOperation(record.id, 'discard'); await this.replayDiscard(record.id) }
        catch (error) { process.stderr.write(`[room] discard replay ${record.id}: ${error}\n`) }
        finally { await this.finishOperation(record.id).catch(() => {}) }
        continue
      }
      if (record.phase === 'preparing' && this.alive(run.launcher) === 'dead') {
        this.rollbackPreparation(record)
        await this.update(record.id, old => ({ ...old, phase: 'abandoned', seq: old.seq + 1 }))
        continue
      }
      if (!run.launch) {
        const report = this.reports(record.id).find(r => r.run === run.n && r.nonce === run.nonce)
        const writer = this.readFact(this.writerFile(record.id, run.n), tokenShape)
        if (writer && report) await this.update(record.id, old => {
          const latest = old.runs.at(-1)!
          if (latest.launch) return { ...old, seq: old.seq + 1 }
          const process = admittedHost(report)
          return { ...old, phase: 'active', runs: [...old.runs.slice(0, -1), { ...latest,
            launch: process ? { outcome: 'launched', pid: process.pid, process } : { outcome: 'ambiguous', at: this.now() } }], seq: old.seq + 1 }
        })
        else if (this.alive(run.launcher) === 'dead') await this.update(record.id, old => ({ ...old,
          runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, launch: { outcome: 'ambiguous', at: this.now() } }], seq: old.seq + 1 }))
        continue
      }
      if (run.launch.outcome === 'ambiguous') {
        const report = this.reports(record.id).find(r => r.run === run.n && r.nonce === run.nonce)
        const writer = this.readFact(this.writerFile(record.id, run.n), tokenShape)
        if (writer && report) await this.update(record.id, old => {
          const process = admittedHost(report)
          if (!process) return old
          return { ...old, phase: 'active', runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, launch: { outcome: 'launched', pid: process.pid, process } }], seq: old.seq + 1 }
        })
      }
      if (run.launch.outcome === 'launched' && !this.exits(record.id).some(e => e.run === run.n)
        && this.alive(run.launcher) === 'dead' && run.launch.process && this.alive(run.launch.process) === 'dead') {
        await this.writeExit(record.id, { run: run.n, code: null, at: this.now(), witnessed: false })
      }
    }
    for (const file of files(path.join(this.root, 'patches'), '.patch')) {
      const workerId = path.basename(file, '.patch')
      const owner = this.read(workerId)
      if (owner && owner.phase !== 'retired') continue
      if (this.now() - fs.statSync(file).mtimeMs >= 7 * 24 * 60 * 60 * 1000) fs.rmSync(file, { force: true })
    }
    const next = new Map<string, string>()
    for (const record of this.list()) next.set(record.id, JSON.stringify([record, this.reports(record.id), this.exits(record.id)]))
    const externalChange = next.size !== this.observed.size || [...next].some(([key, value]) => this.observed.get(key) !== value)
    this.observed = next
    if (externalChange) this.changed()
  }

  private async migrate(): Promise<void> {
    const file = path.join(this.root, 'migration.json')
    if (readJson<MigrationMap>(file)?.done) return
    const lock = path.join(this.root, 'migration.lock')
    let acquired = false
    const deadline = performance.now() + GUARD_WAIT_MS
    while (performance.now() < deadline) {
      if (createExclusive(lock, this.identity)) { acquired = true; break }
      if (readJson<MigrationMap>(file)?.done) return
      if (await leaseRetry(() => recover(lock, () => true), deadline)) continue
      // Migration is a startup barrier. A second MCP process waits for the
      // first to finish; an unreadable/live holder is never stolen on an elapsed-time guess.
      await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, Math.min(GUARD_POLL_MS, deadline - performance.now()))))
    }
    if (!acquired) throw new Error('registry migration in progress')
    try {
      const map = readJson<MigrationMap>(file) ?? { v: 1 as const, sources: {}, done: false }
      if (map.done) return
      let sources: LegacySource[]
      try { sources = (this.options.sources ?? discoverLegacyWorktrees)(this.commonDir) }
      catch (error) {
        // Do not mark migration done: a repaired snapshot must still supply its retirements.
        if (error instanceof LegacySnapshotUnavailable) return
        throw error
      }
      for (const source of sources) {
        if (!map.sources[source.key]) {
          map.sources[source.key] = { id: id(), state: 'assigned' }
          writeAtomic(file, map)
        }
        const target = map.sources[source.key]
        if (target.state === 'imported') continue
        this.importLegacy(source, target.id)
        target.state = 'imported'
        writeAtomic(file, map)
      }
      map.done = true
      writeAtomic(file, map)
    } finally {
      // compare-and-release normalizes bare token files as well as holder envelopes.
      await leaseRetry(() => compareAndRelease(lock, this.identity))
    }
  }

  private importLegacy(source: LegacySource, workerId: string): void {
    const file = this.workerFile(workerId)
    const carryFile = path.join(this.commonDir, 'room-carry', `${source.tag}.json`)
    const migratedCarryFile = `${carryFile}.migrated`
    if (!missing(file)) {
      if (fs.existsSync(carryFile) && !fs.existsSync(migratedCarryFile)) fs.renameSync(carryFile, migratedCarryFile)
      return
    }
    const token = this.identity
    const carryRecord = readJson<{ base?: unknown; carriedBase?: unknown }>(carryFile)
    const base = commitExists(this.commonDir, carryRecord?.base) ? carryRecord.base : undefined
    const carriedBase = commitExists(this.commonDir, carryRecord?.carriedBase) ? carryRecord.carriedBase : undefined
    const carry = base && (!carryRecord?.carriedBase || carriedBase) ? 'delta' : 'copy'
    const hostSessionId = legacySession(source.dir, source.oldId, source.host)
    const record: WorkerRecord = {
      v: 1, id: workerId, tag: source.tag, name: '', mode: 'local', room: '',
      lead: { participant: '', room: '', instance: token }, host: source.host, model: source.model,
      budget: { threads: 1, memGb: 1, nice: 10 }, share: source.share ?? 'intent', task: source.task ?? 'legacy worker',
      dir: source.dir, outside: false, branch: source.branch, prep: { step: 'prepared' }, base,
      carriedBase, hostSessionId,
      capabilities: { resume: !!hostSessionId, signal: false, collect: carry },
      phase: source.keptWorktree ? 'retired' : 'active', keptWorktree: source.keptWorktree,
      cleanup: source.keptWorktree ? { legacy: 'done' } : undefined,
      runs: [{ n: 1, mode: 'fresh', intentAt: this.now(), nonce: `imported:${workerId}`, busFrontier: 0, promptMsgIds: [], launcher: token, launch: { outcome: 'imported' }, logStart: 0 }],
      legacy: { id: source.key, source: source.dir, said: source.said, unowned: true }, createdAt: this.now(), seq: 1,
    }
    createExclusive(this.tagFile(source.tag), { id: workerId, holder: token, at: this.now() })
    createExclusive(file, record)
    if (fs.existsSync(carryFile) && !fs.existsSync(migratedCarryFile)) fs.renameSync(carryFile, migratedCarryFile)
  }
}
