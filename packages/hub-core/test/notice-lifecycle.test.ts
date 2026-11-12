import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { OUTCOMES_TTL_MS, trim } from '@room/shared'
import * as core from '../src/index.js'
import { holder } from './contract.js'
import { bound, local, noticeFixture as fixture } from './notice-fixture.js'

it('registers atomically; worker retirement is set-once, duplicate and contradictory intents are fenced', async () => {
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true, managed: true, revision: 1 })
  const ending = f.retirement([bound('cf:original')], { operation: 'retire-once' })
  expect(f.request(ending)).toMatchObject({ ok: true })
  const at = f.room.outcomes.get(bound('cf:original'))?.at
  f.clock.advance(100)
  expect(f.request(ending)).toMatchObject({ ok: true, duplicate: true })
  expect(f.room.outcomes.get(bound('cf:original'))?.at).toBe(at)
  expect(f.request({ ...ending, workerId: 'another-worker' })).toMatchObject({ ok: false })
})

it('rejects stale registration evidence, producer revisions and producer incarnations', async () => {
  const f = await fixture(), evidence = f.evidence()
  f.room.claims.set('new', { id: 'new', by: 'B', byKind: 'agent', path: 'x', from: 1, to: 2, intent: 'edit', at: 1 })
  expect(f.publish(bound('cf:stale'), { evidence })).toMatchObject({ ok: false, reason: 'stale' })
  expect(f.publish()).toMatchObject({ ok: true })
  expect(f.publish(bound('cf:stale-rev'))).toMatchObject({ ok: false, reason: 'stale' })
  const grant = f.hub.handle(f.conn, { v: 1, id: 'again', op: 'acquire', name: 'A', holder: holder('session-A') }, local)
  f.lease.epoch = Number(grant.epoch)
  expect(f.publish(bound('cf:old-producer'), { expected: 1 })).toMatchObject({ ok: false, reason: 'stale' })
  expect(f.publish(bound('cf:new-producer'), { producer: 'producer-new' })).toMatchObject({ ok: true })
})

it('rejects an old-epoch queued retirement after a new same-name lease takes authority', async () => {
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true })
  const old = { ...f.lease }, next = {}
  f.hub.handle(next, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'new', sessionId: 'new' }, local)
  f.hub.noticeContract(next, { capabilities: { 'room.notice-lifecycle': 1 } })
  const grant = f.hub.handle(next, { v: 1, id: 'a', op: 'acquire', name: 'A', supersedes: old.epoch, holder: holder('new') }, local)
  expect(grant.ok).toBe(true)
  expect(f.retire()).toMatchObject({ ok: false, reason: 'stale' })
  expect(f.room.outcomes.size).toBe(0)
  expect(f.hub.handle(next, { v: 1, id: 'end', op: 'notice-lifecycle', generation: f.hub.incarnation,
    lease: { name: 'A', epoch: grant.epoch }, producer: 'retirement', expected: 0, operation: 'new', ...f.retirement() }, local)).toMatchObject({ ok: true })
})

it('registration never consumes notify, partial fyi or clean-looking messages; evaluated operations are invalid', async () => {
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true })
  expect(f.publish(bound('cf:refused'), { expected: 1, msg: { ...f.message(bound('cf:refused')), text: 'x'.repeat(70_000) } })).toMatchObject({ ok: false })
  expect(f.publish(bound('cf:partial'), { expected: 1, msg: f.message(bound('cf:partial'), 'fyi') })).toMatchObject({ ok: true })
  expect(f.publish(bound('cf:clean'), { expected: 2, msg: f.message(bound('cf:clean'), 'fyi', true) })).toMatchObject({ ok: true })
  for (const extra of [{ end: [bound('cf:original')] }, { transition: 'complete' }, { transition: 'update' }, { member: 'x' }, { group: 'g' }])
    expect(f.publish(bound('cf:illegal'), { expected: 3, ...extra })).toMatchObject({ ok: false, reason: 'invalid' })
  for (const action of ['end', 'adopt', 'publish', 'complete']) expect(f.request({ action })).toMatchObject({ ok: false })
  expect(f.room.outcomes.size).toBe(0)
})

it('reasserts private inventory over forged replicas and rejects unknown historical retirement ids', async () => {
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true })
  const before = f.record()
  f.room.doc.getMap('noticeInventory').set('producer-A', { ...before, revision: 999, entries: {} })
  f.hub.tick()
  expect(f.record()).toEqual(before)
  expect(f.retire([bound('cf:historical')])).toMatchObject({ ok: false })
  expect(f.room.outcomes.size).toBe(0)
})

it('terminal registration and raw posts cannot resurrect ids after outcome/archive GC', async () => {
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true })
  const ending = f.retirement([bound('cf:original')], { operation: 'ending' })
  expect(f.request(ending)).toMatchObject({ ok: true })
  f.room.bus.delete(0, f.room.bus.length)
  trim(f.room, f.clock.wall() + OUTCOMES_TTL_MS + 1)
  expect(f.room.outcomes.has(bound('cf:original'))).toBe(false)
  expect(f.request(ending)).toMatchObject({ ok: true, duplicate: true })
  expect(f.publish(bound('cf:original'), { expected: 2 })).toMatchObject({ ok: true, gone: true })
  expect(f.hub.handle(f.conn, { v: 1, id: 'raw', op: 'post', lease: f.lease, auto: true, msg: f.message(bound('cf:original')) }, local)).toMatchObject({ ok: true, gone: true })
  expect(f.room.message(bound('cf:original'))).toBeUndefined()
})

it('requires optional negotiation and writable current authority; baseline posts stay unchanged', async () => {
  const legacy = await fixture(false)
  expect(legacy.publish()).toMatchObject({ ok: false, reason: 'version' })
  expect(legacy.hub.handle(legacy.conn, { v: 1, id: 'base', op: 'post', lease: legacy.lease, auto: true, msg: legacy.message('cf:old') }, local)).toMatchObject({ ok: true })
  expect(core.selectContract(core.CURRENT_COMPAT, { ...core.CURRENT_COMPAT, capabilities: { 'room.ledger': [1] } }, { activeSchema: 2 })).toMatchObject({ ok: true, selection: { capabilities: { 'room.ledger': 1 } } })
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true })
  const req = { v: 1, id: 'retire', op: 'notice-lifecycle', generation: f.hub.incarnation, lease: f.lease,
    producer: 'retirement', expected: 0, operation: 'retire', ...f.retirement() }
  expect(f.hub.handle(f.conn, req, { local: true, readOnly: true } as never)).toMatchObject({ ok: false, reason: 'read-only' })
  f.setAuthority(false)
  expect(f.hub.handle(f.conn, req, local)).toMatchObject({ ok: false, reason: 'not-authority' })
  expect(f.room.outcomes.size).toBe(0)
})

it('reserves per-producer ending capacity at admission saturation', async () => {
  const f = await fixture(), start = performance.now()
  let admitted = 0
  for (; admitted < 200; admitted++) {
    const reply = f.publish(bound(`cf:${admitted}`), { expected: admitted })
    expect(reply.ok).toBe(true)
    if (!reply.managed) break
  }
  expect(admitted).toBeGreaterThanOrEqual(64)
  expect(f.publish(bound('cf:overflow'), { expected: admitted })).toMatchObject({ ok: true, managed: false, fallback: 'capacity' })
  expect(f.retire(Array.from({ length: 64 }, (_, n) => bound(`cf:${n}`)))).toMatchObject({ ok: true })
  expect(f.room.outcomes.size).toBe(64)
  process.stderr.write(`NOTICE_CAPACITY ${JSON.stringify({ admitted, serializedBytes: Buffer.byteLength(JSON.stringify(f.room.doc.getMap('noticeInventory').toJSON())), elapsedMs: performance.now() - start })}\n`)
})

it('empty or freshly repeated retirement endings cannot grow history', async () => {
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true })
  expect(f.retire([])).toMatchObject({ ok: false })
  expect(f.retire()).toMatchObject({ ok: true })
  const before = JSON.stringify(f.record())
  for (let n = 0; n < 10; n++) expect(f.retire()).toMatchObject({ ok: false })
  expect(JSON.stringify(f.record())).toBe(before)
})

it('registration and retirement inventory/outcomes are each visible in a single transaction', async () => {
  const f = await fixture(), observed: unknown[] = []
  f.room.doc.on('afterTransaction', () => { if (f.room.message(bound('cf:original'))) observed.push([f.record()?.revision, f.room.outcomes.has(bound('cf:original'))]) })
  expect(f.publish()).toMatchObject({ ok: true })
  expect(observed).toEqual([[1, false]])
  observed.length = 0
  expect(f.retire()).toMatchObject({ ok: true })
  expect(observed).toEqual([[2, true]])
})

it('requires exact retirement tokens and refuses expired registration horizons', async () => {
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true })
  expect(f.retire(undefined, { targets: [{ producer: 'producer-A', expected: 1, ids: [bound('cf:original')], episodes: { [bound('cf:original')]: 'wrong' } }] })).toMatchObject({ ok: false, reason: 'stale' })
  f.clock.advance(15 * 24 * 60 * 60_000)
  const grant = f.hub.handle(f.conn, { v: 1, id: 'again', op: 'acquire', name: 'A', holder: holder('session-A') }, local)
  f.lease.epoch = Number(grant.epoch)
  expect(f.retire()).toMatchObject({ ok: false, reason: 'stale' })
  expect(f.room.outcomes.size).toBe(0)
})

it('room admission is bounded while retirement progresses at room saturation', async () => {
  const f = await fixture(), start = performance.now()
  let admitted = 0, saturated = false
  let first!: { conn: object; lease: { name: string; epoch: number }; producer: string }
  for (let p = 0; p < 32 && !saturated; p++) {
    const name = `P${p}`, conn = {}, producer = `producer-${name}`
    f.hub.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'capacity', sessionId: name }, local)
    f.hub.noticeContract(conn, { capabilities: { 'room.notice-lifecycle': 1 } })
    const epoch = Number(f.hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name, holder: holder(name) }, local).epoch)
    const lease = { name, epoch }
    if (!p) first = { conn, lease, producer }
    for (let n = 0; n < 200; n++) {
      f.clock.advance(20)
      const reply = f.hub.handle(conn, { v: 1, id: `p${n}`, op: 'notice-lifecycle', action: 'register', lease, generation: f.hub.incarnation,
        producer, expected: n, operation: `reg-${n}`, evidence: f.evidence([name, 'B']), episode: `token-${name}`, msg: { ...f.message(bound(`cf:room:${name}:${n}`)), to: name } }, local) as any
      expect(reply.ok).toBe(true)
      if (!reply.managed) { if (!n) saturated = true; break }
      admitted++
    }
  }
  expect(saturated).toBe(true)
  expect(admitted).toBeLessThanOrEqual(core.NOTICE_ROOM_IDS)
  const root = f.room.doc.getMap<core.NoticeRecord>('noticeInventory'), bytes = Buffer.byteLength(JSON.stringify(root.toJSON()))
  expect(bytes).toBeLessThanOrEqual(core.NOTICE_ROOM_BYTES)
  const record = root.get(first.producer)!, entries = record.entries.slice(0, 64)
  expect(f.hub.handle(first.conn, { v: 1, id: 'retire', op: 'notice-lifecycle', action: 'retire', lease: first.lease, generation: f.hub.incarnation,
    producer: 'retirement', expected: 0, operation: 'retire-capacity', workerId: 'w1', targets: [{ producer: first.producer, expected: record.revision,
      ids: entries.map(e => e.id), episodes: Object.fromEntries(entries.map(e => [e.id, e.episode])) }] }, local)).toMatchObject({ ok: true })
  expect(entries.every(e => f.room.outcomes.has(e.id))).toBe(true)
  process.stderr.write(`NOTICE_ROOM_CAPACITY ${JSON.stringify({ admitted, serializedBytes: bytes, ydocBytes: Y.encodeStateAsUpdate(f.room.doc).byteLength, elapsedMs: performance.now() - start })}\n`)
})

it('lost hub inventory is unknown after restart, never ended or retroactively registered', async () => {
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true })
  f.hub.stop()
  const next = await core.startHub({ doc: f.room, mono: f.clock.mono, wall: f.clock.wall, log() {}, store: core.serializedStore({ read: async () => undefined, write: async () => {} }) })
  try {
    f.clock.advance(core.SETTLE_MS)
    const conn = {}
    next.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'new', sessionId: 'new' }, local)
    next.noticeContract(conn, { capabilities: { 'room.notice-lifecycle': 1 } })
    const grant = next.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'A', holder: holder('new') }, local)
    const base = { v: 1, op: 'notice-lifecycle', generation: next.incarnation, lease: { name: 'A', epoch: grant.epoch } }
    expect(next.handle(conn, { ...base, id: 'retire', producer: 'retirement', expected: 0, operation: 'old', ...f.retirement() }, local)).toMatchObject({ ok: false })
    const worker = {}
    next.handle(worker, { v: 1, id: 'h-worker', op: 'hello', proto: 1, schema: 2, client: 'worker', sessionId: 'worker' }, local)
    expect(next.handle(worker, { v: 1, id: 'b-worker', op: 'acquire', name: 'B', holder: holder('worker', { workerId: 'w1' }) }, local)).toMatchObject({ ok: true })
    expect(next.handle(conn, { ...base, id: 'register', action: 'register', producer: 'new', expected: 0, operation: 'register', evidence: f.evidence(), episode: 'new', msg: f.message(bound('cf:original')) }, local)).toMatchObject({ ok: true, managed: false, fallback: 'untracked' })
    expect(f.room.outcomes.size).toBe(0)
  } finally { next.stop() }
})

it('exact w1 retirement after w2 takes its tag ends stopped-owner inbound ids and preserves w2', async () => {
  const f = await fixture()
  expect(f.publish(bound('cf:w1'))).toMatchObject({ ok: true })
  expect(f.hub.handle(f.worker, { v: 1, id: 'w2', op: 'acquire', name: 'B', holder: holder('session-B', { workerId: 'w2' }) }, local)).toMatchObject({ ok: true })
  expect(f.publish(bound('cf:w2', ['w2']), { expected: 1 })).toMatchObject({ ok: true })
  f.hub.handle(f.conn, { v: 1, id: 'stop', op: 'release', ...f.lease }, local)
  const conn = {}
  f.hub.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'lead', sessionId: 'second' }, local)
  f.hub.noticeContract(conn, { capabilities: { 'room.notice-lifecycle': 1 } })
  const grant = f.hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'L', holder: holder('second') }, local)
  const intent = { v: 1, id: 'retire', op: 'notice-lifecycle', generation: f.hub.incarnation, lease: { name: 'L', epoch: grant.epoch },
    producer: 'retirement', expected: 0, operation: 'w1', ...f.retirement([bound('cf:w1')]) }
  expect(f.hub.handle(conn, intent, local)).toMatchObject({ ok: true })
  expect(f.hub.handle(conn, intent, local)).toMatchObject({ ok: true, duplicate: true })
  expect(f.pending()).toContain(bound('cf:w2', ['w2']))
  expect(f.room.outcomes.has(bound('cf:w2', ['w2']))).toBe(false)
  expect(f.room.participants.get('B\0holder')).toMatchObject({ workerId: 'w2' })
})

it('principal A cannot retire B dependencies; a second session of principal B can', async () => {
  const f = await fixture(), bob = { id: 'github:bob', login: 'bob', readOnly: false }, alice = { id: 'github:alice', login: 'alice', readOnly: false }
  f.hub.handle(f.worker, { v: 1, id: 'replace', op: 'release', name: 'B', epoch: (f.room.participants.get('B\0holder') as any).epoch }, local)
  const worker = {}
  f.hub.handle(worker, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'worker', sessionId: 'bob' }, bob)
  expect(f.hub.handle(worker, { v: 1, id: 'a', op: 'acquire', name: 'B', holder: holder('bob', { workerId: 'bob-worker' }) }, bob)).toMatchObject({ ok: true })
  const id = bound('cf:original', ['bob-worker'])
  expect(f.publish(id)).toMatchObject({ ok: true, managed: true })
  for (const [principal, name, ok] of [[alice, 'alice', false], [bob, 'bob-second', true]] as const) {
    const conn = {}
    f.hub.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'lead', sessionId: name }, principal)
    f.hub.noticeContract(conn, { capabilities: { 'room.notice-lifecycle': 1 } })
    const grant = f.hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name, holder: holder(name) }, principal)
    expect(f.hub.handle(conn, { v: 1, id: 'retire', op: 'notice-lifecycle', generation: f.hub.incarnation, lease: { name, epoch: grant.epoch },
      producer: 'retirement', expected: 0, operation: 'retire-bob', ...f.retirement([id], { workerId: 'bob-worker' }) }, principal)).toMatchObject({ ok })
  }
  expect(f.room.outcomes.has(id)).toBe(true)
})

it('wrong generation cannot register or end an id', async () => {
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true })
  const before = f.record()
  expect(f.retire(undefined, { generation: f.hub.incarnation + 1 })).toMatchObject({ ok: false, reason: 'stale' })
  expect(f.record()).toEqual(before)
  expect(f.room.outcomes.size).toBe(0)
})

it('counts JSON-escaped producer keys inside the serialized inventory budget', async () => {
  const f = await fixture()
  let admitted = 0
  for (let n = 0; n < 200; n++) {
    const reply = f.publish(bound(`cf:escaped-${n}`), { producer: `${n}${'\0'.repeat(100)}` })
    expect(reply.ok).toBe(true)
    if (!reply.managed) break
    admitted++
  }
  expect(admitted).toBeGreaterThan(0)
  expect(Buffer.byteLength(JSON.stringify(f.room.doc.getMap('noticeInventory').toJSON()))).toBeLessThanOrEqual(core.NOTICE_PRODUCER_BYTES)
})
