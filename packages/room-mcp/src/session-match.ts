import { sessionHostIdentity } from './hosts/session-host.js'
import { sameStartTime } from '@room/relay/process'
import type { ProcessIdentity } from './leases.js'
import type { SessionRecord } from './session.js'

export function ownSession(record: SessionRecord, parent: ProcessIdentity): boolean {
  const host = sessionHostIdentity(record)
  return !!host && sameProcess(host, parent)
}

function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && sameStartTime(a.startTime, b.startTime) && a.executable === b.executable
}

