/** Host-specific lifecycle evidence. Storage callers consume these decisions without interpreting hosts. */
import { runLogFacts, runLogIdentity } from '../run-log-facts.js'
import type { Run, WorkerRecord } from '../worker-status.js'

export function retainedSessionMissing(record: Pick<WorkerRecord, 'host' | 'hostSessionId'> & Partial<Pick<WorkerRecord, 'id' | 'dir'>>,
  run: Pick<Run, 'mode' | 'logStart'> & Partial<Pick<Run, 'n'>>, file: string): boolean {
  if (record.host !== 'claude' || run.mode !== 'resume' || !record.hostSessionId) return false
  const identity = record.dir ? runLogIdentity({ ...record, dir: record.dir }, run) : undefined
  const facts = runLogFacts(file, run.logStart, identity).get(record.host)!
  return facts.missingSessions.has(record.hostSessionId) && !facts.acceptedSessions.has(record.hostSessionId)
}
