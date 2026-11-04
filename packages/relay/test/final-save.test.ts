import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { AuthorityLock, FinalSaveError, loadMemory, startRelay, type StartedRelay } from '../src/index.js'
import { FINAL_SAVE_RETRY_MS } from '../src/memory.js'
import { authorizedWebSocket } from '../../roomd/src/ws-auth.js'

const key = 'final-save-key', room = 'local/final-save'
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A relay with memory and the clone's authority lock, and one writer that set meta.k = 'newest'. */
async function relayWithState(finalSaveRetryMs: readonly number[] = [20, 20, 20]) {
  const commonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-final-save-'))
  cleanups.push(() => fs.rmSync(commonDir, { recursive: true, force: true }))
  const lock = AuthorityLock.take(commonDir)!
  const relay: StartedRelay = await startRelay(0, { key, commonDir, log: () => {}, hub: { lock }, finalSaveRetryMs })
  const writer = new WebsocketProvider(`ws://127.0.0.1:${relay.port}`, encodeURIComponent(room), new Y.Doc(), { WebSocketPolyfill: authorizedWebSocket({ key }) as never, params: { schema: '2' }, disableBc: true })
  cleanups.push(() => { writer.destroy(); writer.doc.destroy() })
  writer.doc.getMap('meta').set('k', 'newest')
  await vi.waitFor(() => expect(relay.hubRoom(room)?.doc.doc.getMap('meta').get('k')).toBe('newest'), { timeout: 5000 })
  return { commonDir, lock, relay, writer }
}

/** Fail the snapshot rename with ENOSPC `times` times (Infinity: always) or until `recovered`, counting attempts. */
function failRename(times: number, recovered = () => false) {
  const rename = fs.renameSync, attempts = { count: 0 }
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).endsWith('.ydoc')) {
      attempts.count++
      if (attempts.count <= times && !recovered()) throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' })
    }
    return rename(from, to)
  })
  return attempts
}

it('a final save that keeps failing rejects naming the cause and keeps the documents, clients and authority lock', async () => {
  const { commonDir, lock, relay } = await relayWithState()
  const attempts = failRename(Infinity)
  const closing = relay.close()
  await expect(closing).rejects.toThrow(FinalSaveError)
  await expect(closing).rejects.toThrow(/ENOSPC/)
  expect(attempts.count).toBe(4) // the first save and one per retry delay
  expect(relay.hubRoom(room)?.doc.doc.getMap('meta').get('k')).toBe('newest')
  expect(lock.held()).toBe(true)
  // Still serving: a new client syncs the unsaved state from the relay.
  const reader = new WebsocketProvider(`ws://127.0.0.1:${relay.port}`, encodeURIComponent(room), new Y.Doc(), { WebSocketPolyfill: authorizedWebSocket({ key }) as never, params: { schema: '2' }, disableBc: true })
  cleanups.push(() => { reader.destroy(); reader.doc.destroy() })
  await vi.waitFor(() => expect(reader.doc.getMap('meta').get('k')).toBe('newest'), { timeout: 5000 })
  // Once the disk recovers, a later close saves the newest state and stops.
  vi.restoreAllMocks()
  await relay.close()
  expect(lock.held()).toBe(false)
  const saved = loadMemory(commonDir, room, () => {}); cleanups.push(() => saved.destroy())
  expect(saved.getMap('meta').get('k')).toBe('newest')
})

it('a final save that succeeds on a retry stops cleanly with the newest state on disk', async () => {
  const { commonDir, lock, relay, writer } = await relayWithState(FINAL_SAVE_RETRY_MS)
  // The disk recovers only once a write made during the retries has reached the relay.
  const latest = () => relay.hubRoom(room)?.doc.doc.getMap('meta').get('k')
  const attempts = failRename(Infinity, () => latest() === 'during retries' && attempts.count >= 2)
  const closing = relay.close()
  writer.doc.getMap('meta').set('k', 'during retries')
  await closing
  expect(attempts.count).toBeGreaterThanOrEqual(2) // the first save failed; a retry saved
  expect(lock.held()).toBe(false)
  expect(relay.hubRoom(room)).toBeUndefined()
  const saved = loadMemory(commonDir, room, () => {}); cleanups.push(() => saved.destroy())
  expect(saved.getMap('meta').get('k')).toBe('during retries')
})

it('an ordinary stop saves once, releases the lock and drops the documents', async () => {
  const { commonDir, lock, relay } = await relayWithState()
  const attempts = failRename(0)
  await relay.close()
  expect(attempts.count).toBe(1)
  expect(lock.held()).toBe(false)
  expect(relay.hubRoom(room)).toBeUndefined()
  const saved = loadMemory(commonDir, room, () => {}); cleanups.push(() => saved.destroy())
  expect(saved.getMap('meta').get('k')).toBe('newest')
})
