import path from 'node:path'
import { worktreeGitDirSync } from './git-dirs.js'
import { readBoundedFileSync } from './bounded-read.js'

/** Session metadata is a few short strings; anything larger is not a room file. */
const ROOM_FILE_MAX_BYTES = 16 * 1024

export interface RoomFile { room?: string; name?: string; dir?: string }

/** The current worktree's private metadata, never the shared Git directory. */
export function roomFilePath(dir: string): string {
  return path.join(worktreeGitDirSync(dir), 'room.json')
}

export function readRoomFile(dir: string): RoomFile | undefined {
  const read = (file: string): RoomFile => {
    const value = JSON.parse(readBoundedFileSync(file, ROOM_FILE_MAX_BYTES))
    if (!value || typeof value !== 'object' || Array.isArray(value) || ['room', 'name', 'dir'].some(k => value[k] !== undefined && typeof value[k] !== 'string')) throw new Error('invalid room file')
    return value
  }
  try {
    return read(roomFilePath(dir))
  } catch (error) {
    if (error instanceof Error && error.message.includes('timed out')) throw error
    return undefined
  }
}
