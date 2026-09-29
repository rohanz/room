import * as Y from 'yjs'
import { gitBlobHash, manifestKey, type ManifestEntry, type RoomDoc } from '@room/shared'
import { epochPublication } from '@room/shared/testing'

/** Schema-2 publication fixture for web tests; mirrors the daemon's current incarnation. */
export function publish(room: RoomDoc, name: string, path: string, text: string, baseText = '', base = 'base'): void {
  room.ensureRoomSalt()
  const fence = '1'
  if (!room.participants.has(`${name}\0holder`)) {
    epochPublication(room, name, base, 1, `lease-${name}`)
    room.manifestHead.set(name, { ...room.manifestHead.get(name)!, level: 'full' })
    room.manifest.set(manifestKey(name, fence), new Y.Map<ManifestEntry>())
    room.overlays.set(manifestKey(name, fence), new Y.Map<Y.Text>())
  }
  const entries = room.manifest.get(manifestKey(name, fence))!
  const overlays = room.overlays.get(manifestKey(name, fence))!
  entries.set(path, { change: 'M', state: 'shared', hash: gitBlobHash(text), size: new TextEncoder().encode(text).length, at: Date.now(), fence })
  let overlay = overlays.get(path)
  if (!overlay) { overlay = new Y.Text(); overlays.set(path, overlay) }
  overlay.delete(0, overlay.length)
  overlay.insert(0, text)
  room.setBaseText(name, base, path, baseText)
  const head = room.manifestHead.get(name)!
  room.manifestHead.set(name, { ...head, rev: head.rev + 1, semRev: head.semRev + 1 })
}

export function deletePublished(room: RoomDoc, name: string, path: string): void {
  const head = room.manifestHead.get(name)!
  room.manifest.get(manifestKey(name, head.fence))!.set(path, { change: 'D', state: 'shared', at: Date.now(), fence: head.fence })
  room.overlays.get(manifestKey(name, head.fence))?.delete(path)
  room.manifestHead.set(name, { ...head, rev: head.rev + 1, semRev: head.semRev + 1 })
}
