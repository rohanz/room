import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { hasCompany } from '../src/company.js'
import { describeCompany } from '../src/company.js'
import { RoomDoc } from '@room/shared'
import type { Session } from '../src/session.js'

it('counts a teammate with a different machine checkout id, while deduping the same physical checkout', () => {
  const own = new Y.Doc(), foreign = new Y.Doc(), remote = new Y.Doc()
  const awareness = new Awareness(own), peer = new Awareness(foreign), remotePeer = new Awareness(remote)
  try {
    awareness.setLocalState({ user: { name: 'Ada', kind: 'agent' }, watchedDirectory: 'machine-a:path' })
    peer.setLocalState({ user: { name: 'Bea', kind: 'agent' }, watchedDirectory: 'machine-b:path' })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [foreign.clientID]), 'test')
    const session = { awareness, me: { name: 'Ada', kind: 'agent' } } as Session
    expect(hasCompany(session)).toEqual({ company: true, others: ['Bea'] })
    peer.setLocalStateField('watchedDirectory', 'machine-a:path')
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [foreign.clientID]), 'test')
    expect(hasCompany(session)).toEqual({ company: false, others: [] })
    remotePeer.setLocalState({ user: { name: 'Bea', kind: 'agent' }, watchedDirectory: 'machine-b:path' })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remotePeer, [remote.clientID]), 'test')
    expect(hasCompany(session)).toEqual({ company: true, others: ['Bea'] })
  } finally {
    awareness.destroy(); peer.destroy(); remotePeer.destroy(); own.destroy(); foreign.destroy(); remote.destroy()
  }
})

it('announces an untagged agent with its marker and a human by the bare name', () => {
  const own = new RoomDoc(), beaDoc = new Y.Doc(), cyDoc = new Y.Doc()
  const awareness = new Awareness(own.doc), bea = new Awareness(beaDoc), cy = new Awareness(cyDoc)
  try {
    awareness.setLocalState({ user: { name: 'Ada', kind: 'agent' } })
    bea.setLocalState({ user: { name: 'Bea', kind: 'agent' } })
    cy.setLocalState({ user: { name: 'Cy', kind: 'human' } })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(bea, [beaDoc.clientID]), 'test')
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(cy, [cyDoc.clientID]), 'test')
    own.setScope({ by: 'Bea', byKind: 'agent', area: 'api', summary: 'parser', paths: ['src/'] })
    const session = { awareness, me: { name: 'Ada', kind: 'agent' }, room: own } as Session
    expect(describeCompany(session, hasCompany(session))).toBe("[room] Bea's agent is here, on api: src/; Cy is here.")
  } finally {
    awareness.destroy(); bea.destroy(); cy.destroy(); own.doc.destroy(); beaDoc.destroy(); cyDoc.destroy()
  }
})
