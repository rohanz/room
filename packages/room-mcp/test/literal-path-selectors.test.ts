import { expect, it, vi } from 'vitest'
import { createTools } from '../src/tools.js'
import { validRepoPath, DISK_READ_PATH } from '@room/roomd'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomDoc } from '@room/shared'
import { Awareness } from 'y-protocols/awareness'
import { handlers } from '../src/tools/join.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'

vi.mock('../src/repository.js', async original => ({ ...await original<object>(), repositoryProblem: async () => undefined }))

// These handlers use path strings literally, unlike identity/model selectors.
const paths: [string, string][] = [
  ['room_join', 'dir'], ['room_create', 'dir'],
  ['room_export', 'path'], ['room_state', 'path'], ['room_read', 'path'],
  ['room_impact', 'path'], ['room_spawn', 'dir'],
]

it.each(paths)('%s preserves whitespace-only literal %s at dispatch', async (tool, argument) => {
  expect(validRepoPath(' ', DISK_READ_PATH)).toBe(true)
  const tools = createTools({ cwd: process.cwd(), getSession: () => null, setSession() {} })
  const selected = tool === 'room_join' || tool === 'room_create' ? 'explicit room path' : 'automatic room path'
  tools.setAutoJoin({
    ensure: async () => { throw new Error('automatic room path') },
    settle: async () => { throw new Error('explicit room path') },
    cancel() {}, retarget() {},
  })
  // Baseline handlers receive the exact string; the new refusal intercepts it.
  await expect(tools.call(tool, { [argument]: ' ' })).rejects.toThrow(selected)
})

it('preserves a literal whitespace filename which the unchanged export handler writes successfully', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-review-blank-path-'))
  const room = new RoomDoc(), awareness = new Awareness(room.doc)
  const session = { dir: root, room, awareness, roomName: 'local/review', me: { name: 'review', kind: 'agent' } } as Session
  try {
    const reply = await handlers({ S: () => session, now: () => 0 } as HandlerState).room_export({ path: ' ' })
    expect(reply).toContain('exported')
    expect(fs.statSync(path.join(root, ' ')).isFile()).toBe(true)
    const tools = createTools({ cwd: root, getSession: () => null, setSession() {} })
    tools.setAutoJoin({ ensure: async () => { throw new Error('handler dispatch') }, settle: async () => {}, cancel() {}, retarget() {} })
    await expect(tools.call('room_export', { path: ' ' })).rejects.toThrow('handler dispatch')
  } finally { awareness.destroy(); room.doc.destroy(); fs.rmSync(root, { recursive: true, force: true }) }
})
