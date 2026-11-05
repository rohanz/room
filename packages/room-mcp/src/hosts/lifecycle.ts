/** Host-specific lifecycle evidence. Storage callers consume these decisions without interpreting hosts. */
import { runLogFacts } from '../run-log-facts.js'
import type { Run, WorkerRecord } from '../worker-status.js'
import type { HostId } from './types.js'

/** The legacy discovery path historically assigned Codex when no display evidence named a host. */
export function legacyWorkerHost(value: HostId | undefined): HostId { return value ?? 'codex' }

export function resumeHostOptions(config?: { claudeChannel?: string }): { claudeChannel?: string } {
  return { claudeChannel: config?.claudeChannel }
}

export function retainedSessionMissing(record: Pick<WorkerRecord, 'host' | 'hostSessionId'>,
  run: Pick<Run, 'mode' | 'logStart'>, file: string): boolean {
  if (record.host !== 'claude' || run.mode !== 'resume' || !record.hostSessionId) return false
  const facts = runLogFacts(file, run.logStart)
  return facts.missingSessions.has(record.hostSessionId) && !facts.assistantSessions.has(record.hostSessionId)
}
