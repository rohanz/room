/** Independent authority controls retained for the reduced register/retire operation set. */
import { expect, it } from 'vitest'
import { holder } from './contract.js'
import { bound, local, noticeFixture as fixture } from './notice-fixture.js'

it('refuses malformed and oversized retirement targets without changing inventory or debt', async () => {
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true })
  const original = JSON.stringify(f.record()), target = f.retirement().targets[0]
  for (const change of [
    { ids: [bound('cf:original'), bound('cf:original')] }, { ids: Array.from({ length: 65 }, () => bound('cf:original')) },
    { ids: [null] }, { ids: ['x'.repeat(70_000)] }, { episodes: { [bound('cf:original')]: 'wrong' } }, { expected: 0 },
    { principal: 'local' }, { workerId: 'forged' },
  ]) {
    expect(f.retire(undefined, { targets: [{ ...target, ...change }] })).toMatchObject({ ok: false })
    expect(JSON.stringify(f.record())).toBe(original)
    expect(f.room.outcomes.size).toBe(0)
  }
  for (const extra of [{ principal: 'local' }, { epoch: f.lease.epoch }, { targets: [] }, { workerId: null }])
    expect(f.retire(undefined, extra)).toMatchObject({ ok: false })
})

it('refuses a competing same-name session and forged live epoch retirement', async () => {
  const f = await fixture(), second = {}
  expect(f.publish()).toMatchObject({ ok: true })
  f.hub.handle(second, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 'second' }, local)
  f.hub.noticeContract(second, { capabilities: { 'room.notice-lifecycle': 1 } })
  expect(f.hub.handle(second, { v: 1, id: 'a', op: 'acquire', name: 'A', holder: holder('second') }, local)).toMatchObject({ ok: false, reason: 'held' })
  expect(f.hub.handle(second, { v: 1, id: 'forge', op: 'notice-lifecycle', lease: f.lease, generation: f.hub.incarnation,
    producer: 'retirement', expected: 0, operation: 'forge', ...f.retirement() }, local)).toMatchObject({ ok: false, reason: 'not-yours' })
  expect(f.room.outcomes.size).toBe(0)
})

it('refuses contradictory retirement at an already consumed inventory revision', async () => {
  const f = await fixture()
  expect(f.publish(bound('cf:first'))).toMatchObject({ ok: true })
  expect(f.publish(bound('cf:second'), { expected: 1 })).toMatchObject({ ok: true })
  const first = f.retirement([bound('cf:first')]), second = f.retirement([bound('cf:second')])
  expect(f.request(first)).toMatchObject({ ok: true })
  expect(f.request(second)).toMatchObject({ ok: false, reason: 'stale' })
  expect(f.room.outcomes.has(bound('cf:second'))).toBe(false)
})

it('rejects all removed completion, member, withdrawal and adoption fields/actions', async () => {
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true })
  const before = JSON.stringify(f.record())
  for (const extra of [{ transition: 'complete' }, { transition: 'update' }, { transition: null }, { transition: {} },
    { member: 'exact' }, { member: 'x'.repeat(129) }, { end: [bound('cf:original')] }, { reason: 'withdraw-authority' }, { successor: 'next' }]) {
    expect(f.publish(bound('cf:invalid'), { expected: 1, ...extra })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(f.retire(undefined, extra)).toMatchObject({ ok: false, reason: 'invalid' })
  }
  for (const action of ['complete', 'end', 'adopt', 'publish']) expect(f.request({ action })).toMatchObject({ ok: false })
  expect(JSON.stringify(f.record())).toBe(before)
  expect(f.room.outcomes.size).toBe(0)
})

it('never enables registration or retirement without negotiation or changes baseline post envelopes', async () => {
  const f = await fixture(false)
  expect(f.publish()).toMatchObject({ ok: false, reason: 'version' })
  expect(f.retire()).toMatchObject({ ok: false, reason: 'version' })
  for (const extra of [{ transition: 'complete' }, { member: 'exact' }, { workerId: 'w1' }])
    expect(f.hub.handle(f.conn, { v: 1, id: 'ordinary', op: 'post', lease: f.lease, auto: true, msg: f.message('cf:ordinary'), ...extra }, local)).toMatchObject({ ok: false, reason: 'invalid' })
})

it('duplicate and foreign-target retirement cannot end a new registered id', async () => {
  const f = await fixture()
  expect(f.publish(bound('cf:old'))).toMatchObject({ ok: true })
  const completed = f.retirement([bound('cf:old')], { operation: 'retire-old' })
  expect(f.request(completed)).toMatchObject({ ok: true })
  expect(f.publish(bound('cf:new'), { expected: 2 })).toMatchObject({ ok: true })
  expect(f.request(completed)).toMatchObject({ ok: true, duplicate: true })
  expect(f.retire([bound('cf:new')], { targets: [{ ...f.retirement([bound('cf:new')]).targets[0], producer: 'another-producer' }] })).toMatchObject({ ok: false })
  expect(f.room.outcomes.has(bound('cf:new'))).toBe(false)
})

it('mixed valid and foreign-worker targets reject atomically without changing ordinary post ordering', async () => {
  const f = await fixture()
  expect(f.publish(bound('cf:one'))).toMatchObject({ ok: true })
  expect(f.publish(bound('cf:two'), { producer: 'producer-two' })).toMatchObject({ ok: true })
  const before = JSON.stringify(f.room.doc.getMap('noticeInventory').toJSON())
  const good = f.retirement([bound('cf:one')]).targets[0]
  expect(f.retire([bound('cf:one')], { targets: [good, { producer: 'producer-two', expected: 1,
    ids: [bound('cf:not-registered')], episodes: { [bound('cf:not-registered')]: 'registration-token' } }] })).toMatchObject({ ok: false })
  expect(JSON.stringify(f.room.doc.getMap('noticeInventory').toJSON())).toBe(before)
  expect(f.room.outcomes.size).toBe(0)
  const previousSeq = (f.room.message(bound('cf:two')) as any).seq
  const ordinary = f.hub.handle(f.conn, { v: 1, id: 'ordinary', op: 'post', lease: f.lease, auto: true, msg: f.message(bound('cf:ordinary')) }, local)
  expect(ordinary).toMatchObject({ ok: true, seq: previousSeq + 1 })
})

it('forged dependency fields and worker-view edits cannot introduce retirement authority', async () => {
  const f = await fixture()
  for (const extra of [{ dependencies: [{ workerId: 'fake', principal: 'local' }] }, { principal: 'local' }, { workerId: 'fake' }])
    expect(f.publish(bound('cf:invalid'), extra)).toMatchObject({ ok: false, reason: 'invalid' })
  f.room.workerViews.set('fake', { id: 'fake', name: 'B', lead: 'A', status: 'running' } as any)
  expect(f.publish()).toMatchObject({ ok: true })
  expect(f.retire(undefined, { workerId: 'fake' })).toMatchObject({ ok: false, reason: 'not-yours' })
  expect(f.record().entries[0].dependencies).toEqual([{ workerId: 'w1', principal: 'local' }])
  expect(f.room.outcomes.size).toBe(0)
})

it('a same-principal retirement assertion is trusted even while the exact worker lease is live', async () => {
  // Deliberate trust boundary: the hub cannot prove the local registry's retirement fact.
  // This control documents the authorized worst case rather than asserting a nonexistent registry check.
  const f = await fixture()
  expect(f.publish()).toMatchObject({ ok: true })
  expect(f.retire()).toMatchObject({ ok: true })
  expect(f.room.participants.get('B\0holder')).toMatchObject({ workerId: 'w1' })
  expect(f.room.outcomes.get(bound('cf:original'))).toMatchObject({ outcome: 'expired' })
})

it('reserved endings remain inside the producer budget after escaped-key saturation', async () => {
  const f = await fixture()
  const producers: string[] = []
  for (let n = 0; n < 200; n++) {
    const producer = `${n}${'\0'.repeat(100)}`
    const reply = f.publish(bound(`cf:budget-${n}`), { producer })
    expect(reply.ok).toBe(true)
    if (!reply.managed) break
    producers.push(producer)
  }
  expect(producers.length).toBeGreaterThan(0)
  for (const [n, producer] of producers.entries()) {
    const id = bound(`cf:budget-${n}`)
    expect(f.retire([id], { targets: [{ producer, expected: 1, ids: [id], episodes: { [id]: 'registration-token' } }] })).toMatchObject({ ok: true })
  }
  expect(Buffer.byteLength(JSON.stringify(f.room.doc.getMap('noticeInventory').toJSON()))).toBeLessThanOrEqual(64 * 1024)
  expect(f.room.outcomes.size).toBe(producers.length)
})

it('refuses managed registration unless the id binds every private worker dependency', async () => {
  const f = await fixture()
  for (const id of ['cf:baseline', 'cf:baseline:worker:forged']) {
    expect(f.publish(id)).toMatchObject({ ok: true, managed: false, fallback: 'unbound' })
    expect(f.room.doc.getMap('noticeInventory').size).toBe(0)
    expect(f.room.message(id)).toBeUndefined()
  }
  expect(f.publish('cf:no-worker', { evidence: f.evidence(['A']) })).toMatchObject({ ok: true, managed: false, fallback: 'unbound' })
  expect(f.room.outcomes.size).toBe(0)
})

it('requires all private worker ids and never rebinds a terminal id to a successor', async () => {
  const f = await fixture()
  const grant = f.hub.handle(f.conn, { v: 1, id: 'owner-worker', op: 'acquire', name: 'A', holder: holder('session-A', { workerId: 'owner-worker' }) }, local)
  expect(grant.ok).toBe(true)
  f.lease.epoch = Number(grant.epoch)
  for (const workers of [[], ['w1'], ['owner-worker'], ['fake', 'w1']]) {
    const id = workers.length ? bound('cf:pair', workers) : 'cf:pair'
    expect(f.publish(id)).toMatchObject({ ok: true, managed: false, fallback: 'unbound' })
  }
  const first = bound('cf:pair', ['w1', 'owner-worker'])
  expect(first).toBe(bound('cf:pair', ['owner-worker', 'w1', 'w1']))
  expect(f.publish(first)).toMatchObject({ ok: true, managed: true })
  expect(f.retire([first])).toMatchObject({ ok: true })
  expect(f.hub.handle(f.worker, { v: 1, id: 'w2', op: 'acquire', name: 'B', holder: holder('session-B', { workerId: 'w2' }) }, local)).toMatchObject({ ok: true })
  expect(f.publish(first, { expected: 2 })).toMatchObject({ ok: true, managed: false, fallback: 'unbound' })
  const second = bound('cf:pair', ['owner-worker', 'w2'])
  expect(f.publish(second, { expected: 2 })).toMatchObject({ ok: true, managed: true })
  expect(f.record().entries[0].dependencies.map(d => d.workerId)).toEqual(['owner-worker', 'w1'])
  expect(f.room.outcomes.has(first)).toBe(true)
  expect(f.room.outcomes.has(second)).toBe(false)
  expect(f.pending()).toContain(second)
})
