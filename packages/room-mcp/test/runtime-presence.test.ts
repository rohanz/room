import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { RoomDoc } from '@room/shared'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { sessionDirectory, startAutoTaggedRoomd, type Session } from '../src/session.js'
import { hubRoom } from './fixtures/hub-provider.js'
import { createTools } from '../src/tools.js'
import { hubSeam } from './fixtures/hub.js'

vi.mock('@room/roomd', async importOriginal => ({
  ...await importOriginal<typeof import('@room/roomd')>(),
  startRoomd: vi.fn(async (options) => {
    const roomDoc = new RoomDoc()
    const awareness = new Awareness(roomDoc.doc)
    awareness.setLocalState({ user: { name: options.name, kind: 'agent' }, host: options.host, model: options.model, effort: options.effort })
    return { touch: vi.fn(), roomDoc, provider: { awareness, messageHandlers: [], on() {}, off() {}, wsconnected: false }, stop: async () => { awareness.destroy(); roomDoc.doc.destroy() } }
  }),
}))
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

/** A Codex worker's host session bound by its worker id (registry §17): its directory under the common git dir. */
function boundWorker(host: 'codex' | 'claude' = 'codex') {
  vi.stubEnv('ROOM_WORKER_ID', 'w1')
  vi.stubEnv('ROOM_WORKER_HOST', '')
  vi.stubEnv('ROOM_HOST', host)
  vi.stubEnv('ROOM_WORKER_MODEL', '')
  vi.stubEnv('ROOM_WORKER_EFFORT', '')
  vi.stubEnv('CLAUDE_MODEL', 'wrong')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-runtime-'))
  execFileSync('git', ['init', '-q', dir])
  const sessionDir = sessionDirectory(path.join(dir, '.git'), 'worker-thread')
  fs.mkdirSync(sessionDir, { recursive: true })
  const write = (name: string, value: object) => fs.writeFileSync(path.join(sessionDir, name), JSON.stringify(value))
  write('session.json', { session_id: 'worker-thread', host, worker_id: 'w1', at: 100, chain: [], hostPid: 1, model: 'gpt-6-astra' })
  return { dir, write }
}

it('publishes runtime.json after the hook rewrites it, clears a missing model, and stops polling on leave', async () => {
  const { dir, write } = boundWorker()
  const { daemon } = await startAutoTaggedRoomd({ dir, name: 'Ada+worker', label: 'worker', room: 'ws://unused/room', providerFactory: (_s: string, _r: string, doc: Y.Doc) => hubRoom().provider(doc) } as Parameters<typeof startAutoTaggedRoomd>[0], 'worker')
  try {
    expect(daemon.provider.awareness.getLocalState()).toMatchObject({ model: 'gpt-6-astra' })
    write('runtime.json', { model: 'actual-model', at: 200 })
    await expect.poll(() => daemon.provider.awareness.getLocalState()?.model).toBe('actual-model')
    write('session.json', { session_id: 'worker-thread', host: 'codex', worker_id: 'w1', at: 300, chain: [], hostPid: 1 })
    await expect.poll(() => daemon.provider.awareness.getLocalState()?.model).toBeUndefined()
    expect(daemon.provider.awareness.getLocalState()?.effort).toBeUndefined()
    const publish = vi.spyOn(daemon.provider.awareness, 'setLocalState')
    await daemon.stop()
    publish.mockClear()
    write('runtime.json', { model: 'after-leave', at: 400 })
    await new Promise(r => setTimeout(r, 700))
    expect(publish).not.toHaveBeenCalled()
    publish.mockRestore()
  } finally { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it('touches for new hook activity of the bound session only', async () => {
  const { dir, write } = boundWorker()
  write('hook-activity.json', { session_id: 'worker-thread', event: 'PreToolUse', at: 1 })
  const { daemon } = await startAutoTaggedRoomd({ dir, name: 'Ada+worker', label: 'worker', room: 'ws://unused/room', providerFactory: (_s: string, _r: string, doc: Y.Doc) => hubRoom().provider(doc) } as Parameters<typeof startAutoTaggedRoomd>[0], 'worker')
  try {
    await new Promise(r => setTimeout(r, 700))
    expect(daemon.touch).not.toHaveBeenCalled()
    write('hook-activity.json', { session_id: 'worker-thread', event: 'PreToolUse', at: Date.now() })
    await expect.poll(() => vi.mocked(daemon.touch).mock.calls.length).toBe(1)
    await new Promise(r => setTimeout(r, 700))
    expect(daemon.touch).toHaveBeenCalledTimes(1)
  } finally {
    await daemon.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('publishes a model the hook found in the Claude transcript on the next room tool call', async () => {
  const { dir, write } = boundWorker('claude')
  const { daemon, me, refreshRuntime } = await startAutoTaggedRoomd({ dir, name: 'Ada+worker', label: 'worker', room: 'ws://unused/room', providerFactory: (_s: string, _r: string, doc: Y.Doc) => hubRoom().provider(doc) } as Parameters<typeof startAutoTaggedRoomd>[0], 'worker')
  const session = {
    room: daemon.roomDoc, provider: { ...daemon.provider, synced: true }, awareness: daemon.provider.awareness, daemon, me, ...hubSeam(daemon.roomDoc),
    dir, roomUrl: 'ws://unused/room', roomName: 'room', browserUrl: '', shareMax: 'full', shareRequested: 'full', pinnedRoom: true, refreshRuntime,
  } as unknown as Session
  const tools = createTools({ cwd: dir, getSession: () => session, setSession: () => {} })
  try {
    write('runtime.json', { model: 'claude-first', at: 200 })
    await tools.call('room_state', {})
    expect(daemon.provider.awareness.getLocalState()?.model).toBe('claude-first')
    write('runtime.json', { model: 'claude-second', at: 300 })
    await tools.call('room_state', {})
    expect(daemon.provider.awareness.getLocalState()?.model).toBe('claude-second')
  } finally {
    await tools.shutdown()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
