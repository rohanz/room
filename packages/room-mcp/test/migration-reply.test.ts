import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

it('answers an unresolved migrated sender and resolves a later alias', async () => {
  const room = new RoomDoc(new Y.Doc()), awareness = new Awareness(room.doc)
  const placeholder = '?abc123'
  room.mail.set('old-q', { id: 'old-q', type: 'question', from: placeholder, fromKind: 'agent', to: 'cy', text: 'help?', at: 1, priority: 'notify' })
  room.doc.getMap('unresolved').set('local/repo/main\0ben', { placeholder, claims: [] })
  const s = {
    room, awareness, me: { name: 'cy', kind: 'agent' }, dir: process.cwd(), roomName: 'local/repo', roomUrl: 'ws://localhost/local%2Frepo', browserUrl: '',
    provider: { synced: true, wsconnected: true, awareness }, daemon: { touch() {}, async stop() {} },
    policyStore: testPolicyStore(), ...hubSeam(room), local: { url: 'ws://localhost', key: 'key', async stop() {} },
  } as unknown as Session
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: process.cwd() })
  const first = await tools.call('room_send', { type: 'answer', inReplyTo: 'old-q', text: 'yes' })
  expect(first).toContain('sent [')
  expect(room.messages().find(m => m.type === 'answer')?.to).toBe(placeholder)
  room.doc.getMap<string>('aliases').set(placeholder, 'ben')
  room.doc.getMap('unresolved').delete('local/repo/main\0ben')
  const later = await tools.call('room_send', { type: 'note', to: placeholder, text: 'follow up' })
  expect(later).toContain('sent [')
  expect(room.messages().at(-1)?.to).toBe('ben')
  await tools.shutdown()
})

it('prefixes tool and hook output with an actionable size-cap rejection', async () => {
  const room = new RoomDoc(new Y.Doc()), awareness = new Awareness(room.doc)
  const s = {
    room, awareness, me: { name: 'cy', kind: 'agent' }, dir: process.cwd(), roomName: 'local/repo', roomUrl: 'ws://localhost/local%2Frepo', browserUrl: '',
    rejected: { reason: 'room is over its size cap (5 MB)', at: Date.now() },
    provider: { synced: false, wsconnected: false, awareness }, daemon: { touch() {}, async stop() {} },
    policyStore: testPolicyStore(), ...hubSeam(room), local: { url: 'ws://localhost', key: 'key', async stop() {} },
  } as unknown as Session
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: process.cwd() })
  expect(await tools.call('room_state', {})).toContain('your last edits are not in the room')
  expect(tools.hookSelect().notices.join('\n')).toContain('room is over its size cap (5 MB)')
  await tools.shutdown()
})
