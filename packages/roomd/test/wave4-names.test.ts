import { expect, it } from 'vitest'
import { RoomDoc, manifestKey } from '@room/shared'
import { publishManifest } from '../src/manifest-publish.js'

it('M3 removes older owned overlay incarnations when publishing a new grant', () => {
  const room = new RoomDoc()
  const input = { room, name: 'ada', base: 'base', level: 'full' as const, prefixes: [], complete: true }
  const old = manifestKey('ada', '101')
  const next = manifestKey('ada', '102')
  publishManifest({ ...input, fence: '101' }, [{ path: 'secret', change: 'M', hash: 'abc', size: 7, text: 'secret\n' }])
  room.setOverlay(old, 'secret', 'secret\n')
  publishManifest({ ...input, fence: '102' }, [])
  expect(room.manifest.has(old)).toBe(false)
  expect(room.overlayText(old, 'secret')).toBeUndefined()
  room.setOverlay(old, 'straggler', 'old\n')
  publishManifest({ ...input, fence: '102', publisher: 'bea' }, [])
  expect(room.overlayText(old, 'straggler')).toBeUndefined()
  expect(room.overlays.has(next)).toBe(false)
  room.doc.destroy()
})
