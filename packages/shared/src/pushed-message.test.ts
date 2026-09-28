import { describe, expect, it } from 'vitest'
import { RoomDoc } from './doc.js'
import { BASE_CATCH_UP, formatMsg, messageForMe } from './messages.js'
import { shouldWakeOnMsg } from './wake.js'
import type { PushedMsg } from './types.js'
import { hubAppend } from './testing.js'

const body = { type: 'pushed' as const, branch: 'feat-x', upstream: 'origin/feat-x', fromSha: 'a'.repeat(40), toSha: 'd'.repeat(40), commits: 3, paths: ['app.py'], summary: 'fix login' }

describe('pushed notices (reporooms §B4)', () => {
  it('reports an observed upstream advance of the author\'s own commits, addressed to nobody', () => {
    const room = new RoomDoc()
    const message = hubAppend<PushedMsg>(room, { name: 'ben', kind: 'agent' }, body)
    expect(message).toMatchObject({ ...body, priority: 'notify' })
    expect(message.to).toBeUndefined()
    const text = formatMsg(message)
    expect(text).toContain("ben's local commits aaaaaaa..ddddddd are now on origin/feat-x (3 commits: fix login)")
    expect(text).toContain(`if you work on origin/feat-x: ${BASE_CATCH_UP}`)
    expect(messageForMe({ name: 'cy' }, message)).toBe(true)
    expect(messageForMe({ name: 'ben' }, message)).toBe(false)
    room.doc.destroy()
  })

  it('wakes a teammate only with uncommitted work, never its author', () => {
    const room = new RoomDoc()
    const message = hubAppend<PushedMsg>(room, { name: 'ben', kind: 'agent' }, { ...body, commits: 1 })
    expect(formatMsg(message)).toContain('(1 commit: fix login)')
    expect(shouldWakeOnMsg({ name: 'cy', kind: 'agent' }, message, [], true).wake).toBe(true)
    expect(shouldWakeOnMsg({ name: 'cy', kind: 'agent' }, message, [], false).wake).toBe(false)
    expect(shouldWakeOnMsg({ name: 'ben', kind: 'agent' }, message, [], true).wake).toBe(false)
    room.doc.destroy()
  })
})
