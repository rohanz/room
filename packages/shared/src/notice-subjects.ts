import { validMessageShape } from './messages.js'
import type { Msg, RetiredWorker } from './types.js'

const conflictNotice = (m: Msg): boolean => validMessageShape(m) && m.from === 'room' && m.id.startsWith('cf:') &&
  ['merge-conflict', 'conflict', 'contract'].includes(m.type)

/** Only recorded exact worker IDs are notice retirement evidence. */
export function retiredNoticeMatcher(workers: Iterable<Pick<RetiredWorker, 'id' | 'name'>>): (m: Msg) => boolean {
  const ids = new Set([...workers].map(worker => worker.id).filter(Boolean))
  return m => conflictNotice(m) && !!m.noticeSubjects?.some(subject =>
      !!subject.workerId && ids.has(subject.workerId))
}
