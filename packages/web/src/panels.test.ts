import { describe, expect, it } from 'vitest'
import { RoomDoc, type Claim, type Msg, type Presence, type Scope } from '@room/shared'
import { parseRoomUrl } from './conn.ts'
import { deriveParticipants, feedMessages, threadFeed } from './panels.ts'

describe('room URL parsing', () => {
  it('keeps the last segment encoded for y-websocket and decodes it for display', () => {
    expect(parseRoomUrl('ws://localhost:1244/local%2Fbare%2Fmain')).toEqual({
      serverUrl: 'ws://localhost:1244',
      encodedRoomName: 'local%2Fbare%2Fmain',
      displayRoomName: 'local/bare/main',
    })
  })
})

describe('participant card derivation', () => {
  it('unions awareness, scope and overlay names and marks old offline claims stale', () => {
    const now = 2_000_000
    const presences: Presence[] = [
      { user: { name: 'Rohan', kind: 'human', color: '#111' }, status: 'viewing', lastActive: now - 2_000 },
      { user: { name: 'Rohan', kind: 'agent', color: '#222' }, status: 'working', lastActive: now - 1_000 },
    ]
    const scope: Scope = { by: 'Kieran', byKind: 'agent', area: 'auth', summary: 'tokens', paths: ['src/auth'], at: 1 }
    const oldClaim: Claim = { id: 'c1', path: 'src/auth/token.ts', from: 2, to: 4, by: 'Kieran', byKind: 'agent', intent: 'rotate token', at: now - 11 * 60_000 }
    const changes = new Map<string, string[]>([
      ['Rohan', ['src/ui.ts']],
      ['Kieran', ['src/auth/token.ts']],
      ['Ada', ['README.md']],
    ])

    const result = deriveParticipants({
      presences,
      scopes: [['Kieran', scope]],
      overlayPeople: ['Ada'],
      changesByPerson: changes,
      claims: [oldClaim],
      now,
    })

    expect(result.map(person => person.name)).toEqual(['Ada', 'Kieran', 'Rohan'])
    expect(result.find(person => person.name === 'Rohan')).toMatchObject({
      online: true,
      latestActive: now - 1_000,
      kinds: ['agent', 'human'],
      files: ['src/ui.ts'],
    })
    expect(result.find(person => person.name === 'Kieran')).toMatchObject({
      online: false,
      scope: { area: 'auth' },
      claims: [{ id: 'c1', stale: true }],
    })
  })
})

describe('feed threading', () => {
  it('nests answers under their question and leaves unrelated entries in order', () => {
    const messages: Msg[] = [
      { id: 'q1', type: 'question', priority: 'notify', from: 'Rohan', fromKind: 'agent', at: 1, text: 'Which shape?' },
      { id: 'm1', type: 'note', priority: 'fyi', from: 'Ada', fromKind: 'human', at: 2, text: 'Looking' },
      { id: 'a1', type: 'answer', priority: 'notify', from: 'Kieran', fromKind: 'agent', at: 3, inReplyTo: 'q1', text: 'Use v2' },
    ]

    const threads = threadFeed(messages)
    expect(threads.map(thread => thread.message.id)).toEqual(['q1', 'm1'])
    expect(threads[0].replies.map(reply => reply.id)).toEqual(['a1'])
  })
})

describe('feed area filtering', () => {
  it('uses the derived ledger for areas and supports all-ledger filtering', () => {
    const room = new RoomDoc()
    room.setScope({ by: 'Kieran', byKind: 'agent', area: 'auth', summary: 'tokens', paths: ['src/auth'], at: 1 })
    room.setScope({ by: 'Ada', byKind: 'human', area: 'docs', summary: 'guide', paths: ['docs'], at: 2 })
    room.bus.push([
      { id: 'scope-auth', type: 'scope', priority: 'notify', from: 'Kieran', fromKind: 'agent', at: 1, area: 'auth', summary: 'tokens', paths: ['src/auth'] },
      { id: 'auth-change', type: 'changed', priority: 'fyi', from: 'Kieran', fromKind: 'agent', at: 2, paths: ['src/auth/token.ts'], summary: 'rotated' },
      { id: 'docs-change', type: 'changed', priority: 'fyi', from: 'Ada', fromKind: 'human', at: 3, paths: ['docs/guide.md'], summary: 'expanded' },
      { id: 'note', type: 'note', priority: 'fyi', from: 'Ada', fromKind: 'human', at: 4, text: 'hello' },
    ])

    expect(feedMessages(room, 'auth', false).map(message => message.id)).toEqual(['scope-auth', 'auth-change'])
    expect(feedMessages(room, 'all', true).map(message => message.id)).toEqual(['scope-auth', 'auth-change', 'docs-change'])
    expect(feedMessages(room, 'all', false).map(message => message.id)).toEqual(['scope-auth', 'auth-change', 'docs-change', 'note'])
  })
})
