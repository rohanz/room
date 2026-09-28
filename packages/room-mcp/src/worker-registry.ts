/** The local source of truth for worker operations. No replicated document grants local authority. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import * as Y from 'yjs'
import { participantRecord, RoomDoc } from '@room/shared'
import { compareAndRelease, createExclusive, liveness, recover, replace, withGuard, writeAtomic, type InstanceToken } from './leases.js'
import { idleClaimsDue, statusOf, type ExitObservation, type LivenessProbe, type RunReport, type WorkerRecord, type WorkerStatusResult } from './worker-status.js'
import { isOwnedWorkerWorktree, roomWorkerPathMatchesBranch } from './worker-state.js'
import { realStateInput } from './worker-status.js'

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
  roomKey: string; sessionId: string; participant: string; idleEpoch: string
  host: 'shared-app-server' | 'interactive'; lastActivityMs: number; monotonicMs: () => number
  doc: RoomDoc; postNotice: (id: string, text: string) => void
  /** Legacy fallback until a holder record has been published; must check the local name lease. */
  ownsParticipant?: () => boolean
}
interface IdleReleaseRecord { state: 'pending' | 'done'; claimIds: string[]; claimNames: string[]; hadScope: boolean }
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
const missing = (file: string): boolean => !fs.existsSync(file)
const safeId = (value: string): boolean => /^w_[A-Za-z0-9_-]{1,64}$/.test(value)
const safeTag = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) && value !== '..'
const GUARD_WAIT_MS = 30_000
const GUARD_POLL_MS = 25
const guardBusy = (error: unknown): boolean => error instanceof Error && error.message.startsWith('lease guard busy: ')
const pauseForGuard = (deadline: number, error: unknown): void => {
  if (!guardBusy(error)) throw error
  const remaining = deadline - performance.now()
  if (remaining <= 0) throw new Error(`registry guard wait exceeded ${GUARD_WAIT_MS} ms: ${(error as Error).message}`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(GUARD_POLL_MS, remaining))
}
/** Retry acquisition only; a callback that entered its guard is never replayed. */
function guarded<T>(file: string, fn: () => T, deadline = performance.now() + GUARD_WAIT_MS): T {
  for (;;) {
    let entered = false
    try { return withGuard<T>(file, (() => { entered = true; return fn() }) as () => T extends PromiseLike<unknown> ? never : T) }
    catch (error) { if (entered) throw error; pauseForGuard(deadline, error) }
  }
}
/** The lease primitives each acquire their own guard before touching their file. */
function leaseRetry<T>(fn: () => T, deadline = performance.now() + GUARD_WAIT_MS): T {
  for (;;) {
    try { return fn() }
    catch (error) { pauseForGuard(deadline, error) }
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
    || typeof value.nonce !== 'string' || !Array.isArray(value.busFrontier) || !Array.isArray(value.promptMsgIds)
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
  && typeof value.joinedAt === 'number' && (value.hostSessionId === undefined || typeof value.hostSessionId === 'string')
  && (value.posted === undefined || typeof value.posted === 'string')
  && (value.done === undefined || (object(value.done) && typeof value.done.at === 'number'
    && typeof value.done.summary === 'string' && Array.isArray(value.done.changed)))
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

/** The old CRDT is display evidence only: it never supplies pid, session, base or capability. */
function legacyDisplay(commonDir: string): Map<string, Pick<LegacySource, 'oldId' | 'host' | 'model' | 'task' | 'said' | 'keptWorktree'>> {
  const found = new Map<string, Pick<LegacySource, 'oldId' | 'host' | 'model' | 'task' | 'said' | 'keptWorktree'>>()
  const canonical = (dir: string): string => { try { return fs.realpathSync(dir) } catch { return path.resolve(dir) } }
  for (const file of files(path.join(commonDir, 'room-local'), '.ydoc')) {
    const doc = new Y.Doc()
    try {
      if (fs.statSync(file).size > 5 * 1024 * 1024) continue
      Y.applyUpdate(doc, fs.readFileSync(file))
      const room = new RoomDoc(doc)
      for (const worker of room.workers.values()) {
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
    } catch { /* A corrupt legacy snapshot supplies no authority or display. */ }
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
  private readonly listeners = new Set<() => void>()
  private observed = new Map<string, string>()
  private readonly watchers: fs.FSWatcher[] = []
  private timer?: ReturnType<typeof setInterval>
  private watchQueued = false
  private constructor(readonly commonDir: string, private readonly options: RegistryOptions) {
    this.root = path.join(commonDir, 'room', 'registry')
    this.alive = options.liveness ?? liveness
    this.now = options.now ?? Date.now
    this.identity = options.identity ?? synthetic()
  }

  static open(commonDir: string, options: RegistryOptions = {}): WorkerRegistry {
    const registry = new WorkerRegistry(commonDir, options)
    if (options.migrate !== false) registry.migrate()
    registry.reconcile()
    if (options.watch !== false) registry.watch()
    return registry
  }
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
            try { this.reconcile() } catch (e) { process.stderr.write(`[room] registry reconcile: ${e}\n`) }
          })
        })
        watcher.on('error', e => { watcher.close(); process.stderr.write(`[room] registry watch: ${e}; polling remains active\n`) })
        watcher.unref()
        this.watchers.push(watcher)
      } catch (e) { process.stderr.write(`[room] registry watch: ${e}; polling remains active\n`) }
    }
    this.timer = setInterval(() => {
      try { this.reconcile() } catch (e) { process.stderr.write(`[room] registry reconcile: ${e}\n`) }
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
  private changed(): void { for (const listener of this.listeners) listener() }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  /** Callable by the wave-4 presence loop; its durable journal makes crash replay idempotent. */
  reconcileIdleClaims(action: IdleClaimsAction): boolean {
    const { doc, participant } = action
    const holder = participantRecord(doc, participant)?.holder
    if (holder ? holder.sessionId !== action.sessionId : !action.ownsParticipant?.()) return false
    const claims = [...doc.claims.values()].filter(c => c.by === participant && c.byKind !== 'human')
    const hasScope = doc.scopes.has(participant)
    const key = createHash('sha256').update(`${action.roomKey}\0${action.sessionId}\0${action.idleEpoch}`).digest('hex')
    const file = path.join(this.commonDir, 'room', 'sessions', action.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'), 'idle-claims', `${key}.json`)
    if (!fs.existsSync(file) && !idleClaimsDue({ host: action.host, lastActivityMs: action.lastActivityMs,
      nowMs: action.monotonicMs(), heldClaims: claims.length, hasScope })) return false
    return guarded(file, () => {
      let journal = readJson<IdleReleaseRecord>(file)
      if (journal?.state === 'done') return false
      if (!journal) {
        journal = { state: 'pending', claimIds: claims.map(c => c.id),
          claimNames: claims.map(c => c.path.endsWith('/') ? c.path : `${c.path}:${c.from}-${c.to}`), hadScope: hasScope }
        writeAtomic(file, journal)
      }
      const pending = journal
      doc.doc.transact(() => {
        for (const claimId of pending.claimIds) {
          const current = doc.claims.get(claimId)
          if (current?.by === participant && current.byKind !== 'human') doc.removeClaim(claimId)
        }
        if (pending.hadScope) doc.clearScope(participant)
      })
      const noticeId = `idle-claims:${action.sessionId}:${action.idleEpoch}`
      const names = pending.claimNames.length ? `released claims ${pending.claimNames.join(', ')}` : 'released no claims'
      action.postNotice(noticeId, `${participant} ${names}${pending.hadScope ? ' and cleared its scope' : ''} after 8 h idle`)
      writeAtomic(file, { ...pending, state: 'done' })
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
  status(id: string): WorkerStatusResult | undefined {
    const record = this.read(id)
    if (!record) return undefined
    return statusOf(record, record.runs, this.reports(id), this.exits(id), this.alive, this.now())
  }
  /** No room view or remote presence can turn into a local worktree capability. */
  async trusted(lead: { participant: string; room: string; dir: string }, tagOrName: string): Promise<{ record: WorkerRecord; status: WorkerStatusResult } | undefined> {
    let candidate = this.list().find(r => r.tag === tagOrName || r.name === tagOrName)
    if (candidate?.legacy?.unowned) candidate = await this.adoptLegacy(candidate, lead)
    if (!candidate || candidate.lead.participant !== lead.participant || candidate.lead.room !== lead.room
      || ['retiring', 'retired', 'abandoned'].includes(candidate.phase)) return undefined
    const reservation = readJson<{ id?: string }>(this.tagFile(candidate.tag))
    if (reservation?.id !== candidate.id) return undefined
    const status = this.status(candidate.id)
    if (!status) return undefined
    const workers = this.list().flatMap(record => {
      const state = this.status(record.id)
      return state ? [realStateInput(record, state)] : []
    })
    let leadDir: string
    try { leadDir = fs.realpathSync(lead.dir) } catch { return undefined }
    if (!await isOwnedWorkerWorktree(leadDir, realStateInput(candidate, status), lead.participant, workers)) return undefined
    return { record: candidate, status }
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
      this.changed()
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
  writeIntent(record: WorkerRecord, capacity = Number.POSITIVE_INFINITY): void {
    if (!safeId(record.id) || !recordShape(record, record.id) || record.runs[0].launch) throw new Error('invalid worker intent')
    guarded(path.join(this.root, 'capacity'), () => {
      if (this.occupancy() >= capacity) throw new Error('worker capacity reached')
      const tagFile = this.tagFile(record.tag)
      if (!createExclusive(tagFile, { id: record.id, holder: record.lead.instance, at: this.now() })) {
        const reservation = readJson<{ id?: string; holder?: InstanceToken }>(tagFile)
        if (reservation?.id && safeId(reservation.id) && tokenShape(reservation.holder)) {
          const bound = this.read(reservation.id)
          const reusable = bound && (bound.phase === 'abandoned' || (bound.phase === 'retired' && !bound.keptWorktree
            && !!bound.cleanup && Object.values(bound.cleanup).every(state => state === 'done')))
          if (reusable) leaseRetry(() => compareAndRelease(tagFile, reservation.holder!))
          else if (!bound && !this.hasQuarantinedRecord(reservation.id)) leaseRetry(() => recover(tagFile, current => current.id === reservation.id))
        }
        if (!createExclusive(tagFile, { id: record.id, holder: record.lead.instance, at: this.now() })) throw new Error(`tag in use: ${record.tag}`)
      }
      if (!createExclusive(this.opFile(record.id), { op: 'spawn', holder: record.runs[0].launcher, at: this.now() })) throw new Error('worker operation lease busy')
      if (!createExclusive(this.workerFile(record.id), record)) throw new Error(`worker already exists: ${record.id}`)
    })
    this.changed()
  }

  /** One operation writer per worker; the next rollout step uses this for preparation and launch facts. */
  update(id: string, edit: (record: WorkerRecord) => WorkerRecord): WorkerRecord {
    const priorOp = readJson<{ holder: InstanceToken }>(this.opFile(id))
    if (priorOp && priorOp.holder.nonce !== this.identity.nonce && this.alive(priorOp.holder) === 'dead') leaseRetry(() => recover(this.opFile(id), () => true))
    const value = guarded(this.opFile(id), () => {
      const op = readJson<{ holder: InstanceToken }>(this.opFile(id))
      if (op && op.holder.nonce !== this.identity.nonce) throw new Error(`worker operation lease held by another instance: ${id}`)
      const old = this.read(id)
      if (!old) throw new Error(`unknown worker ${id}`)
      const next = edit(old)
      if (next.id !== old.id || next.seq !== old.seq + 1 || !recordShape(next, id)) throw new Error('worker update must retain id, advance seq and remain valid')
      writeAtomic(this.workerFile(id), next)
      return next
    })
    this.changed()
    return value
  }
  finishOperation(id: string): boolean { return leaseRetry(() => compareAndRelease(this.opFile(id), this.identity)) }

  /** Admission is evidence of launch only when a run writer proves the matching nonce. */
  writeReport(id: string, report: RunReport): void {
    const record = this.read(id)
    const run = record?.runs.at(-1)
    if (!run || run.n !== report.run || run.nonce !== report.nonce || !['prepared', 'active'].includes(record!.phase)) throw new Error('run not admitted')
    const writer = this.writerFile(id, report.run)
    if (!fs.existsSync(writer) && !createExclusive(writer, this.identity)) throw new Error('run writer busy')
    const prior = this.readFact(writer, tokenShape)
    if (prior && prior.nonce !== this.identity.nonce && !leaseRetry(() => replace(writer,
      current => current.sessionId === this.identity.sessionId && this.alive(current as InstanceToken) === 'dead', this.identity))) {
      throw new Error('run writer busy')
    }
    guarded(writer, () => {
      const owner = this.readFact(writer, tokenShape)
      if (owner?.nonce !== this.identity.nonce) throw new Error('run writer belongs to another instance')
      const previous = this.readFact(this.reportFile(id, report.run), reportShape)
      if (previous && previous.nonce !== report.nonce) throw new Error('run report nonce mismatch')
      writeAtomic(this.reportFile(id, report.run), previous ? { ...previous,
        chain: previous.chain, joinedAt: previous.joinedAt,
        hostSessionId: previous.hostSessionId ?? report.hostSessionId,
        done: previous.done ?? report.done, posted: previous.posted ?? report.posted } : report)
    })
    this.changed()
  }

  /** A witnessed child-close observation is never replaced by a later unwitnessed poll. */
  writeExit(id: string, observation: ExitObservation): void {
    const file = this.exitFile(id, observation.run)
    guarded(file, () => {
      const old = this.readFact(file, exitShape)
      if (!old || (!old.witnessed && observation.witnessed)) writeAtomic(file, observation)
    })
    this.changed()
  }

  private rollbackPreparation(record: WorkerRecord): void {
    const prep = record.prep
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
    const carry = path.join(this.commonDir, 'room-carry', `${record.tag}.json`)
    if (readJson<{ ownerId?: string }>(carry)?.ownerId === record.id) fs.rmSync(carry, { force: true })
  }

  reconcile(): void {
    for (const record of this.list()) {
      const run = record.runs.at(-1)
      if (!run) continue
      // The operation lease itself is deliberately not treated as launch evidence.
      const hadOp = fs.existsSync(this.opFile(record.id))
      const op = this.readFact(this.opFile(record.id), (value): value is { holder: InstanceToken } => object(value) && tokenShape(value.holder))
      if (hadOp && !op) continue
      if (op && this.alive(op.holder) === 'dead') leaseRetry(() => recover(this.opFile(record.id), () => true))
      if (record.phase === 'collecting' && (!op || this.alive(op.holder) === 'dead')) {
        this.update(record.id, old => ({ ...old, phase: 'active',
          interrupted: old.interrupted ?? { op: 'collect', at: this.now(), detail: 'collection stopped; partial apply may remain' },
          seq: old.seq + 1 }))
        continue
      }
      if (record.phase === 'preparing' && this.alive(run.launcher) === 'dead') {
        this.rollbackPreparation(record)
        this.update(record.id, old => ({ ...old, phase: 'abandoned', seq: old.seq + 1 }))
        continue
      }
      if (!run.launch) {
        const report = this.reports(record.id).find(r => r.run === run.n && r.nonce === run.nonce)
        const writer = this.readFact(this.writerFile(record.id, run.n), tokenShape)
        if (writer && report) this.update(record.id, old => {
          const latest = old.runs.at(-1)!
          if (latest.launch) return { ...old, seq: old.seq + 1 }
          const process = report.chain[0]
          return { ...old, phase: 'active', runs: [...old.runs.slice(0, -1), { ...latest, launch: { outcome: 'launched', pid: process?.pid ?? 0, ...(process ? { process } : {}) } }], seq: old.seq + 1 }
        })
        else if (this.alive(run.launcher) === 'dead') this.update(record.id, old => ({ ...old,
          runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, launch: { outcome: 'ambiguous', at: this.now() } }], seq: old.seq + 1 }))
        continue
      }
      if (run.launch.outcome === 'ambiguous') {
        const report = this.reports(record.id).find(r => r.run === run.n && r.nonce === run.nonce)
        const writer = this.readFact(this.writerFile(record.id, run.n), tokenShape)
        if (writer && report) this.update(record.id, old => {
          const process = report.chain[0]
          return { ...old, phase: 'active', runs: [...old.runs.slice(0, -1), { ...old.runs.at(-1)!, launch: { outcome: 'launched', pid: process?.pid ?? 0, ...(process ? { process } : {}) } }], seq: old.seq + 1 }
        })
      }
      if (run.launch.outcome === 'launched' && !this.exits(record.id).some(e => e.run === run.n)
        && this.alive(run.launcher) === 'dead' && run.launch.process && this.alive(run.launch.process) === 'dead') {
        this.writeExit(record.id, { run: run.n, code: null, at: this.now(), witnessed: false })
      }
    }
    const next = new Map<string, string>()
    for (const record of this.list()) next.set(record.id, JSON.stringify([record, this.reports(record.id), this.exits(record.id)]))
    const externalChange = next.size !== this.observed.size || [...next].some(([key, value]) => this.observed.get(key) !== value)
    this.observed = next
    if (externalChange) this.changed()
  }

  private migrate(): void {
    const file = path.join(this.root, 'migration.json')
    if (readJson<MigrationMap>(file)?.done) return
    const lock = path.join(this.root, 'migration.lock')
    let acquired = false
    const deadline = performance.now() + GUARD_WAIT_MS
    while (performance.now() < deadline) {
      if (createExclusive(lock, this.identity)) { acquired = true; break }
      if (readJson<MigrationMap>(file)?.done) return
      if (leaseRetry(() => recover(lock, () => true), deadline)) continue
      // Migration is a synchronous startup barrier. A second MCP process waits for the
      // first to finish; an unreadable/live holder is never stolen on an elapsed-time guess.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Math.min(GUARD_POLL_MS, deadline - performance.now())))
    }
    if (!acquired) throw new Error('registry migration in progress')
    try {
      const map = readJson<MigrationMap>(file) ?? { v: 1 as const, sources: {}, done: false }
      if (map.done) return
      const sources = (this.options.sources ?? discoverLegacyWorktrees)(this.commonDir)
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
      leaseRetry(() => compareAndRelease(lock, this.identity))
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
      runs: [{ n: 1, mode: 'fresh', intentAt: this.now(), nonce: `imported:${workerId}`, busFrontier: [], promptMsgIds: [], launcher: token, launch: { outcome: 'imported' }, logStart: 0 }],
      legacy: { id: source.key, source: source.dir, said: source.said, unowned: true }, createdAt: this.now(), seq: 1,
    }
    createExclusive(this.tagFile(source.tag), { id: workerId, holder: token, at: this.now() })
    createExclusive(file, record)
    if (fs.existsSync(carryFile) && !fs.existsSync(migratedCarryFile)) fs.renameSync(carryFile, migratedCarryFile)
  }
}
