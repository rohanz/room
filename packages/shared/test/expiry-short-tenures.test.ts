import { expect, it } from 'vitest'
import { ExpiryTenure, ROOM_STALE_MS, RoomDoc } from '../src/index.js'

const MINUTE = 60_000
const absent = [{ name: 'ben', fresh: false, visible: true }]
function setup() {
  const room = new RoomDoc()
  room.participants.set('ben\0id', { name: 'ben', kind: 'agent' })
  room.participants.set('ben\0holder', { sessionId: 's', epoch: 1, pid: 1, startTime: 't', executable: 'codex', at: 0 })
  let now = 0
  return { room, advance: (ms: number) => { now += ms }, tenure: (epoch: string) => new ExpiryTenure(epoch, () => now) }
}

it('many 63-minute measured tenures approach twice the stale interval but never expire early', () => {
  const s = setup()
  let measured = 0, expired = false
  for (let n = 0; !expired && measured <= 2 * ROOM_STALE_MS; n++) {
    const tenure = s.tenure(String(n))
    expect(tenure.observe(s.room, absent, undefined, () => {})).toEqual([])
    for (let minute = 1; minute <= 63; minute++) {
      measured += MINUTE
      s.advance(MINUTE)
      expired = tenure.observe(s.room, absent, undefined, () => {}).length > 0
      if (expired) break
    }
  }
  expect(expired).toBe(true)
  expect(measured).toBeGreaterThan(1.9 * ROOM_STALE_MS)
  expect(measured).toBeLessThan(2 * ROOM_STALE_MS)
})

it('single-observation tenures have no measured interval and no finite wall-clock expiry bound', () => {
  const s = setup()
  for (let n = 0; n < 20; n++) {
    s.advance(ROOM_STALE_MS)
    expect(s.tenure(String(n)).observe(s.room, absent, undefined, () => {})).toEqual([])
  }
  expect(s.room.expiry.has('ben')).toBe(false)
  expect(s.room.participants.has('ben\0holder')).toBe(true)
})

it('concurrent leaders restart on another writer even during a deferred-write interval', () => {
  const s = setup(), a = s.tenure('a'), b = s.tenure('b')
  const pass = (t: ExpiryTenure) => t.observe(s.room, absent, undefined, () => {})
  pass(a); pass(b)
  for (let n = 0; n < 30; n++) {
    s.advance(MINUTE)
    expect(pass(a)).toEqual([])
    expect(pass(b)).toEqual([])
    expect(s.room.expiry.get('ben')!.observedMs).toBeLessThanOrEqual((n + 1) * MINUTE)
  }
})
