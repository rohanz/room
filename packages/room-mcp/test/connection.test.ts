import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { offlineSince, trackConnection } from '../src/connection.js'
import type { Session } from '../src/session.js'

function fake(connected = false) {
  const provider = Object.assign(new EventEmitter(), { wsconnected: connected, synced: connected })
  return { session: { provider } as unknown as Session, provider }
}
describe('connection grace', () => {
  it('ignores initial connection, transient disconnects, and requires both transport and sync', () => {
    let clock = 0
    const { session, provider } = fake()
    trackConnection(session, () => clock)
    clock = 10000
    expect(offlineSince(session, () => clock)).toBeUndefined()
    provider.wsconnected = provider.synced = true; provider.emit('sync', true)
    provider.wsconnected = false; provider.emit('status')
    clock += 2000
    expect(offlineSince(session, () => clock)).toBeUndefined()
    clock++
    expect(offlineSince(session, () => clock)).toBe(10000)
    provider.wsconnected = true; provider.synced = false; provider.emit('status')
    expect(offlineSince(session, () => clock)).toBe(10000)
    provider.synced = true; provider.emit('sync', true)
    expect(offlineSince(session, () => clock)).toBeUndefined()
    provider.wsconnected = false; provider.emit('status')
    clock += 1000
    provider.wsconnected = true; provider.emit('status')
    clock += 5000
    expect(offlineSince(session, () => clock)).toBeUndefined()
  })
  it('keeps a connected primary online when a workers provider disconnects', () => {
    let clock = 0
    const primary = fake(true), workers = fake(true)
    trackConnection(primary.session, () => clock); trackConnection(workers.session, () => clock)
    workers.provider.wsconnected = false; workers.provider.emit('status')
    clock = 3000
    expect(offlineSince(workers.session, () => clock)).toBe(0)
    expect(offlineSince(primary.session, () => clock)).toBeUndefined()
  })
})
