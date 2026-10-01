import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { participantRecord, type Kind, type RoomDoc } from '@room/shared'

/** Give a fixture peer the participant record that a real join publishes. */
export function visiblePeer(room: RoomDoc, name: string, kind: Kind = 'agent', sessionId = `fixture:${name}`): string {
  if (!participantRecord(room, name)?.id) room.participants.set(`${name}\0id`, { name, kind })
  if (!participantRecord(room, name)?.holder) room.participants.set(`${name}\0holder`, { sessionId, epoch: 1 })
  return participantRecord(room, name)?.holder?.sessionId ?? sessionId
}

/** A peer present now, as a real join makes it (record and fresh awareness): company for `target`. Returns its cleanup. */
export function presentPeer(room: RoomDoc, target: Awareness, name: string, kind: Kind = 'agent'): () => void {
  visiblePeer(room, name, kind)
  const peer = new Awareness(new Y.Doc())
  peer.setLocalState({ user: { name, kind, color: '#111' }, status: 'idle', lastActive: Date.now() })
  applyAwarenessUpdate(target, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
  return () => { peer.destroy(); peer.doc.destroy() }
}
