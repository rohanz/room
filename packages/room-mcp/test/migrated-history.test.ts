import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type Msg, type NoteMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

const repo = 'local/room-redesign'

async function roomStates(seed: (room: RoomDoc) => void): Promise<{ recent: string; all: string }> {
  const room = new RoomDoc(new Y.Doc()), awareness = new Awareness(room.doc)
  seed(room)
  const s = {
    room, awareness, me: { name: 'rohanz', kind: 'agent' }, dir: process.cwd(), roomName: repo, roomUrl: `ws://localhost/${encodeURIComponent(repo)}`, browserUrl: '',
    provider: { synced: true, wsconnected: true, awareness }, daemon: { touch() {}, async stop() {} },
    policyStore: testPolicyStore(), ...hubSeam(room),
  } as unknown as Session
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: process.cwd() })
  try { return { recent: await tools.call('room_state', {}), all: await tools.call('room_state', { all: true }) } }
  finally { await tools.shutdown() }
}

it('keeps migrated Room 0.16 history out of the recent bus, and shows it with all=true (rc8)', async () => {
  const { recent, all } = await roomStates(room => {
    room.metaMap.set('hubIncarnation', 1)
    for (let i = 0; i < 3; i++) hubAppend<NoteMsg>(room, { name: 'rohanz', kind: 'agent' }, { type: 'note', text: `current ${i}` })
    // The local migration copies 0.16 bus messages as they were: no hub seq, their old time, appended after current lines.
    const old = Date.UTC(2026, 8, 28, 12)
    room.bus.push(Array.from({ length: 12 }, (_, i): Msg => i % 2
      ? { id: `old-${i}`, type: 'note', from: 'rohanz', fromKind: 'agent', priority: 'fyi', at: old + i, text: `registry-review ${i}` }
      : { id: `old-${i}`, type: 'base', from: 'rohanz', fromKind: 'agent', priority: 'fyi', at: old + i, base: '422c74e1a5'.padEnd(40, '0'), prev: 'a'.repeat(40), commits: 1, paths: [], summary: 'old' }))
  })
  for (let i = 0; i < 3; i++) expect(recent).toContain(`current ${i}`)
  expect(recent).not.toContain('registry-review')
  expect(recent).not.toContain('moved the base to 422c74e1a5')
  expect(recent).toContain('recent bus (3):')
  expect(recent).toContain('migrated Room 0.16 history: 12 messages, room_state all=true shows them')
  expect(all).toContain('registry-review')
})
