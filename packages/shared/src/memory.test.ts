import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { memorySnapshot } from './memory.js'

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
