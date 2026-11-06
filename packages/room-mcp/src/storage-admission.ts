/**
 * Whole-operation file-storage admission. Hooks use validated reads and never register or write tickets.
 *
 * A tool call opens a lazy scope (withDirectoryAdmission) that costs nothing until the call first needs lifecycle
 * authority: opening the store or a mutation acquires the scope's single ticket, which then spans every later effect
 * until the scope ends. Reads before that point are validated reads; the scope remembers the generation they saw, and
 * a ticket admitted in a different generation is refused before any effect, so an operation either runs within one
 * legacy generation or stops without acting. Calls that never touch lifecycle storage never touch the gate.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { canonicalCommonDir, openStorageGate } from '@room/local-state/gate'
import { probeOwnProcess } from '@room/local-state/process'
import type { InstanceToken } from '@room/local-state/leases'
import { preflight } from '@room/local-state/preflight'
import { GATE_LIMITS, StorageRefused, type OperationKind, type PreflightResult, type ReadValidation, type Registration, type StorageGate, type Ticket } from '@room/local-state/protocol'
import { legacyImportRequired, legacyImportRemedy, preRegistryImportRequired } from './offline/legacy-import.js'
import manifest from '../../../plugins/room/.claude-plugin/plugin.json' with { type: 'json' }

interface ProcessRegistration { gate: StorageGate; registration: Registration; preflight: PreflightResult }
interface Admission {
  kind: OperationKind; active: boolean
  /** Lazy scopes resolve their clone only when they first need it. */
  dir?: string
  commonDir?: string; ticket?: Ticket; gate?: StorageGate; acquiring?: Promise<Ticket>
  /** Generation seen by validated reads in this scope before its ticket existed. */
  observed?: number
}
const registrations = new Map<string, Promise<ProcessRegistration>>()
const ambient = new AsyncLocalStorage<Admission>()
const reads = new AsyncLocalStorage<{ commonDir: string; active: boolean }>()
const gates = new Map<string, StorageGate>()

/** Bind each process-local storage facade to its canonical directory once. */
export function storageGate(commonDir: string): StorageGate {
  const key = path.resolve(commonDir)
  const cached = gates.get(key)
  if (cached) return cached
  const common = canonicalCommonDir(key)
  const gate = gates.get(common) ?? openStorageGate(common)
  gates.set(common, gate)
  gates.set(key, gate)
  return gate
}

export function storageInstance(): InstanceToken {
  const own = probeOwnProcess()
  return { pid: process.pid, startTime: own?.startTime ?? '', executable: own?.executable ?? '',
    sessionId: `mcp:${process.pid}`, nonce: randomBytes(16).toString('hex') }
}
export function currentAdmission(commonDir: string): Ticket | undefined {
  const context = ambient.getStore()
  return context?.active && context.ticket && context.commonDir === storageGate(commonDir).commonDir ? context.ticket : undefined
}

/** Acquire the enclosing lazy scope's ticket for this clone, once. */
async function acquire(context: Admission, commonDir: string): Promise<Ticket> {
  const common = storageGate(commonDir).commonDir
  if (context.ticket && context.commonDir === common) return context.ticket
  if (context.acquiring && context.commonDir === common) return context.acquiring
  context.commonDir = common
  context.acquiring = (async () => {
    const { gate, registration } = await storageRegistration(common)
    const ticket = await gate.admit(registration, context.kind)
    if (context.observed !== undefined && context.observed !== ticket.generation) {
      await gate.finish(ticket)
      throw new StorageRefused('maintenance', 'storage changed during this operation; nothing was changed, retry it')
    }
    if (!context.active) { await gate.finish(ticket); throw new StorageRefused('unavailable', 'operation ended before admission') }
    context.gate = gate
    context.ticket = ticket
    return ticket
  })()
  try { return await context.acquiring }
  catch (error) { context.acquiring = undefined; context.commonDir = undefined; throw error }
}

/** The ticket authorizing a lifecycle effect: the ambient one, or the enclosing lazy scope's, acquired now. */
export async function requireAdmission(commonDir: string): Promise<Ticket> {
  const context = ambient.getStore()
  const common = storageGate(commonDir).commonDir
  if (context?.active && (!context.commonDir || context.commonDir === common)) return acquire(context, common)
  throw new StorageRefused('unavailable', 'worker effects require an admission ticket')
}
export async function assertLegacyReady(commonDir: string, gate = storageGate(commonDir)): Promise<void> {
  const status = await gate.status()
  if (status.refusal) throw new StorageRefused(status.refusal.reason, status.refusal.detail, status.refusal.remedy)
  if (legacyImportRequired(gate.commonDir, status.legacyImport, status.gate))
    throw new StorageRefused('maintenance', 'offline legacy import required', legacyImportRemedy(gate.commonDir))
}

/** One successful preflight and registration per canonical directory. Failed startup is never cached. */
export async function storageRegistration(commonDir: string): Promise<ProcessRegistration> {
  const gate = storageGate(commonDir), common = gate.commonDir
  let pending = registrations.get(common)
  if (pending) return pending
  let expired = false
  const deadline = performance.now() + GATE_LIMITS.startupMs
  const timedOut = () => expired || performance.now() >= deadline
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = async (): Promise<ProcessRegistration> => {
    const evidence = await preflight('mcp', { commonDir: common })
    if (!evidence.ok) throw new StorageRefused('unavailable', evidence.detail, evidence.remedy)
    if (timedOut()) throw new StorageRefused('unavailable', 'storage startup check exceeded 10 s')
    const status = await gate.status()
    const preRegistryImport = status.gate?.preRegistryImport ?? (preRegistryImportRequired(common) ? 'required' : 'not-needed')
    const registration = await gate.register({ instance: storageInstance(), kind: 'mcp', release: manifest.version, preRegistryImport })
    try {
      if (timedOut()) throw new StorageRefused('unavailable', 'storage startup check exceeded 10 s')
      await assertLegacyReady(common, gate)
      if (timedOut()) throw new StorageRefused('unavailable', 'storage startup check exceeded 10 s')
      return { gate, registration, preflight: evidence }
    } catch (error) { await gate.unregister(registration); throw error }
  }
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new StorageRefused('unavailable', 'storage startup check exceeded 10 s', legacyImportRemedy(common))) }, GATE_LIMITS.startupMs)
    timer.unref?.()
  })
  pending = Promise.race([work(), timeout]).finally(() => clearTimeout(timer))
  registrations.set(common, pending)
  void pending.catch(() => { if (registrations.get(common) === pending) registrations.delete(common) })
  return pending
}

export async function closeStorageAdmissions(): Promise<void> {
  for (const [common, pending] of registrations) {
    const state = await pending.catch(() => undefined)
    if (!state) continue
    try { await state.gate.unregister(state.registration); registrations.delete(common) }
    catch (error) { if (!(error instanceof StorageRefused && error.reason === 'busy')) throw error }
  }
}
// beforeExit permits the guarded async unregister to settle; abrupt death preserves recovery evidence.
process.on('beforeExit', () => { void closeStorageAdmissions().catch(() => {}) })

export async function withAdmission<T>(commonDir: string, kind: OperationKind, fn: (ticket: Ticket) => Promise<T>): Promise<T> {
  const common = storageGate(commonDir).commonDir, enclosing = ambient.getStore()
  // Nested work reuses the enclosing operation's ticket, acquiring a lazy scope's ticket at this first authority use.
  if (enclosing?.active && (!enclosing.commonDir || enclosing.commonDir === common)) return fn(await acquire(enclosing, common))
  const { gate, registration } = await storageRegistration(common)
  const ticket = await gate.admit(registration, kind)
  const context: Admission = { kind, commonDir: common, ticket, gate, active: true }
  try { return await ambient.run(context, () => fn(ticket)) }
  finally { context.active = false; await gate.finish(ticket) }
}

/** Reserve a detached callback before returning from its parent, then run/finish it exactly once. */
export async function detachedAdmission(commonDir: string, kind: OperationKind): Promise<{
  run<T>(fn: () => Promise<T>): Promise<T>; finish(): Promise<void>
}> {
  const common = storageGate(commonDir).commonDir, enclosing = ambient.getStore()
  const parent = enclosing?.active && (!enclosing.commonDir || enclosing.commonDir === common)
    ? await acquire(enclosing, common) : undefined
  const { gate, registration } = await storageRegistration(common)
  const ticket = await gate.admit(registration, kind, { parent })
  const context: Admission = { kind, commonDir: common, ticket, gate, active: true }
  let started = false
  const finish = async () => { if (context.active) { context.active = false; await gate.finish(ticket) } }
  return { async run<T>(fn: () => Promise<T>): Promise<T> {
    if (started || !context.active) throw new StorageRefused('unavailable', 'detached admission already consumed')
    started = true
    try { return await ambient.run(context, fn) } finally { await finish() }
  }, finish }
}

export async function withValidatedRead<T>(commonDir: string, fn: () => Promise<T>): Promise<T> {
  if (currentAdmission(commonDir)) return fn()
  const gate = storageGate(commonDir)
  const scope = ambient.getStore()
  const remember = (generation: number) => {
    if (!scope?.active || scope.ticket || scope.commonDir && scope.commonDir !== gate.commonDir) return
    if (scope.observed !== undefined && scope.observed !== generation)
      throw new StorageRefused('maintenance', 'storage changed during this operation; nothing was changed, retry it')
    scope.commonDir = gate.commonDir
    scope.observed = generation
  }
  const enclosing = reads.getStore()
  if (enclosing?.active && enclosing.commonDir === gate.commonDir) return fn()
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await gate.observe()
    if (before.phase !== 'legacy') throw new StorageRefused('maintenance', 'storage is under maintenance')
    remember(before.generation)
    const context = { commonDir: gate.commonDir, active: true }
    let value: T
    try { value = await reads.run(context, fn) }
    finally { context.active = false }
    const after: ReadValidation = await gate.observe()
    if (after.phase !== 'legacy') throw new StorageRefused('maintenance', 'storage is under maintenance')
    if (before.generation === after.generation) { remember(after.generation); return value }
  }
  throw new StorageRefused('maintenance', 'storage changed during the read; retry after maintenance')
}

/**
 * A tool call's lazy admission scope. No gate work, Git resolution or ticket happens unless the call reaches
 * lifecycle authority; nested scopes reuse the outermost one. `dir` may be undefined for sessions outside Git.
 */
export async function withDirectoryAdmission<T>(dir: string | undefined, kind: OperationKind, fn: () => Promise<T>): Promise<T> {
  const enclosing = ambient.getStore()
  if (enclosing?.active) return fn()
  const context: Admission = { kind, dir, active: true }
  try { return await ambient.run(context, fn) }
  finally {
    context.active = false
    const pending = context.acquiring
    if (pending) { const ticket = await pending.catch(() => undefined); if (ticket) await context.gate!.finish(ticket) }
  }
}

/** The clone a lazy scope belongs to, resolved on demand. */
async function scopeCommonDir(context: Admission): Promise<string | undefined> {
  if (context.commonDir) return context.commonDir
  if (!context.dir) return undefined
  const { commonGitDirFromDotGit } = await import('@room/roomd')
  try { return storageGate(commonGitDirFromDotGit(context.dir)).commonDir } catch { return undefined }
}

/** Timers/event callbacks are independent operations, even when installed inside another admission. */
export function withoutAdmission<T>(fn: () => T): T { return ambient.exit(() => reads.exit(fn)) }

/** Parent registers the actual paused helper identity before allowing its OS/Git effects. */
export async function admitStorageHelper(pid: number): Promise<(() => Promise<void>) | undefined> {
  const context = ambient.getStore()
  if (!context?.active) return undefined
  const common = await scopeCommonDir(context)
  if (!common) return undefined
  const parent = await acquire(context, common)
  const { probeProcessNow } = await import('@room/local-state/process')
  const identity = probeProcessNow(pid)
  if (!identity?.startTime || !identity.executable) throw new StorageRefused('unavailable', 'preview helper identity is unreadable')
  const gate = storageGate(common)
  const instance = { pid, startTime: identity.startTime, executable: identity.executable,
    sessionId: `preview:${pid}`, nonce: randomBytes(16).toString('hex') }
  const registration = await gate.register({ instance, kind: 'helper', release: manifest.version })
  let ticket: Ticket
  try { ticket = await gate.admit(registration, 'preview', { parent }) }
  catch (error) { await gate.unregister(registration); throw error }
  let done = false
  return async () => {
    if (done) return
    await gate.finish(ticket)
    await gate.unregister(registration)
    done = true
  }
}
