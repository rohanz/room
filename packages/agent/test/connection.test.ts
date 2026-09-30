import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { roomConnectionParams, waitForRoomSync } from '../src/connection.js'

class Provider extends EventEmitter { synced = false }

describe('Room client connections', () => {
  it('keeps explicit credentials out of the websocket URL', () => {
    expect(roomConnectionParams('ws://room.test/name', { token: 'shared', session: 'explicit-session', key: 'local' }))
      .toEqual({ token: 'shared', session: 'explicit-session', key: 'local' })
  })

  it('fails a connection that never syncs within the deadline and removes its listener', async () => {
    vi.useFakeTimers()
    try {
      const provider = new Provider()
      const waiting = waitForRoomSync(provider, 25, 'ws://room.test/name')
      const rejected = expect(waiting).rejects.toThrow('could not sync with ws://room.test/name within 25ms')
      await vi.advanceTimersByTimeAsync(25)
      await rejected
      expect(provider.listenerCount('sync')).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('resolves on the first successful sync and removes its listener', async () => {
    const provider = new Provider()
    const waiting = waitForRoomSync(provider, 100, 'room')
    provider.synced = true; provider.emit('sync', true)
    await waiting
    expect(provider.listenerCount('sync')).toBe(0)
  })
})
