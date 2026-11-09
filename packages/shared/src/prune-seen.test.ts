import { expect, it } from 'vitest'
import { RoomDoc } from './doc.js'

it('retains receipts absent from bus/mail or still in mail, and prunes only ended ids under the fence', () => {
  const room = new RoomDoc()
  for (const id of ['missing', 'archived', 'mailed', 'outcome']) room.seen('ada').set(id, 123)
  room.archive.set('archived', {} as never)
  room.archive.set('mailed', {} as never); room.mail.set('mailed', { id: 'mailed' } as never)
  room.outcomes.set('outcome', {} as never)
  room.pruneSeen('ada', () => false)
  expect(room.seen('ada').size).toBe(4)
  room.pruneSeen('ada', () => true)
  expect([...room.seen('ada').keys()].sort()).toEqual(['mailed', 'missing'])
  room.doc.destroy()
})
