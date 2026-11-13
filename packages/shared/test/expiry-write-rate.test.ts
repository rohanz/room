import { describe, expect, it } from 'vitest'
import { ExpiryTenure, ROOM_STALE_MS, RoomDoc } from '../src/index.js'

/**
 * Observed 2026-11-14: the hub recorded every absent participant's time away on every one-minute pass. With about
 * 125 retired worker names in a room, an idle room gained 10,000 deleted entries every 81 minutes, which is the
 * daemon's threshold for restarting to compact the document.
 */
const MINUTE = 60 * 1000, HOUR = 60 * MINUTE
const ignore = () => {}

function setup() {
  const room = new RoomDoc()
  room.participants.set('ben\0id', { name: 'ben', kind: 'agent' })
  room.participants.set('ben\0holder', { sessionId: 's', epoch: 1, pid: 1, startTime: 't', executable: 'codex', at: 0 })
  let t = 0, writes = 0
  room.expiry.observe(() => { writes++ })
  const tenure = (epoch: string) => new ExpiryTenure(epoch, () => t)
  const pass = (on: ExpiryTenure, minutes: number): string[] => {
    const expired: string[] = []
    for (let i = 0; i < minutes; i++) { t += MINUTE; expired.push(...on.observe(room, [{ name: 'ben', fresh: false, visible: true }], undefined, ignore)) }
    return expired
  }
  return { room, tenure, pass, writes: () => writes }
}

describe('how often a participant\'s absence is recorded', () => {
  it('records a long absence about once an hour, not on every pass', () => {
    const t = setup()
    t.pass(t.tenure('a'), 24 * 60)
    expect(t.writes()).toBeLessThanOrEqual(32)
    expect(t.room.expiry.get('ben')!.observedMs).toBeGreaterThanOrEqual(23 * HOUR - MINUTE)
  })

  it('a short tenure still records at least half of what it measured', () => {
    const t = setup()
    t.pass(t.tenure('a'), 11) // the first pass only starts the measurement: ten minutes measured
    expect(t.room.expiry.get('ben')!.observedMs).toBeGreaterThanOrEqual(5 * MINUTE)
    t.pass(t.tenure('b'), 11)
    expect(t.room.expiry.get('ben')!.observedMs).toBeGreaterThanOrEqual(10 * MINUTE)
  })

  it('expires on the pass that reaches the stale period, whatever was last recorded', () => {
    const t = setup()
    const tenure = t.tenure('a')
    const minutes = ROOM_STALE_MS / MINUTE
    expect(t.pass(tenure, minutes)).toEqual([]) // the first pass starts the measurement, so one minute short
    expect(t.pass(tenure, 1)).toEqual(['ben'])
    expect(t.room.expiry.has('ben')).toBe(false)
  })
})
