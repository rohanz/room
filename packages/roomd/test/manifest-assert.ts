import { manifestKey, manifestPaths, type RoomDoc } from '@room/shared'

export { manifestPaths }

/** Test the current incarnation rather than the retired participant-keyed overlay. */
export function incarnationText(room: RoomDoc, name: string, path: string) {
  const fence = room.manifestHead.get(name)?.fence
  return fence ? room.overlayText(manifestKey(name, fence), path) : undefined
}

export function manifestText(room: RoomDoc, path: string, name: string): string | undefined {
  return incarnationText(room, name, path)?.toString()
}

export function manifestDeleted(room: RoomDoc, name: string, path: string): boolean {
  const fence = room.manifestHead.get(name)?.fence
  return !!fence && room.manifest.get(manifestKey(name, fence))?.get(path)?.change === 'D'
}
