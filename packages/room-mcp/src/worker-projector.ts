/**
 * The lead-side writer of its workers' room facts (registry §13): in each room a lead session is in, the
 * views of the workers that joined that room, the coordination of a worker whose host stopped without
 * reporting, and retirement cleanup keyed by worker ID (§12). The bridge does the same for `local` workers
 * projected into the team room. Input is the registry's level-triggered `projectable()`.
 */
import type { Session } from './session.js'
import path from 'node:path'
import { completionMessage, type WorkerView } from '@room/shared'
import { registrySnapshotForDir, type WorkerRegistry } from './worker-registry.js'
import { statusOf, workerView, type WorkerRecord } from './worker-status.js'
import { releasePoster } from './post.js'
import { postWorkerMessage } from './post.js'
import { followUpAnswer, missingClaudeSession, resumeAccepted } from './worker-process.js'

/** Which of the lead's workers a writer in `roomKey` owns: those that joined it, or those projected into it. */
export type ProjectorRole = 'joined' | 'projected'

const inRole = (record: WorkerRecord, roomKey: string, role: ProjectorRole): boolean =>
  role === 'joined' ? record.room === roomKey : record.projectedInto === roomKey

/**
 * One pass over `projectable(lead, roomKey)`: writes views of `write`, retires `retire` and marks that room's
 * cleanup done, and deletes this lead's views whose worker is in neither list. Retiring records are never
 * written, so projection cannot undo retirement (N2). Returns the written records for the caller's own facts.
 */
export async function projectWorkers(s: Session, registry: WorkerRegistry, lead: string, role: ProjectorRole, origin?: unknown): Promise<WorkerRecord[] | undefined> {
  const roomKey = s.roomName, fence = s.daemon.fence
  if (!fence) return undefined
  const { write: all, retire: retiring } = registry.projectable(lead, roomKey)
  const write = all.filter(({ record }) => inRole(record, roomKey, role))
  const retire = retiring.filter(record => inRole(record, roomKey, role))
  const post = releasePoster(s.post)
  const listed = new Set([...write.map(({ record }) => record.id), ...retire.map(record => record.id)])
  s.room.doc.transact(() => {
    for (const { record, status } of write) {
      const run = status.run
      const ended = ['done', 'failed', 'stopped'].includes(status.status)
      const ownsName = s.room.workerOwnsName(record.id, record.name)
      const logFile = path.join(s.dir, '.room', 'workers', `${record.tag}.log`)
      if (ended && ownsName && s.daemon.fence === fence && run?.mode === 'resume' && run.promptMsgIds.length && record.hostSessionId
        && resumeAccepted(logFile, record.host, record.hostSessionId, run.logStart)) {
        const retained = run.promptMsgIds.filter(id => s.room.message(id) || s.room.outcomes.has(id))
        s.room.markSeen(record.name, retained, { s: record.hostSessionId, via: 'prompt' })
      }
      // Older receipts can become orphaned even when this run was not accepted. Only the
      // projector of an ended worker's current incarnation may clean up its ledger.
      if (ended && ownsName) s.room.pruneSeen(record.name,
        () => s.daemon.fence === fence && s.room.workerOwnsName(record.id, record.name))
      const missing = ended && record.host === 'claude' && run?.mode === 'resume' && record.hostSessionId
        && missingClaudeSession(logFile, record.hostSessionId, run.logStart)
      const shown = missing ? { ...status, note: `its retained conversation ${record.hostSessionId} no longer exists; the message stays owed` } : status
      const view = workerView(record, shown, fence)
      if (JSON.stringify(s.room.workerViews.get(record.id)) !== JSON.stringify(view)) s.room.workerViews.set(record.id, view)
      // A host that ended without room_done can no longer act: its claims and scope stop blocking others.
      const stopped = status.status === 'failed' || status.status === 'stopped' || status.noReport === true
      if (stopped && s.room.workerOwnsName(record.id, record.name)
        && (s.room.scopes.has(record.name) || s.room.openClaims().some(c => c.by === record.name))) {
        s.room.clearWorkerCoordination(record.name, 'worker stopped', post)
      }
    }
    for (const [id, view] of s.room.workerViews) {
      if (view.lead !== lead || listed.has(id)) continue
      const known = registry.read(id)
      // A view without a local record is a dead incarnation's; the joined writer removes it.
      if (known ? inRole(known, roomKey, role) : role === 'joined') s.room.workerViews.delete(id)
    }
  }, origin)
  // A completed worker cannot retry its own post. The joined-room projector replays the
  // deterministic ID from durable report/exit evidence after outages and lead restarts.
  const undelivered = new Set<string>()
  if (role === 'joined') for (const { record, status } of [
    ...write, ...retire.flatMap(record => { const status = registry.status(record.id); return status ? [{ record, status }] : [] }),
  ]) {
    const run = status.run ?? record.runs.at(-1)
    if (!run) continue
    const logFile = path.join(s.dir, '.room', 'workers', `${record.tag}.log`)
    const report = registry.reports(record.id).find(value => value.run === run.n)
    const exit = registry.exits(record.id).find(value => value.run === run.n)
    const terminal = record.phase === 'retiring'
      ? statusOf({ ...record, phase: 'active' }, record.runs, registry.reports(record.id), registry.exits(record.id), () => 'dead')
      : status
    try {
      if (report?.done && exit) await registry.postCompletion(record.id, run.n, async (_id, current, done) => {
        const message = completionMessage(current, run, status, done)
        if (message) await postWorkerMessage(s.post, current, message)
      })
      else if (terminal.status === 'done' && run.mode === 'resume' && exit?.witnessed && exit.code === 0
        && registry.reports(record.id).some(value => value.run < run.n && value.done) && !run.posted) {
        const answer = followUpAnswer(logFile, record.host, run.logStart)
        const message = completionMessage(record, run, { ...terminal, summary: answer || terminal.summary })
        if (message) {
          await postWorkerMessage(s.post, record, message)
          await registry.update(record.id, old => ({ ...old, runs: old.runs.map(value => value.n === run.n ? { ...value, posted: message.id } : value), seq: old.seq + 1 }))
        }
      }
      else if (terminal.status === 'failed' || terminal.noReport || record.phase === 'retiring' && !record.stop && !report?.done) {
        const posted = await registry.postObservedFailure(record.id, run.n, message => postWorkerMessage(s.post, record, message))
        if (record.phase === 'retiring' && !record.stop && exit?.witnessed && !posted && !run.posted) undelivered.add(record.id)
      } else if (record.phase === 'retiring' && report?.done && !exit) undelivered.add(record.id)
    } catch { undelivered.add(record.id) }
  }
  for (const record of retire) {
    if (s.daemon.fence !== fence) return undefined
    s.room.retireWorker(record.id, { ...(record.archive ?? registry.archiveOf(record, { summary: '' })), id: record.id }, post)
    if (!undelivered.has(record.id)) await registry.finishCleanup(record.id, roomKey).catch(() => undefined)
  }
  return write.map(({ record }) => record)
}

/** The lead's own view of one of its workers, straight from its registry (room_state's worker lines). */
export function localWorkerView(s: Session, id: string): WorkerView | undefined {
  if (!s.daemon.fence) return undefined
  const registry = registrySnapshotForDir(s.dir)
  const record = registry.read(id), status = registry.status(id)
  return record && status ? workerView(record, status, s.daemon.fence) : undefined
}

/** Keeps a lead session's worker facts in one room current: on start, on every registry change, and on demand. */
export class WorkerProjector {
  private unsubscribe?: () => void
  private onSync = (synced: boolean) => { if (synced) void this.project() }
  private onBusDelete = (event: { changes: { delta: { delete?: number }[] } }) => {
    if (event.changes.delta.some(change => change.delete)) void this.project()
  }
  private onReferenceDelete = (event: { changes: { keys: Map<string, { action: string }> } }) => {
    if ([...event.changes.keys.values()].some(change => change.action === 'delete')) void this.project()
  }
  private running?: Promise<void>
  private dirty = false
  private stopped = false

  constructor(private s: Session, private registry: WorkerRegistry, private log: (line: string) => void = () => {}) {}

  start(): void {
    this.unsubscribe = this.registry.onChange(() => { void this.project() })
    this.s.provider.on?.('sync', this.onSync)
    this.s.room.bus.observe(this.onBusDelete)
    this.s.room.mail.observe(this.onReferenceDelete)
    this.s.room.outcomes.observe(this.onReferenceDelete)
    void this.project()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.s.provider.off?.('sync', this.onSync)
    this.s.room.bus.unobserve(this.onBusDelete)
    this.s.room.mail.unobserve(this.onReferenceDelete)
    this.s.room.outcomes.unobserve(this.onReferenceDelete)
  }

  /** A request waits for a pass started after that request; concurrent requests share the next pass. */
  project(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.dirty = true
    if (!this.running) this.running = Promise.resolve().then(() => this.drain())
    return this.running
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty && !this.stopped) {
        this.dirty = false
        // projectWorkers reads the current registry and checks the current fence on each pass.
        // Changes arriving during an awaited pass request just one follow-up pass.
        try { await projectWorkers(this.s, this.registry, this.s.me.name, 'joined', this) }
        catch (e) { this.log(`worker projector (${this.s.roomName}): ${e instanceof Error ? e.message : String(e)}`) }
      }
    } finally {
      this.running = undefined
    }
  }
}
