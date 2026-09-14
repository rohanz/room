import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import * as encoding from 'lib0/encoding'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { isWriteMessage, makeReadOnly, ownsName } from '../src/readonly.js'

const doc = new Y.Doc()
doc.getText('t').insert(0, 'hello')

function sync(build: (enc: encoding.Encoder) => void): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 0)
  build(enc)
  return encoding.toUint8Array(enc)
}
const step1 = sync(enc => syncProtocol.writeSyncStep1(enc, doc))
const step2 = sync(enc => syncProtocol.writeSyncStep2(enc, doc))
const update = sync(enc => syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc)))
const awareness = (() => {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 1)
  const a = new awarenessProtocol.Awareness(doc)
  a.setLocalState({ user: { name: 'viewer' } })
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(a, [doc.clientID]))
  return encoding.toUint8Array(enc)
})()

describe('read-only view connections', () => {
  it('classifies sync step2 and updates as writes, step1 and awareness as reads', () => {
    expect(isWriteMessage(step1)).toBe(false)
    expect(isWriteMessage(awareness)).toBe(false)
    expect(isWriteMessage(step2)).toBe(true)
    expect(isWriteMessage(update)).toBe(true)
    expect(isWriteMessage(new Uint8Array())).toBe(true)
  })

  it('drops writes before message listeners and counts them', () => {
    const conn = new EventEmitter()
    const seen: Uint8Array[] = []
    let dropped = 0
    conn.on('message', (m: Uint8Array) => seen.push(m))
    makeReadOnly(conn, () => dropped++)
    conn.emit('message', Buffer.from(step1))
    conn.emit('message', Buffer.from(update))
    conn.emit('message', Buffer.from(step2))
    conn.emit('message', Buffer.from(awareness))
    expect(seen).toHaveLength(2)
    expect(dropped).toBe(2)
  })
})

describe('identity-bound connections', () => {
  const aw = (name: string | null, owner?: string) => {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, 1)
    const a = new awarenessProtocol.Awareness(doc)
    a.setLocalState(name === null ? null : { user: { name, kind: 'agent', ...(owner ? { owner } : {}) }, status: 'x' })
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(a, [doc.clientID]))
    return encoding.toUint8Array(enc)
  }
  it('flags presence under another name, passes the login, null states and doc messages', async () => {
    const { isForeignIdentity, bindIdentity } = await import('../src/readonly.js')
    expect(isForeignIdentity(aw('octo'), 'octo')).toBe(false)
    expect(isForeignIdentity(aw('kieran'), 'octo')).toBe(true)
    expect(isForeignIdentity(aw(null), 'octo')).toBe(false)
    // principals: the name must be one the login owns (login or login+label); a matching owner alone is not enough
    expect(isForeignIdentity(aw('octo+codex', 'octo'), 'octo')).toBe(false)
    expect(isForeignIdentity(aw('deploy-bot', 'octo'), 'octo')).toBe(true)
    expect(isForeignIdentity(aw('octo+deploy', 'octo'), 'octo')).toBe(false)
    expect(isForeignIdentity(aw('octo', 'kieran'), 'octo')).toBe(true)
    expect(isForeignIdentity(aw('octo+codex'), 'octo')).toBe(false)
    expect(isForeignIdentity(aw('kieran+codex', 'kieran'), 'octo')).toBe(true)
    expect(isForeignIdentity(step1, 'octo')).toBe(false)
    expect(isForeignIdentity(update, 'octo')).toBe(false)
    const conn = new EventEmitter()
    const seen: string[] = []; const dropped: string[] = []
    conn.on('message', () => seen.push('m'))
    bindIdentity(conn, 'octo', n => dropped.push(n))
    conn.emit('message', Buffer.from(aw('octo')))
    conn.emit('message', Buffer.from(aw('kieran')))
    conn.emit('message', Buffer.from(update))
    expect(seen).toHaveLength(2)
    expect(dropped).toEqual(['octo'])
  })
})

it('a login owns itself and login+tag, nothing else', () => {
  expect(ownsName('rohanz', 'rohanz')).toBe(true)
  expect(ownsName('rohanz+codex', 'rohanz')).toBe(true)
  expect(ownsName('rohanz+', 'rohanz')).toBe(false)
  expect(ownsName('rohanzz', 'rohanz')).toBe(false)
  expect(ownsName('kieran', 'rohanz')).toBe(false)
})
