/** Recovery dead end, with a real in-process hub and durable running-worker registry. */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createTools, type Tools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { memorySession } from './fixtures/session.js'
import { finishWorker, registerWorkers } from './registry-fixture.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { trackConnection } from '../src/connection.js'
import { AutoJoin } from '../src/auto-join.js'
import { workerByTag } from './registry-fixture.js'

let dir: string, s: Session, tools: Tools
afterEach(async () => {
  if (s) await finishWorker(s, 'busy', { status: 'done', summary: 'fixture cleanup' })
  await tools?.shutdown()
  s?.awareness.destroy(); s?.hub.close(); s?.room.doc.destroy()
  if (dir) { await closeRegistryForDir(dir); fs.rmSync(dir, { recursive: true, force: true }) }
})

it('an unsynced lead with a running worker can reconnect to its room while moves, takeover and nonforced leave keep their guards', async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-unsynced-recovery-')))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, '-c', 'user.name=Ada', '-c', 'user.email=a@a', 'commit', '-qm', 'init', '--allow-empty'])
  s = memorySession({ name: 'Ada', kind: 'agent' }, dir, undefined, 'local/recovery')
  Object.assign(s, { local: { url: 'ws://127.0.0.1:9', stop: async () => {} } })
  Object.assign(s.provider, { wsconnected: true })
  trackConnection(s) // session really was connected before it became unsynced
  await registerWorkers(s, [{ tag: 'busy', name: 'Ada+busy', lead: 'Ada', host: 'claude', task: 'still working',
    dir, branch: 'main', pid: 987654321, startedAt: Date.now(), status: 'running' }])
  const join = vi.fn(async () => s), leave = vi.fn(async () => {})
  let current: Session | null = s
  tools = createTools({ cwd: dir, getSession: () => current, setSession: x => { current = x }, join, leave })
  const recover = vi.fn(async () => { Object.assign(s.provider, { synced: true, wsconnected: true }) })
  s.recoverLocal = recover
  const auto = new AutoJoin({ local: true, joined: () => !!current?.provider.synced, log: () => {}, report: () => {},
    attempt: async () => { await s.recoverLocal!(); return s }, adopt: async x => { current = x }, discard: async () => {} })
  auto.remember(s)
  tools.setAutoJoin(auto)
  // A normal tool succeeds before the loss, and offline room_state still answers.
  expect(await tools.call('room_state', {})).toContain('local/recovery')
  Object.assign(s.provider, { synced: false, wsconnected: false })
  const move = await tools.call('room_join', { dir, where: 'local', room: 'different' })
  const takeover = await tools.call('room_join', { dir, where: 'local', room: s.roomName, takeover: true })
  const leaveReply = await tools.call('room_leave', {})
  expect(move).toContain('error: room not synced yet, retry')
  expect(takeover).toContain('error: room not synced yet, retry')
  expect(leaveReply).toContain('error: 1 worker(s) still running: busy')
  expect(s.provider.synced).toBe(false)
  expect(await tools.call('room_join', { room: s.roomName })).not.toMatch(/^error/)
  expect(s.provider.synced).toBe(true)
  expect(recover).toHaveBeenCalledTimes(1)
  expect((await workerByTag(dir, 'busy'))?.status).toBe('running')
  expect(await tools.call('room_state', {})).toContain('local/recovery')
  expect(current).toBe(s)
  expect(join).not.toHaveBeenCalled(); expect(leave).not.toHaveBeenCalled()
})
