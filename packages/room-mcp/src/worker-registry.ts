/** The local source of truth for worker operations. No replicated document grants local authority. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { participantRecord, RoomDoc } from '@room/shared'
import { compareAndRelease, createExclusive, liveness, recover, replace, withGuard, writeAtomic, type InstanceToken } from './leases.js'
import { idleClaimsDue, statusOf, type ExitObservation, type LivenessProbe, type RunReport, type WorkerRecord, type WorkerStatusResult } from './worker-status.js'
import { isOwnedWorkerWorktree, roomWorkerPathMatchesBranch } from './worker-state.js'
import { realStateInput } from './worker-status.js'

export interface LegacySource {
  key: string; tag: string; name: string; lead: string; room: string; dir: string; branch: string; host: 'claude' | 'codex'
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
  const mainWorktree = /^worktree (.+)$/m.exec(output)?.[1]
  const localRoom = `local/${path.basename(mainWorktree ?? path.dirname(commonDir))}`
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
    if (!mainWorktree || !roomWorkerPathMatchesBranch(mainWorktree, canonical, branch, true)) continue
    const leadDir = path.dirname(path.dirname(path.dirname(canonical)))
    const lead = path.basename(leadDir)
    const prior = display.get(canonical)
    out.push({ key: `worktree:${canonical}`, tag, name: `${lead}+${tag}`, lead, room: localRoom, dir: canonical, branch,
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
    return withGuard(file, () => {
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
      action.postNotice(noticeId, `${participant} ${names} and cleared its scope after 8 h idle`)
      writeAtomic(file, { ...pending, state: 'done' })
      return true
    })
  }
  read(id: string): WorkerRecord | undefined {
    const file = this.workerFile(id)
    try {
      const record = readJson<WorkerRecord>(file)
      if (record && (record.v !== 1 || record.id !== id || !Array.isArray(record.runs))) {
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
    const candidate = this.list().find(r => r.tag === tagOrName || r.name === tagOrName)
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
  occupancy(): number { return this.list().filter(r => ['starting', 'running', 'unknown', 'ambiguous'].includes(this.status(r.id)?.status ?? '')).length }
  reports(id: string): RunReport[] { if (!safeId(id)) throw new Error('invalid worker id'); return files(path.join(this.root, 'runs', id), '.report.json').flatMap(f => {
    try { const r = readJson<RunReport>(f); return r ? [r] : [] } catch { return [] }
  }) }
  exits(id: string): ExitObservation[] { if (!safeId(id)) throw new Error('invalid worker id'); return files(path.join(this.root, 'runs', id), '.exit.json').flatMap(f => {
    try { const r = readJson<ExitObservation>(f); return r ? [r] : [] } catch { return [] }
  }) }

  /** Direct write-ahead seam for the wave-2 spawner; never spawns by itself. */
  writeIntent(record: WorkerRecord, capacity = Number.POSITIVE_INFINITY): void {
    if (record.v !== 1 || !safeId(record.id) || !safeTag(record.tag) || !record.runs.length || record.runs[0].launch) throw new Error('invalid worker intent')
    withGuard(path.join(this.root, 'capacity'), () => {
      if (this.occupancy() >= capacity) throw new Error('worker capacity reached')
      const tagFile = this.tagFile(record.tag)
      if (!createExclusive(tagFile, { id: record.id, holder: record.lead.instance, at: this.now() })) {
        recover(tagFile, current => typeof current.id === 'string' && !this.read(current.id) && !this.hasQuarantinedRecord(current.id))
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
    if (priorOp && priorOp.holder.nonce !== this.identity.nonce && this.alive(priorOp.holder) === 'dead') recover(this.opFile(id), () => true)
    const value = withGuard(this.opFile(id), () => {
      const op = readJson<{ holder: InstanceToken }>(this.opFile(id))
      if (op && op.holder.nonce !== this.identity.nonce) throw new Error(`worker operation lease held by another instance: ${id}`)
      const old = this.read(id)
      if (!old) throw new Error(`unknown worker ${id}`)
      const next = edit(old)
      if (next.id !== old.id || next.seq !== old.seq + 1) throw new Error('worker update must retain id and advance seq')
      writeAtomic(this.workerFile(id), next)
      return next
    })
    this.changed()
    return value
  }
  finishOperation(id: string): boolean { return compareAndRelease(this.opFile(id), this.identity) }

  /** Admission is evidence of launch only when a run writer proves the matching nonce. */
  writeReport(id: string, report: RunReport): void {
    const record = this.read(id)
    const run = record?.runs.at(-1)
    if (!run || run.n !== report.run || run.nonce !== report.nonce || !['prepared', 'active'].includes(record!.phase)) throw new Error('run not admitted')
    const writer = this.writerFile(id, report.run)
    if (!fs.existsSync(writer) && !createExclusive(writer, this.identity)) throw new Error('run writer busy')
    const prior = readJson<InstanceToken>(writer)
    if (prior && prior.nonce !== this.identity.nonce && !replace(writer,
      current => current.sessionId === this.identity.sessionId && this.alive(current as InstanceToken) === 'dead', this.identity)) {
      throw new Error('run writer busy')
    }
    withGuard(writer, () => {
      const owner = readJson<InstanceToken>(writer)
      if (owner?.nonce !== this.identity.nonce) throw new Error('run writer belongs to another instance')
      const previous = readJson<RunReport>(this.reportFile(id, report.run))
      if (previous && (previous.nonce !== report.nonce || previous.done)) return
      writeAtomic(this.reportFile(id, report.run), previous ? { ...previous, ...report, joinedAt: previous.joinedAt, done: report.done ?? previous.done } : report)
    })
    this.changed()
  }

  /** A witnessed child-close observation is never replaced by a later unwitnessed poll. */
  writeExit(id: string, observation: ExitObservation): void {
    const file = this.exitFile(id, observation.run)
    withGuard(file, () => {
      const old = readJson<ExitObservation>(file)
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
      const op = readJson<{ holder: InstanceToken }>(this.opFile(record.id))
      if (op && this.alive(op.holder) === 'dead') recover(this.opFile(record.id), () => true)
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
        const writer = readJson<InstanceToken>(this.writerFile(record.id, run.n))
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
        const writer = readJson<InstanceToken>(this.writerFile(record.id, run.n))
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
  }

  private migrate(): void {
    const file = path.join(this.root, 'migration.json')
    if (readJson<MigrationMap>(file)?.done) return
    const lock = path.join(this.root, 'migration.lock')
    let acquired = false
    for (let attempt = 0; attempt < 1_200; attempt++) {
      if (createExclusive(lock, this.identity)) { acquired = true; break }
      if (readJson<MigrationMap>(file)?.done) return
      if (recover(lock, () => true)) continue
      // Migration is a synchronous startup barrier. A second MCP process waits for the
      // first to finish; an unreadable/live holder is never stolen on an elapsed-time guess.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
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
      compareAndRelease(lock, this.identity)
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
      v: 1, id: workerId, tag: source.tag, name: source.name, mode: 'local', room: source.room,
      lead: { participant: source.lead, room: source.room, instance: token }, host: source.host, model: source.model,
      budget: { threads: 1, memGb: 1, nice: 10 }, share: source.share ?? 'intent', task: source.task ?? 'legacy worker',
      dir: source.dir, outside: false, branch: source.branch, prep: { step: 'prepared' }, base,
      carriedBase, hostSessionId,
      capabilities: { resume: !!hostSessionId, signal: false, collect: carry },
      phase: source.keptWorktree ? 'retired' : 'active', keptWorktree: source.keptWorktree,
      cleanup: source.keptWorktree ? { [source.room]: 'done' } : undefined,
      runs: [{ n: 1, mode: 'fresh', intentAt: this.now(), nonce: `imported:${workerId}`, busFrontier: [], promptMsgIds: [], launcher: token, launch: { outcome: 'imported' }, logStart: 0 }],
      legacy: { id: source.key, source: source.dir, said: source.said }, createdAt: this.now(), seq: 1,
    }
    createExclusive(this.tagFile(source.tag), { id: workerId, holder: token, at: this.now() })
    createExclusive(file, record)
    if (fs.existsSync(carryFile) && !fs.existsSync(migratedCarryFile)) fs.renameSync(carryFile, migratedCarryFile)
  }
}
