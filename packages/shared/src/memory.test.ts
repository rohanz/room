import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { memorySnapshot } from './memory.js'
import { RoomDoc } from './doc.js'

it('keeps memory by value, excludes all live state and unknown future types, and leaves the source intact', () => {
  const source = new Y.Doc(), wire = new Y.Doc(), restored = new Y.Doc()
  for (const name of ['ledger', 'workers', 'scopes', 'colors', 'meta']) source.getMap(name).set('key', { nested: ['kept'] })
  for (const name of ['bus', 'retiredWorkers']) source.getArray(name).push([{ id: 'kept' }])
  for (const name of ['overlays', 'deleted', 'basetext', 'graphs', 'claims', 'bases', 'overlayAt', 'future']) source.getMap(name).set('key', 'discard')
  const before = Y.encodeStateAsUpdate(source)
  // Exercise unresolved top-level types exactly as the relay receives them over the wire.
  Y.applyUpdate(wire, before)
  Y.applyUpdate(restored, memorySnapshot(wire))
  expect([...restored.share.keys()].sort()).toEqual(['bus', 'colors', 'ledger', 'meta', 'retiredWorkers', 'scopes', 'workers'])
  expect(restored.getArray('bus').toArray()).toEqual([{ id: 'kept' }])
  expect(restored.getMap('workers').toJSON()).toEqual({ key: { nested: ['kept'] } })
  expect(Y.encodeStateAsUpdate(source)).toEqual(before)
  source.destroy(); wire.destroy(); restored.destroy()
})

it('restores read markers from unresolved dynamic maps, bounded by timestamp per participant', () => {
  const source = new RoomDoc(), wire = new Y.Doc(), restored = new RoomDoc()
  const name = 'lead+worker / encoded'
  source.markSeen(name, ['addressed-message'])
  for (let i = 2100; i >= 0; i--) source.seen(name).set(`message-${i}`, i)
  source.seen('other').set('independent', 1)
  source.seen(name).set('invalid', NaN)
  Y.applyUpdate(wire, Y.encodeStateAsUpdate(source.doc))
  Y.applyUpdate(restored.doc, memorySnapshot(wire))
  expect(restored.seen(name).has('addressed-message')).toBe(true)
  expect(restored.seen(name).size).toBe(2000)
  expect(restored.seen(name).has('message-2100')).toBe(true)
  expect(restored.seen(name).has('message-102')).toBe(true)
  expect(restored.seen(name).has('message-101')).toBe(false)
  expect(restored.seen(name).has('invalid')).toBe(false)
  expect(restored.seen('other').get('independent')).toBe(1)
  expect(source.seen(name).size).toBe(2103)
  source.doc.destroy(); wire.destroy(); restored.doc.destroy()
})
