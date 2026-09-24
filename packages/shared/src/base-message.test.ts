import { describe, expect, it } from 'vitest'
import { RoomDoc } from './doc.js'
import { formatMsg } from './messages.js'
import { shouldWakeOnMsg } from './wake.js'
import type { BaseMsg } from './types.js'

describe('base catch-up guidance', () => {
  it('gives the safe command and refusal path in the base message', () => {
    const room = new RoomDoc()
    const message = room.post<BaseMsg>({ name: 'Alice', kind: 'agent' }, {
      type: 'base', prev: 'old', base: 'new', commits: 1, paths: [], summary: 'change',
    })
    const text = formatMsg(message)
    expect(text).toContain('git pull --ff-only --autostash')
    expect(text).toContain('If it refuses, stop and tell your human; never merge another branch into this one.')
    room.doc.destroy()
  })

  it('wakes for same-name human base messages only with uncommitted work', () => {
    const room = new RoomDoc()
    const human = room.post<BaseMsg>({ name: 'Alice', kind: 'human' }, {
      type: 'base', prev: 'old', base: 'new', commits: 1, paths: [], summary: 'change',
    })
    const me = { name: 'Alice', kind: 'agent' } as const
    expect(shouldWakeOnMsg(me, human, [], true).wake).toBe(true)
    expect(shouldWakeOnMsg(me, human, [], false).wake).toBe(false)
    expect(shouldWakeOnMsg(me, { ...human, fromKind: undefined } as unknown as BaseMsg, [], true).wake).toBe(false)
    room.doc.destroy()
  })
})
