import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { BUS_BYTES, OWED_TTL_MS, OUTCOMES_TTL_MS, RoomDoc, admit, deliveryIndex, owed, type Msg } from '@room/shared'
import { startHub, serializedStore, SETTLE_MS } from '../src/index.js'
import { fakeClock, holder } from './contract.js'

const sizes = [100, 1000, 10000]
const message = (id: string): Msg => ({ id, type: 'note', text: 'x', from: 'ada', fromKind: 'agent', priority: 'notify', at: 1 })

// Count values examined by full-array materialization and serialization, including trims.
// The optimized index exposes its changed-entry visits as well; no timing thresholds.
async function costs(n: number, batches = false, memberCopies = false) {
  const doc = new RoomDoc(), clock = fakeClock()
  doc.bus.push(Array.from({ length: n }, (_, i) => message(`old-${i}`)))
  let durable: number | undefined
  const hub = await startHub({ doc, busKeep: n + (memberCopies ? 100 : 0), fresh: true, mono: clock.mono, wall: clock.wall, log() {},
    store: serializedStore({ read: async () => durable, write: async x => { durable = x } }) })
  clock.advance(SETTLE_MS); hub.tick()
  const conn = {}, p = { local: true } as const
  hub.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 't', sessionId: 's' }, p)
  let lease = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s') }, p) as { epoch: number }
  if (memberCopies) doc.doc.transact(() => {
    const owed = { ...message('member'), to: 'pat' }
    doc.mail.set('alias-first', owed)
    doc.mail.set('alias-second', { ...owed, to: 'quinn' })
    doc.bus.push([owed])
  })
  if (memberCopies) {
    clock.advance(60000); hub.tick()
    lease = hub.handle(conn, { v: 1, id: 'a2', op: 'acquire', name: 'ada', holder: holder('s') }, p) as { epoch: number }
  }
  let ops = 0
  const index = deliveryIndex(doc).bus
  let visits = index.visits
  const originalArray = doc.bus.toArray.bind(doc.bus)
  const originalStringify = JSON.stringify
  const array = vi.spyOn(doc.bus, 'toArray').mockImplementation(() => { ops += doc.bus.length; return originalArray() })
  const originalMail = doc.mail.values.bind(doc.mail)
  const mail = vi.spyOn(doc.mail, 'values').mockImplementation(function* () { for (const m of originalMail()) { ops++; yield m } })
  const json = vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof JSON.stringify>) => { ops++; return originalStringify(...args) })
  const posts = batches ? Math.ceil(n / 2) : 20
  try {
    for (let i = 0; i < posts; i++) {
      if (batches) {
        clock.advance(5)
        if (i % 200 === 0) hub.handle(conn, { v: 1, id: `r${i}`, op: 'renew', name: 'ada', epoch: lease.epoch }, p)
      }
      const reply = hub.handle(conn, { v: 1, id: `p${i}`, op: 'post', lease: { name: 'ada', epoch: lease.epoch },
        msg: { id: `new-${i}`, type: 'note', from: 'ada', to: 'pat', text: 'x' } }, p)
      expect(reply.ok).toBe(true)
      if (batches) doc.markSeen('pat', [`new-${i}`], { s: 's', via: 'reply' })
    }
    const post = (ops + index.visits - visits) / posts
    ops = 0; visits = index.visits
    for (let i = 0; i < 20; i++) { doc.metaMap.set('member-update', i); hub.tick() }
    return { post, tick: (ops + index.visits - visits) / 20 }
  } finally { array.mockRestore(); mail.mockRestore(); json.mockRestore(); hub.stop(); doc.doc.destroy() }
}

it('post and member-update ticks do not scan the retained bus', async () => {
  const results = []
  for (const n of sizes) results.push(await costs(n))
  console.log('ledger operation counts', sizes.map((n, i) => ({ n, ...results[i] })))
  expect(results[2].post).toBeLessThanOrEqual(results[0].post * 1.5)
  expect(results[2].tick).toBeLessThanOrEqual(Math.max(1, results[0].tick) * 1.5)
})


it('amortises batch trims over a proportional run of posts', async () => {
  const results = []
  for (const n of sizes) results.push(await costs(n, true))
  console.log('ledger amortised operation counts (including batch trims)', sizes.map((n, i) => ({ n, ...results[i] })))
  expect(results[2].post).toBeLessThanOrEqual(results[0].post * 1.5)
})

it('reasserts newly inserted duplicate and newly archived/outcome ids in array order', async () => {
  const doc = new RoomDoc(), clock = fakeClock()
  let durable: number | undefined
  const hub = await startHub({ doc, mono: clock.mono, wall: clock.wall, log() {},
    store: serializedStore({ read: async () => durable, write: async x => { durable = x } }) })
  clock.advance(SETTLE_MS); hub.tick()
  doc.bus.push([message('a'), message('b'), message('c')])
  hub.tick()
  const earliest = { ...message('a'), text: 'earliest' }
  doc.doc.transact(() => { doc.bus.insert(0, [earliest]); doc.bus.push([message('b')]) })
  hub.tick()
  expect(doc.messages()).toEqual([earliest, message('b'), message('c')])
  doc.archive.set('b', ['note', 'ada', 1, []])
  doc.outcomes.set('c', { to: 'pat', from: 'ada', outcome: 'expired', at: 1 })
  hub.tick()
  expect(doc.messages()).toEqual([earliest])
  const read = vi.spyOn(doc.bus, 'toArray')
  doc.metaMap.set('unrelated', 1); hub.tick()
  expect(read).not.toHaveBeenCalled()
  read.mockRestore()
  expect(doc.message('a')).toEqual(earliest)
  hub.stop(); doc.doc.destroy()
})


it('keeps the serialized bus under its memory budget between byte-triggered trims', async () => {
  const doc = new RoomDoc(), clock = fakeClock()
  let durable: number | undefined
  const hub = await startHub({ doc, fresh: true, mono: clock.mono, wall: clock.wall, log() {},
    store: serializedStore({ read: async () => durable, write: async x => { durable = x } }) })
  const conn = {}, p = { local: true } as const
  hub.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 't', sessionId: 's' }, p)
  const lease = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s') }, p) as { epoch: number }
  for (let i = 0; i < 100; i++) {
    const reply = hub.handle(conn, { v: 1, id: `p${i}`, op: 'post', lease: { name: 'ada', epoch: lease.epoch },
      msg: { id: `big-${i}`, type: 'note', from: 'ada', text: 'x'.repeat(60000) } }, p)
    expect(reply.ok).toBe(true)
    expect(deliveryIndex(doc).bus.bytes).toBeLessThanOrEqual(BUS_BYTES)
  }
  expect(doc.archive.size).toBeGreaterThan(0)
  hub.stop(); doc.doc.destroy()
})


it('keeps per-post work flat after minute repair of aliased and overlapping member mail', async () => {
  const results = []
  for (const n of sizes) results.push(await costs(n, false, true))
  console.log('aliased/overlapping mail operation counts', sizes.map((n, i) => ({ n, ...results[i] })))
  expect(results.map(x => x.post)).toEqual([7, 7, 7])
})

it('delivers a post whose id matches a keyed phantom bus item', async () => {
  const doc = new RoomDoc(), clock = fakeClock(), member = new Y.Doc()
  let durable: number | undefined
  const hub = await startHub({ doc, fresh: true, mono: clock.mono, wall: clock.wall, log() {},
    store: serializedStore({ read: async () => durable, write: async x => { durable = x } }) })
  const conn = {}, p = { local: true } as const
  hub.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 't', sessionId: 's' }, p)
  const lease = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s') }, p) as { epoch: number }
  member.getMap<Msg>('bus').set('key', message('phantom'))
  Y.applyUpdate(doc.doc, Y.encodeStateAsUpdate(member))
  const reply = hub.handle(conn, { v: 1, id: 'p', op: 'post', lease: { name: 'ada', epoch: lease.epoch },
    msg: { id: 'phantom', type: 'note', from: 'ada', to: 'pat', text: 'deliver this' } }, p)
  expect(reply.ok).toBe(true)
  expect(reply.duplicate).not.toBe(true)
  expect(doc.messages().find(m => m.id === 'phantom')).toMatchObject({ text: 'deliver this' })
  hub.stop(); doc.doc.destroy(); member.destroy()
})


it('corrects deliberately corrupted ledger aggregates during minute maintenance', async () => {
  const doc = new RoomDoc(), clock = fakeClock(), logs: string[] = []
  let durable: number | undefined
  const hub = await startHub({ doc, fresh: true, mono: clock.mono, wall: clock.wall, log: line => logs.push(line),
    store: serializedStore({ read: async () => durable, write: async x => { durable = x } }) })
  doc.bus.push([{ ...message('owed'), to: 'pat', at: clock.wall() }])
  hub.tick()
  const index = deliveryIndex(doc)
  index.owedBytes++
  clock.advance(60000); hub.tick()
  expect(index.owedBytes).toBe(new TextEncoder().encode(JSON.stringify(doc.bus.get(0))).length)
  expect(logs).toContain('hub: ledger index drift corrected (owedBytes)')
  hub.stop(); doc.doc.destroy()
})

it('minute maintenance removes bigint member content without recurring failure', async () => {
  const doc = new RoomDoc(), clock = fakeClock(), logs: string[] = []
  let durable: number | undefined
  const hub = await startHub({ doc, fresh: true, mono: clock.mono, wall: clock.wall, log: line => logs.push(line),
    store: serializedStore({ read: async () => durable, write: async x => { durable = x } }) })
  expect(() => doc.bus.push([{ id: 'bad', type: 'note', from: 'ada', text: { nested: 1n } } as never, message('good')])).not.toThrow()
  doc.outcomes.set('bigint-outcome', { to: 'pat', from: 'ada', outcome: 'expired', at: clock.wall(), extra: { nested: 1n } } as never)
  doc.archive.set('bigint-archive', ['note', 'ada', clock.wall(), [1n]] as never)
  for (let i = 0; i < 2; i++) { clock.advance(60000); hub.tick() }
  expect(doc.outcomes.has('bigint-outcome')).toBe(false)
  expect(doc.archive.has('bigint-archive')).toBe(false)
  expect(doc.messages()).toEqual([message('good')])
  expect(logs.filter(line => line.includes('maintenance failed'))).toEqual([])
  hub.stop(); doc.doc.destroy()
})


it.each(['alias', 'duplicate', 'outcome-count', 'outcome-bytes', 'outcome-ttl', 'recipient-cap', 'mail-cap', 'owed-ttl'])(
  'clears the %s certainty guard within one minute and returns to the fast path', async state => {
    const doc = new RoomDoc(), clock = fakeClock(), now = clock.wall()
    let durable: number | undefined
    const hub = await startHub({ doc, fresh: true, busKeep: 1, mono: clock.mono, wall: clock.wall, log() {},
      store: serializedStore({ read: async () => durable, write: async x => { durable = x } }) })
    const fresh = (id: string, to = 'pat') => ({ ...message(id), to, at: now })
    const outcome = { to: 'quinn', from: 'ada', outcome: 'over-cap' as const, at: now }
    doc.doc.transact(() => {
      if (state === 'alias') doc.mail.set('alias', fresh('canonical'))
      if (state === 'duplicate') doc.bus.push([fresh('copy'), fresh('middle'), { ...fresh('copy'), to: 'quinn' }])
      if (state === 'outcome-count') for (let i = 0; i < 2001; i++) doc.outcomes.set(`o-${i}`, outcome)
      if (state === 'outcome-bytes') for (let i = 0; i < 4; i++) doc.outcomes.set(`o-${i}`, { ...outcome, to: 'x'.repeat(65536) })
      if (state === 'outcome-ttl') doc.outcomes.set('old', { ...outcome, at: now - OUTCOMES_TTL_MS - 1 })
      if (state === 'recipient-cap') {
        doc.outcomes.set('other', outcome)
        doc.bus.push(Array.from({ length: 201 }, (_, i) => fresh(`m-${i}`)))
      }
      if (state === 'mail-cap') for (let i = 0; i < 2001; i++) doc.mail.set(`m-${i}`, fresh(`m-${i}`, `p-${i}`))
      if (state === 'owed-ttl') {
        doc.outcomes.set('other', outcome)
        doc.bus.push([{ ...fresh('old'), at: now - OWED_TTL_MS - 1 }])
      }
    })
    const index = deliveryIndex(doc)
    // Overfull mail is also uncertain without existing outcomes (it may contain aliases).
    if (state === 'mail-cap') doc.outcomes.set('other', outcome)
    expect(index.certain(now, { busKeep: 1 })).toBe(false)
    clock.advance(60000); hub.tick()
    expect(index.certain(clock.wall(), { busKeep: 1 })).toBe(true)
    const read = vi.spyOn(doc.bus, 'toArray').mockImplementation(() => { throw new Error('repaired state scanned bus') })
    expect(admit(doc, { to: 'unused-recipient', text: 'x' }, clock.wall(), { busKeep: 1 })).toEqual({ ok: true })
    read.mockRestore(); hub.stop(); doc.doc.destroy()
  })

it.each(['mail', 'bus'])('alias repair preserves the only owed %s copy', async source => {
  const doc = new RoomDoc(), clock = fakeClock(), now = clock.wall()
  let durable: number | undefined
  const hub = await startHub({ doc, fresh: true, busKeep: 0, mono: clock.mono, wall: clock.wall, log() {},
    store: serializedStore({ read: async () => durable, write: async x => { durable = x } }) })
  const wanted = { ...message('pair'), to: 'pat', at: now }
  if (source === 'mail') {
    doc.mail.set('pair', { ...wanted, from: 'pat' }) // self-sent canonical copy, not owed
    doc.mail.set('alias', wanted)
  } else {
    doc.mail.set('alias', { ...wanted, from: 'pat' })
    doc.bus.push([wanted])
  }
  const cursor = { frontier: 0, routed: new Set<string>() }, route = { scopes: [], claims: [] }
  const before = owed(doc, { name: 'pat' }, cursor, route)
  expect(before).toEqual([wanted])
  clock.advance(60000); hub.tick()
  expect(doc.mail.has('alias')).toBe(false)
  expect(owed(doc, { name: 'pat' }, cursor, route)).toEqual(before)
  expect(deliveryIndex(doc).pending.get('pair')).toEqual(wanted)
  hub.stop(); doc.doc.destroy()
})
