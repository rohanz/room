import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { readRoomFile, roomFilePath } from '../src/room-file.js'
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })))
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
function repo() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-file-')); dirs.push(dir); git(dir, 'init', '-q'); return dir }
it('migrates valid legacy metadata into private storage once', () => {
  const dir = repo(), legacy = path.join(dir, '.room.json'), value = { name: 'me', room: 'ws://local/room' }
  fs.writeFileSync(legacy, JSON.stringify(value)); expect(readRoomFile(dir)).toEqual(value)
  expect(fs.existsSync(legacy)).toBe(false); expect(roomFilePath(dir)).toBe(path.join(fs.realpathSync(dir), '.git', 'room.json'))
  expect(readRoomFile(dir)).toEqual(value)
})
it('keeps invalid legacy data for recovery', () => {
  const dir = repo(), legacy = path.join(dir, '.room.json'); fs.writeFileSync(legacy, '{')
  expect(readRoomFile(dir)).toBeUndefined(); expect(fs.existsSync(legacy)).toBe(true)
})
it('uses independent metadata for sibling worktrees', () => {
  const dir = repo(); git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'base')
  const worker = path.join(dir, 'worker'); git(dir, 'worktree', 'add', '-qb', 'worker', worker)
  fs.writeFileSync(path.join(worker, '.room.json'), JSON.stringify({ name: 'worker' }))
  expect(readRoomFile(worker)).toEqual({ name: 'worker' }); expect(readRoomFile(dir)).toBeUndefined()
  expect(roomFilePath(worker)).not.toBe(roomFilePath(dir))
})
