import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { RoomDoc } from '@room/shared'
import { Awareness } from 'y-protocols/awareness'
import { startAutoTaggedRoomd } from '../src/session.js'
import { sessionMetadataPath } from '../src/config.js'

vi.mock('@room/roomd', async importOriginal => ({
  ...await importOriginal<typeof import('@room/roomd')>(),
  startRoomd: vi.fn(async (options) => {
    const roomDoc = new RoomDoc()
    const awareness = new Awareness(roomDoc.doc)
    awareness.setLocalState({ user: { name: options.name, kind: 'agent' }, host: options.host, model: options.model, effort: options.effort })
    return { roomDoc, provider: { awareness }, stop: async () => { awareness.destroy(); roomDoc.doc.destroy() } }
  }),
}))
afterEach(() => vi.unstubAllEnvs())
it('refreshes runtime metadata after hook rewrites, clears missing model, and stops watching on leave', async () => {
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
    await new Promise(resolve => setTimeout(resolve, 650))
    expect(publish).not.toHaveBeenCalled()
    publish.mockRestore()
  } finally { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }) }
})
