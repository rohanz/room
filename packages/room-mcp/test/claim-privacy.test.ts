import { expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import { testPolicyStore } from './policy-fixture.js'
import { handlers } from '../src/tools/claims.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'

it('keeps an out-of-area claim digest private while retaining local re-anchoring evidence', async () => {
  const room = new RoomDoc()
  room.setScope({ by: 'Bob', byKind: 'agent', area: 'config', summary: 'edit', paths: ['secret.txt'] })
  room.participants.set('Bob\0holder', { sessionId: 'b', epoch: 1 })
  const rememberClaimDigest = vi.fn()
  const post = vi.fn(() => Object.assign(Promise.resolve({ ok: false, text: 'offline' }), { id: 'msg' }))
  const awareness = { getStates: () => new Map([
    [1, { user: { name: 'Alice', kind: 'agent' }, sessionId: 'a', at: Date.now() }],
    [2, { user: { name: 'Bob', kind: 'agent' }, sessionId: 'b', at: Date.now() }],
  ]) }
  const session = { room, me: { name: 'Alice', kind: 'agent' }, awareness, post, daemon: { rememberClaimDigest, touch() {} },
    policyStore: testPolicyStore('declared') } as unknown as Session
  const state = { S: () => session, readText: async () => 'SECRET_CUSTOMER=alpha\n', lines: () => 1,
    isMe: (_s: Session, p: { name: string }) => p.name === 'Alice', mine: () => [], planChanged: () => [],
    setPresence: () => {}, describeUsers: () => '', loadAreas: async () => {}, ownerHints: () => [],
    areasOf: () => ({ areaOf: () => 'config' }), upgrade: async () => [], log: () => {} } as unknown as HandlerState
  try {
    const result = await handlers(state).room_claim({ path: 'secret.txt', from: 1, to: 1, intent: 'edit' })
    expect(result).toContain('claimed')
    const claim = room.openClaims()[0]!
    expect(claim.claimedHash).toBeUndefined()
    expect(rememberClaimDigest).toHaveBeenCalledWith(claim.id, expect.stringMatching(/^[a-f0-9]{64}$/))
  } finally { room.doc.destroy() }
})
