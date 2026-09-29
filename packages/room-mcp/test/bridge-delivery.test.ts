import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { RoomDoc, type ConflictMsg } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { Bridge } from '../src/bridge.js'
import { memorySession } from './fixtures/session.js'
import type { WorkerRegistry } from '../src/worker-registry.js'
import type { WorkerRecord } from '../src/worker-status.js'

it('keeps a holder-addressed team conflict out of the already-notified worker inbox', async () => {
  const pair = () => {
    const a = new Y.Doc(), b = new Y.Doc()
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
    b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
    return { lead: new RoomDoc(a), peer: new RoomDoc(b) }
  }
  const teamDocs = pair(), localDocs = pair()
  const team = memorySession({ name: 'L', kind: 'agent' }, '/tmp', teamDocs.lead, 'team')
  const local = memorySession({ name: 'L', kind: 'agent' }, '/tmp', localDocs.lead, 'workers')
  const worker = { name: 'W', tag: 'w', phase: 'active', lead: { participant: 'L' }, room: 'workers' } as WorkerRecord
  const bridge = new Bridge(team, local, { registry: { list: () => [worker], onChange: () => () => {} } as unknown as WorkerRegistry, debounceMs: 100_000 })
  local.room.setScope({ by: 'W', byKind: 'agent', area: 'x', summary: 'x', paths: ['x'] })
  bridge.start()
  const room = { name: 'room', kind: 'agent' } as const
  hubAppend<ConflictMsg>(localDocs.peer, room, { type: 'conflict', path: 'x', claimId: 'c', otherClaimId: '', to: 'W', priority: 'interrupt', text: "you edited x inside Kieran's claim" })
  const holder = hubAppend<ConflictMsg>(teamDocs.peer, room, { type: 'conflict', path: 'x', claimId: 'c', otherClaimId: '', to: 'Kieran', priority: 'notify', text: 'W edited x inside your claim' })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(localDocs.peer.messages().filter(m => m.to === 'W' && m.priority === 'interrupt')).toHaveLength(1)
  expect(localDocs.peer.messages().filter(m => m.type === 'note' && m.to === 'W')).toHaveLength(0)
  expect(teamDocs.peer.messages().filter(m => m.to === 'Kieran')).toEqual([holder])
  bridge.stop(true)
  team.awareness.destroy(); local.awareness.destroy()
  for (const doc of [teamDocs.lead, teamDocs.peer, localDocs.lead, localDocs.peer]) doc.doc.destroy()
})
