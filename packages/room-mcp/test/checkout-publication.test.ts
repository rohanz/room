import { expect, it } from 'vitest'
import { RoomDoc, type ManifestHead, type ParticipantView } from '@room/shared'
import { checkoutContact, checkoutPublication, checkoutPublisherName, stalePublication } from '../src/checkout-publication.js'
import { publisherLine } from '../src/tools/share.js'
import type { Session } from '../src/session.js'

function fixture() {
  const room = new RoomDoc()
  const head: ManifestHead = { base: 'base', fence: '1', coverage: { kind: 'all' }, level: 'full',
    excluded: [], complete: true, scannedAt: Date.now(), rev: 1, semRev: 1 }
  for (const name of ['idle', 'active', 'third']) room.participants.set(`${name}\0holder`, { sessionId: name, epoch: 1 })
  room.participants.set('idle\0git', { base: 'base', head: 'base', fence: '1', rev: 1 })
  room.manifestHead.set('idle', head)
  room.manifestHead.set('active', { ...head, publisher: 'idle', coverage: { kind: 'none', reason: 'not-publisher' } })
  const view: ParticipantView[] = ['idle', 'active'].map(name => ({ name, fresh: true, visible: true,
    holder: { sessionId: name, epoch: 1 }, idleMin: name === 'idle' ? 480 : 0 }))
  return { room, head, view }
}

it('keeps the terminal publisher identity for Git, text and acknowledgements while retaining link snapshots', () => {
  const { room } = fixture()
  const result = checkoutPublication(room, 'active', [])
  expect(result.snap?.name).toBe('idle')
  expect(result.snap?.record?.git?.head).toBe('base')
  expect(result.links.map(s => s.name)).toEqual(['active', 'idle'])
  room.doc.destroy()
})

it('refuses unfenced alias links and terminates cycles without reading a different publisher', () => {
  const { room, head } = fixture()
  room.manifestHead.set('active', { ...head, fence: '0', publisher: 'idle', coverage: { kind: 'none', reason: 'not-publisher' } })
  expect(checkoutPublication(room, 'active', []).snap?.fenceValid).toBe(false)
  room.manifestHead.set('active', { ...head, publisher: 'idle', coverage: { kind: 'none', reason: 'not-publisher' } })
  room.manifestHead.set('idle', { ...head, publisher: 'active', coverage: { kind: 'none', reason: 'not-publisher' } })
  expect(checkoutPublication(room, 'active', []).snap).toBeUndefined()
  expect(checkoutPublisherName(room, 'active')).toBeUndefined()
  room.doc.destroy()
})

it('routes checkout publication questions to the active session before and after handoff', () => {
  const { room, head, view } = fixture()
  expect(checkoutContact(room, 'idle', view)).toBe('active')
  room.manifestHead.set('active', head)
  room.manifestHead.set('idle', { ...head, publisher: 'active', coverage: { kind: 'none', reason: 'not-publisher' } })
  expect(checkoutContact(room, 'idle', view)).toBe('active')
  const awareness = { getStates: () => new Map(view.map((p, i) => [i, { user: { name: p.name }, sessionId: p.name, idleMin: p.idleMin }])) }
  const s = { room, me: { name: 'idle' }, awareness } as unknown as Session
  expect(publisherLine(s)).toContain('Address active')
  room.doc.destroy()
})

it('uses the full scan clock, including invalid or future timestamps', () => {
  const { room } = fixture()
  const snap = checkoutPublication(room, 'active', []).snap!
  expect(stalePublication(room, snap, snap.head.scannedAt + 119_000)).toBe(false)
  expect(stalePublication(room, snap, snap.head.scannedAt + 121_000)).toBe(true)
  expect(stalePublication(room, snap, snap.head.scannedAt - 1)).toBe(true)
  room.doc.destroy()
})

it('displays an announced publisher before its first manifest, while text remains unavailable', () => {
  const { room } = fixture()
  room.manifestHead.delete('idle')
  expect(checkoutPublisherName(room, 'active')).toBe('idle')
  expect(checkoutPublication(room, 'active', []).snap).toBeUndefined()
  room.doc.destroy()
})
