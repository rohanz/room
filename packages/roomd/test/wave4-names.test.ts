import { expect, it } from 'vitest'
import { RoomDoc, manifestKey } from '@room/shared'
import { publishManifest } from '../src/manifest-publish.js'
import { policyFromLevel, rulesFromText } from '../src/policy.js'
import { Publisher, withdrawFormerPublisher } from '../src/publisher.js'

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

it('M2 handoff withdrawal leaves a newer holder incarnation intact', () => {
  const room = new RoomDoc(), name = 'ada'
  publishManifest({ room, name, fence: '101', base: 'base', level: 'full', prefixes: [], complete: true },
    [{ path: 'x', change: 'M', hash: 'old', size: 4, text: 'old\n' }])
  publishManifest({ room, name, fence: '102', base: 'base', level: 'full', prefixes: [], complete: true },
    [{ path: 'x', change: 'M', hash: 'new', size: 4, text: 'new\n' }])
  withdrawFormerPublisher(room, name, '101', 'bea')
  expect(room.manifestHead.get(name)).toMatchObject({ fence: '102', coverage: { kind: 'all' } })
  expect(room.manifest.get(manifestKey(name, '102'))?.get('x')?.hash).toBe('new')
  room.doc.destroy()
})

it('tracks the latest publisher across repeated handoffs instead of withdrawing the initial one', () => {
  const room = new RoomDoc()
  const head = { room, fence: '1', base: 'base', level: 'full' as const, prefixes: [], complete: true }
  publishManifest({ ...head, name: 'first' }, [])
  publishManifest({ ...head, name: 'second' }, [])
  const host = { name: 'third', roomDoc: room, fence: undefined, stopped: true,
    inputs: { policy: { publisher: false, publisherName: 'first' } } } as unknown as ConstructorParameters<typeof Publisher>[0]
  const publisher = new Publisher(host)
  const next = { ...host.inputs, policy: { ...host.inputs.policy, publisher: false, publisherName: 'second' } }
  publisher.applyInputs(next)
  publisher.applyInputs({ ...next, policy: { ...next.policy, publisher: true, publisherName: undefined } })
  expect(room.manifestHead.get('second')).toMatchObject({ publisher: 'third', coverage: { kind: 'none', reason: 'not-publisher' } })
  expect(room.manifestHead.get('first')?.coverage).toEqual({ kind: 'all' })
  publisher.stop()
  room.doc.destroy()
})

it('policy-only publication preserves the last full disk scan clock', () => {
  const room = new RoomDoc()
  publishManifest({ room, name: 'ada', fence: '1', base: 'base', level: 'full', prefixes: [], complete: true, scannedAt: 1 }, [])
  const inputs = { policy: policyFromLevel('full'), rules: rulesFromText('', 1000, 1000), head: 'base' }
  const host = { name: 'ada', roomDoc: room, fence: '1', stopped: true, inputs } as unknown as ConstructorParameters<typeof Publisher>[0]
  const publisher = new Publisher(host)
  publisher.applyInputs({ ...inputs, policy: policyFromLevel('declared') })
  expect(room.manifestHead.get('ada')?.scannedAt).toBe(1)
  publisher.stop()
  room.doc.destroy()
})
