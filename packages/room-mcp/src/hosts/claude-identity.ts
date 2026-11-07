import type { HostAdapter, IdentityResult } from './types.js'
import { matchingRecord } from './identity-records.js'
const pending: IdentityResult = { kind: 'pending', reason: 'unbound', initialJoinWaitMs: 0 }
export const claudeIdentity: Pick<HostAdapter, 'identify' | 'admitToolSession'> = {
  admitToolSession() {},
  identify(e) {
    const bound = (id: string, source: 'worker' | 'hook' | 'env'): IdentityResult =>
      ({ kind: 'bound', target: { host: 'claude', id, surface: 'interactive' }, source })
    if (e.workerId && e.workerSessionId) return bound(e.workerSessionId, 'worker')
    if (e.repositoryAvailable === false) return pending
    const record = matchingRecord(e, 'claude')
    if (record) return bound(record.session_id, 'hook')
    if (e.workerId) return pending
    return e.env.CLAUDE_CODE_SESSION_ID ? bound(e.env.CLAUDE_CODE_SESSION_ID, 'env') : pending
  },
}
