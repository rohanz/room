import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc } from './doc.js'
import { deliveryIndex } from './delivery.js'
import { validMessageShape } from './messages.js'
import type { Msg, WorkerView } from './types.js'

it('matches the prior per-name pass for mixed bus/mail, receipts, outcomes and self messages', () => {
  const batch = new RoomDoc(), old = new RoomDoc()
  const names = ['lead+a', 'lead+b', 'lead+c']
  try {
    for (let i = 0; i < 120; i++) {
      const to = [...names, 'ordinary'][i % 4]
      const m: Msg = { id: `m${i}`, type: i % 2 ? 'question' : 'note', from: i % 7 ? 'sender' : to, fromKind: i % 3 ? 'agent' : 'human', to, text: 'hello', at: i, priority: 'notify' }
      if (i % 2) batch.bus.push([m]); else batch.mail.set(m.id, m)
      if (i % 11 === 0) batch.bus.push([m])
      if (i % 5 === 0) batch.seen(to).set(m.id, 100)
      if (i % 9 === 0) batch.outcomes.set(m.id, { from: m.from, to, outcome: i % 18 ? 'expired' : 'recipient-retired', at: 50 })
    }
    Y.applyUpdate(old.doc, Y.encodeStateAsUpdate(batch.doc))
    deliveryIndex(old); deliveryIndex(batch)
    // The exact pre-b15542a0 per-name loop, including mail deletion after setting outcomes.
    old.doc.transact(() => {
      for (const name of names) {
        const addressed = (m: Msg) => validMessageShape(m) && m.to === name && !(m.from === m.to && m.fromKind !== 'human')
        for (const m of [...old.mail.values(), ...old.messages()]) {
          if (addressed(m) && old.outcomes.get(m.id)?.outcome !== 'recipient-retired')
            old.outcomes.set(m.id, { to: name, from: m.from, outcome: 'recipient-retired', at: 200 })
        }
        for (const [id, m] of old.mail) if (addressed(m)) old.mail.delete(id)
      }
    })
    batch.retireWorkerMail(names.map(name => ({ id: name, name })), 200)
    expect(batch.messages()).toEqual(old.messages())
    expect(batch.mail.toJSON()).toEqual(old.mail.toJSON())
    expect(batch.outcomes.toJSON()).toEqual(old.outcomes.toJSON())
    const totals = (room: RoomDoc) => {
      const index = deliveryIndex(room)
      return { bytes: index.owedBytes, recipients: structuredClone(index.recipients), pending: new Map(index.pending) }
    }
    expect(totals(batch)).toEqual(totals(old))
    for (const room of [batch, old]) {
      const before = totals(room)
      deliveryIndex(room).rebuild()
      expect(totals(room)).toEqual(before)
    }
  } finally { batch.doc.destroy(); old.doc.destroy() }
})

it.each(['lead', 'another'])('preserves a live successor owned by %s without a participant holder', lead => {
  const room = new RoomDoc()
  try {
    const name = 'lead+w'
    const view: WorkerView = { id: 'new', name, tag: 'w', lead, host: 'codex', mode: 'local', task: '', branch: 'b', status: 'running', run: 1, startedAt: 1, fence: 'f' }
    room.workerViews.set(view.id, view)
    room.bus.push([{ id: 'fresh', type: 'question', to: name, from: 'sender', fromKind: 'agent', text: 'hello', at: 1, priority: 'notify' }])
    expect(room.retireWorkerMail([{ id: 'old', name }], 2).size).toBe(0)
    expect(deliveryIndex(room).pending.has('fresh')).toBe(true)
    expect(room.outcomes.has('fresh')).toBe(false)
  } finally { room.doc.destroy() }
})
