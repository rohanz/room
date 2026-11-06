/** Whole-operation file-storage admission. Hooks use validated reads and never register or write tickets. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { canonicalCommonDir, openStorageGate } from '@room/local-state/gate'
import { probeOwnProcess } from '@room/local-state/process'
import type { InstanceToken } from '@room/local-state/leases'
import { preflight } from '@room/local-state/preflight'
import { GATE_LIMITS, StorageRefused, type OperationKind, type PreflightResult, type ReadValidation, type Registration, type StorageGate, type Ticket } from '@room/local-state/protocol'
import { legacyImportRequired, legacyImportRemedy } from './offline/legacy-import.js'
import manifest from '../../../plugins/room/.claude-plugin/plugin.json' with { type: 'json' }

interface ProcessRegistration { gate: StorageGate; registration: Registration; preflight: PreflightResult }
interface Admission { commonDir: string; ticket: Ticket; active: boolean }
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
  return context?.active && context.commonDir === storageGate(commonDir).commonDir ? context.ticket : undefined
}
export async function assertLegacyReady(commonDir: string, gate = storageGate(commonDir)): Promise<void> {
  const status = await gate.status()
  if (status.refusal) throw new StorageRefused(status.refusal.reason, status.refusal.detail, status.refusal.remedy)
  if (legacyImportRequired(gate.commonDir, status.legacyImport))
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
    const registration = await gate.register({ instance: storageInstance(), kind: 'mcp', release: manifest.version })
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
  const common = storageGate(commonDir).commonDir, parent = currentAdmission(common)
  if (parent) return fn(parent)
  const { gate, registration } = await storageRegistration(common)
  const ticket = await gate.admit(registration, kind)
  const context: Admission = { commonDir: common, ticket, active: true }
  try { return await ambient.run(context, () => fn(ticket)) }
  finally { context.active = false; await gate.finish(ticket) }
}

/** Reserve a detached callback before returning from its parent, then run/finish it exactly once. */
export async function detachedAdmission(commonDir: string, kind: OperationKind): Promise<{
  run<T>(fn: () => Promise<T>): Promise<T>; finish(): Promise<void>
}> {
  const common = storageGate(commonDir).commonDir, parent = currentAdmission(common)
  const { gate, registration } = await storageRegistration(common)
  const ticket = await gate.admit(registration, kind, { parent })
  const context: Admission = { commonDir: common, ticket, active: true }
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
  const enclosing = reads.getStore()
  if (enclosing?.active && enclosing.commonDir === gate.commonDir) return fn()
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await gate.observe()
    if (before.phase !== 'legacy') throw new StorageRefused('maintenance', 'storage is under maintenance')
    const context = { commonDir: gate.commonDir, active: true }
    let value: T
    try { value = await reads.run(context, fn) }
    finally { context.active = false }
    const after: ReadValidation = await gate.observe()
    if (after.phase !== 'legacy') throw new StorageRefused('maintenance', 'storage is under maintenance')
    if (before.generation === after.generation) return value
  }
  throw new StorageRefused('maintenance', 'storage changed during the read; retry after maintenance')
}

/** Resolve a checkout before its first lifecycle read, keeping admission outside all lifecycle lanes. */
export async function withDirectoryAdmission<T>(dir: string, kind: OperationKind, fn: () => Promise<T>): Promise<T> {
  const { commonGitDirFromDotGit } = await import('@room/roomd')
  return withAdmission(commonGitDirFromDotGit(dir), kind, fn)
}

/** Timers/event callbacks are independent operations, even when installed inside another admission. */
export function withoutAdmission<T>(fn: () => T): T { return ambient.exit(() => reads.exit(fn)) }

/** Parent registers the actual paused helper identity before allowing its OS/Git effects. */
export async function admitStorageHelper(pid: number): Promise<(() => Promise<void>) | undefined> {
  const context = ambient.getStore()
  if (!context?.active) return undefined
  const { probeProcessNow } = await import('@room/local-state/process')
  const identity = probeProcessNow(pid)
  if (!identity?.startTime || !identity.executable) throw new StorageRefused('unavailable', 'preview helper identity is unreadable')
  const gate = storageGate(context.commonDir)
  const instance = { pid, startTime: identity.startTime, executable: identity.executable,
    sessionId: `preview:${pid}`, nonce: randomBytes(16).toString('hex') }
  const registration = await gate.register({ instance, kind: 'helper', release: manifest.version })
  let ticket: Ticket
  try { ticket = await gate.admit(registration, 'preview', { parent: context.ticket }) }
  catch (error) { await gate.unregister(registration); throw error }
  let done = false
  return async () => {
    if (done) return
    await gate.finish(ticket)
    await gate.unregister(registration)
    done = true
  }
}
