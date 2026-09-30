import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { OWED_TTL_MS, ROOM_STALE_MS, RoomDoc } from '@room/shared'
import { LEASE_TTL_MS, MAINTENANCE_MS, MAX_LEASES_PER_PRINCIPAL, MAX_RETAINED_NAMES_PER_PRINCIPAL, POST_RATE_PER_LEASE, SETTLE_MS, RoomStateError, incarnationOf, serializedStore, startHub, type Hub, type HubHost, type Push } from '../src/index.js'
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
  it('separates colliding OIDC display logins across live and persisted leases', async () => {
    const h = host({ fresh: true, owns: (p, name) => 'login' in p && p.login === name })
    const victim = { login: 'ada', id: 'oidc:issuer:subject-a', readOnly: false }
    const attacker = { login: 'ada', id: 'oidc:issuer:subject-b', readOnly: false }
    const a = {}, b = {}
    const hub = await startHub(h)
    hub.handle(a, { ...hello, sessionId: 'copied' }, victim)
    hub.handle(b, { ...hello, sessionId: 'copied' }, attacker)
    const epoch = (hub.handle(a, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('copied') }, victim) as { epoch: number }).epoch
    const checks = (instance: Hub) => {
      expect(instance.handle(b, { v: 1, id: 's', op: 'acquire', name: 'ada', holder: holder('copied'), supersedes: epoch }, attacker)).toMatchObject({ ok: false, reason: 'not-yours' })
      expect(instance.handle(b, { v: 1, id: 'r', op: 'renew', name: 'ada', epoch }, attacker)).toMatchObject({ reason: 'not-yours' })
      expect(instance.handle(b, { v: 1, id: 'x', op: 'release', name: 'ada', epoch }, attacker)).toMatchObject({ reason: 'not-yours' })
      expect(instance.handle(b, { v: 1, id: 'p', op: 'post', lease: { name: 'ada', epoch }, msg: { id: 'm', type: 'note', from: 'ada', text: 'x' } }, attacker)).toMatchObject({ reason: 'not-yours' })
    }
    checks(hub)
    expect(h.doc.participants.get('ada\u0000holder')).toMatchObject({ principal: victim.id })
    hub.stop()
    const restarted = await startHub(host({ doc: h.doc, store: h.store }))
    restarted.handle(a, { ...hello, sessionId: 'copied' }, victim)
    restarted.handle(b, { ...hello, sessionId: 'copied' }, attacker)
    checks(restarted)
    expect(restarted.handle(a, { v: 1, id: 'r2', op: 'renew', name: 'ada', epoch }, victim)).toMatchObject({ ok: true })
  })

  it('upgrades a legacy login principal only for its matching holder session', async () => {
    const h = host({ fresh: true })
    const legacy = { login: 'ada', readOnly: false }
    const identified = { ...legacy, id: 'oidc:issuer:subject-a' }
    const hub = await startHub(h)
    const old = {}, wrong = {}
    hub.handle(old, { ...hello, sessionId: 'original' }, legacy)
    hub.handle(wrong, { ...hello, sessionId: 'other' }, identified)
    const epoch = (hub.handle(old, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('original') }, legacy) as { epoch: number }).epoch
    hub.stop()
    const next = await startHub(host({ doc: h.doc, store: h.store }))
    next.handle(wrong, { ...hello, sessionId: 'other' }, identified)
    expect(next.handle(wrong, { v: 1, id: 'bad', op: 'renew', name: 'ada', epoch }, identified)).toMatchObject({ reason: 'not-yours' })
    const resumed = {}
    next.handle(resumed, { ...hello, sessionId: 'original' }, identified)
    expect(next.handle(resumed, { v: 1, id: 'good', op: 'renew', name: 'ada', epoch }, identified)).toMatchObject({ ok: true })
    expect(h.doc.participants.get('ada\u0000holder')).toMatchObject({ principal: identified.id })
  })

  it('uses a stable ID even when the principal has no display login', async () => {
    const h = host({ fresh: true }), hub = await startHub(h), conn = {}
    const principal = { id: 'oidc:issuer:subject-a', readOnly: false }
    hub.handle(conn, { ...hello, sessionId: 's' }, principal)
    expect(hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s') }, principal)).toMatchObject({ ok: true })
    expect(h.doc.participants.get('ada\u0000holder')).toMatchObject({ principal: principal.id })
  })

  it('refuses Bob renewing, releasing, or posting with Alice’s public epoch without replacing her push connection', async () => {
    const h = host({ fresh: true, owns: (p, name) => 'login' in p && p.login === name })
    const hub = await startHub(h)
    const alice = {}, bob = {}, pushes: object[] = []
    hub.onPush((conn, push) => { if (push.push === 'lease-lost') pushes.push(conn) })
    hub.handle(alice, { ...hello, sessionId: 'alice-session' }, { login: 'alice', readOnly: false })
    hub.handle(bob, { ...hello, sessionId: 'bob-session' }, { login: 'bob', readOnly: false })
    const epoch = (hub.handle(alice, { v: 1, id: 'a', op: 'acquire', name: 'alice', holder: holder('alice-session') }, { login: 'alice', readOnly: false }) as { epoch: number }).epoch
    const bobPrincipal = { login: 'bob', readOnly: false }
    expect(hub.handle(bob, { v: 1, id: 'r', op: 'renew', name: 'alice', epoch }, bobPrincipal)).toMatchObject({ reason: 'not-yours' })
    expect(hub.handle(bob, { v: 1, id: 'x', op: 'release', name: 'alice', epoch }, bobPrincipal)).toMatchObject({ reason: 'not-yours' })
    expect(hub.handle(bob, { v: 1, id: 'p', op: 'post', lease: { name: 'alice', epoch }, msg: { id: 'm1', type: 'note', from: 'bob', text: 'x' } }, bobPrincipal)).toMatchObject({ reason: 'not-yours' })
    const sameLoginOtherSession = { login: 'alice', readOnly: false }
    expect(hub.handle(bob, { v: 1, id: 'same-login', op: 'renew', name: 'alice', epoch }, sameLoginOtherSession)).toMatchObject({ reason: 'not-yours' })
    expect(h.doc.messages()).toEqual([])
    const reconnected = {}
    hub.handle(reconnected, { ...hello, sessionId: 'alice-session' }, sameLoginOtherSession)
    expect(hub.handle(reconnected, { v: 1, id: 'r2', op: 'renew', name: 'alice', epoch }, sameLoginOtherSession)).toMatchObject({ ok: true })
    hub.handle(reconnected, { v: 1, id: 'a2', op: 'acquire', name: 'alice', holder: holder('alice-session') }, sameLoginOtherSession)
    expect(pushes).toEqual([reconnected])
  })

  it('quarantines a forged high incarnation before touching the shared store; recovers a poisoned durable max', async () => {
    let max: number | undefined
    const store = serializedStore({ read: async () => max, write: async n => { max = n } })
    const forged = new RoomDoc()
    forged.metaMap.set('hubIncarnation', 2 ** 32)
    await expect(startHub(host({ doc: forged, store }))).rejects.toBeInstanceOf(RoomStateError)
    expect(max).toBeUndefined()
    const forgedSeq = new RoomDoc()
    forgedSeq.bus.push([{ id: 'm', type: 'note', from: 'alice', text: 'x', seq: (2 ** 32) * (2 ** 21), at: 1 } as never])
    await expect(startHub(host({ doc: forgedSeq, store }))).rejects.toBeInstanceOf(RoomStateError)
    expect(max).toBeUndefined()
    const clean = await startHub(host({ store }))
    expect(clean.incarnation).toBeLessThan(2 ** 32)
    clean.stop()
    max = 2 ** 32 + 1 // rc1 wrote this invalid value before validating the room
    const recovered = await startHub(host({ store }))
    expect(max).toBe(recovered.incarnation)
    expect(max).toBeLessThan(2 ** 32)
    recovered.stop()
    max = 2 ** 32 - 1 // in range, but impossibly far ahead of the process's own floor
    const implausible = await startHub(host({ store }))
    expect(max).toBe(implausible.incarnation)
    expect(max).toBeLessThan(2 ** 32 - 1)
  })

  it('rejects malformed changed posts and drops the same malformed CRDT record during maintenance', async () => {
    const h = host({ fresh: true })
    const hub = await startHub(h), conn = {}
    hub.handle(conn, hello, local)
    const epoch = (hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s') }, local) as { epoch: number }).epoch
    expect(hub.handle(conn, { v: 1, id: 'p', op: 'post', lease: { name: 'ada', epoch }, msg: { id: 'bad', type: 'changed', from: 'ada', paths: {}, summary: 'x' } }, local)).toMatchObject({ reason: 'invalid' })
    h.doc.bus.push([{ id: 'bad', type: 'changed', from: 'ada', paths: {}, summary: 'x', at: h.clock.wall(), priority: 'fyi' } as never])
    h.clock.advance(MAINTENANCE_MS + SETTLE_MS)
    expect(() => hub.tick()).not.toThrow()
    expect(h.doc.messages().some(m => m.id === 'bad')).toBe(false)
  })

  it('bounds holders, live and retained names, and refuses acquisition when the document is full', async () => {
    let full = false
    const h = host({ fresh: true, full: () => full })
    const hub = await startHub(h), conn = {}
    hub.handle(conn, hello, local)
    expect(hub.handle(conn, { v: 1, id: 'huge', op: 'acquire', name: 'huge', holder: holder('s', { executable: 'x'.repeat(2_000_000) }) }, local)).toMatchObject({ ok: false, reason: 'too-large' })
    const epoch = (hub.handle(conn, { v: 1, id: 'first', op: 'acquire', name: 'n0', holder: holder('s') }, local) as { epoch: number }).epoch
    full = true
    expect(hub.handle(conn, { v: 1, id: 'full', op: 'acquire', name: 'n1', holder: holder('s') }, local)).toMatchObject({ reason: 'room-full' })
    expect(hub.handle(conn, { v: 1, id: 'renew', op: 'renew', name: 'n0', epoch }, local)).toMatchObject({ ok: true })
    expect(hub.handle(conn, { v: 1, id: 'release', op: 'release', name: 'n0', epoch }, local)).toMatchObject({ ok: true })
    full = false
    for (let i = 0; i < MAX_LEASES_PER_PRINCIPAL; i++) expect(hub.handle(conn, { v: 1, id: `l${i}`, op: 'acquire', name: `l${i}`, holder: holder('s') }, local)).toMatchObject({ ok: true })
    expect(hub.handle(conn, { v: 1, id: 'overflow', op: 'acquire', name: 'overflow', holder: holder('s') }, local)).toMatchObject({ reason: 'room-full' })
    for (let i = 0; i < MAX_LEASES_PER_PRINCIPAL; i++) {
      const record = h.doc.participants.get(`l${i}\u0000holder`) as { epoch: number }
      hub.handle(conn, { v: 1, id: `r${i}`, op: 'release', name: `l${i}`, epoch: record.epoch }, local)
    }
    for (let i = 0; i < MAX_RETAINED_NAMES_PER_PRINCIPAL + 2; i++) {
      const name = `e${i}`
      const got = hub.handle(conn, { v: 1, id: `e${i}`, op: 'acquire', name, holder: holder('s') }, local) as { epoch: number }
      expect(got.epoch).toBeTypeOf('number')
      hub.handle(conn, { v: 1, id: `er${i}`, op: 'release', name, epoch: got.epoch }, local)
    }
    expect([...h.doc.participants.keys()].filter(k => k.endsWith('\u0000holder')).length).toBeLessThanOrEqual(MAX_RETAINED_NAMES_PER_PRINCIPAL)
  })

  it('rate-limits a flood and refuses durable writes while unavailable', async () => {
    let unavailable: string | undefined
    const h = host({ fresh: true, unavailable: () => unavailable })
    const hub = await startHub(h), conn = {}
    hub.handle(conn, hello, local)
    const epoch = (hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s') }, local) as { epoch: number }).epoch
    const post = (i: number) => hub.handle(conn, { v: 1, id: `p${i}`, op: 'post', lease: { name: 'ada', epoch }, msg: { id: `m${i}`, type: 'note', from: 'ada', text: 'x' } }, local)
    for (let i = 0; i < POST_RATE_PER_LEASE; i++) expect(post(i)).toMatchObject({ ok: true })
    expect(post(POST_RATE_PER_LEASE)).toMatchObject({ reason: 'rate-limited', retryMs: expect.any(Number) })
    unavailable = 'storage is down'
    let writes = 0
    h.doc.doc.on('update', () => { writes++ })
    expect(post(POST_RATE_PER_LEASE + 1)).toMatchObject({ reason: 'unavailable', text: unavailable })
    expect(hub.handle(conn, { v: 1, id: 'a2', op: 'acquire', name: 'new', holder: holder('s') }, local)).toMatchObject({ reason: 'unavailable' })
    for (let i = 0; i < 4; i++) {
      h.clock.advance(LEASE_TTL_MS / 2)
      hub.tick()
      expect(hub.handle(conn, { v: 1, id: `r${i}`, op: 'renew', name: 'ada', epoch }, local)).toMatchObject({ ok: true })
    }
    expect(hub.handle(conn, { v: 1, id: 'x', op: 'release', name: 'ada', epoch }, local)).toMatchObject({ reason: 'unavailable' })
    expect(writes).toBe(0)
    expect(h.doc.participants.get('ada\u0000holder')).not.toHaveProperty('ended')
    unavailable = undefined
    hub.tick()
    h.clock.advance(LEASE_TTL_MS)
    hub.tick()
    expect(h.doc.participants.get('ada\u0000holder')).toHaveProperty('ended', 'expired')
  })
  it('grants a name immediately only for a genuinely fresh room', async () => {
    const h = host({ fresh: true } as Partial<HubHost>)
    const hub = await startHub(h)
    const conn = {}
    hub.handle(conn, hello, local)
    const first = hub.handle(conn, { v: 1, id: 'fresh', op: 'acquire', name: 'ada', holder: holder('s1') }, local) as { ok: true; epoch: number }
    expect(first).toMatchObject({ ok: true })

    // A new process loading that room must retain the settle window for old grants.
    hub.stop()
    h.doc.participants.delete('ada\u0000holder') // the old grant's holder record has not synced yet
    const reopened = host({ doc: h.doc, fresh: true } as Partial<HubHost>)
    const next = await startHub(reopened)
    const other = {}
    next.handle(other, hello, local)
    expect(next.handle(other, { v: 1, id: 'reopen', op: 'acquire', name: 'ben', holder: holder('s2') }, local)).toMatchObject({ ok: false, reason: 'starting' })
    expect(next.handle(other, { v: 1, id: 'renew', op: 'renew', name: 'ada', epoch: first.epoch }, local)).toMatchObject({ ok: false, reason: 'not-yours' })
    next.stop()
  })

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
    h.clock.advance(SETTLE_MS)
    const { epoch } = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s1') }, local) as { epoch: number }
    const post = (id: string) => hub.handle(conn, { v: 1, id, op: 'post', lease: { name: 'ada', epoch }, msg: { id, type: 'note', from: 'ada', text: id } }, local) as { ok: boolean; seq?: number; reason?: string }
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
    h.clock.advance(SETTLE_MS)
    const { epoch } = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s1') }, local) as { epoch: number }
    hub.handle(conn, { v: 1, id: 'p', op: 'post', lease: { name: 'ada', epoch }, msg: { id: 'q1', type: 'question', from: 'ada', to: 'bob', text: '?' } }, local)
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
    const here = (hub.handle(conn, { v: 1, id: 'b', op: 'acquire', name: 'here', holder: holder('s2') }, local) as { epoch: number }).epoch
    hub.handle(conn, { v: 1, id: 'c', op: 'release', name: 'gone', epoch }, local)
    h.doc.setScope('gone', { byKind: 'agent', area: 'old', summary: 'left', paths: ['a.txt'] })
    h.doc.setScope('here', { byKind: 'agent', area: 'new', summary: 'here', paths: ['b.txt'] })
    // "here" renews every 15 s throughout; the hub ticks every maintenance period.
    for (let t = 0; t <= ROOM_STALE_MS + MAINTENANCE_MS; t += 15_000) {
      h.clock.advance(15_000)
      expect(hub.handle(conn, { v: 1, id: 'r', op: 'renew', name: 'here', epoch: here }, local)).toMatchObject({ ok: true })
      if (t % MAINTENANCE_MS === 0) hub.tick()
    }
    expect(h.doc.participants.get('gone\u0000holder')).toBeUndefined()
    expect(h.doc.scope('gone')).toBeUndefined()
    expect(h.doc.scope('here')).toBeDefined()
    expect(h.doc.participants.get('here\u0000holder')).toMatchObject({ epoch: here })
    expect(h.logs.some(l => l.includes('expired gone'))).toBe(true)
  })

  it("a return and release between maintenance passes restarts the participant's absence", async () => {
    const h = host()
    const hub = await startHub(h)
    const conn = {}
    hub.handle(conn, hello, local)
    h.clock.advance(SETTLE_MS)
    const acquire = () => (hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s1') }, local) as { epoch: number }).epoch
    hub.handle(conn, { v: 1, id: 'r', op: 'release', name: 'ada', epoch: acquire() }, local)
    // Absent for all but the last two maintenance passes of the stale period.
    for (let t = 0; t < ROOM_STALE_MS - MAINTENANCE_MS; t += MAINTENANCE_MS) { h.clock.advance(MAINTENANCE_MS); hub.tick() }
    h.clock.advance(20_000)
    const back = acquire()
    h.doc.setScope('ada', { byKind: 'agent', area: 'new', summary: 'back', paths: ['a.txt'] })
    h.clock.advance(10_000)
    expect(hub.handle(conn, { v: 1, id: 'r', op: 'release', name: 'ada', epoch: back }, local)).toMatchObject({ ok: true })
    for (let i = 0; i < 3; i++) { h.clock.advance(MAINTENANCE_MS); hub.tick() }
    expect(h.doc.scope('ada')).toBeDefined()
    expect(h.logs.some(l => l.includes('expired ada'))).toBe(false)
  })

  it("expiry's release notices go through the sequencer", async () => {
    const h = host()
    const hub = await startHub(h)
    const conn = {}
    hub.handle(conn, hello, local)
    h.clock.advance(SETTLE_MS)
    const { epoch } = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'gone', holder: holder('s1') }, local) as { epoch: number }
    const { seq } = hub.handle(conn, { v: 1, id: 'p', op: 'post', lease: { name: 'gone', epoch }, msg: { id: 'm1', type: 'note', from: 'gone', text: 'x' } }, local) as { seq: number }
    h.doc.addClaim({ path: 'a.txt', from: 1, to: 1, by: 'gone', byKind: 'agent', intent: 'edit' })
    hub.handle(conn, { v: 1, id: 'r', op: 'release', name: 'gone', epoch }, local)
    const expired = () => h.logs.some(l => l.includes('expired gone'))
    for (let t = 0; t <= ROOM_STALE_MS + MAINTENANCE_MS && !expired(); t += MAINTENANCE_MS) { h.clock.advance(MAINTENANCE_MS); hub.tick() }
    expect(expired()).toBe(true)
    const release = h.doc.messages().find(m => m.type === 'release') as unknown as { seq: number; at: number; from: string }
    expect(release).toMatchObject({ from: 'gone', at: h.clock.wall() })
    expect(release.seq).toBeGreaterThan(seq)
    expect(incarnationOf(release.seq)).toBe(hub.incarnation)
    expect(h.doc.metaMap.get('hubSeq')).toBe(release.seq)
  })

  it('restores the loaded counter mirrors over a stale replica before issuing anything', async () => {
    const doc = new RoomDoc()
    doc.metaMap.set('hubSeq', 123)
    doc.metaMap.set('hubEpoch', 124)
    const h = host({ doc })
    const hub = await startHub(h)
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc.doc))
    replica.transact(() => { replica.getMap('meta').set('hubSeq', 1); replica.getMap('meta').set('hubEpoch', 2) })
    Y.applyUpdate(doc.doc, Y.encodeStateAsUpdate(replica), 'replica')
    expect(doc.metaMap.get('hubSeq')).toBe(1)
    h.clock.advance(SETTLE_MS)
    hub.tick()
    expect(doc.metaMap.get('hubSeq')).toBe(123)
    expect(doc.metaMap.get('hubEpoch')).toBe(124)
  })
})

describe('the hub remembers ended holders', () => {
  const acquire = (hub: Hub, conn: object, sessionId: string) => (hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder(sessionId) }, local) as { epoch: number }).epoch
  /** A replica that saw everything writes `value` over ada's holder (new CRDT items, so it wins). */
  function staleSync(doc: RoomDoc, value: unknown): void {
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc.doc))
    replica.getMap('participants').set('ada\u0000holder', value)
    Y.applyUpdate(doc.doc, Y.encodeStateAsUpdate(replica), 'replica')
  }

  it('a stale replica cannot bring back a superseded or released epoch', async () => {
    const h = host()
    const hub = await startHub(h)
    const conn = {}
    hub.handle(conn, hello, local)
    h.clock.advance(SETTLE_MS)
    const e1 = acquire(hub, conn, 's1')
    const e1Record = h.doc.participants.get('ada\u0000holder')
    const e2 = acquire(hub, conn, 's1')
    expect(hub.handle(conn, { v: 1, id: 'r', op: 'release', name: 'ada', epoch: e2 }, local)).toMatchObject({ ok: true })
    staleSync(h.doc, e1Record)
    expect(h.doc.participants.get('ada\u0000holder')).toMatchObject({ epoch: e1 })
    // The acknowledged release stays acknowledged, before and after re-assertion.
    expect(hub.handle(conn, { v: 1, id: 'r', op: 'release', name: 'ada', epoch: e2 }, local)).toMatchObject({ ok: true })
    hub.tick()
    expect(h.doc.participants.get('ada\u0000holder')).toMatchObject({ epoch: e2, ended: 'released' })
    expect(hub.handle(conn, { v: 1, id: 'r', op: 'release', name: 'ada', epoch: e2 }, local)).toMatchObject({ ok: true })

    // An expired lease, brought back un-ended, is expired again.
    const e3 = acquire(hub, conn, 's1')
    const e3Record = h.doc.participants.get('ada\u0000holder')
    h.clock.advance(LEASE_TTL_MS)
    hub.tick()
    expect(h.doc.participants.get('ada\u0000holder')).toMatchObject({ epoch: e3, ended: 'expired' })
    staleSync(h.doc, e3Record)
    hub.tick()
    expect(h.doc.participants.get('ada\u0000holder')).toMatchObject({ epoch: e3, ended: 'expired' })
  })

  it('the settle window never adopts an epoch this incarnation released, or one below the latest', async () => {
    let max: number | undefined
    const store = serializedStore({ read: async () => max, write: async v => { max = v } })
    const first = host({ store })
    const a = await startHub(first)
    const conn = {}
    a.handle(conn, hello, local)
    first.clock.advance(SETTLE_MS)
    const e1 = acquire(a, conn, 's1')
    const e2 = acquire(a, conn, 's1')
    a.stop()

    // The successor carries e2, which is released inside the settle window.
    const second = host({ store, doc: first.doc })
    const b = await startHub(second)
    b.handle(conn, hello, local)
    expect(b.handle(conn, { v: 1, id: 'r', op: 'release', name: 'ada', epoch: e2 }, local)).toMatchObject({ ok: true })
    // Renews already in flight arrive after the release.
    expect(b.handle(conn, { v: 1, id: 'n', op: 'renew', name: 'ada', epoch: e2 }, local)).toMatchObject({ ok: false, reason: 'stale' })
    expect(b.handle(conn, { v: 1, id: 'n', op: 'renew', name: 'ada', epoch: e1 }, local)).toMatchObject({ ok: false, reason: 'stale' })
    second.clock.advance(SETTLE_MS)
    b.tick()
    expect(first.doc.participants.get('ada\u0000holder')).toMatchObject({ epoch: e2, ended: 'released' })
  })

  /** A hub that granted ada an epoch and stopped: the successor inherits it, seeded from `first.doc` or not. */
  async function predecessor() {
    const first = host()
    const a = await startHub(first)
    const conn = {}
    a.handle(conn, hello, local)
    first.clock.advance(SETTLE_MS)
    const epoch = acquire(a, conn, 's1')
    a.stop()
    return { first, epoch, live: first.doc.participants.get('ada\u0000holder') as Record<string, unknown> }
  }

  for (const adoption of ['seed'] as const) {
    for (const when of ['inside', 'just after'] as const) {
      for (const how of ['released', 'expired'] as const) {
        it(`a late ${how} record ends an epoch adopted by ${adoption}, ${when} the settle window`, async () => {
          const { first, epoch, live } = await predecessor()
          // Seeded, the successor adopts the un-ended holder at start; unseeded, it adopts the holder's renew.
          const second = host({ store: first.store, doc: adoption === 'seed' ? first.doc : new RoomDoc() })
          const b = await startHub(second)
          const pushes: Push[] = []
          b.onPush((_c, p) => pushes.push(p))
          const conn = {}
          b.handle(conn, hello, local)
          const renew = () => b.handle(conn, { v: 1, id: 'n', op: 'renew', name: 'ada', epoch }, local)
          expect(renew()).toMatchObject({ ok: true })
          if (when === 'just after') { second.clock.advance(SETTLE_MS); b.tick() }
          staleSync(second.doc, { ...live, ended: how })
          expect(renew()).toMatchObject({ ok: false, reason: 'stale' })
          const post = { v: 1, id: 'p', op: 'post', lease: { name: 'ada', epoch }, msg: { id: 'm1', type: 'note', from: 'ada', text: 'x' } }
          expect(b.handle(conn, post, local)).toMatchObject({ ok: false, reason: 'stale' })
          expect(pushes).toEqual([{ v: 1, push: 'lease-lost', name: 'ada', epoch, reason: 'expired' }])
          second.clock.advance(SETTLE_MS)
          b.tick()
          expect(second.doc.participants.get('ada\u0000holder')).toEqual({ ...live, ended: how })
          expect(renew()).toMatchObject({ ok: false, reason: 'stale' })
        })
      }
    }
  }

  it("a missing holder record cannot be adopted with an epoch alone", async () => {
    const { first, epoch, live } = await predecessor()
    const second = host({ store: first.store, doc: new RoomDoc() })
    const b = await startHub(second)
    const conn = {}
    b.handle(conn, hello, local)
    const renew = () => b.handle(conn, { v: 1, id: 'n', op: 'renew', name: 'ada', epoch }, local)
    expect(renew()).toMatchObject({ ok: false, reason: 'not-yours' })
    expect(b.handle(conn, { v: 1, id: 'r', op: 'release', name: 'ada', epoch }, local)).toMatchObject({ ok: false, reason: 'stale' })
    second.clock.advance(SETTLE_MS)
    b.tick()
    staleSync(second.doc, live)
    b.tick()
    b.tick()
    expect(second.doc.participants.get('ada\u0000holder')).toMatchObject({ ...live, ended: 'expired' })
    expect(renew()).toMatchObject({ ok: false, reason: 'stale' })
  })
})
