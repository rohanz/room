import { newId } from './identity.js'
import { outgoing, type PostBody, type RoomDoc } from './doc.js'
import type { Identity, Msg } from './types.js'

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
