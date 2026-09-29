import { participantRecord, type Kind, type RoomDoc } from '@room/shared'

/** Give a fixture peer the participant record that a real join publishes. */
export function visiblePeer(room: RoomDoc, name: string, kind: Kind = 'agent', sessionId = `fixture:${name}`): string {
  if (!participantRecord(room, name)?.id) room.participants.set(`${name}\0id`, { name, kind })
  if (!participantRecord(room, name)?.holder) room.participants.set(`${name}\0holder`, { sessionId, epoch: 1 })
  return participantRecord(room, name)?.holder?.sessionId ?? sessionId
}
