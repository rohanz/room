import { describe, expect, it } from 'vitest'
import { OWED_TTL_MS, ROOM_STALE_MS, RoomDoc } from '@room/shared'
import { MAINTENANCE_MS, SETTLE_MS, incarnationOf, serializedStore, startHub, type HubHost, type Push } from '../src/index.js'
import { contractSuite, fakeClock, holder, memoryEnv } from './contract.js'

contractSuite('in process', memoryEnv())

function host(extra: Partial<HubHost> = {}): HubHost & { clock: ReturnType<typeof fakeClock>; logs: string[] } {
  const clock = fakeClock()
  let max: number | undefined
  const logs: string[] = []
  return {
    doc: new RoomDoc(), mono: clock.mono, wall: clock.wall, log: l => { logs.push(l) },
    store: serializedStore({ read: async () => max, write: async v => { max = v } }), clock, logs, ...extra,
  }
}
const hello = { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 't', sessionId: 's' }
const local = { local: true } as const

describe('hub in process', () => {
  it('answers invalid frames and refuses a view connection', async () => {
    const h = host()
    const hub = await startHub(h)
    const conn = {}
    expect(hub.handle(conn, 'nonsense', local)).toMatchObject({ re: '', ok: false, reason: 'invalid' })
    expect(hub.handle(conn, { v: 1, id: 'x', op: 'fly' }, local)).toMatchObject({ ok: false, reason: 'hello-first' })
    hub.handle(conn, hello, local)
    expect(hub.handle(conn, { v: 1, id: 'x', op: 'fly' }, local)).toMatchObject({ re: 'x', ok: false, reason: 'invalid' })
    expect(hub.handle(conn, { v: 1, id: 'y', op: 'acquire', name: 'ada' }, local)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(hub.handle({}, hello, { readOnly: true })).toMatchObject({ ok: false, reason: 'read-only' })
  })

  it('ends a lease at once when the relay finds its holder process dead', async () => {
    const dead = new Set<number>()
    const h = host({ holderDead: x => dead.has(x.pid) })
    const hub = await startHub(h)
    h.clock.advance(SETTLE_MS)
    const conn = {}
    hub.handle(conn, hello, local)
    const first = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s1', { pid: 7 }) }, local)
    expect(hub.handle(conn, { v: 1, id: 'b', op: 'acquire', name: 'ada', holder: holder('s2') }, local)).toMatchObject({ reason: 'held' })
    dead.add(7)
    expect(hub.handle(conn, { v: 1, id: 'c', op: 'acquire', name: 'ada', holder: holder('s2') }, local)).toMatchObject({ ok: true })
    expect(h.doc.participants.get('ada\u0000holder')).toMatchObject({ sessionId: 's2' })
    expect(first).toMatchObject({ ok: true })
  })

  it('without the authority it answers not-authority and tells holders once', async () => {
    let authority = true
    const h = host({ authority: () => authority })
    const hub = await startHub(h)
    const pushes: Push[] = []
    hub.onPush((_c, p) => pushes.push(p))
    h.clock.advance(SETTLE_MS)
    const conn = {}
    hub.handle(conn, hello, local)
    const { epoch } = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s1') }, local) as { epoch: number }
    authority = false
    hub.tick(); hub.tick()
    expect(pushes).toEqual([{ v: 1, push: 'lease-lost', name: 'ada', epoch, reason: 'not-authority' }])
    expect(hub.handle(conn, { v: 1, id: 'b', op: 'renew', name: 'ada', epoch }, local)).toMatchObject({ ok: false, reason: 'not-authority' })
    expect(hub.handle({}, hello, local)).toMatchObject({ ok: false, reason: 'not-authority' })
    h.clock.advance(60_000)
    hub.tick()
    expect(h.doc.participants.get('ada\u0000holder')).not.toHaveProperty('ended')
  })

  it('takes a new incarnation when a counter runs out, answering starting meanwhile', async () => {
    const h = host({ counterLimit: 2 })
    const hub = await startHub(h)
    const conn = {}
    hub.handle(conn, hello, local)
    const post = (id: string) => hub.handle(conn, { v: 1, id, op: 'post', msg: { id, type: 'note', from: 'ada', text: id } }, local) as { ok: boolean; seq?: number; reason?: string }
    const first = hub.incarnation
    const seqs = [post('m1').seq!, post('m2').seq!]
    expect(post('m3')).toMatchObject({ ok: false, reason: 'starting' })
    await new Promise(r => setTimeout(r, 0))
    expect(hub.incarnation).toBeGreaterThan(first)
    const next = post('m3').seq!
    expect(incarnationOf(next)).toBe(hub.incarnation)
    expect(next).toBeGreaterThan(Math.max(...seqs))
    expect(h.doc.metaMap.get('hubIncarnation')).toBe(hub.incarnation)
  })

  it('a start that dies before or after the durable write never lets a value repeat', async () => {
    let max: number | undefined
    let failWrite = false
    const store = serializedStore({ read: async () => max, write: async v => { if (failWrite) throw new Error('killed'); max = v } })
    // Each start sees a doc that lost everything (no mirror): only the durable record orders them.
    const h = () => host({ doc: new RoomDoc(), store })
    const a = await startHub(h())
    a.stop()
    failWrite = true
    await expect(startHub(h())).rejects.toThrow('killed')
    failWrite = false
    const b = await startHub(h()) // "killed just after the write": never served
    b.stop()
    const c = await startHub(h())
    expect(new Set([a.incarnation, b.incarnation, c.incarnation]).size).toBe(3)
    expect(a.incarnation).toBeLessThan(b.incarnation)
    expect(b.incarnation).toBeLessThan(c.incarnation)
  })

  it('two hubs sharing one record never take the same incarnation', async () => {
    let max: number | undefined
    const store = serializedStore({ read: async () => max, write: async v => { await new Promise(r => setTimeout(r, 5)); max = v } })
    const [a, b] = await Promise.all([startHub(host({ store })), startHub(host({ store }))])
    expect(a.incarnation).not.toBe(b.incarnation)
  })

  it('trims on the hub clock every maintenance period', async () => {
    const h = host()
    const hub = await startHub(h)
    const conn = {}
    hub.handle(conn, hello, local)
    hub.handle(conn, { v: 1, id: 'p', op: 'post', msg: { id: 'q1', type: 'question', from: 'ada', to: 'bob', text: '?' } }, local)
    h.clock.advance(OWED_TTL_MS + MAINTENANCE_MS)
    hub.tick()
    expect(h.doc.outcomes.get('q1')).toMatchObject({ outcome: 'expired', to: 'bob' })
    expect(h.doc.messages()).toEqual([])
  })

  it('expires a participant without a live lease after the stale period, measured on its own clock', async () => {
    const h = host()
    const hub = await startHub(h)
    const conn = {}
    hub.handle(conn, hello, local)
    h.clock.advance(SETTLE_MS)
    const { epoch } = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'gone', holder: holder('s1') }, local) as { epoch: number }
    hub.handle(conn, { v: 1, id: 'b', op: 'acquire', name: 'here', holder: holder('s2') }, local)
    hub.handle(conn, { v: 1, id: 'c', op: 'release', name: 'gone', epoch }, local)
    h.doc.setScope('gone', { byKind: 'agent', area: 'old', summary: 'left', paths: ['a.txt'] })
    h.doc.setScope('here', { byKind: 'agent', area: 'new', summary: 'here', paths: ['b.txt'] })
    const keepAlive = (ms: number) => {
      for (let t = 0; t < ms; t += 15_000) {
        h.clock.advance(15_000)
        hub.handle(conn, { v: 1, id: 'r', op: 'renew', name: 'here', epoch: epoch + 1 }, local)
      }
    }
    keepAlive(MAINTENANCE_MS)
    hub.tick()
    h.clock.advance(ROOM_STALE_MS)
    hub.handle(conn, { v: 1, id: 'r', op: 'renew', name: 'here', epoch: epoch + 1 }, local)
    hub.tick()
    expect(h.doc.participants.get('gone\u0000holder')).toBeUndefined()
    expect(h.doc.scope('gone')).toBeUndefined()
    expect(h.doc.scope('here')).toBeDefined()
    expect(h.logs.some(l => l.includes('expired gone'))).toBe(true)
  })
})
