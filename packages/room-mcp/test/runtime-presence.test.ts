import { afterEach, expect, it, vi } from 'vitest'
import fs, { watchFile, unwatchFile } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { RoomDoc } from '@room/shared'
import { Awareness } from 'y-protocols/awareness'
import { startAutoTaggedRoomd } from '../src/session.js'
import { sessionMetadataPath } from '../src/config.js'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, watchFile: vi.fn(actual.watchFile), unwatchFile: vi.fn(actual.unwatchFile) }
})

vi.mock('@room/roomd', async importOriginal => ({
  ...await importOriginal<typeof import('@room/roomd')>(),
  startRoomd: vi.fn(async (options) => {
    const roomDoc = new RoomDoc()
    const awareness = new Awareness(roomDoc.doc)
    awareness.setLocalState({ user: { name: options.name, kind: 'agent' }, host: options.host, model: options.model, effort: options.effort })
    return { touch: vi.fn(), roomDoc, provider: { awareness }, stop: async () => { awareness.destroy(); roomDoc.doc.destroy() } }
  }),
}))
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
it('refreshes runtime metadata after hook rewrites, clears missing model, and stops watching on leave', async () => {
  vi.stubEnv('ROOM_WORKER_ID', '')
  vi.stubEnv('ROOM_HOST', 'codex')
  vi.stubEnv('ROOM_WORKER_MODEL', '')
  vi.stubEnv('ROOM_WORKER_EFFORT', '')
  vi.stubEnv('CLAUDE_MODEL', 'wrong')
  vi.stubEnv('CLAUDE_EFFORT', 'high')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-runtime-'))
  execFileSync('git', ['init', '-q', dir])
  const file = sessionMetadataPath(dir)
  fs.writeFileSync(file, JSON.stringify({ model: 'gpt-6-astra' }))
  const { daemon } = await startAutoTaggedRoomd({ dir, name: 'Ada+worker', label: 'worker', room: 'ws://unused/room' }, 'worker')
  try {
    expect(daemon.provider.awareness.getLocalState()).toMatchObject({ model: 'gpt-6-astra' })
    daemon.roomDoc.setWorker({ tag: 'worker', name: 'Ada+worker', host: 'codex', task: '', dir, branch: 'main', pid: 1, lead: 'Ada', status: 'running', startedAt: 1 })
    fs.writeFileSync(file, JSON.stringify({ model: 'actual-model' }))
    await vi.waitFor(() => expect(daemon.provider.awareness.getLocalState()?.model).toBe('actual-model'), { timeout: 3000 })
    expect(daemon.roomDoc.workerOf('Ada+worker')?.model).toBe('actual-model')
    fs.writeFileSync(file, '{}')
    await vi.waitFor(() => expect(daemon.provider.awareness.getLocalState()?.model).toBeUndefined(), { timeout: 3000 })
    expect(daemon.provider.awareness.getLocalState()?.effort).toBeUndefined()
    const publish = vi.spyOn(daemon.provider.awareness, 'setLocalState')
    await daemon.stop()
    publish.mockClear()
    fs.writeFileSync(file, JSON.stringify({ model: 'after-leave' }))
    expect(publish).not.toHaveBeenCalled()
    publish.mockRestore()
  } finally { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it('touches for new matching-session hook activity and unregisters both polling callbacks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-activity-'))
  execFileSync('git', ['init', '-q', dir])
  const file = sessionMetadataPath(dir)
  const activity = path.join(path.dirname(file), 'room-hook-activity.json')
  fs.writeFileSync(file, JSON.stringify({ session_id: 'current' }))
  fs.writeFileSync(activity, JSON.stringify({ session_id: 'current', at: 1 }))
  const watched = vi.mocked(watchFile)
  const unwatched = vi.mocked(unwatchFile)
  const { daemon } = await startAutoTaggedRoomd({ dir, name: 'Ada+worker', label: 'worker', room: 'ws://unused/room' }, 'worker')
  try {
    const refresh = watched.mock.calls.find(([name]) => name === activity)![2] as () => void
    expect(daemon.touch).not.toHaveBeenCalled()
    fs.writeFileSync(activity, JSON.stringify({ session_id: 'other', at: Date.now() + 1 }))
    refresh()
    expect(daemon.touch).not.toHaveBeenCalled()
    fs.writeFileSync(activity, '{partial')
    refresh()
    expect(daemon.touch).not.toHaveBeenCalled()
    // Wait for the observable hook write to be consumed, not an arbitrary timer delay.
    await vi.waitFor(() => {
      fs.writeFileSync(activity, JSON.stringify({ session_id: 'current', at: Date.now() }))
      refresh()
      expect(daemon.touch).toHaveBeenCalledTimes(1)
    })
    refresh()
    expect(daemon.touch).toHaveBeenCalledTimes(1)
    await daemon.stop()
    expect(unwatched).toHaveBeenCalledWith(activity, refresh)
    expect(unwatched).toHaveBeenCalledWith(file, expect.any(Function))
  } finally {
    await daemon.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('publishes a Claude transcript model to participant and worker records on room tool calls', async () => {
  vi.stubEnv('ROOM_WORKER_ID', '')
  vi.stubEnv('ROOM_HOST', 'claude')
  vi.stubEnv('ROOM_WORKER_MODEL', '')
  vi.stubEnv('ROOM_WORKER_EFFORT', '')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-runtime-claude-'))
  execFileSync('git', ['init', '-q', dir])
  const transcript = path.join(dir, 'transcript.jsonl')
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'claude-first' } }) + '\n')
  fs.writeFileSync(sessionMetadataPath(dir), JSON.stringify({ session_id: 'claude-session', host: 'claude', transcript_path: transcript }))
  const { daemon, me, refreshRuntime } = await startAutoTaggedRoomd({ dir, name: 'Ada+worker', label: 'worker', room: 'ws://unused/room' }, 'worker')
  daemon.roomDoc.setWorker({ tag: 'worker', name: 'Ada+worker', host: 'claude', task: '', dir, branch: 'main', pid: 1, lead: 'Ada', status: 'running', startedAt: 1 })
  const session = {
    room: daemon.roomDoc, provider: { ...daemon.provider, synced: true }, awareness: daemon.provider.awareness, daemon, me,
    dir, roomUrl: 'ws://unused/room', roomName: 'room', browserUrl: '', shareMax: 'full', shareRequested: 'full', pinnedRoom: true, refreshRuntime,
  } as unknown as Session
  const tools = createTools({ cwd: dir, getSession: () => session, setSession: () => {} })
  try {
    expect(daemon.provider.awareness.getLocalState()?.model).toBeUndefined()
    await tools.call('room_state', {})
    expect(daemon.provider.awareness.getLocalState()?.model).toBe('claude-first')
    expect(daemon.roomDoc.workerOf('Ada+worker')?.model).toBe('claude-first')
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model: 'claude-second' } }) + '\n')
    await tools.call('room_state', {})
    expect(daemon.provider.awareness.getLocalState()?.model).toBe('claude-second')
    expect(daemon.roomDoc.workerOf('Ada+worker')?.model).toBe('claude-second')
  } finally {
    await tools.shutdown()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
