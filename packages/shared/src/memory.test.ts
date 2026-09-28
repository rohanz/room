import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { MAX_MEMORY_BYTES, memorySnapshot } from './memory.js'
import { RoomDoc } from './doc.js'
import { RECEIPTS_BYTES, trim } from './delivery.js'
import type { Msg } from './types.js'

const NOW = Date.UTC(2026, 8, 28, 12)
const restore = (source: Y.Doc, opts?: Parameters<typeof memorySnapshot>[1]) => {
  const wire = new Y.Doc(), restored = new RoomDoc()
  // Exercise unresolved top-level types exactly as the relay receives them over the wire.
  Y.applyUpdate(wire, Y.encodeStateAsUpdate(source))
  const update = memorySnapshot(wire, opts)
  Y.applyUpdate(restored.doc, update)
  wire.destroy()
  return { restored, size: update.byteLength }
}
let seq = 0
const message = (fields: Record<string, unknown> = {}): Msg =>
  ({ id: `m_${String(++seq).padStart(6, '0')}`, type: 'note', priority: 'notify', from: 'quinn', fromKind: 'agent', at: NOW - 1000 + seq, text: 'n', ...fields }) as Msg

it('keeps memory by value, excludes all live state and unknown future types, and leaves the source intact', () => {
  const source = new Y.Doc(), wire = new Y.Doc(), restored = new Y.Doc()
  for (const name of ['ledger', 'workers', 'scopes', 'colors', 'meta', 'mail', 'outcomes', 'archive']) source.getMap(name).set('key', { nested: ['kept'] })
  for (const name of ['bus', 'retiredWorkers']) source.getArray(name).push([{ id: 'kept' }])
  for (const name of ['overlays', 'deleted', 'basetext', 'graphs', 'claims', 'bases', 'overlayAt', 'future']) source.getMap(name).set('key', 'discard')
  const before = Y.encodeStateAsUpdate(source)
  Y.applyUpdate(wire, before)
  Y.applyUpdate(restored, memorySnapshot(wire))
  expect([...restored.share.keys()].sort()).toEqual(['archive', 'bus', 'colors', 'ledger', 'mail', 'meta', 'outcomes', 'retiredWorkers', 'scopes', 'workers'])
  expect(restored.getArray('bus').toArray()).toEqual([{ id: 'kept' }])
  expect(restored.getMap('workers').toJSON()).toEqual({ key: { nested: ['kept'] } })
  expect(restored.getMap('mail').toJSON()).toEqual({ key: { nested: ['kept'] } })
  expect(Y.encodeStateAsUpdate(source)).toEqual(before)
  source.destroy(); wire.destroy(); restored.destroy()
})

it('keeps exactly the receipts that bus, mail and outcomes reference: a shown question survives 2,500 later messages (SF5)', () => {
  const source = new RoomDoc()
  const name = 'lead+worker / encoded'
  const q = message({ type: 'question', to: name, text: 'which token?' })
  source.bus.push([q])
  source.markSeen(name, [q.id])
  for (let i = 0; i < 2500; i++) source.bus.push([message()])
  source.markSeen(name, source.messages().map(m => m.id))
  source.seen(name).set('gone', NOW)
  source.seen(name).set('invalid', NaN)
  source.outcomes.set('m_ended', { to: 'other', from: 'quinn', outcome: 'expired', at: NOW })
  source.doc.getMap('seen:other').set('m_ended', { s: 'session', via: 'reply', at: NOW })
  trim(source, NOW)
  expect(source.mail.has(q.id)).toBe(true)

  const { restored } = restore(source.doc)
  expect(restored.mail.get(q.id)).toEqual(q)
  expect(restored.seen(name).has(q.id)).toBe(true)
  expect(restored.seen(name).size).toBe(2001)
  expect(restored.seen(name).has('gone')).toBe(false)
  expect(restored.seen(name).has('invalid')).toBe(false)
  expect(restored.seen('other').get('m_ended')).toEqual({ s: 'session', via: 'reply', at: NOW })
  expect(source.seen(name).size).toBe(2503)
})

it('spends the receipt budget on mail and addressed receipts first, then the newest broadcasts', () => {
  const source = new RoomDoc()
  const addressed = message({ to: 'p0' })
  const mailed = message({ to: 'p1', type: 'answer', inReplyTo: 'q' })
  source.bus.push([addressed])
  source.mail.set(mailed.id, mailed)
  for (let i = 0; i < 2000; i++) source.bus.push([message()])
  const broadcasts = source.messages().slice(1)
  for (let p = 0; p < 20; p++) source.markSeen(`p${p}`, broadcasts.map(m => m.id))
  source.markSeen('p0', [addressed.id])
  source.doc.getMap('seen:p1').set(mailed.id, { s: 'session', via: 'hook', at: NOW })

  const { restored } = restore(source.doc)
  expect(restored.seen('p0').has(addressed.id)).toBe(true)
  expect(restored.seen('p1').has(mailed.id)).toBe(true)
  let kept = 0
  for (let p = 0; p < 20; p++) {
    const seen = restored.seen(`p${p}`)
    expect(seen.has(broadcasts.at(-1)!.id)).toBe(true)
    expect(seen.has(broadcasts[0].id)).toBe(false)
    for (const [id, value] of seen) kept += id.length + JSON.stringify(value).length
  }
  expect(kept).toBeLessThanOrEqual(RECEIPTS_BYTES)
})

it('never exceeds the limit: drops archive oldest first, then broadcast receipts, then the oldest bus broadcasts (MF6)', () => {
  const log = vi.fn()
  const build = (siblingBytes: number) => {
    const source = new RoomDoc()
    source.doc.getMap('workers').set('w', { blob: 'w'.repeat(siblingBytes) })
    const addressed = message({ to: 'pat', text: 'a'.repeat(1000) })
    source.bus.push([addressed])
    for (let i = 0; i < 150; i++) source.bus.push([message({ text: 'b'.repeat(10 * 1024) })])
    for (let i = 0; i < 150; i++) { const m = message({ to: `r${i}`, type: 'question', text: 'm'.repeat(10 * 1024) }); source.mail.set(m.id, m) }
    for (let i = 0; i < 5000; i++) source.archive.set(`a_${String(i).padStart(5, '0')}`, ['changed', 'quinn', NOW - 10_000 + i, ['area-with-a-long-name']])
    source.outcomes.set('m_x', { to: 'pat', from: 'quinn', outcome: 'over-cap', at: NOW })
    source.markSeen('pat', [addressed.id, ...source.messages().slice(1).map(m => m.id)])
    return { source, addressed }
  }

  const light = build(1.9 * 1024 * 1024)
  const first = restore(light.source.doc, { log })
  expect(first.size).toBeGreaterThan(0)
  expect(first.size).toBeLessThanOrEqual(MAX_MEMORY_BYTES)
  expect(first.restored.archive.size).toBeGreaterThan(0)
  expect(first.restored.archive.size).toBeLessThan(5000)
  expect(first.restored.archive.has('a_04999')).toBe(true)
  expect(first.restored.archive.has('a_00000')).toBe(false)
  expect(first.restored.messages()).toHaveLength(151)
  expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/dropped [1-9]\d* archive entries, 0 broadcast receipts, 0 bus broadcasts$/))

  const heavy = build(3.2 * 1024 * 1024)
  const second = restore(heavy.source.doc, { log })
  expect(second.size).toBeLessThanOrEqual(MAX_MEMORY_BYTES)
  expect(second.restored.archive.size).toBe(0)
  expect(second.restored.mail.size).toBe(150)
  expect(second.restored.outcomes.has('m_x')).toBe(true)
  const bus = second.restored.messages()
  expect(bus[0]).toEqual(heavy.addressed)
  expect(bus.length).toBeLessThan(151)
  expect(bus.at(-1)!.id).toBe(heavy.source.messages().at(-1)!.id)
  expect(second.restored.seen('pat').has(heavy.addressed.id)).toBe(true)
  expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/dropped 5000 archive entries, 150 broadcast receipts, [1-9]\d* bus broadcasts$/))
})
