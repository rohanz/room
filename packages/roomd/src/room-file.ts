import fs from 'node:fs'
import path from 'node:path'
import { worktreeGitDirSync } from './git-dirs.js'

export interface RoomFile { room?: string; name?: string; dir?: string }

/** The current worktree's private metadata, never the shared Git directory. */
export function roomFilePath(dir: string): string {
  return path.join(worktreeGitDirSync(dir), 'room.json')
}

export function readRoomFile(dir: string): RoomFile | undefined {
  const read = (file: string): RoomFile => {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value) || ['room', 'name', 'dir'].some(k => value[k] !== undefined && typeof value[k] !== 'string')) throw new Error('invalid room file')
    return value
  }
  try {
    const file = roomFilePath(dir)
    if (fs.existsSync(file)) return read(file)
    const legacy = path.join(dir, '.room.json')
    const value = read(legacy)
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    fs.unlinkSync(legacy)
    return value
  } catch (error) {
    if (error instanceof Error && error.message.includes('timed out')) throw error
    return undefined
  }
}
