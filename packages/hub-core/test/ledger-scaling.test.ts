import { expect, it, vi } from 'vitest'
import { BUS_BYTES, RoomDoc, deliveryIndex, type Msg } from '@room/shared'
import { startHub, serializedStore, SETTLE_MS } from '../src/index.js'
import { fakeClock, holder } from './contract.js'

const sizes = [100, 1000, 10000]
const message = (id: string): Msg => ({ id, type: 'note', text: 'x', from: 'ada', fromKind: 'agent', priority: 'notify', at: 1 })

// Count values examined by full-array materialization and serialization, including trims.
// The optimized index exposes its changed-entry visits as well; no timing thresholds.
async function costs(n: number, batches = false) {
  const doc = new RoomDoc(), clock = fakeClock()
  doc.bus.push(Array.from({ length: n }, (_, i) => message(`old-${i}`)))
  let durable: number | undefined
  const hub = await startHub({ doc, busKeep: n, fresh: true, mono: clock.mono, wall: clock.wall, log() {},
    store: serializedStore({ read: async () => durable, write: async x => { durable = x } }) })
  clock.advance(SETTLE_MS); hub.tick()
  const conn = {}, p = { local: true } as const
  hub.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 't', sessionId: 's' }, p)
  const lease = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'ada', holder: holder('s') }, p) as { epoch: number }
  let ops = 0
  const index = deliveryIndex(doc).bus
  let visits = index.visits
  const originalArray = doc.bus.toArray.bind(doc.bus)
  const originalStringify = JSON.stringify
  const array = vi.spyOn(doc.bus, 'toArray').mockImplementation(() => { ops += doc.bus.length; return originalArray() })
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
  } finally { array.mockRestore(); json.mockRestore(); hub.stop(); doc.doc.destroy() }
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
