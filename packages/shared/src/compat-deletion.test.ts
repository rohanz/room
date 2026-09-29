import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import { manifestChangers, manifestKey, manifestPaths, type ManifestEntry } from './manifest.js'

it('uses fenced manifests for changed paths without the overlay compatibility readers', () => {
  const room = new RoomDoc()
  room.setOverlay('ben\0old', 'stale.py', 'old')
  const entries = new Y.Map<ManifestEntry>()
  entries.set('held.py', { change: 'M', state: 'held', held: 'scope', at: 1, fence: '22' })
  room.manifest.set(manifestKey('ben', '22'), entries)
  room.manifestHead.set('ben', { base: 'abc', fence: '22', coverage: { kind: 'all' }, level: 'declared', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })
  expect(manifestPaths(room, 'ben')).toEqual(['held.py'])
  expect(manifestChangers(room, 'held.py')).toEqual(['ben'])
  for (const old of ['changedPaths', 'whoChanged', 'paths', 'hasFile', 'markDeleted', 'unmarkDeleted', 'deletedFor', 'deleted', 'overlayAt', 'overlayAtOf']) {
    expect(old in room).toBe(false)
  }
})
