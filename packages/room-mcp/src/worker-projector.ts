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
import { workerView, type WorkerRecord } from './worker-status.js'
import { releasePoster } from './post.js'
import { postWorkerMessage } from './post.js'
import { missingClaudeSession, resumeAccepted } from './worker-process.js'

/** Which of the lead's workers a writer in `roomKey` owns: those that joined it, or those projected into it. */
export type ProjectorRole = 'joined' | 'projected'

const inRole = (record: WorkerRecord, roomKey: string, role: ProjectorRole): boolean =>
  role === 'joined' ? record.room === roomKey : record.projectedInto === roomKey

/**
 * One pass over `projectable(lead, roomKey)`: writes views of `write`, retires `retire` and marks that room's
 * cleanup done, and deletes this lead's views whose worker is in neither list. Retiring records are never
 * written, so projection cannot undo retirement (N2). Returns the written records for the caller's own facts.
 */
export async function projectWorkers(s: Session, registry: WorkerRegistry, lead: string, role: ProjectorRole, origin?: unknown): Promise<WorkerRecord[]> {
  const roomKey = s.roomName, fence = s.daemon.fence
  if (!fence) return []
  const { write: all, retire: retiring } = registry.projectable(lead, roomKey)
  const write = all.filter(({ record }) => inRole(record, roomKey, role))
  const retire = retiring.filter(record => inRole(record, roomKey, role))
  const post = releasePoster(s.post)
  const listed = new Set([...write.map(({ record }) => record.id), ...retire.map(record => record.id)])
  s.room.doc.transact(() => {
    for (const { record, status } of write) {
      const run = status.run
      const ended = ['done', 'failed', 'stopped'].includes(status.status)
      const logFile = path.join(s.dir, '.room', 'workers', `${record.tag}.log`)
      if (ended && run?.mode === 'resume' && run.promptMsgIds.length && record.hostSessionId
        && resumeAccepted(logFile, record.host, record.hostSessionId, run.logStart)) {
        s.room.markSeen(record.name, run.promptMsgIds, { s: record.hostSessionId, via: 'prompt' })
      }
      const missing = ended && record.host === 'claude' && run?.mode === 'resume' && record.hostSessionId
        && missingClaudeSession(logFile, record.hostSessionId, run.logStart)
      const shown = missing ? { ...status, note: `its retained conversation ${record.hostSessionId} no longer exists; the message stays owed` } : status
      const view = workerView(record, shown, fence)
      if (JSON.stringify(s.room.workerViews.get(record.id)) !== JSON.stringify(view)) s.room.workerViews.set(record.id, view)
      // A host that ended without room_done can no longer act: its claims and scope stop blocking others.
      const stopped = status.status === 'failed' || status.status === 'stopped'
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
  if (role === 'joined') for (const { record, status } of [
    ...write, ...retire.flatMap(record => { const status = registry.status(record.id); return status ? [{ record, status }] : [] }),
  ]) {
    const run = status.run ?? record.runs.at(-1)
    if (!run) continue
    const report = registry.reports(record.id).find(value => value.run === run.n)
    try {
      if (report?.done && registry.exits(record.id).some(exit => exit.run === run.n)) await registry.postCompletion(record.id, run.n, async (_id, current, done) => {
        const message = completionMessage(current, run, status, done)
        if (message) await postWorkerMessage(s.post, current, message)
      })
      else if (status.status === 'failed' || record.phase === 'retiring' && !record.stop) await registry.postObservedFailure(record.id, run.n,
        message => postWorkerMessage(s.post, record, message))
    } catch { /* The next registry change, reconnect or projector pass retries this ID. */ }
  }
  for (const record of retire) {
    s.room.retireWorker(record.id, { ...(record.archive ?? registry.archiveOf(record, { summary: '' })), id: record.id }, post)
    await registry.finishCleanup(record.id, roomKey).catch(() => undefined)
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
  private running: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private s: Session, private registry: WorkerRegistry, private log: (line: string) => void = () => {}) {}

  start(): void {
    this.unsubscribe = this.registry.onChange(() => { void this.project() })
    this.s.provider.on?.('sync', this.onSync)
    void this.project()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.s.provider.off?.('sync', this.onSync)
  }

  /** Serialized: a pass never overlaps another, and a request during a pass runs once after it. */
  project(): Promise<void> {
    const next = this.running.then(async () => {
      if (this.stopped) return
      try { await projectWorkers(this.s, this.registry, this.s.me.name, 'joined', this) }
      catch (e) { this.log(`worker projector (${this.s.roomName}): ${e instanceof Error ? e.message : String(e)}`) }
    })
    this.running = next
    return next
  }
}
