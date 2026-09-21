import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface RoomFile { room?: string; name?: string; dir?: string }

/** The current worktree's private metadata, never the shared Git directory. */
export function roomFilePath(dir: string): string {
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  return path.join(gitDir, 'room.json')
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
  } catch { return undefined }
}
