/** Pure projections for synchronous callbacks. The caller supplies facts acquired asynchronously. */
import { snapshotReserved, type WorkerSnapshot } from './worker-store.js'
import { workerBaseline } from '@room/roomd/baseline'

export function snapshotBaseline(snapshot: WorkerSnapshot | undefined, participant: string) {
  if (!snapshot?.available) return undefined
  const plus = participant.lastIndexOf('+')
  if (plus < 1) return undefined
  const record = snapshotReserved(snapshot, participant.slice(plus + 1))
  if (!record || record.name !== participant || ['retired', 'abandoned'].includes(record.phase)) return undefined
  const baseline = workerBaseline(record)
  return baseline ? { baseline, lead: record.lead.participant } : undefined
}
