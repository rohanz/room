import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { finalClose, roomConnectionParams, waitForRoomSync } from '../src/connection.js'

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

  it('a refused replica (4409) exits for a restart with a fresh copy; 4401/4403 exit; other closes reconnect', () => {
    expect(finalClose({ code: 4409, reason: "this room's document was compacted when the server restarted; rejoin with a fresh copy" }))
      .toEqual({ exitCode: 75, line: "this room's document was compacted when the server restarted; rejoin with a fresh copy; restart roomagent to rejoin with a fresh copy" })
    expect(finalClose({ code: 4403, reason: 'update Room to 0.17.0 or later' })).toEqual({ exitCode: 1, line: 'update Room to 0.17.0 or later; not reconnecting' })
    expect(finalClose({ code: 4401, reason: '' })).toMatchObject({ exitCode: 1 })
    expect(finalClose({ code: 1006, reason: '' })).toBeUndefined()
    expect(finalClose(null)).toBeUndefined()
  })
})
