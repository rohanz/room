import { describe, expect, it } from 'vitest'
import { RoomDoc } from './doc.js'
import { formatMsg } from './messages.js'
import { shouldWakeOnMsg } from './wake.js'
import type { BaseMsg, PushedMsg } from './types.js'
import { hubAppend } from './testing.js'

describe('base catch-up guidance', () => {
  it('warns about a rewritten branch without fast-forward advice', () => {
    const room = new RoomDoc()
    const message = hubAppend<PushedMsg>(room, { name: 'Cy', kind: 'agent' }, {
      type: 'pushed', branch: 'feature', upstream: 'origin/feature', fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40),
      commits: 1, paths: [], summary: 'replacement', rewrite: 'yes',
    })
    const text = formatMsg(message)
    expect(text).toContain('rewrote feature (force-push)')
    expect(text).toContain('git pull --ff-only will refuse')
    expect(text).toContain('git fetch && git reset --keep origin/feature')
    expect(text).toContain('git rebase --onto origin/feature')
    expect(text).not.toContain('git pull --ff-only --autostash')
    room.doc.destroy()
  })
  it('gives the safe command and refusal path in the base message', () => {
    const room = new RoomDoc()
    const message = hubAppend<BaseMsg>(room, { name: 'Alice', kind: 'agent' }, {
      type: 'base', prev: 'old', base: 'new', commits: 1, paths: [], summary: 'change',
    })
    const text = formatMsg(message)
    expect(text).toContain('git pull --ff-only --autostash')
    expect(text).toContain('If it refuses, or your push is rejected, stop and tell your human; never merge another branch into this one, and do not undo, rebase or recommit your commits to get past it without their yes.')
    room.doc.destroy()
  })

  it('keeps a historical base message without waking a current session', () => {
    const room = new RoomDoc()
    const human = hubAppend<BaseMsg>(room, { name: 'Alice', kind: 'human' }, {
      type: 'base', prev: 'old', base: 'new', commits: 1, paths: [], summary: 'change',
    })
    const me = { name: 'Alice', kind: 'agent' } as const
    expect(shouldWakeOnMsg(me, human, [], true).wake).toBe(false)
    expect(shouldWakeOnMsg(me, human, [], false).wake).toBe(false)
    expect(shouldWakeOnMsg(me, { ...human, fromKind: undefined } as unknown as BaseMsg, [], true).wake).toBe(false)
    room.doc.destroy()
  })
})
