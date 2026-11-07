import type { BindingEvidence, HostId } from './types.js'
import type { SessionRecord } from '../session.js'
import { ownSession } from '../session-match.js'
import { sameFolder } from '../repository.js'

/** Preserve reader acceptance and stable newest-first ordering; no stricter record validation. */
export function matchingRecord(e: BindingEvidence, host: HostId, records = e.records): SessionRecord | undefined {
  return (records as readonly SessionRecord[]).filter(record => record.host === host)
    .filter(record => e.workerId ? record.worker_id === e.workerId
      && (!e.cwd || typeof record.cwd === 'string' && sameFolder(record.cwd, e.cwd))
      : !!e.parent && !record.worker_id && ownSession(record, e.parent))
    .sort((a, b) => b.at - a.at)[0]
}
