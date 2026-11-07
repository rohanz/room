/**
 * The storage gate: the whole-operation admission barrier and maintenance generation for one clone.
 * Contract: protocol.ts. Files only; this module never loads SQLite.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { cleanupOrphanTemps, createExclusive, liveness as processLiveness, withGuard, writeAtomic, type InstanceToken, type Liveness, type ProcessIdentity } from './leases.js'
import { pidAlive } from './process.js'
import { privateStateDirectory } from './private-state.js'
import { callGateThread } from './gate-thread.js'
export { closeStorageGates } from './gate-thread.js'
import {
  GATE_LIMITS, STORAGE_BUILD, STORAGE_PATHS, StorageRefused,
  type AdmitOptions, type DrainProgress, type GateOwner, type GatePhase, type GateStatus, type OperationKind, type ReadValidation,
  type RegisterInput, type Registration, type RegistrationKind, type StorageGate, type StorageGateRecord, type Ticket, type TicketListing, type TicketView,
} from './protocol.js'

const PHASES: readonly GatePhase[] = ['legacy', 'draining', 'staging', 'db-complete', 'active']
const KINDS: readonly RegistrationKind[] = ['mcp', 'daemon', 'maintenance']
const MAX_GATE_BYTES = 64 * 1024
const MAX_RECORD_BYTES = 8 * 1024
const MAX_NOTE = 512
const NONCE = /^[0-9a-f-]{8,64}$/
const TICKET_ID = /^[0-9a-f]{32}$/
const REGISTRATION_ID = /^registration:([0-9a-f-]{8,64})$/
const TICKET_FILE = /^([0-9a-f-]{8,64})\.([0-9a-f]{32})\.json$/
const EVIDENCE_NAMES = new Set([path.basename(STORAGE_PATHS.database), `${path.basename(STORAGE_PATHS.database)}-wal`,
  `${path.basename(STORAGE_PATHS.database)}-shm`, path.basename(STORAGE_PATHS.activationMarker)])
const REMEDY = 'run `node <plugin>/server/room-state.mjs status --common-dir <git common dir>` for details'

export interface GateOptions {
  /** Function injection selects in-thread execution for deterministic tests only. Production uses a worker. */
  now?: () => number
  /** Injected for tests; production uses the shared identity-verified probe. */
  liveness?: (identity: ProcessIdentity) => Liveness
  /** Test seam for cap behavior; production uses GATE_LIMITS. */
  limits?: Partial<Pick<typeof GATE_LIMITS, 'registrations' | 'tickets' | 'scanBatch'>>
}

const bounded = (text: string, max = MAX_NOTE) => text.replace(/[\r\n\t]/g, ' ').slice(0, max)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1
const identityShape = (value: unknown): value is ProcessIdentity => object(value) && Number.isSafeInteger(value.pid) && (value.pid as number) > 0
  && typeof value.startTime === 'string' && typeof value.executable === 'string'
const tokenShape = (value: unknown): value is InstanceToken => identityShape(value) && object(value)
  && typeof value.sessionId === 'string' && typeof value.nonce === 'string' && NONCE.test(value.nonce)

/** Bounded read of a private regular file. ENOENT is absence; anything else (symlink, oversize, bad JSON) throws. */
function readRecord(file: string, max: number): unknown {
  let stat: fs.Stats
  try { stat = fs.lstatSync(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  if (!stat.isFile()) throw new Error(`not a regular file: ${path.basename(file)}`)
  if (stat.size > max) throw new Error(`record exceeds ${max} bytes: ${path.basename(file)}`)
  let text: string
  try { text = fs.readFileSync(file, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  return JSON.parse(text)
}

export function parseGate(value: unknown): StorageGateRecord {
  if (!object(value) || value.v !== 1 || typeof value.cloneId !== 'string' || !/^[0-9a-f]{32}$/.test(value.cloneId)
    || typeof value.commonDir !== 'string' || !positive(value.generation) || !PHASES.includes(value.phase as GatePhase)
    || !positive(value.minReader) || !positive(value.minWriter) || typeof value.updatedAt !== 'number')
    throw new Error('invalid storage gate record')
  if (value.phase !== 'legacy' && !(object(value.owner) && tokenShape(value.owner.instance) && typeof value.owner.token === 'string'))
    throw new Error('storage gate in maintenance without an owner')
  if (value.phase === 'draining' && !(positive(value.drainingFrom) && (value.drainingFrom as number) < (value.generation as number)))
    throw new Error('draining storage gate without a predecessor generation')
  return value as unknown as StorageGateRecord
}

function parseRegistration(value: unknown, nonce: string): Registration {
  if (!object(value) || value.v !== 1 || !tokenShape(value.instance) || value.instance.nonce !== nonce || !KINDS.includes(value.kind as RegistrationKind)
    || !positive(value.build) || typeof value.release !== 'string' || !positive(value.generation) || typeof value.registeredAt !== 'number'
    || value.hasHeldTickets !== undefined && value.hasHeldTickets !== true)
    throw new Error('invalid storage registration')
  return value as unknown as Registration
}

function parseTicket(value: unknown, holder: string, id: string): Ticket {
  if (!object(value) || value.v !== 1 || value.id !== id || value.holder !== holder || !identityShape(value.identity)
    || typeof value.kind !== 'string' || !positive(value.generation) || typeof value.admittedAt !== 'number'
    || value.parent !== undefined && !(typeof value.parent === 'string' && TICKET_ID.test(value.parent)))
    throw new Error('invalid storage ticket')
  return value as unknown as Ticket
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const yieldTurn = () => new Promise<void>(resolve => setImmediate(resolve))
const guardBusy = (error: unknown) => error instanceof Error && error.message.startsWith('lease guard busy')

/** Canonical common directory with HEAD; throws `unavailable` before any write otherwise. */
export function canonicalCommonDir(commonDir: string): string {
  let canonical: string
  try { canonical = fs.realpathSync.native(commonDir) }
  catch (error) { throw new StorageRefused('unavailable', `common directory unreadable: ${(error as NodeJS.ErrnoException).code ?? error}`) }
  if (!path.isAbsolute(canonical) || !fs.existsSync(path.join(canonical, 'HEAD')))
    throw new StorageRefused('unavailable', 'not a Git common directory (no HEAD)')
  return canonical
}

export function openStorageGate(commonDir: string, options: GateOptions = {}): StorageGate {
  const gate = new FileStorageGate(commonDir, options)
  // Functions cannot be structured-cloned. Keep the deterministic unit-test seams in this thread;
  // callers without injected functions (including process/integration tests) always use the worker.
  if (options.now || options.liveness) return gate
  return {
    commonDir: gate.commonDir,
    register: (...args) => callGateThread(gate.commonDir, options, 'register', args),
    admit: (...args) => callGateThread(gate.commonDir, options, 'admit', args),
    finish: (...args) => callGateThread(gate.commonDir, options, 'finish', args),
    unregister: (...args) => callGateThread(gate.commonDir, options, 'unregister', args),
    drain: (...args) => callGateThread(gate.commonDir, options, 'drain', args),
    resolveDead: (...args) => callGateThread(gate.commonDir, options, 'resolveDead', args),
    takeOver: (...args) => callGateThread(gate.commonDir, options, 'takeOver', args),
    reopen: (...args) => callGateThread(gate.commonDir, options, 'reopen', args),
    status: (...args) => callGateThread(gate.commonDir, options, 'status', args),
    listTickets: (...args) => callGateThread(gate.commonDir, options, 'listTickets', args),
    // The read-only hot path remains one cached lstat; it never syncs or probes processes.
    observe: () => gate.observe(),
  }
}

/** Internal implementation shared by the worker and function-injected tests. */
export class FileStorageGate implements StorageGate {
  private readonly now: () => number
  private readonly alive: (identity: ProcessIdentity) => Liveness
  private readonly gateFile: string
  private readonly registrationDir: string
  private readonly ticketDir: string
  private readonly resolutionDir: string
  private readonly limits: { registrations: number; tickets: number; scanBatch: number }
  /** Last observation, keyed by the gate file's identity. Every publication renames a new file into place. */
  private observed?: { key: string; value: ReadValidation; gate: StorageGateRecord }

  readonly commonDir: string

  constructor(commonDir: string, options: GateOptions) {
    this.commonDir = commonDir = canonicalCommonDir(commonDir)
    this.now = options.now ?? Date.now
    this.alive = options.liveness ?? (identity => processLiveness(identity))
    this.limits = { registrations: GATE_LIMITS.registrations, tickets: GATE_LIMITS.tickets, scanBatch: GATE_LIMITS.scanBatch, ...options.limits }
    this.gateFile = path.join(commonDir, STORAGE_PATHS.gate)
    this.registrationDir = path.join(commonDir, STORAGE_PATHS.registrations)
    this.ticketDir = path.join(commonDir, STORAGE_PATHS.tickets)
    this.resolutionDir = path.join(commonDir, STORAGE_PATHS.resolutions)
  }

  // ---- primitives ------------------------------------------------------------------------------------------

  /** Short synchronous critical section on the gate guard; waits only outside it, bounded by guardWaitMs. */
  private async guarded<T>(fn: () => T extends PromiseLike<unknown> ? never : T, repairing = false): Promise<T> {
    const deadline = performance.now() + GATE_LIMITS.guardWaitMs
    for (let attempt = 0; ; attempt++) {
      try { return withGuard(path.join(this.commonDir, 'room-storage-location'), () => {
        if (!repairing) this.readGate()
        return fn()
      }, undefined, { durable: false }) }
      catch (error) {
        if (error instanceof StorageRefused) throw error
        if (!guardBusy(error)) throw new StorageRefused('unavailable', bounded(`storage gate I/O failed: ${(error as Error).message ?? error}`), REMEDY)
        const remaining = deadline - performance.now()
        if (remaining <= 0) throw new StorageRefused('unavailable', 'storage gate guard busy', REMEDY)
        await pause(Math.min(remaining, Math.min(50, 2 + attempt * 3) + Math.random() * 5))
      }
    }
  }

  private readGate(allowForeign = false): StorageGateRecord | undefined {
    let raw: unknown
    try { raw = readRecord(this.gateFile, MAX_GATE_BYTES) }
    catch (error) { throw new StorageRefused('unavailable', bounded(`storage gate unreadable: ${(error as Error).message}`), 'preserve room/storage-gate.json and repair it; Room never reinitializes it') }
    if (raw === undefined) return undefined
    let gate: StorageGateRecord
    try { gate = parseGate(raw) }
    catch (error) { throw new StorageRefused('unavailable', bounded(`storage gate invalid: ${(error as Error).message}`), 'preserve room/storage-gate.json and repair it; Room never reinitializes it') }
    if (!allowForeign && gate.commonDir !== this.commonDir && !this.sameDirectory(gate.commonDir)) throw this.locationMismatch(gate.commonDir)
    return gate
  }

  private relocationCommand(): string {
    const entry = fileURLToPath(new URL(import.meta.url.endsWith('.mjs')
      ? './room-state.mjs' : '../../../plugins/room/server/room-state.mjs', import.meta.url))
    // Single quoting prevents shell expansion of repository and installation paths.
    const quote = (value: string) => process.platform === 'win32' ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\\''") + "'"
    return `node ${quote(entry)} repair-location --common-dir ${quote(this.commonDir)}`
  }

  private locationMessage(old: string): string {
    const command = this.relocationCommand()
    return `This repository's Room state was recorded at \`${old}\`; it is now at \`${this.commonDir}\`. If you moved it, run: \`${command} --confirm-moved\`. If it is a copy, run: \`${command} --confirm-copied\`.`
  }

  private locationMismatch(old: string): StorageRefused {
    return new StorageRefused('incompatible', this.locationMessage(old))
  }

  private relocationRefused(detail: string): StorageRefused {
    const old = this.readGate(true)?.commonDir ?? 'the recorded location'
    return new StorageRefused('incompatible', detail, this.locationMessage(old))
  }

  private sameDirectory(old: string): boolean {
    try {
      const source = fs.statSync(old, { bigint: true }), current = fs.statSync(this.commonDir, { bigint: true })
      return source.isDirectory() && current.isDirectory() &&
        source.ino !== 0n && source.dev === current.dev && source.ino === current.ino
    } catch { return false }
  }

  /** Confirmation changes only the gate, or archives the whole copy. */
  async repairLocation(mode?: 'moved' | 'copied'): Promise<void> {
    await this.guarded(() => {
      if (this.completeCopy(false, mode)) return
      const gate = this.readGate(true)
      if (!gate) return
      const old = gate.commonDir
      const alias = this.sameDirectory(old)
      if (mode === 'copied' && alias)
        throw this.relocationRefused('--confirm-copied refused: recorded and current paths are the same directory')
      if (old === this.commonDir) return
      if (!mode && !alias) throw this.locationMismatch(old)
      if (mode && gate.phase !== 'legacy') throw this.relocationRefused(`relocation requires legacy phase; found ${gate.phase}`)
      if (alias) {
        writeAtomic(this.gateFile, { ...gate, commonDir: this.commonDir })
        process.stderr.write(`Room location alias: ${old} -> ${this.commonDir}\n`)
        return
      }
      const room = path.join(this.commonDir, 'room')
      this.checkRelocationHolders(room)
      if (mode === 'moved') {
        const remaining = this.pathBearingRecords(room)
        if (remaining.length) throw this.relocationRefused(`finish (collect or discard) your workers and release review holds, then rerun; remaining: ${remaining.join(', ')}`)
        writeAtomic(this.gateFile, { ...gate, commonDir: this.commonDir })
        process.stderr.write(`Room moved: ${old} -> ${this.commonDir}${fs.existsSync(path.join(this.commonDir, 'worktrees')) ? '; linked worktrees may require git worktree repair' : ''}\n`)
      } else {
        const aside = `room.copied-${this.now()}-${randomBytes(6).toString('hex')}`
        writeAtomic(path.join(room, 'copy-pending.json'), { v: 1, aside,
          fresh: { cloneId: randomBytes(16).toString('hex'), relocationNonce: randomBytes(16).toString('hex') } })
        this.completeCopy(false)
      }
    }, true)
  }

  /** The marker travels with the archive; its identity recognises our fresh gate. */
  private completeCopy(inspect: boolean, mode?: 'moved' | 'copied'): boolean {
    const room = path.join(this.commonDir, 'room')
    const candidates = ['room', ...this.names(this.commonDir).filter(n => /^room\.copied-[0-9]+-[a-f0-9]{12}$/.test(n))]
      .filter(n => fs.existsSync(path.join(this.commonDir, n, 'copy-pending.json')))
    if (!candidates.length) return false
    if (candidates.length !== 1) throw this.relocationRefused('multiple pending copy markers; preserve for inspection')
    if (mode === 'moved') throw this.relocationRefused('pending copy repair; rerun --confirm-copied')
    const source = path.join(this.commonDir, candidates[0])
    if (!fs.lstatSync(source).isDirectory()) throw this.relocationRefused('copy source is not a directory')
    const marker = readRecord(path.join(source, 'copy-pending.json'), MAX_GATE_BYTES)
    if (!object(marker) || marker.v !== 1 || typeof marker.aside !== 'string' || !/^room\.copied-[0-9]+-[a-f0-9]{12}$/.test(marker.aside)
      || !object(marker.fresh) || typeof marker.fresh.cloneId !== 'string' || !/^[a-f0-9]{32}$/.test(marker.fresh.cloneId)
      || typeof marker.fresh.relocationNonce !== 'string' || !/^[a-f0-9]{32}$/.test(marker.fresh.relocationNonce)
      || candidates[0] !== 'room' && candidates[0] !== marker.aside)
      throw this.relocationRefused('invalid copy marker; preserve for inspection')
    const original = parseGate(readRecord(path.join(source, 'storage-gate.json'), MAX_GATE_BYTES))
    if (original.phase !== 'legacy') throw this.relocationRefused('relocation requires legacy phase')
    if (this.sameDirectory(original.commonDir)) throw this.relocationRefused('--confirm-copied refused: recorded and current paths are the same directory')
    this.checkRelocationHolders(source)
    const archived = candidates[0] !== 'room'
    const current = this.readGate(true)
    const own = archived && current?.cloneId === marker.fresh.cloneId && current?.relocationNonce === marker.fresh.relocationNonce
      && current?.commonDir === this.commonDir && current?.phase === 'legacy'
    if (archived && current && !own) throw this.relocationRefused('copy archive exists alongside a foreign gate')
    if (inspect) throw new StorageRefused('incompatible', `pending copy repair: ${original.commonDir} -> ${this.commonDir}`, this.locationMessage(original.commonDir))
    const aside = path.join(this.commonDir, marker.aside)
    if (!archived) {
      if (fs.existsSync(aside)) throw this.relocationRefused('copy archive already exists')
      fs.renameSync(room, aside)
      syncDirectoryQuietly(this.commonDir)
    }
    if (!own) {
      this.cleanRelocationDestination(room)
      this.initialize('not-needed', marker.fresh as { cloneId: string; relocationNonce: string })
    }
    fs.unlinkSync(path.join(aside, 'copy-pending.json'))
    syncDirectoryQuietly(aside)
    process.stderr.write(`Room copied: ${original.commonDir} -> ${this.commonDir}; previous state preserved at ${aside}\n`)
    return true
  }

  /** Refuse path-bearing durable state; never rewrite records or their keys. */
  private pathBearingRecords(room: string): string[] {
    const remaining: string[] = []
    const paths = new Set(['dir', 'commonDir', 'worktree', 'keptWorktree', 'leadDir', 'cwd', 'gitDir', 'sessionDir', 'logDir', 'logFile', 'reportFile', 'exitFile', 'transcript_path', 'path'])
    const carriesPath = (value: unknown): boolean => Array.isArray(value) ? value.some(carriesPath)
      : object(value) && Object.entries(value).some(([key, item]) => key.startsWith('worktree:') || path.isAbsolute(key) || key === 'clone'
        || paths.has(key) && typeof item === 'string' && path.isAbsolute(item) || carriesPath(item))
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(file); continue }
        if (file === this.gateFile || !entry.name.endsWith('.json')) continue
        const value = readRecord(file, 16 * 1024 * 1024)
        const review = path.basename(dir) === 'collection-reviews'
        const worker = path.basename(dir) === 'workers' && object(value)
        const activeWorker = worker && (!['retired', 'abandoned'].includes(String(value.phase)) || !!value.keptWorktree)
        if (review ? !Array.isArray(value) || value.length > 0 : activeWorker || carriesPath(value)) remaining.push(path.relative(room, file))
      }
    }
    walk(room)
    return remaining
  }

  /** Only reclaim known scratch with a verified-gone writer; unknown evidence stays for inspection. */
  private cleanRelocationDestination(room: string): void {
    if (!fs.existsSync(room)) return
    const refuse = () => { throw this.relocationRefused('relocation destination is not empty') }
    if (!fs.lstatSync(room).isDirectory()) refuse()
    const scratch = path.join(room, 'preflight')
    const children: string[] = []
    for (const entry of fs.readdirSync(room, { withFileTypes: true })) {
      if (entry.name === 'preflight' && entry.isDirectory()) {
        for (const child of fs.readdirSync(scratch, { withFileTypes: true })) {
          const match = /^p([1-9][0-9]*)-n[a-f0-9]{16}$/.exec(child.name)
          const pid = match ? Number(match[1]) : NaN
          // PID reuse conservatively refuses, even if the original owner has exited.
          if (!child.isDirectory() || !Number.isSafeInteger(pid) || pidAlive(pid)) refuse()
          const dir = path.join(scratch, child.name)
          for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!file.isFile() || !['probe.sqlite', 'probe.sqlite-wal', 'probe.sqlite-shm'].includes(file.name)) refuse()
          }
          children.push(dir)
        }
      } else if (!entry.isFile()) refuse()
    }
    // Reuse atomic publication's exact naming and process-death rules. Live/unknown
    // temps and all other files remain, so the final emptiness check refuses them.
    cleanupOrphanTemps(room)
    for (const dir of children) {
      for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name))
      fs.rmdirSync(dir)
    }
    // Shared with concurrent preflights between parent verification and child creation.
    // Never remove this parent, even when empty.
    if (fs.readdirSync(room, { withFileTypes: true }).some(entry =>
      entry.name !== 'preflight' || !entry.isDirectory())) refuse()
  }

  private checkRelocationHolders(dir: string): void {
    const dead = (identity: unknown): void => {
      if (!identityShape(identity) || this.alive(identity) !== 'dead')
        throw this.relocationRefused('relocation blocked by a live or unknown recorded process')
    }
    const hasPid = (value: unknown): boolean => Array.isArray(value) ? value.some(hasPid)
      : object(value) && Object.entries(value).some(([key, item]) => /pid$/i.test(key) || hasPid(item))
    const check = (value: unknown, name: string): void => {
      // Explicit ownership contracts. Never apply session ancestry rules to reports.
      if (name.endsWith('.report.json')) {
        if (!object(value) || !Array.isArray(value.chain)) dead(undefined)
        const report = value as Record<string, unknown>
        const chain = report.chain as unknown[]
        dead(chain[0]) // MCP
        dead(report.hostProcess !== undefined ? report.hostProcess : chain[1]) // admitted host or legacy fallback
      } else if (name === 'session.json') {
        if (!object(value)) dead(undefined)
        const session = value as Record<string, unknown>
        const interpreter = /^(?:sh|bash|dash|zsh|fish|cmd|powershell|pwsh)(?:\.exe)?$/i
        if ('chain' in session) {
          const chain = Array.isArray(session.chain) ? session.chain : []
          const first = chain[0]
          const host = identityShape(first) && interpreter.test(first.executable) ? chain[1] : first
          if (!identityShape(host) || !host.executable || interpreter.test(host.executable))
            throw this.relocationRefused('cannot verify session host identity')
          dead(host)
        } else dead({ pid: session.hostPid, startTime: '', executable: '' })
      } else if (object(value) && name === 'storage-gate.json') {
        if (object(value.owner)) dead(value.owner.instance)
      } else if (object(value) && dir === this.registrationDir) {
        dead(value.instance)
      } else if (object(value) && /storage-gate[/\\](registrations|tickets)$/.test(dir)) {
        dead(value.instance ?? value.identity) // same paths inside an archive
      } else if (object(value) && /[/\\]workers$/.test(dir) && name.endsWith('.json')) {
        if (!object(value.lead) || !Array.isArray(value.runs)) dead(undefined)
        dead((value.lead as Record<string, unknown>).instance)
        for (const run of value.runs as Record<string, unknown>[]) {
          dead(run.launcher)
          if (object(run.launch) && run.launch.outcome === 'launched')
            dead(run.launch.process ?? { pid: run.launch.pid, startTime: '', executable: '' })
          else if (object(run.launch) && run.launch.outcome === 'ambiguous') dead(undefined)
        }
      } else if (object(value) && (name.endsWith('.op') || name.endsWith('.writer') || name.endsWith('.lock') || name.endsWith('.guard')
        || /[/\\](publishers|collect|tags|adoptions)$/.test(dir))) {
        dead(value.holder ?? value)
        if (object(value.requested)) dead(value.requested.holder)
      } else if (object(value) && (name === 'relay.json' || value.runtime === 'daemon-client')) {
        dead(value)
        if (object(value.worker)) dead(value.worker.host)
      } else if (hasPid(value)) {
        throw this.relocationRefused(`relocation blocked by a live or unknown record kind: ${name}`)
      }
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw this.relocationRefused(`cannot relocate symbolic link ${entry.name}`)
      if (entry.isDirectory()) this.checkRelocationHolders(file)
      else if (entry.name.endsWith('.json') || entry.name.endsWith('.lock') || entry.name.endsWith('.op') || entry.name.endsWith('.writer') || entry.name.endsWith('.guard')) {
        try { check(readRecord(file, 16 * 1024 * 1024), entry.name) }
        catch (error) {
          if (error instanceof StorageRefused) throw error
          throw this.relocationRefused(`cannot verify relocation record ${entry.name}`)
        }
      }
    }
  }

  private requireGate(): StorageGateRecord {
    const gate = this.readGate()
    if (!gate) throw new StorageRefused('unavailable', this.activationEvidence()
      ? 'storage activation evidence exists without a storage gate' : 'storage gate not initialized; register first', REMEDY)
    return gate
  }

  /** One directory read: every evidence path lives directly in room/. Unreadable counts as evidence. */
  private activationEvidence(): boolean {
    let names: string[]
    try { names = fs.readdirSync(path.join(this.commonDir, 'room')) }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
    return names.some(name => EVIDENCE_NAMES.has(name))
  }

  private names(dir: string): string[] {
    try { return fs.readdirSync(dir) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  private ticketNames(): string[] { return this.names(this.ticketDir).filter(name => TICKET_FILE.test(name)) }
  private registrationNames(): string[] { return this.names(this.registrationDir).filter(name => /^[0-9a-f-]{8,64}\.json$/.test(name)) }
  private ticketFile(holder: string, id: string): string { return path.join(this.ticketDir, `${holder}.${id}.json`) }
  private registrationFile(nonce: string): string { return path.join(this.registrationDir, `${nonce}.json`) }

  private readRegistration(nonce: string): Registration | undefined {
    const raw = readRecord(this.registrationFile(nonce), MAX_RECORD_BYTES)
    return raw === undefined ? undefined : parseRegistration(raw, nonce)
  }

  private publish(gate: StorageGateRecord): StorageGateRecord {
    const next = { ...gate, updatedAt: this.now() }
    writeAtomic(this.gateFile, next)
    return next
  }

  private initialize(preRegistryImport: 'required' | 'not-needed', fresh?: { cloneId: string; relocationNonce: string }): StorageGateRecord {
    if (this.activationEvidence()) throw new StorageRefused('unavailable', 'storage activation evidence exists without a storage gate', 'preserve room/state.sqlite and the activation marker; repair the gate with the offline command')
    privateStateDirectory(path.join(this.commonDir, 'room'))
    const gate: StorageGateRecord = { v: 1, cloneId: randomBytes(16).toString('hex'), ...fresh, commonDir: this.commonDir, generation: 1,
      phase: 'legacy', minReader: 1, minWriter: 1, preRegistryImport, updatedAt: this.now() }
    // The guard serializes initializers; exclusive creation also refuses to overwrite a successor written by
    // any process that bypassed it.
    if (!createExclusive(this.gateFile, gate)) return this.requireGate()
    return gate
  }

  private compatibility(gate: StorageGateRecord, build: number): void {
    if (build < gate.minReader || build < gate.minWriter)
      throw new StorageRefused('incompatible', `storage build ${build} is below this clone's minimum ${Math.max(gate.minReader, gate.minWriter)}`, 'update the Room plugin on every host, then restart them')
    if (gate.phase === 'active' && build < 2)
      throw new StorageRefused('incompatible', 'this clone uses SQLite storage; this Room build only supports legacy files', 'update the Room plugin on every host, then restart them')
  }

  /** The maintenance owner must hold migration.lock and match the gate's recorded owner when there is one. */
  private requireOwner(owner: GateOwner, gate: StorageGateRecord): void {
    let raw: unknown
    try { raw = readRecord(path.join(this.commonDir, STORAGE_PATHS.migrationLock), MAX_RECORD_BYTES) }
    catch (error) { throw new StorageRefused('unavailable', bounded(`migration lock unreadable: ${(error as Error).message}`)) }
    const holder = object(raw) ? (object(raw.holder) ? raw.holder : raw) : undefined
    if (!holder || holder.nonce !== owner.instance.nonce)
      throw new StorageRefused('maintenance', 'this process does not hold migration.lock')
    if (gate.owner && (gate.owner.instance.nonce !== owner.instance.nonce || gate.owner.token !== owner.token))
      throw new StorageRefused('maintenance', 'another maintenance owner holds this generation')
  }

  // ---- StorageGate -----------------------------------------------------------------------------------------

  async register(input: RegisterInput): Promise<Registration> {
    if (!tokenShape(input.instance)) throw new StorageRefused('unavailable', 'invalid instance identity')
    if (!KINDS.includes(input.kind)) throw new StorageRefused('unavailable', 'invalid registration kind')
    await this.repairLocation()
    const build = input.build ?? STORAGE_BUILD
    const attempt = () => this.guarded(() => {
      const gate = this.readGate() ?? this.initialize(input.preRegistryImport ?? 'required')
      this.compatibility(gate, build)
      const existing = this.readRegistration(input.instance.nonce)
      if (existing) return existing
      if (this.registrationNames().length >= this.limits.registrations) return 'full' as const
      const registration: Registration = { v: 1, instance: input.instance, kind: input.kind, build, release: bounded(input.release, 64),
        generation: gate.generation, registeredAt: this.now() }
      writeAtomic(this.registrationFile(input.instance.nonce), registration)
      return registration
    })
    let result = await attempt()
    if (result === 'full') {
      // Prune verified-dead, ticketless registrations outside the guard, then retry once.
      await this.pruneDeadRegistrations()
      result = await attempt()
    }
    if (result === 'full') throw new StorageRefused('capacity', `${this.limits.registrations} processes are registered for this clone`, REMEDY)
    return result
  }

  /**
   * Lock-free admission against the guarded drain transition. The ticket is published atomically, then the gate is
   * read again: a drain publishes its generation under the guard before scanning tickets, so either that scan sees
   * this ticket, or this re-read sees the drain and the ticket is withdrawn before anything can act on it.
   */
  async admit(registration: Registration, kind: OperationKind, options: AdmitOptions = {}): Promise<Ticket> {
    const holder = registration.instance.nonce
    const parent = options.parent
    if (options.identity && !(parent && identityShape(options.identity)))
      throw new StorageRefused('unavailable', 'a ticket for another process must be a child of the operation that started it')
    const current = this.readRegistrationOrRefuse(holder)
    const permitted = (gate: StorageGateRecord): number => {
      this.compatibility(gate, current.build)
      // A detached child inherits its live parent's generation, so a drain waits for it too.
      if (parent && !fs.existsSync(this.ticketFile(parent.holder, parent.id)))
        throw new StorageRefused('maintenance', 'parent operation already finished')
      if (gate.phase !== 'legacy') {
        const predecessor = gate.phase === 'draining' && parent && parent.generation <= (gate.drainingFrom ?? 0)
        if (!predecessor) throw new StorageRefused(gate.phase === 'active' ? 'incompatible' : 'maintenance',
          `Room storage maintenance in progress (generation ${gate.generation}, ${gate.phase})`, REMEDY)
      }
      return parent ? parent.generation : gate.generation
    }
    const capacity = () => {
      if (this.ticketNames().length > this.limits.tickets)
        throw new StorageRefused('capacity', `${this.limits.tickets} operations are in progress for this clone`, 'retry after current operations finish')
    }
    const before = this.requireGate()
    const generation = permitted(before)
    if (this.ticketNames().length >= this.limits.tickets)
      throw new StorageRefused('capacity', `${this.limits.tickets} operations are in progress for this clone`, 'retry after current operations finish')
    // One durable marker per registration, before any non-durable ticket can authorize effects.
    // It survives ticket loss and prevents dead-holder pruning from skipping lifecycle recovery.
    if (!current.hasHeldTickets) writeAtomic(this.registrationFile(holder), { ...current, hasHeldTickets: true })
    const effectOwner = options.identity ?? {
      pid: registration.instance.pid, startTime: registration.instance.startTime, executable: registration.instance.executable }
    const ticket: Ticket = { v: 1, id: randomBytes(16).toString('hex'), holder, identity: effectOwner,
      kind, generation, ...(parent ? { parent: parent.id } : {}), admittedAt: this.now() }
    const file = this.ticketFile(holder, ticket.id)
    // Published by atomic rename: readers never see a partial ticket. This relies on the holder nonce plus 128 random
    // bits being unique; an exclusive hard-link create would only add cost (APFS links are several times slower than
    // a rename) to guard a collision of negligible probability.
    writeAtomic(file, ticket, { durable: false })
    try {
      const after = this.requireGate()
      if (after.generation !== before.generation || after.phase !== before.phase) {
        // Any maintenance between the two reads invalidates decisions made under the first.
        if (!parent) throw new StorageRefused('maintenance', `Room storage maintenance in progress (generation ${after.generation}, ${after.phase})`, REMEDY)
        permitted(after)
      }
      capacity()
    } catch (error) {
      try { fs.unlinkSync(file) } catch (unlinkError) { if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError }
      throw error
    }
    return ticket
  }

  private readRegistrationOrRefuse(holder: string): Registration {
    let current: Registration | undefined
    try { current = this.readRegistration(holder) }
    catch (error) { throw new StorageRefused('unavailable', bounded(`storage registration unreadable: ${(error as Error).message}`)) }
    if (!current) throw new StorageRefused('unavailable', 'this process is not registered with the storage gate')
    return current
  }

  async finish(ticket: Ticket): Promise<void> {
    this.readGate()
    // No guard: ticket ids are unique, and finish must stay available to predecessors while draining.
    const file = this.ticketFile(ticket.holder, ticket.id)
    try { fs.unlinkSync(file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new StorageRefused('unavailable', bounded(`ticket release failed: ${(error as NodeJS.ErrnoException).code ?? error}`))
    }
  }

  async unregister(registration: Registration): Promise<void> {
    const nonce = registration.instance.nonce
    await this.guarded(() => {
      if (this.ticketNames().some(name => name.startsWith(`${nonce}.`)))
        throw new StorageRefused('busy', 'this process still holds storage tickets')
      try { fs.unlinkSync(this.registrationFile(nonce)); syncDirectoryQuietly(this.registrationDir) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    })
  }

  async drain(owner: GateOwner): Promise<DrainProgress> {
    const gate = await this.guarded(() => {
      const gate = this.requireGate()
      if (!this.readRegistration(owner.instance.nonce)) throw new StorageRefused('maintenance', 'maintenance owner is not registered')
      if (gate.phase === 'legacy') {
        this.requireOwner(owner, { ...gate, owner: undefined })
        return this.publish({ ...gate, generation: gate.generation + 1, phase: 'draining', drainingFrom: gate.generation, owner })
      }
      if (gate.phase !== 'draining') throw new StorageRefused('incompatible', `storage gate is ${gate.phase}; this build only drains legacy storage`)
      this.requireOwner(owner, gate)
      return gate
    })
    return this.progress(gate)
  }

  async takeOver(owner: GateOwner): Promise<DrainProgress> {
    const observed = this.requireGate()
    if (observed.phase !== 'draining' || !observed.owner) throw new StorageRefused('maintenance', 'no draining generation to take over')
    if (this.alive(observed.owner.instance) !== 'dead') throw new StorageRefused('maintenance', 'the recorded maintenance owner is alive or unknown')
    const gate = await this.guarded(() => {
      const gate = this.requireGate()
      if (gate.generation !== observed.generation || gate.owner?.token !== observed.owner!.token)
        throw new StorageRefused('maintenance', 'storage gate changed during takeover')
      this.requireOwner(owner, { ...gate, owner: undefined })
      return this.publish({ ...gate, generation: gate.generation + 1, owner })
    })
    return this.progress(gate)
  }

  /**
   * Registration evidence is separate from volatile tickets. Never interpret lifecycle leases here. A ticket name
   * whose record was read and found gone (Windows lists a delete-pending name until its last handle closes) does not
   * cover its holder, so that holder's registration evidence is still reported.
   */
  private async registrationEvidence(ticketNames: string[], gone: ReadonlySet<string> = new Set()): Promise<TicketListing['tickets']> {
    const holders = new Set(ticketNames.filter(name => !gone.has(name)).map(name => name.split('.')[0]))
    const names = this.registrationNames(), evidence: TicketListing['tickets'] = []
    for (let start = 0; start < names.length; start += this.limits.scanBatch) {
      for (const name of names.slice(start, start + this.limits.scanBatch)) {
        const holder = name.slice(0, -5)
        if (holders.has(holder)) continue
        let registration: Registration | undefined
        try { registration = this.readRegistration(holder) }
        catch {
          evidence.push({ id: `registration:${holder}`, holder, kind: 'reconcile', generation: 0, pid: 0,
            admittedAt: 0, holderState: 'unreadable' })
          continue
        }
        if (!registration?.hasHeldTickets) continue
        evidence.push({ id: `registration:${holder}`, holder, kind: 'reconcile', generation: registration.generation,
          pid: registration.instance.pid, admittedAt: registration.registeredAt, holderState: this.alive(registration.instance) })
      }
      await yieldTurn()
    }
    return evidence
  }

  private async progress(gate: StorageGateRecord): Promise<DrainProgress> {
    const live: TicketView[] = [], unknown: TicketView[] = [], dead: TicketView[] = []
    const names = this.ticketNames(), gone = new Set<string>()
    for (let start = 0; start < names.length; start += this.limits.scanBatch) {
      for (const name of names.slice(start, start + this.limits.scanBatch)) {
        const [, holder, id] = TICKET_FILE.exec(name)!
        let ticket: Ticket | undefined
        try { const raw = readRecord(path.join(this.ticketDir, name), MAX_RECORD_BYTES); if (raw === undefined) { gone.add(name); continue }; ticket = parseTicket(raw, holder, id) }
        catch { unknown.push({ id, kind: 'reconcile', generation: 0, holder, pid: 0, admittedAt: 0 }); continue }
        const view: TicketView = { id, kind: ticket.kind, generation: ticket.generation, holder, pid: ticket.identity.pid,
          ...(ticket.parent ? { parent: ticket.parent } : {}), admittedAt: ticket.admittedAt }
        const state = this.alive(ticket.identity)
        ;(state === 'alive' ? live : state === 'dead' ? dead : unknown).push(view)
      }
      await yieldTurn()
    }
    for (const { holderState, ...view } of await this.registrationEvidence(names, gone)) {
      ;(holderState === 'alive' ? live : holderState === 'dead' ? dead : unknown).push(view)
    }
    if (!names.length) await this.pruneDeadRegistrations()
    return { generation: gate.generation, phase: gate.phase,
      complete: names.length === 0 && !live.length && !dead.length && !unknown.length, live, unknown, dead, pending: 0 }
  }

  private async pruneDeadRegistrations(): Promise<void> {
    const names = this.registrationNames()
    const holders = new Set(this.ticketNames().map(name => name.split('.')[0]))
    for (let start = 0; start < names.length; start += this.limits.scanBatch) {
      for (const name of names.slice(start, start + this.limits.scanBatch)) {
        const nonce = name.slice(0, -5)
        if (holders.has(nonce)) continue
        let registration: Registration | undefined
        try { registration = this.readRegistration(nonce) } catch { continue } // damaged: keep as evidence
        // Owner identity survives in gate.owner; takeover never needs the dead registration file.
        if (!registration || registration.hasHeldTickets || this.alive(registration.instance) !== 'dead') continue
        try { fs.unlinkSync(this.registrationFile(nonce)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      await yieldTurn()
    }
    syncDirectoryQuietly(this.registrationDir)
  }

  async resolveDead(owner: GateOwner, ticketId: string, note: string): Promise<void> {
    const registrationId = REGISTRATION_ID.exec(ticketId)
    if (registrationId) {
      const holder = registrationId[1], registration = this.readRegistration(holder)
      if (!registration?.hasHeldTickets) throw new StorageRefused('unavailable', 'no such registration evidence')
      if (this.alive(registration.instance) !== 'dead')
        throw new StorageRefused('blocked', 'the registration holder is alive or its identity cannot be verified')
      await this.guarded(() => {
        const gate = this.requireGate()
        if (gate.phase !== 'draining') throw new StorageRefused('maintenance', 'dead holders are resolved only while draining')
        this.requireOwner(owner, gate)
        if (!this.readRegistration(holder)?.hasHeldTickets) return
        if (this.ticketNames().some(name => name.startsWith(`${holder}.`)))
          throw new StorageRefused('busy', 'resolve remaining holder tickets before registration evidence')
        writeAtomic(path.join(this.resolutionDir, `registration-${holder}.json`), { v: 1, registration, note: bounded(note),
          owner: owner.instance.nonce, generation: gate.generation, liveness: 'dead', at: this.now(), id: randomUUID() })
        fs.unlinkSync(this.registrationFile(holder))
        syncDirectoryQuietly(this.registrationDir)
      })
      return
    }
    if (!TICKET_ID.test(ticketId)) throw new StorageRefused('unavailable', 'invalid ticket id')
    const name = this.ticketNames().find(candidate => candidate.endsWith(`.${ticketId}.json`))
    if (!name) throw new StorageRefused('unavailable', 'no such ticket')
    const [, holder] = TICKET_FILE.exec(name)!
    const ticket = parseTicket(readRecord(path.join(this.ticketDir, name), MAX_RECORD_BYTES), holder, ticketId)
    // Probe outside the guard; the guarded section rechecks the ticket and owner.
    if (this.alive(ticket.identity) !== 'dead') throw new StorageRefused('blocked', 'the ticket holder is alive or its identity cannot be verified')
    await this.guarded(() => {
      const gate = this.requireGate()
      if (gate.phase !== 'draining') throw new StorageRefused('maintenance', 'dead tickets are resolved only while draining')
      this.requireOwner(owner, gate)
      const file = path.join(this.ticketDir, name)
      if (!fs.existsSync(file)) return
      privateStateDirectory(this.resolutionDir)
      writeAtomic(path.join(this.resolutionDir, `${ticketId}.json`), { v: 1, ticket, note: bounded(note), owner: owner.instance.nonce,
        generation: gate.generation, liveness: 'dead', at: this.now(), id: randomUUID() })
      fs.unlinkSync(file)
      syncDirectoryQuietly(this.ticketDir)
    })
  }

  async reopen(owner: GateOwner, options: { notAfter?: number } = {}): Promise<StorageGateRecord> {
    return this.guarded(() => {
      const gate = this.requireGate()
      if (gate.phase !== 'draining') throw new StorageRefused('maintenance', `storage gate is ${gate.phase}, not draining`)
      this.requireOwner(owner, gate)
      const { owner: _owner, drainingFrom: _from, ...rest } = gate
      if (options.notAfter !== undefined && (!Number.isFinite(options.notAfter) || this.now() >= options.notAfter))
        throw new StorageRefused('maintenance', 'import attempt deadline passed; admission stays closed')
      return this.publish({ ...rest, phase: 'legacy' })
    })
  }

  async status(): Promise<GateStatus> {
    const counts = () => {
      try { return { registrations: this.registrationNames().length, tickets: this.ticketNames().length } }
      catch { return { registrations: 0, tickets: 0 } }
    }
    let legacyImport: GateStatus['legacyImport']
    try {
      const raw = readRecord(path.join(this.commonDir, STORAGE_PATHS.migrationMap), 4 * 1024 * 1024)
      legacyImport = raw === undefined ? 'absent' : object(raw) && raw.done === true ? 'done' : 'pending'
    } catch { legacyImport = 'unreadable' }
    let gate: StorageGateRecord | undefined
    try {
      this.completeCopy(true)
      gate = this.readGate()
    }
    catch (error) {
      const refused = error as StorageRefused
      return { state: 'unreadable', ...counts(), legacyImport, maintenanceRequired: true, refusal: { reason: refused.reason, detail: refused.detail, remedy: refused.remedy } }
    }
    if (!gate) {
      const evidence = this.activationEvidence()
      return { state: evidence ? 'evidence-without-gate' : 'absent', ...counts(), legacyImport, maintenanceRequired: evidence,
        ...(evidence ? { refusal: { reason: 'unavailable' as const, detail: 'storage activation evidence exists without a storage gate', remedy: REMEDY } } : {}) }
    }
    try { this.compatibility(gate, STORAGE_BUILD) }
    catch (error) {
      const refused = error as StorageRefused
      return { state: 'present', gate, ...counts(), legacyImport, maintenanceRequired: true, refusal: { reason: refused.reason, detail: refused.detail, remedy: refused.remedy } }
    }
    const maintenance = gate.phase !== 'legacy'
    return { state: 'present', gate, ...counts(), legacyImport, maintenanceRequired: maintenance,
      ...(gate.commonDir !== this.commonDir ? { locationUpdate: { recorded: gate.commonDir, canonical: this.commonDir } } : {}),
      ...(maintenance ? { refusal: { reason: 'maintenance' as const, detail: `generation ${gate.generation} is ${gate.phase}`, remedy: REMEDY } } : {}) }
  }

  async listTickets(limit: number = this.limits.scanBatch): Promise<TicketListing> {
    this.readGate()
    const names = this.ticketNames().sort()
    const bound = Math.max(0, Math.min(limit, this.limits.scanBatch))
    const tickets: TicketListing['tickets'] = [], gone = new Set<string>()
    for (const name of names.slice(0, bound)) {
      const [, holder, id] = TICKET_FILE.exec(name)!
      try {
        const raw = readRecord(path.join(this.ticketDir, name), MAX_RECORD_BYTES)
        if (raw === undefined) { gone.add(name); continue }
        const ticket = parseTicket(raw, holder, id)
        tickets.push({ id, kind: ticket.kind, generation: ticket.generation, holder, pid: ticket.identity.pid,
          ...(ticket.parent ? { parent: ticket.parent } : {}), admittedAt: ticket.admittedAt, holderState: this.alive(ticket.identity) })
      } catch { tickets.push({ id, kind: 'reconcile', generation: 0, holder, pid: 0, admittedAt: 0, holderState: 'unreadable' }) }
    }
    const evidence = await this.registrationEvidence(names, gone)
    tickets.push(...evidence.slice(0, Math.max(0, bound - tickets.length)))
    const total = names.length + evidence.length
    return { tickets, total, truncated: total > bound }
  }

  async observe(): Promise<ReadValidation> {
    let stat: fs.BigIntStats | undefined
    try { stat = fs.lstatSync(this.gateFile, { bigint: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new StorageRefused('unavailable', bounded(`storage gate unreadable: ${(error as NodeJS.ErrnoException).code ?? error}`), REMEDY) }
    const key = stat && `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`
    if (key && this.observed?.key === key) {
      this.compatibility(this.observed.gate, STORAGE_BUILD)
      return this.observed.value
    }
    this.observed = undefined
    const gate = stat ? this.readGate() : undefined
    if (gate) {
      // Both fresh observations and cache hits enforce this build's reader/writer capability.
      this.compatibility(gate, STORAGE_BUILD)
      const value = { generation: gate.generation, phase: gate.phase }
      if (key) this.observed = { key, value, gate }
      return value
    }
    // Before the first registration the clone is legacy at generation 0; initialization moves it to 1, so a read
    // spanning initialization sees a change. Activation evidence without a gate is never legacy.
    if (this.activationEvidence()) throw new StorageRefused('unavailable', 'storage activation evidence exists without a storage gate', REMEDY)
    return { generation: 0, phase: 'legacy' }
  }
}

function syncDirectoryQuietly(dir: string): void {
  let fd: number | undefined
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd) }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}
