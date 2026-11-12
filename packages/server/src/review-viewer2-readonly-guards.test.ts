import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as sync from 'y-protocols/sync'
import { bindDocumentIdentity, bindIdentity, DocumentIdentityGuard, makeReadOnly } from './readonly.js'

// The removed narrowing rule combined a session login with read-only filtering.
// Restored admission uses the view-key path: read-only filter, no login identity guards.
it('a view key cannot seed the shared identity shadow before another session writes', () => {
  const source = new Y.Doc(), guard = new DocumentIdentityGuard(() => source)
  const reader = new EventEmitter(), writer = new EventEmitter()
  // A view-key credential has no login; only the writer receives identity guards.
  makeReadOnly(reader, () => {})
  bindDocumentIdentity(writer, 'alice', guard, () => {}, 'enforce')
  const docs: Y.Doc[] = [source]
  const packet = (owner: string) => {
    const doc = new Y.Doc(); docs.push(doc); doc.clientID = 123456
    doc.getMap('overlays').set(owner, 'untrusted')
    const update = Y.encodeStateAsUpdate(doc), frame = encoding.createEncoder()
    encoding.writeVarUint(frame, 0); sync.writeUpdate(frame, update)
    return { update, frame: encoding.toUint8Array(frame) }
  }
  const benign = packet('alice'), forged = packet('bob')
  writer.on('message', () => Y.applyUpdate(source, forged.update))
  try {
    reader.emit('message', benign.frame)
    expect(source.getMap('overlays').size).toBe(0)
    writer.emit('message', forged.frame)
    expect(source.getMap('overlays').get('bob')).toBeUndefined()
  } finally { docs.forEach(doc => doc.destroy()) }
})

it('view-key presence cannot reserve another session’s client ID', () => {
  const owners = new Map<number, string>(), reader = new EventEmitter(), writer = new EventEmitter()
  makeReadOnly(reader, () => {})
  bindIdentity(writer, 'bob', () => {}, owners)
  const packet = (name: string) => {
    const inner = encoding.createEncoder(), outer = encoding.createEncoder()
    encoding.writeVarUint(inner, 1); encoding.writeVarUint(inner, 123456); encoding.writeVarUint(inner, 1)
    encoding.writeVarString(inner, JSON.stringify({ user: { name } }))
    encoding.writeVarUint(outer, 1); encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner))
    return encoding.toUint8Array(outer)
  }
  let delivered = false
  writer.on('message', () => { delivered = true })
  try {
    reader.emit('message', packet('alice'))
    writer.emit('message', packet('bob'))
    expect(delivered).toBe(true)
    expect(owners.get(123456)).toBe('bob')
  } finally { reader.emit('close'); writer.emit('close') }
})
