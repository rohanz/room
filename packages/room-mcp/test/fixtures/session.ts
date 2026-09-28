/** Tests: an in-memory Session whose posts go through an in-process hub on its own doc. */
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type Identity } from '@room/shared'
import type { Session } from '../../src/session.js'
import { hubSeam } from './hub.js'
import { testPolicyStore } from '../policy-fixture.js'

export function memorySession(me: Identity, dir: string, room = new RoomDoc(new Y.Doc()), roomName = 'r'): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  return {
    room, awareness, me, dir, roomUrl: `ws://x/${roomName}`, roomName, browserUrl: 'http://x', shareMax: 'full', shareRequested: 'full',
    provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base: 'base' } as unknown as Session['daemon'],
    ...hubSeam(room), policyStore: testPolicyStore(),
  }
}
