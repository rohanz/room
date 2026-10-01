import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type Msg } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

const repo = 'github.com/o/r'
const question = (id: string, to: string): Msg => ({ id, type: 'question', from: 'cy', fromKind: 'agent', to, text: id, at: 1, priority: 'notify' } as Msg)

async function roomState(seed: (room: RoomDoc) => void): Promise<string> {
  const room = new RoomDoc(new Y.Doc()), awareness = new Awareness(room.doc)
  seed(room)
  const s = {
    room, awareness, me: { name: 'cy', kind: 'agent' }, dir: process.cwd(), roomName: repo, roomUrl: `ws://localhost/${encodeURIComponent(repo)}`, browserUrl: '',
    provider: { synced: true, wsconnected: true, awareness }, daemon: { touch() {}, async stop() {} },
    policyStore: testPolicyStore(), ...hubSeam(room),
  } as unknown as Session
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: process.cwd() })
  try { return await tools.call('room_state', {}) } finally { await tools.shutdown() }
}

it('lists an ambiguous migrated name once, with its owed messages and candidates', async () => {
  const out = await roomState(room => {
    const unresolved = room.doc.getMap('unresolved')
    unresolved.set(`${repo}/main\0ben`, { placeholder: '?main', claims: [{ id: 'c1', by: '?main', byKind: 'agent', path: 'a.ts', from: 1, to: 2, intent: 'edit', at: 1 }] })
    unresolved.set(`${repo}/feature%2Fx\0ben`, { placeholder: '?feature', claims: [] })
    room.mail.set('q1', question('q1', '?main'))
    room.mail.set('q2', question('q2', '?feature'))
    room.mail.set('q3', question('q3', 'dee'))
  })
  expect(out).toContain('2 messages and 1 claim for an unresolved name (ben on main or ben on feature/x): ask them to rejoin')
  expect(out).not.toContain('unresolved from')
})

it('prints no line for an unresolved name with nothing owed, nor ever for the Room bot (rc8)', async () => {
  const out = await roomState(room => {
    const unresolved = room.doc.getMap('unresolved')
    // rc8 dogfood: the user's own 0.16 name and the bot `room`, both with nothing owed, repeated on every call.
    unresolved.set(`${repo}/redesign\0rohanz`, { placeholder: '?rohanz', claims: [] })
    unresolved.set(`${repo}/redesign-wave0\0room`, { placeholder: '?room0', claims: [] })
    unresolved.set(`${repo}/redesign\0room`, { placeholder: '?room1', claims: [{ id: 'c1', by: '?room1', byKind: 'bot', path: 'a.ts', from: 1, to: 2, intent: 'edit', at: 1 }] })
    room.mail.set('q1', question('q1', '?room1'))
  })
  expect(out).not.toContain('unresolved name')
  expect(out).not.toContain('nothing owed')
})

it('bounds the candidate names and the number of unresolved lines', async () => {
  const out = await roomState(room => {
    const unresolved = room.doc.getMap('unresolved')
    for (let i = 0; i < 5; i++) unresolved.set(`${repo}/b${i}\0ben`, { placeholder: `?ben${i}`, claims: [] })
    room.mail.set('q1', question('q1', '?ben0'))
    for (let i = 0; i < 8; i++) {
      unresolved.set(`${repo}/main\0p${i}`, { placeholder: `?p${i}`, claims: [] })
      room.mail.set(`p${i}`, question(`p${i}`, `?p${i}`))
    }
  })
  expect(out).toContain('1 message for an unresolved name (ben on b0 or ben on b1 or ben on b2, +2 more): ask them to rejoin')
  expect(out.split('\n').filter(line => line.includes('for an unresolved name'))).toHaveLength(5)
  expect(out).toContain('+4 more unresolved names')
})
