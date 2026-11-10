import { createHash } from 'node:crypto'
import { participantRecord, type RoomDoc } from './doc.js'
import type { Msg } from './types.js'

/** Replicated conflict provenance; the delivery ledger does not need evaluation or source text. */
export interface ConflictNoticeSlot {
  owner: string
  other: string
  kind: 'merge' | 'edit-in-claim' | 'claims' | 'contract'
  path: string
  subject?: string
  settled: 'conflict' | 'possible' | 'clean' | 'none'
  clearedFrom?: 'conflict' | 'possible'
  epoch: number
  episode?: string
  possibleEpisode?: number
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
export const slotKey = (owner: string, kind: ConflictNoticeSlot['kind'], other: string, path: string, subject = ''): string =>
  [owner, kind, other, path, subject].join('\0')
export const noticeId = (key: string, epoch: number, episode?: string): string =>
  `cf:${hash(key)}:${epoch}${episode ? `:${episode}` : ''}`
export const peerNoticeId = (owner: string, other: string, episode: number, open: readonly { path: string; epoch: number }[], cleared: readonly { path: string; epoch: number }[]): string =>
  `cf:${hash([owner, other, 'merge'].join('\0'))}:peer:${episode}:${open.length
    ? hash(JSON.stringify([open.map(s => [s.path, s.epoch]), cleared.map(s => [s.path, s.epoch])]))
    : 'clean'}`

/** Shared with the producer: recover even old notices without parsing participant names out of prose. */
export function conflictNoticeId(key: string, slot: ConflictNoticeSlot): string {
  const episode = slot.kind === 'edit-in-claim' && slot.possibleEpisode !== undefined && (slot.settled === 'possible' || slot.clearedFrom === 'possible')
    ? slot.possibleEpisode : undefined
  return episode !== undefined
    ? `cf:${hash([slot.owner, slot.other, slot.path, 'possible', episode].join('\0'))}:${slot.settled === 'clean' ? 'clean' : 'possible'}`
    : slot.settled === 'clean' && slot.kind !== 'contract'
      ? `cf:${hash([slot.owner, slot.other, slot.path, slot.clearedFrom, slot.epoch].join('\0'))}:clean`
      : noticeId(key, slot.epoch, slot.episode) + (slot.settled === 'clean' ? ':clean' : '')
}

type Subjects = Map<string, ConflictNoticeSlot[]>
const caches = new WeakMap<object, { subjects?: Subjects }>()
function subjects(doc: RoomDoc): Subjects {
  let cache = caches.get(doc.doc)
  if (!cache) {
    cache = {}
    caches.set(doc.doc, cache)
    // Invalidate before readers observe newly merged lifecycle state.
    const invalidate = (tx: { changed: Map<unknown, unknown> }) => {
      if ([doc.claims, doc.participants, doc.doc.getMap('conflicts')].some(root => tx.changed.has(root))) cache!.subjects = undefined
    }
    doc.doc.on('beforeObserverCalls', invalidate)
    doc.doc.on('destroy', () => doc.doc.off('beforeObserverCalls', invalidate))
  }
  if (cache.subjects) return cache.subjects
  const out: Subjects = new Map()
  const add = (id: string, slot: ConflictNoticeSlot) => out.set(id, [...out.get(id) ?? [], slot])
  for (const [key, slot] of doc.doc.getMap<ConflictNoticeSlot>('conflicts')) {
    if (!slot || typeof slot.owner !== 'string' || typeof slot.other !== 'string' || typeof slot.path !== 'string'
      || !['merge', 'edit-in-claim', 'claims', 'contract'].includes(slot.kind) || !Number.isSafeInteger(slot.epoch)
      || slot.subject !== undefined && typeof slot.subject !== 'string') continue
    // Peer notices keep older urgent updates owed while the same pair still exists.
    if (slot.kind === 'merge' && slot.path !== '*') add(peerNoticeId(slot.owner, slot.other, 0, [], []).split(':peer:')[0] + ':peer:', slot)
    add(conflictNoticeId(key, slot), slot)
    add(noticeId(key, slot.epoch, slot.episode) + ':holder', slot)
  }
  cache.subjects = out
  return out
}

/** Conflict notices are current state, not offline mail. Nonautomatic contract/mail messages stay events. */
export function staleConflictNotice(doc: RoomDoc, m: Msg): boolean {
  if (m.type !== 'conflict' && m.type !== 'merge-conflict' && m.type !== 'contract') return false
  if (m.type === 'conflict' && [m.claimId, m.otherClaimId].some(id => id && !doc.claims.has(id))) return true
  if (m.from !== 'room' || !m.id.startsWith('cf:')) return false
  const pair = /^cf:[0-9a-f]+:peer:/.exec(m.id)?.[0]
  const slots = subjects(doc).get(pair ?? m.id) ?? []
  if (!slots.length) {
    // Local snapshots intentionally omit derived slots. No match alone proves nothing after restart.
    // A retired worker archive can still identify old peer/per-file/contract notices by their hashes.
    if (!m.to) return false
    return doc.retiredWorkers().some(worker => {
      if (!worker || typeof worker.name !== 'string' || !Number.isFinite(worker.retiredAt)
        || worker.retiredAt < m.at || participantRecord(doc, worker.name)) return false
      if (pair) return peerNoticeId(m.to!, worker.name, 0, [], []).startsWith(pair)
      const kind = m.type === 'merge-conflict' ? 'merge' : m.type === 'contract' ? 'contract' : 'edit-in-claim'
      const subject = m.type === 'contract' ? m.symbol : m.type === 'conflict' ? m.claimId : ''
      return [slotKey(m.to!, kind, worker.name, m.path, subject), slotKey(m.to!, kind, worker.name, m.path)]
        .some(key => m.id.startsWith(`cf:${hash(key)}:`))
    })
  }
  return !slots.some(slot => {
    if (!participantRecord(doc, slot.owner) || !participantRecord(doc, slot.other)) return false
    if (slot.kind === 'claims' || slot.kind === 'edit-in-claim') {
      const ids = slot.subject?.split('\0').filter(Boolean) ?? []
      return ids.length > 0 && ids.every(id => doc.claims.has(id))
    }
    return true
  })
}
