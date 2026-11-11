/** Storage-neutral lifecycle facts and serializable, named record commands. */
import type { PrepJournal, PrepStep, Run, RunReport, ExitObservation, WorkerRecord } from './worker-status.js'
import type { Liveness, ProcessIdentity } from './leases.js'

/**
 * A record whose lifecycle is over. Only an unended borrower needs its owner's record: retention (pruneRetired)
 * and the inventory's owner check (#list) both decide by this one rule.
 */
export const ended = (record: WorkerRecord): boolean => record.phase === 'retired' || record.phase === 'abandoned'

export interface WorkerQuery {
  workerId?: string; tag?: string
  /** Record projection (all records if no selector): omit run/lease evidence and conservatively mark busy. */
  recordOnly?: boolean
  /** Capture status probes before the snapshot's final revision check. */
  captureLiveness?: boolean
}
export interface WorkerFacts {
  record: WorkerRecord; reports: RunReport[]; exits: ExitObservation[]; busy: boolean
  liveness?: { identity: ProcessIdentity; state: Liveness }[]
}
export type WorkerSnapshot =
  | { available: true; revision: string; workers: WorkerFacts[]; reservations: Record<string, string>; blockers: string[]; operations?: string[]; orphanRuns?: Record<string, { reports: RunReport[]; exits: ExitObservation[] }> }
  | { available: false; reason: 'unavailable'; detail: string }
export type AvailableWorkerSnapshot = Extract<WorkerSnapshot, { available: true }>
/** Unknown lifecycle evidence cannot authorize a destructive or capacity decision. */
export interface BlockedWorkerEvidence { reason: 'blocked'; blockers: string[] }
export class WorkerEvidenceBlocked extends Error {
  readonly reason = 'blocked'
  constructor(readonly blockers: string[]) { super(`worker evidence blocked: ${blockers.join('; ')}`) }
}
/** Operation boundaries report the blocker without proceeding with an empty result. */
export function requireWorkerEvidence<T>(result: T | BlockedWorkerEvidence): T {
  if (result && typeof result === 'object' && 'reason' in result && result.reason === 'blocked')
    throw new WorkerEvidenceBlocked((result as BlockedWorkerEvidence).blockers)
  return result as T
}
export function workerEvidence(snapshot: WorkerSnapshot): AvailableWorkerSnapshot | BlockedWorkerEvidence {
  if (!snapshot.available) throw new Error(`worker snapshot unavailable: ${snapshot.detail}`)
  return snapshot.blockers.length ? { reason: 'blocked', blockers: snapshot.blockers } : snapshot
}
/** Inventory completeness travels with the records, including valid records beside damaged evidence. */
export interface WorkerInventory<T> { records: T[]; blockers: string[] }
/** Consequential consumers must explicitly reject incomplete inventories. */
export function requireWorkerInventory<T>(inventory: WorkerInventory<T>): T[] {
  if (inventory.blockers.length) throw new WorkerEvidenceBlocked(inventory.blockers)
  return inventory.records
}
export interface WorkerFreshness {
  id: string; name: string; lead: string; dir: string; reported: 'done' | 'exited' | 'none'
  run: string; seq: number; busy: boolean; revision: string
}
export type WorkerCommand =
  | { type: 'prepare-start' }
  | { type: 'prepare-step'; step: PrepStep; facts: Partial<PrepJournal> }
  | { type: 'prepare-finish'; facts: Partial<Pick<WorkerRecord, 'base' | 'carriedBase' | 'carriedUntracked' | 'skippedCarry' | 'keptPublication'>>; created: boolean; branchCreated?: boolean }
  | { type: 'launch'; run: number; nonce?: string; launch: Run['launch']; phase?: WorkerRecord['phase']; port?: number; nice?: number; link?: string[]; hostSessionId?: string }
  | { type: 'activate' }
  | { type: 'run-prompts'; run: number; promptMsgIds: string[] }
  | { type: 'run-posted'; run: number; messageId: string }
  | { type: 'collect-keep'; base: string; keptPublication?: WorkerRecord['keptPublication'] }
  | { type: 'kept-publication'; expectedBase?: string; publication: WorkerRecord['keptPublication'] }
  | { type: 'rebase'; expectedBase?: string; base?: string; collectedKeep?: boolean; carriedBase?: string; carriedUntracked?: WorkerRecord['carriedUntracked']; keptPublication?: WorkerRecord['keptPublication'] }
  | { type: 'retired-checkout-kept'; dir: string; reason: string }
  | { type: 'retired-checkout-removed' }

/** A command is reduced under the storage implementation's existing seq/lease guard. No effects here. */
export function applyWorkerCommand(old: WorkerRecord, command: WorkerCommand): WorkerRecord {
  const next = { ...old, seq: old.seq + 1 }
  switch (command.type) {
    case 'prepare-start': return { ...next, phase: 'preparing' }
    case 'prepare-step': return { ...next, prep: { ...old.prep, ...command.facts, step: command.step } }
    case 'prepare-finish': return { ...next, ...command.facts, phase: 'prepared', prep: { ...old.prep,
      step: 'prepared', created: command.created, branchCreated: command.branchCreated,
      branchExisted: old.prep.branchExisted ?? (command.branchCreated ? false : undefined) } }
    case 'activate': return { ...next, phase: 'active' }
    case 'launch': {
      const run = old.runs.at(-1)
      if (!run || run.n !== command.run || command.nonce !== undefined && run.nonce !== command.nonce) throw new Error('worker run changed')
      return { ...next, ...(command.phase ? { phase: command.phase } : {}),
        ...('port' in command ? { port: command.port } : {}), ...('hostSessionId' in command ? { hostSessionId: command.hostSessionId } : {}),
        ...(command.nice !== undefined ? { budget: { ...old.budget, nice: command.nice } } : {}), ...('link' in command ? { link: command.link } : {}),
        runs: old.runs.map(value => value.n === command.run ? { ...value, launch: command.launch } : value) }
    }
    case 'run-prompts':
      if (old.runs.at(-1)?.n !== command.run) throw new Error('worker run changed')
      return { ...next, runs: old.runs.map(value => value.n === command.run ? { ...value, promptMsgIds: command.promptMsgIds } : value) }
    case 'run-posted':
      if (!old.runs.some(run => run.n === command.run)) throw new Error('worker run missing')
      return { ...next, runs: old.runs.map(value => value.n === command.run ? { ...value, posted: command.messageId } : value) }
    case 'collect-keep': return { ...next, base: command.base, collectedKeep: true, carriedBase: undefined,
      carriedUntracked: undefined, collectPending: undefined, phase: 'active',
      keptPublication: command.keptPublication && { ...command.keptPublication, base: command.base } }
    case 'kept-publication':
      if (old.base !== command.expectedBase) throw new Error('worker base changed')
      return { ...next, keptPublication: command.publication }
    case 'rebase':
      if (old.base !== command.expectedBase) throw new Error('worker base changed')
      return { ...next, base: command.base, collectedKeep: old.collectedKeep || command.collectedKeep || undefined,
        carriedBase: command.carriedBase, carriedUntracked: command.carriedUntracked, keptPublication: command.keptPublication }
    case 'retired-checkout-kept': return { ...next, keptWorktree: command.dir,
      archive: { ...old.archive!, keptWorktree: command.dir, keptReason: command.reason } }
    case 'retired-checkout-removed': {
      const { keptWorktree: _kept, keptReason: _reason, ...archive } = old.archive ?? {}
      return { ...next, keptWorktree: undefined, archive: archive as WorkerRecord['archive'] }
    }
  }
}

/** Minimal snapshot/mutation boundary; the online file adapter is the sole implementation in slice 1. */
export interface WorkerStore {
  snapshot(query?: WorkerQuery): Promise<WorkerSnapshot>
  command(id: string, command: WorkerCommand, expectedSeq?: number): Promise<WorkerRecord>
}

import { statusOf, type LivenessProbe, type WorkerStatusResult } from './worker-status.js'
/** Reducer branches whose answer is complete without run reports, exits or log enrichment. */
export function recordStatus(fact: WorkerFacts): WorkerStatusResult | undefined {
  const { record } = fact
  const ordered = [...record.runs].sort((a, b) => a.n - b.n)
  let index = ordered.length - 1
  while (ordered[index]?.mode === 'resume' && ordered[index]?.launch?.outcome === 'never') index--
  if (!['retired', 'abandoned', 'collecting', 'discarding', 'retiring'].includes(record.phase)
    && ordered[index]?.launch?.outcome === 'launched') return undefined
  return statusOf(record, record.runs, [], [], identity => fact.liveness?.find(probe =>
    probe.identity.pid === identity.pid && probe.identity.startTime === identity.startTime
    && probe.identity.executable === identity.executable)?.state ?? 'unknown')
}

export const snapshotRead = (snapshot: WorkerSnapshot, id: string): WorkerRecord | undefined =>
  requireWorkerEvidence(workerEvidence(snapshot)).workers.find(fact => fact.record.id === id)?.record
export function snapshotReserved(snapshot: WorkerSnapshot, tag: string): WorkerRecord | undefined {
  const facts = requireWorkerEvidence(workerEvidence(snapshot))
  const record = snapshotRead(facts, facts.reservations[tag])
  return record?.tag === tag ? record : undefined
}
export function snapshotFreshness(snapshot: WorkerSnapshot, id: string): WorkerFreshness | undefined {
  const fact = requireWorkerEvidence(workerEvidence(snapshot)).workers.find(fact => fact.record.id === id)
  if (!fact || !snapshot.available) return undefined
  const { record, reports, exits, busy } = fact, run = record.runs.at(-1)
  const reported = run && reports.some(report => report.run === run.n && report.nonce === run.nonce && !!report.done)
    ? 'done' : run && exits.some(exit => exit.run === run.n) ? 'exited' : 'none'
  return { id: record.id, name: record.name, lead: record.lead.participant, dir: record.dir, reported,
    run: run ? `${run.n}:${run.nonce}` : '', seq: record.seq, busy, revision: snapshot.revision }
}
export function snapshotStatus(snapshot: WorkerSnapshot, id: string, alive: LivenessProbe = () => 'unknown', nowMs?: number): WorkerStatusResult | undefined {
  const fact = requireWorkerEvidence(workerEvidence(snapshot)).workers.find(fact => fact.record.id === id)
  return fact && statusOf(fact.record, fact.record.runs, fact.reports, fact.exits, alive, nowMs)
}
