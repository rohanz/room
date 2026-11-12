import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import { deliveryIndex, retireRecipient, trim, OUTCOMES_BYTES, OUTCOMES_MAX } from './delivery.js'
import type { Msg } from './types.js'

it('measures pinned outcomes with maximum small-body occupancy', () => {
  const room = new RoomDoc()
  try {
    const long = 'a'.repeat(300)
    room.doc.transact(() => {
      for (let i = 0; i < 2000; i++) room.bus.push([{ id: `m${i}`, from: long, fromKind: 'agent', to: long + 'w', type: 'note', text: '', priority: 'notify', at: 1 } satisfies Msg])
      retireRecipient(room, long + 'w', 2)
    })
    trim(room, 3)
    const busBytes = room.messages().reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0)
    const outcomeBytes = [...room.outcomes].reduce((n, [id, o]) => n + id.length + Buffer.byteLength(JSON.stringify(o)), 0)
    console.log('REVIEW_MAIL2_BOUND', { busBytes, outcomeBytes, outcomes: room.outcomes.size, bus: room.messages().length })
    expect(room.outcomes.size).toBeLessThanOrEqual(OUTCOMES_MAX)
    expect(outcomeBytes).toBeLessThanOrEqual(Math.max(OUTCOMES_BYTES, busBytes + 128 * room.messages().length))
    expect(deliveryIndex(room).verify()).toBeUndefined()
  } finally { room.doc.destroy() }
})

it('does not resurrect retired mail after diagnostic pruning with the sole hub trimming', () => {
  const a = new RoomDoc(), b = new RoomDoc()
  try {
    a.bus.push([{ id: 'old', from: 'lead', fromKind: 'agent', to: 'lead+w', type: 'question', text: 'hello', priority: 'notify', at: 1 } satisfies Msg])
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc))
    retireRecipient(a, 'lead+w', 2)
    // Enough newer diagnostics to evict the old marker when its bus body leaves.
    for (let i = 0; i < 2000; i++) a.outcomes.set(`new-${i}`, { from: 'lead', to: 'other', outcome: 'recipient-retired', at: 3 })
    trim(a, 4, { busKeep: 0 })
    expect(a.outcomes.has('old')).toBe(false)
    // B is a participant replica: only A, the room's hub, may trim bus bodies into mail.
    const au = Y.encodeStateAsUpdate(a.doc), bu = Y.encodeStateAsUpdate(b.doc)
    Y.applyUpdate(a.doc, bu); Y.applyUpdate(b.doc, au)
    for (const room of [a, b]) {
      expect(deliveryIndex(room).verify()).toBeUndefined()
      expect(deliveryIndex(room).pending.has('old')).toBe(false)
    }
  } finally { a.doc.destroy(); b.doc.destroy() }
})
