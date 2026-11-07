import type { HostId } from './hosts/types.js'
import { workerEnvironmentSession, registryEnvironmentSession } from './hosts/selection.js'
/** Async lifecycle facade. A display snapshot never grants operation authority. */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { commonGitDirFromDotGit, gitCommonDir } from '@room/roomd'
import { workerBaseline, type Baseline, type BaselineSource } from '@room/roomd/baseline'
import { FileWorkerStore, type RegistryOptions } from './worker-file-store.js'
import { probeOwnProcess, probeProcessNow } from './worker-process.js'
import { statusOf, realStateInput, type LocalWorker, type WorkerRecord, type WorkerStatusResult } from './worker-status.js'
import type { InstanceToken, ProcessIdentity } from './leases.js'
import type { RetiredWorker } from '@room/shared'
import { safeId, safeTag } from './worker-codecs.js'
import { requireWorkerInventory, type WorkerInventory, requireWorkerEvidence, workerEvidence, type BlockedWorkerEvidence, recordStatus, snapshotRead, snapshotReserved, snapshotFreshness, type WorkerQuery, type WorkerStore, type WorkerSnapshot, type AvailableWorkerSnapshot, type WorkerFacts, type WorkerCommand, type WorkerFreshness } from './worker-store.js'
import { IdleClaimsJournal } from './idle-claims.js'
export type { RegistryOptions, LegacySource } from './worker-file-store.js'
export type { IdleClaimsAction } from './idle-claims.js'
export { workerLogFile, backgroundAtExit } from './worker-file-store.js'
export type { WorkerSnapshot, WorkerCommand, WorkerFreshness, WorkerStore } from './worker-store.js'
const registries = new Map<string, Promise<WorkerRegistry>>()
const MAX_PROCESS_REGISTRIES = 24
export async function closeRegistryForDir(dir: string): Promise<void> {
  const common = commonGitDirFromDotGit(dir)
  const pending = registries.get(common)
  registries.delete(common)
  ;(await pending?.catch(() => undefined))?.close()
}
/** One token and watcher per common dir for this MCP process. */
export async function registryForDir(dir: string, sessionId?: string): Promise<WorkerRegistry> {
  const common = await gitCommonDir(dir)
  // The registry writes under <common>/room; a Git directory always holds HEAD. Anything else (a
  // resolution that landed on the working tree) must not be written to.
  if (!fs.existsSync(path.join(common, 'HEAD'))) throw new Error(`worker registry: ${common} is not a Git directory (no HEAD); not writing room/registry there`)
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
    const processInfo = probeOwnProcess()
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

/** A read-only view has no mutation or lease methods, even at runtime. */
export type WorkerReader = Pick<WorkerRegistry, 'root' | 'commonDir' | 'close' | 'snapshot' | 'read' | 'list' | 'reserved'
  | 'reservedByTagOrName' | 'sourceToken' | 'worktreeOwner' | 'checkoutUsers' | 'status' | 'operationInProgress'
  | 'freshness' | 'statusFromSnapshot' | 'reports' | 'exits' | 'occupancy' | 'projectable' | 'archiveOf'>
export async function openWorkerReader(dir: string): Promise<WorkerReader> {
  const common = commonGitDirFromDotGit(dir)
  return WorkerRegistry.openReader(common)
}

/** Called before roomd publishes a worker's identity or files. */
/** The worker this process was admitted as, with the host identity admission recorded; undefined until then. */
let admitted: { id: string; host: ProcessIdentity } | undefined
export function admittedWorker(): { id: string; host: ProcessIdentity } | undefined { return admitted }

/** Admit this process as its environment's worker run. A refused admission withdraws any earlier one, so a
 *  collected or superseded run no longer vouches for its worker in the daemon-client marker. */
export async function admitWorkerEnvironment(dir: string, env: NodeJS.ProcessEnv = process.env,
  bound?: Parameters<typeof admitOnce>[2]): Promise<void> {
  try { await admitOnce(dir, env, bound) } catch (error) { admitted = undefined; throw error }
}

async function admitOnce(dir: string, env: NodeJS.ProcessEnv = process.env,
  bound?: { id: string; host: HostId }): Promise<void> {
  const id = env.ROOM_WORKER_ID
  if (!id) return
  const room = env.ROOM_ROOM ?? ''
  if (!id.startsWith('w_')) throw new Error('this worker runs Room 0.17 but its lead runs an older Room: update the Room plugin for the lead\'s host')
  const run = Number(env.ROOM_WORKER_RUN), nonce = env.ROOM_LAUNCH_NONCE
  if (!Number.isSafeInteger(run) || run < 1 || !nonce) throw new Error('this worker run was collected, discarded or superseded')
  const registry = await registryForDir(dir, registryEnvironmentSession(env))
  const record = await registry.read(id)
  if (!room || record?.room !== room) throw new Error('this worker run was collected, discarded or superseded')
  if (bound && bound.host !== record.host) throw new Error('worker host session mismatch')
  const hostSessionId = bound?.id ?? workerEnvironmentSession(record.host, env)
  if (env.ROOM_REGISTRY && fs.realpathSync(path.resolve(env.ROOM_REGISTRY)) !== fs.realpathSync(registry.root)) throw new Error('this worker run was collected, discarded or superseded')
  // The parent is recorded as this worker's host process: read it definitively, once per admission.
  const processInfo = probeOwnProcess()
  const parentInfo = probeProcessNow(process.ppid)
  const chain = [{ pid: process.pid, startTime: processInfo?.startTime ?? '', executable: processInfo?.executable ?? '' },
    ...(parentInfo ? [{ pid: process.ppid, startTime: parentInfo.startTime ?? '', executable: parentInfo.executable ?? '' }] : [])]
  try { await registry.admit({ id, run, nonce, dir, chain, hostProcess: chain[1] ?? null,
    hostSessionId }) }
  catch { throw new Error('this worker run was collected, discarded or superseded') }
  if (chain[1]?.startTime && chain[1].executable) admitted = { id, host: chain[1] }
}
/**
 * This clone's current worker under a participant name, as a carried-baseline source with its lead: a local
 * fact from the registry (registry §14), for merge bases and carried-work checks, never from the room.
 * A worker is named `<owner>+<tag>`, and a record that is neither retired nor abandoned holds its tag's
 * reservation, so one reservation and one record answer it without listing every record.
 */
export async function localWorkerBaseline(dir: string, participant: string): Promise<(BaselineSource & { lead: string }) | undefined> {
  const plus = participant.lastIndexOf('+')
  if (plus < 1) return undefined
  let record = await (await openWorkerReader(dir)).reserved(participant.slice(plus + 1))
  if (record && (record.name !== participant || ['retired', 'abandoned'].includes(record.phase))) record = undefined
  return record && { name: record.name, dir: record.dir, base: record.base, carriedBase: record.carriedBase,
    carriedUntracked: record.carriedUntracked, link: record.link, lead: record.lead.participant }
}

/** A lead's workers that are not retiring, by name: the wake path's own-worker set (registry §14). No process probes. */
export async function ownWorkerNames(dir: string, lead: string): Promise<Set<string>> {
  return new Set(requireWorkerInventory(await (await openWorkerReader(dir)).list())
    .filter(r => r.lead.participant === lead && !['retiring', 'retired', 'abandoned'].includes(r.phase)).map(r => r.name))
}

/** This clone's workers that are not retiring, as the lifecycle helpers' input (registry §1: local facts only). */
export async function localWorkers(dir: string, keep: (record: WorkerRecord) => boolean = () => true): Promise<LocalWorker[]> {
  const registry = await openWorkerReader(dir)
  const records = requireWorkerInventory(await registry.list())
  const workers: LocalWorker[] = []
  for (const record of records) {
    if (['retiring', 'retired', 'abandoned'].includes(record.phase) || !keep(record)) continue
    const status = await registry.status(record.id)
    if (status) workers.push(realStateInput(record, status))
  }
  return workers
}

/** A participant's carried baseline and its lead, when it is one of this clone's workers (ConflictSet's `carriedFrom`). */
export async function carriedFrom(dir: string, participant: string): Promise<{ baseline: Baseline; lead: string } | undefined> {
  const source = await localWorkerBaseline(dir, participant)
  const baseline = workerBaseline(source)
  return source && baseline ? { baseline, lead: source.lead } : undefined
}
/**
 * A freshness token for `carriedFrom(dir, participant)`: the revision of its consistent lifecycle fact snapshot.
 * Callers compare opaque tokens rather than relying on file metadata.
 */
export async function carriedSourceToken(dir: string, participant: string): Promise<string> {
  const plus = participant.lastIndexOf('+')
  if (plus < 1) return ''
  try { return await (await openWorkerReader(dir)).sourceToken(participant.slice(plus + 1)) } catch (error) { return `unavailable:${String(error)}` }
}

/** A worker daemon's carried baseline, read from its lead's registry record (F2): the room never supplies it. */
export async function workerCarried(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<WorkerRecord | undefined> {
  const id = env.ROOM_WORKER_ID
  if (!id || !safeId(id)) return undefined
  return (await openWorkerReader(dir)).read(id)
}

export class WorkerRegistry {
  private constructor(private readonly store: WorkerStore, private readonly file?: FileWorkerStore) {}
  static async open(commonDir: string, options: RegistryOptions = {}): Promise<WorkerRegistry> {
    const file = await FileWorkerStore.open(commonDir, options)
    return new WorkerRegistry(file, file)
  }
  static async openReader(commonDir: string, options: RegistryOptions = {}): Promise<WorkerReader> {
    const file = await FileWorkerStore.openReader(commonDir, options)
    const registry = new WorkerRegistry(file, file)
    return {
      root: registry.root, commonDir: registry.commonDir,
      close: () => registry.close(), snapshot: query => registry.snapshot(query),
      read: id => registry.read(id), list: () => registry.list(), reserved: tag => registry.reserved(tag),
      reservedByTagOrName: name => registry.reservedByTagOrName(name), sourceToken: tag => registry.sourceToken(tag),
      worktreeOwner: record => registry.worktreeOwner(record), checkoutUsers: owner => registry.checkoutUsers(owner),
      status: id => registry.status(id), statusFromSnapshot: (snapshot, id) => registry.statusFromSnapshot(snapshot, id), operationInProgress: id => registry.operationInProgress(id),
      freshness: id => registry.freshness(id), reports: id => registry.reports(id), exits: id => registry.exits(id),
      occupancy: () => registry.occupancy(), projectable: (lead, room) => registry.projectable(lead, room),
      archiveOf: (record, facts) => registry.archiveOf(record, facts),
    }
  }
  /** Inject a delayed/unavailable service without granting a synchronous file escape hatch. */
  static fromStore(store: WorkerStore): WorkerRegistry { return new WorkerRegistry(store) }
  private backend(): FileWorkerStore {
    if (!this.file) throw new Error('worker lifecycle effects unavailable for snapshot-only store')
    return this.file
  }
  get root(): string { return this.backend().root }
  get commonDir(): string { return this.backend().commonDir }
  get instance(): InstanceToken { return this.backend().instance }
  newId(): string { return this.backend().newId() }
  close(): void { this.file?.close() }
  onChange(listener: (id?: string) => void): () => void { return this.backend().onChange(listener) }
  snapshot(query?: WorkerQuery): Promise<WorkerSnapshot> { return this.store.snapshot(query) }
  private async facts(query?: WorkerQuery): Promise<AvailableWorkerSnapshot> {
    return requireWorkerEvidence(workerEvidence(await this.snapshot(query)))
  }
  command(id: string, command: WorkerCommand, expectedSeq?: number): Promise<WorkerRecord> { return this.store.command(id, command, expectedSeq) }
  async read(id: string): Promise<WorkerRecord | undefined> {
    if (!safeId(id)) throw new Error('invalid worker id')
    return snapshotRead(await this.facts({ workerId: id, recordOnly: true }), id)
  }
  async list(): Promise<WorkerInventory<WorkerRecord>> {
    const snapshot = await this.snapshot({ recordOnly: true })
    if (!snapshot.available) throw new Error(`worker snapshot unavailable: ${snapshot.detail}`)
    return { records: snapshot.workers.map(fact => fact.record), blockers: snapshot.blockers }
  }
  async reserved(tag: string): Promise<WorkerRecord | undefined> { return safeTag(tag) ? snapshotReserved(await this.facts({ tag, recordOnly: true }), tag) : undefined }
  async sourceToken(tag: string): Promise<string> { return safeTag(tag) ? (await this.facts({ tag, recordOnly: true })).revision : '' }
  async reservedByTagOrName(tagOrName: string): Promise<WorkerRecord | undefined> {
    const snapshot = await this.facts()
    return snapshotReserved(snapshot, tagOrName) ?? snapshot.workers.find(({ record }) => record.name === tagOrName && snapshot.reservations[record.tag] === record.id)?.record
  }
  async worktreeOwner(record: WorkerRecord): Promise<WorkerRecord | undefined> {
    const snapshot = await this.facts()
    if (record.sharedWith) return snapshotRead(snapshot, record.sharedWith)
    if (path.basename(record.dir) === record.tag && record.branch === `room/${record.tag}`) return undefined
    return snapshot.workers.find(({ record: peer }) => peer.id !== record.id && !peer.sharedWith && path.resolve(peer.dir) === path.resolve(record.dir)
      && path.basename(peer.dir) === peer.tag && peer.branch === `room/${peer.tag}`)?.record
  }
  private enrich(fact: WorkerFacts): Promise<WorkerStatusResult> {
    return this.file ? this.file.enrichedStatus(fact)
      : Promise.resolve(statusOf(fact.record, fact.record.runs, fact.reports, fact.exits, () => 'unknown'))
  }
  async checkoutUsers(owner: Pick<WorkerRecord, 'id' | 'dir'>): Promise<{ record: WorkerRecord; status: WorkerStatusResult }[] | BlockedWorkerEvidence> {
    const snapshot = workerEvidence(await this.snapshot())
    if ('reason' in snapshot) return snapshot
    const users: { record: WorkerRecord; status: WorkerStatusResult }[] = []
    for (const fact of snapshot.workers) {
      const record = fact.record
      if (record.id !== owner.id && !['retiring', 'retired', 'abandoned'].includes(record.phase) && path.resolve(record.dir) === path.resolve(owner.dir))
        users.push({ record, status: await this.enrich(fact) })
    }
    return users
  }
  /** Enrich captured lifecycle facts without replacing their records/reports/exits with live reads. */
  async statusFromSnapshot(snapshot: WorkerSnapshot, id: string): Promise<WorkerStatusResult | undefined> {
    const fact = requireWorkerEvidence(workerEvidence(snapshot)).workers.find(fact => fact.record.id === id)
    return fact && this.enrich(fact)
  }
  async status(id: string): Promise<WorkerStatusResult | undefined> {
    const records = await this.facts({ workerId: id, recordOnly: true, captureLiveness: true })
    const record = records.workers.find(fact => fact.record.id === id)
    if (!record) return undefined
    const immediate = recordStatus(record)
    if (immediate) return immediate
    let snapshot = await this.facts({ workerId: id })
    for (let attempt = 0; attempt < 3; attempt++) {
      const fact = snapshot.workers.find(fact => fact.record.id === id)
      if (!fact) return undefined
      const status = await this.enrich(fact)
      const fresh = await this.facts({ workerId: id })
      if (fresh.revision === snapshot.revision) return status
      snapshot = fresh
    }
    throw new Error('worker snapshot unavailable: facts changed during status enrichment')
  }
  async operationInProgress(id: string): Promise<boolean> {
    if (!safeId(id)) return true
    const snapshot = await this.facts({ workerId: id })
    return snapshot.operations?.includes(id) || snapshot.workers.find(fact => fact.record.id === id)?.busy || false
  }
  async freshness(id: string): Promise<WorkerFreshness | undefined> {
    return safeId(id) ? snapshotFreshness(await this.facts({ workerId: id }), id) : undefined
  }
  async reports(id: string): Promise<import('./worker-status.js').RunReport[]> {
    if (!safeId(id)) throw new Error('invalid worker id')
    const snapshot = await this.facts({ workerId: id })
    return snapshot.workers.find(fact => fact.record.id === id)?.reports ?? snapshot.orphanRuns?.[id]?.reports ?? []
  }
  async exits(id: string): Promise<import('./worker-status.js').ExitObservation[]> {
    if (!safeId(id)) throw new Error('invalid worker id')
    const snapshot = await this.facts({ workerId: id })
    return snapshot.workers.find(fact => fact.record.id === id)?.exits ?? snapshot.orphanRuns?.[id]?.exits ?? []
  }
  async occupancy(): Promise<number> {
    let count = 0
    for (const fact of (await this.facts()).workers) if (['starting', 'running', 'unknown', 'ambiguous'].includes((await this.enrich(fact)).status)) count++
    return count
  }
  async projectable(lead: string, roomKey: string): Promise<{ write: { record: WorkerRecord; status: WorkerStatusResult }[]; retire: WorkerRecord[] } | BlockedWorkerEvidence> {
    const snapshot = workerEvidence(await this.snapshot())
    if ('reason' in snapshot) return snapshot
    const write: { record: WorkerRecord; status: WorkerStatusResult }[] = [], retire: WorkerRecord[] = []
    for (const fact of snapshot.workers) {
      const record = fact.record
      if (record.lead.participant !== lead || record.room !== roomKey && record.projectedInto !== roomKey) continue
      if (record.phase === 'retiring') { if (record.cleanup?.[roomKey] === 'pending') retire.push(record); continue }
      if (record.phase === 'retired' || record.phase === 'abandoned') continue
      write.push({ record, status: await this.enrich(fact) })
    }
    return { write, retire }
  }
  async archiveOf(record: WorkerRecord, facts: Partial<RetiredWorker> & Pick<RetiredWorker, 'summary'>): Promise<RetiredWorker> { return this.backend().archiveOf(record, facts) }
  hasPendingIdleClaims(roomKey: string, sessionId: string, idleEpoch: string): boolean { return IdleClaimsJournal.open(this.commonDir).hasPendingIdleClaims(roomKey, sessionId, idleEpoch) }
  reconcileIdleClaims(action: import('./idle-claims.js').IdleClaimsAction): Promise<boolean> { return IdleClaimsJournal.open(this.commonDir).reconcileIdleClaims(action) }
  trusted(...args: Parameters<FileWorkerStore['trusted']>): ReturnType<FileWorkerStore['trusted']> { return this.backend().trusted(...args) }
  writeIntent(...args: Parameters<FileWorkerStore['writeIntent']>): ReturnType<FileWorkerStore['writeIntent']> { return this.backend().writeIntent(...args) }
  finishOperation(...args: Parameters<FileWorkerStore['finishOperation']>): ReturnType<FileWorkerStore['finishOperation']> { return this.backend().finishOperation(...args) }
  beginOperation(...args: Parameters<FileWorkerStore['beginOperation']>): ReturnType<FileWorkerStore['beginOperation']> { return this.backend().beginOperation(...args) }
  withCollectLease<T>(worktree: string, work: () => Promise<T>): Promise<T> { return this.backend().withCollectLease(worktree, work) }
  resume(...args: Parameters<FileWorkerStore['resume']>): ReturnType<FileWorkerStore['resume']> { return this.backend().resume(...args) }
  admit(...args: Parameters<FileWorkerStore['admit']>): ReturnType<FileWorkerStore['admit']> { return this.backend().admit(...args) }
  reportDone(...args: Parameters<FileWorkerStore['reportDone']>): ReturnType<FileWorkerStore['reportDone']> { return this.backend().reportDone(...args) }
  postCompletion(...args: Parameters<FileWorkerStore['postCompletion']>): ReturnType<FileWorkerStore['postCompletion']> { return this.backend().postCompletion(...args) }
  postObservedFailure(...args: Parameters<FileWorkerStore['postObservedFailure']>): ReturnType<FileWorkerStore['postObservedFailure']> { return this.backend().postObservedFailure(...args) }
  beginStop(...args: Parameters<FileWorkerStore['beginStop']>): ReturnType<FileWorkerStore['beginStop']> { return this.backend().beginStop(...args) }
  beginCollect(...args: Parameters<FileWorkerStore['beginCollect']>): ReturnType<FileWorkerStore['beginCollect']> { return this.backend().beginCollect(...args) }
  abortCollect(...args: Parameters<FileWorkerStore['abortCollect']>): ReturnType<FileWorkerStore['abortCollect']> { return this.backend().abortCollect(...args) }
  deferCollectCleanup(...args: Parameters<FileWorkerStore['deferCollectCleanup']>): ReturnType<FileWorkerStore['deferCollectCleanup']> { return this.backend().deferCollectCleanup(...args) }
  beginRetirement(...args: Parameters<FileWorkerStore['beginRetirement']>): ReturnType<FileWorkerStore['beginRetirement']> { return this.backend().beginRetirement(...args) }
  pruneRetired(...args: Parameters<FileWorkerStore['pruneRetired']>): ReturnType<FileWorkerStore['pruneRetired']> { return this.backend().pruneRetired(...args) }
  finishCleanup(...args: Parameters<FileWorkerStore['finishCleanup']>): ReturnType<FileWorkerStore['finishCleanup']> { return this.backend().finishCleanup(...args) }
  beginDiscard(...args: Parameters<FileWorkerStore['beginDiscard']>): ReturnType<FileWorkerStore['beginDiscard']> { return this.backend().beginDiscard(...args) }
  markDiscardStep(...args: Parameters<FileWorkerStore['markDiscardStep']>): ReturnType<FileWorkerStore['markDiscardStep']> { return this.backend().markDiscardStep(...args) }
  interruptDiscard(...args: Parameters<FileWorkerStore['interruptDiscard']>): ReturnType<FileWorkerStore['interruptDiscard']> { return this.backend().interruptDiscard(...args) }
  recordDiscardPatch(...args: Parameters<FileWorkerStore['recordDiscardPatch']>): ReturnType<FileWorkerStore['recordDiscardPatch']> { return this.backend().recordDiscardPatch(...args) }
  replayDiscard(id: string): Promise<void> { return this.backend().replayDiscard(id, (workerId, bytes) => this.recordDiscardPatch(workerId, bytes)) }
  writeReport(...args: Parameters<FileWorkerStore['writeReport']>): ReturnType<FileWorkerStore['writeReport']> { return this.backend().writeReport(...args) }
  writeExit(...args: Parameters<FileWorkerStore['writeExit']>): ReturnType<FileWorkerStore['writeExit']> { return this.backend().writeExit(...args) }
  abandonPreparation(...args: Parameters<FileWorkerStore['abandonPreparation']>): ReturnType<FileWorkerStore['abandonPreparation']> { return this.backend().abandonPreparation(...args) }
  reconcile(...args: Parameters<FileWorkerStore['reconcile']>): ReturnType<FileWorkerStore['reconcile']> { return this.backend().reconcile(...args) }
}
