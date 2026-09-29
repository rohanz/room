import { newId } from './identity.js'
import { outgoing, participantRecord, type PostBody, type RoomDoc } from './doc.js'
import type { Identity, Msg } from './types.js'

/** Tests only: a coherent hub-epoch holder and publisher facts for manifest readers. */
export function epochPublication(room: Pick<RoomDoc, 'participants' | 'manifestHead'>, name: string, base: string, epoch = 1, sessionId = `session-${name}`): string {
  const fence = String(epoch)
  room.participants.set(`${name}\0holder`, { sessionId, epoch })
  room.participants.set(`${name}\0git`, { branch: 'main', head: base, base, anchored: true, rev: 1, fence })
  room.manifestHead.set(name, { base, fence, coverage: { kind: 'all' }, level: 'declared', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })
  return fence
}

/** Tests only: move one participant's Git baseline without reintroducing the removed room-wide bases map. */
export function setParticipantBase(room: RoomDoc, name: string, base: string): void {
  const git = participantRecord(room, name)?.git
  room.participants.set(`${name}\0git`, { ...git, branch: git?.branch ?? 'main', head: git?.head ?? base,
    base, anchored: git?.anchored ?? true, rev: (git?.rev ?? 0) + 1, fence: git?.fence ?? '1' })
}

/**
 * Tests only: append a message the way the room's hub does (hub §2.3), so a test can stand in for
 * another participant without a hub. An id already in bus, mail, archive or outcomes appends nothing.
 */
export function hubAppend<T extends Msg>(room: RoomDoc, from: Identity, body: PostBody<T>, opts: { id?: string; at?: number } = {}): T {
  const id = opts.id ?? newId('m_')
  const existing = room.message(id)
  if (existing) return existing as T
  const seq = Math.max(0, ...room.messages().map(m => m.seq ?? 0), ...[...room.mail.values()].map(m => m.seq ?? 0)) + 1
  const msg = { ...outgoing<T>(from, body, id), seq, at: opts.at ?? Date.now() } as T
  if (room.archive.has(id) || room.outcomes.has(id)) return msg
  room.doc.transact(() => { room.bus.push([msg]) })
  return msg
}
