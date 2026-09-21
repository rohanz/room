import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { createHandlerState, WORKTREE_NOTE } from '../src/tools/context.js'
import { handlers as fileHandlers } from '../src/tools/files.js'
import { handlers as joinHandlers } from '../src/tools/join.js'
import type { Session } from '../src/session.js'

let dir: string, session: Session, awareness: Awareness
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-memory-'))
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.org'); git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'worker edit\n')
  const doc = new Y.Doc(), room = new RoomDoc(doc)
  room.setMeta({ base })
  room.setWorker({ tag: 'worker', name: 'worker', dir, base, status: 'done' } as never)
  awareness = new Awareness(doc); awareness.setLocalState({ user: { name: 'lead', kind: 'agent' } })
  session = { dir, room, awareness, me: { name: 'lead', kind: 'agent' }, roomName: 'local/test/main', local: {}, daemon: {} } as Session
})
afterEach(() => { awareness.destroy(); session.room.doc.destroy(); fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })
function setup() {
  const state = createHandlerState({ cwd: dir, getSession: () => session, setSession() {} })
  state.ledgerLines = () => []
  return { state, handlers: fileHandlers(state) }
}
it('reads disconnected worker text from disk and labels read and diff', async () => {
  const { state, handlers } = setup()
  expect(await state.liveText(session, 'file.txt', 'worker')).toBe('worker edit\n')
  const read = await handlers.room_read({ person: 'worker', path: 'file.txt' })
  expect(read).toContain('worker edit'); expect(read).toContain(WORKTREE_NOTE)
  const diff = await handlers.room_diff({ person: 'worker', path: 'file.txt' })
  expect(diff).toContain('-base'); expect(diff).toContain('+worker edit'); expect(diff).toContain(WORKTREE_NOTE)
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n')
  expect(await handlers.room_diff({ person: 'worker' })).toContain('+new')
})
it('uses the worker base rather than the lead base and reports deleted files', async () => {
  const { handlers } = setup()
  git('add', '.'); git('commit', '-qm', 'worker commit')
  session.room.setMeta({ base: git('rev-parse', 'HEAD') })
  expect(await handlers.room_diff({ person: 'worker', path: 'file.txt' })).toContain('-base')
  fs.unlinkSync(path.join(dir, 'file.txt'))
  expect(await handlers.room_read({ person: 'worker', path: 'file.txt' })).toContain(WORKTREE_NOTE)
  expect(await handlers.room_diff({ person: 'worker', path: 'file.txt' })).toContain('-base')
})
it.each(['../escape', 'folder/../file.txt', '/etc/passwd', '..\\escape'])('rejects unsafe path %s', async file => {
  const { state, handlers } = setup()
  await expect(state.liveText(session, file, 'worker')).rejects.toThrow('unsafe worker path')
  await expect(handlers.room_diff({ person: 'worker', path: file })).rejects.toThrow('unsafe worker path')
})
it('refuses symlinks outside the worktree but reads internal symlinks', async () => {
  const { state } = setup()
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'outside'))
  await expect(state.liveText(session, 'outside', 'worker')).rejects.toThrow('unsafe worker symlink')
  fs.symlinkSync('file.txt', path.join(dir, 'inside'))
  expect(await state.liveText(session, 'inside', 'worker')).toBe('worker edit\n')
})
it('does not use disk fallback in team rooms, for unknown participants, connected workers or existing overlays', async () => {
  const { state } = setup()
  session.local = undefined
  expect(await state.liveText(session, 'file.txt', 'worker')).toBe('base\n')
  session.local = {} as never
  expect(await state.liveText(session, 'file.txt', 'unknown')).toBe('base\n')
  awareness.setLocalState({ user: { name: 'worker' } })
  expect(await state.liveText(session, 'file.txt', 'worker')).toBe('base\n')
  awareness.setLocalState(null)
  session.room.setOverlay('worker', 'file.txt', 'live overlay\n')
  expect(await state.liveText(session, 'file.txt', 'worker')).toBe('live overlay\n')
})
it('room_close requires confirmation, exports the ledger, forgets memory and leaves', async () => {
  const { state } = setup(), forget = vi.fn(async () => {}), leave = vi.fn(async () => {})
  session.local!.forget = forget
  state.runningWorkers = () => []
  state.closeWorkersRoom = async () => {}
  state.cleanupMine = () => 0
  state.doLeave = leave
  const handlers = joinHandlers(state)
  expect(await handlers.room_close({})).toContain('confirm=true')
  expect(forget).not.toHaveBeenCalled()
  expect(await handlers.room_close({ confirm: true })).toContain('forgot the saved history')
  expect(forget).toHaveBeenCalledOnce(); expect(leave).toHaveBeenCalledOnce()
  expect(fs.readdirSync(path.join(dir, '.room', 'ledger')).length).toBeGreaterThan(0)
})
