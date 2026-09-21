import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { bindDocumentIdentity, DocumentIdentityGuard, isWriteMessage, makeReadOnly, ownsName, capDocSize, filterAwareness, bindIdentity } from '../src/readonly.js'

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

  it('drops document and awareness writes before a view listener sees them', () => {
    const conn = new EventEmitter()
    const seen: Uint8Array[] = []
    let dropped = 0
    conn.on('message', (m: Uint8Array) => seen.push(m))
    makeReadOnly(conn, () => dropped++)
    conn.emit('message', Buffer.from(step1))
    conn.emit('message', Buffer.from(update))
    conn.emit('message', Buffer.from(step2))
    conn.emit('message', Buffer.from(awareness))
    expect(seen).toHaveLength(1)
    expect([...seen[0]]).toEqual([...step1])
    expect(dropped).toBe(3)
  })
})

describe('identity-bound connections', () => {
  type Entry = { clientID: number; clock: number; state: unknown }
  const pack = (entries: Entry[]) => {
    const inner = encoding.createEncoder(), outer = encoding.createEncoder()
    encoding.writeVarUint(inner, entries.length)
    for (const entry of entries) {
      encoding.writeVarUint(inner, entry.clientID)
      encoding.writeVarUint(inner, entry.clock)
      encoding.writeVarString(inner, JSON.stringify(entry.state))
    }
    encoding.writeVarUint(outer, 1)
    encoding.writeVarUint8Array(outer, encoding.toUint8Array(inner))
    return encoding.toUint8Array(outer)
  }
  const unpack = (buf: Uint8Array): Entry[] => {
    const outer = decoding.createDecoder(buf)
    expect(decoding.readVarUint(outer)).toBe(1)
    const inner = decoding.createDecoder(decoding.readVarUint8Array(outer))
    const count = decoding.readVarUint(inner)
    return Array.from({ length: count }, () => ({
      clientID: decoding.readVarUint(inner), clock: decoding.readVarUint(inner),
      state: JSON.parse(decoding.readVarString(inner)),
    }))
  }
  it('keeps and bounds owned runtime metadata, dropping foreign entries', () => {
    const result = filterAwareness(pack([
      { clientID: 1, clock: 3, state: { user: { name: 'octo' }, model: ' gpt-6-astra ', effort: 'm'.repeat(100) + '\n' } },
      { clientID: 2, clock: 4, state: { user: { name: 'octo+worker' }, model: '\u001b' + 'x'.repeat(100) + 'é', effort: 42 } },
      { clientID: 3, clock: 5, state: { user: { name: 'stranger' }, model: 'no' } },
    ]), 'octo')
    expect(unpack(result.buf!)).toEqual([
      { clientID: 1, clock: 3, state: { user: { name: 'octo' }, model: 'gpt-6-astra', effort: 'm'.repeat(80) } },
      { clientID: 2, clock: 4, state: { user: { name: 'octo+worker' }, model: 'x'.repeat(80) } },
    ])
    expect(result.stripped).toEqual(['stranger'])
  })
  const own = { clientID: 123, clock: 42, state: { user: { name: 'octo+codex', owner: 'octo' }, status: 'working' } }
  const foreign = { clientID: 456, clock: 17, state: { user: { name: 'kieran' } } }

  it('forwards only owned entries in a reconnect broadcast without logging a drop', () => {
    const conn = new EventEmitter(), seen: Uint8Array[] = [], dropped: string[] = []
    conn.on('message', (buf, binary) => { expect(binary).toBe(true); seen.push(buf) })
    bindIdentity(conn, 'octo', (_login, name) => dropped.push(name))
    conn.emit('message', Buffer.from(pack([own, foreign])), true)
    expect(seen).toHaveLength(1)
    expect(unpack(seen[0])).toEqual([own])
    expect(dropped).toEqual([])
    expect(filterAwareness(pack([own, foreign]), 'octo').stripped).toEqual(['kieran'])
  })

  it('drops foreign-only updates and reports the stripped name and login', () => {
    const conn = new EventEmitter(), seen: Uint8Array[] = [], dropped: string[][] = []
    conn.on('message', buf => seen.push(buf))
    bindIdentity(conn, 'octo', (login, name) => dropped.push([login, name]))
    expect(conn.emit('message', pack([foreign]))).toBe(false)
    expect(seen).toEqual([])
    expect(dropped).toEqual([['octo', 'kieran']])
  })

  it('drops null leaving entries for client ids this connection does not own', () => {
    const conn = new EventEmitter(), seen: Uint8Array[] = [], dropped: string[] = []
    const leaving = { ...foreign, state: null }
    conn.on('message', buf => seen.push(buf))
    bindIdentity(conn, 'octo', (_login, name) => dropped.push(name))
    conn.emit('message', pack([leaving]))
    expect(seen).toEqual([])
    expect(dropped).toEqual(['(client 456)'])
  })

  it('accepts a leaving entry after the same connection announced that client id', () => {
    const conn = new EventEmitter(), seen: Uint8Array[] = [], dropped: string[] = []
    conn.on('message', buf => seen.push(buf))
    bindIdentity(conn, 'octo', (_login, name) => dropped.push(name))
    conn.emit('message', pack([own]))
    conn.emit('message', pack([{ ...own, clock: own.clock + 1, state: null }]))
    expect(seen).toHaveLength(2)
    expect(dropped).toEqual([])
  })

  it('does not let another login take over an awareness client id', () => {
    const owners = new Map<number, string>()
    const victim = new EventEmitter(), attacker = new EventEmitter()
    const victimSeen: Uint8Array[] = [], attackerSeen: Uint8Array[] = [], dropped: string[] = []
    victim.on('message', buf => victimSeen.push(buf)); attacker.on('message', buf => attackerSeen.push(buf))
    bindIdentity(victim, 'victim', () => {}, owners)
    bindIdentity(attacker, 'octo', (_login, name) => dropped.push(name), owners)
    victim.emit('message', pack([{ clientID: 99, clock: 1, state: { user: { name: 'victim' } } }]))
    attacker.emit('message', pack([{ clientID: 99, clock: 2, state: { user: { name: 'octo' } } }]))
    expect(victimSeen).toHaveLength(1)
    expect(attackerSeen).toEqual([])
    expect(dropped).toEqual(['(client 99)'])
  })

  it('still drops sync writes when combined with the read-only wrapper', () => {
    const conn = new EventEmitter(), seen: Uint8Array[] = []
    let writes = 0
    conn.on('message', buf => seen.push(buf))
    makeReadOnly(conn, () => writes++)
    bindIdentity(conn, 'octo', () => {})
    for (const buf of [step1, step2, update, pack([own, foreign])]) conn.emit('message', buf)
    expect(writes).toBe(3)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(step1)
  })

  it('rejects malformed updates and strips unnamed or mismatched-owner states', () => {
    expect(filterAwareness(new Uint8Array([1]), 'octo').buf).toBeNull()
    for (const state of [{}, { user: { name: 42 } }, { user: { name: 'octo', owner: 'kieran' } }]) {
      const result = filterAwareness(pack([{ ...foreign, state }, own]), 'octo')
      expect(unpack(result.buf!)).toEqual([own])
      expect(result.stripped).toHaveLength(1)
    }
  })

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

describe('document identity binding', () => {
  const packet = (server: Y.Doc, change: (client: Y.Doc) => void) => {
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
    const before = Y.encodeStateVector(client)
    change(client)
    const message = sync(enc => syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(client, before)))
    client.destroy()
    return message
  }
  const applyPacket = (server: Y.Doc, message: Uint8Array) => {
    const decoder = decoding.createDecoder(message)
    expect(decoding.readVarUint(decoder)).toBe(0)
    expect([1, 2]).toContain(decoding.readVarUint(decoder))
    Y.applyUpdate(server, decoding.readVarUint8Array(decoder))
  }
  const updatePacket = (update: Uint8Array) => sync(enc => syncProtocol.writeUpdate(enc, update))
  const connect = (server: Y.Doc, guard: DocumentIdentityGuard, login: string, violations: string[]) => {
    const conn = new EventEmitter()
    conn.on('message', message => applyPacket(server, message))
    bindDocumentIdentity(conn, login, guard, (_login, reason) => violations.push(reason))
    return conn
  }
  const fixture = () => {
    const server = new Y.Doc(), room = new RoomDoc(server)
    room.setScope({ by: 'victim', byKind: 'agent', area: 'api', summary: 'real', paths: ['api.ts'] })
    const claim = room.addClaim({ by: 'victim', byKind: 'agent', path: 'api.ts', from: 1, to: 2, intent: 'real' })
    room.post({ name: 'victim', kind: 'agent' }, { type: 'note', text: 'real' })
    const conn = new EventEmitter(), dropped: string[] = []
    conn.on('message', message => applyPacket(server, message))
    bindDocumentIdentity(conn, 'octo', new DocumentIdentityGuard(() => server), (_login, reason) => dropped.push(reason), 'enforce')
    return { server, room, claim, conn, dropped }
  }

  it('enforce mode rejects victim scope, claim, and message forgeries as whole protocol packets', () => {
    const { server, room, claim, conn, dropped } = fixture()
    const attempts = [
      packet(server, doc => doc.getMap('scopes').set('victim', { by: 'victim', byKind: 'agent', area: 'pwn', summary: 'forged', paths: [] })),
      packet(server, doc => doc.getMap('claims').set(claim.id, { ...doc.getMap('claims').get(claim.id) as object, intent: 'forged' })),
      packet(server, doc => doc.getArray('bus').push([{ id: 'fake', at: 1, type: 'question', priority: 'notify', from: 'victim', fromKind: 'agent', to: 'octo', text: 'forged' }])),
    ]
    for (const attempt of attempts) expect(conn.emit('message', attempt)).toBe(false)
    expect(room.scope('victim')?.summary).toBe('real')
    expect(room.claims.get(claim.id)?.intent).toBe('real')
    expect(room.messages().some(message => message.id === 'fake')).toBe(false)
    expect(dropped).toHaveLength(3)
    server.destroy()
  })

  it('allows maintenance deletion of another participant record but not delete-then-readd forgery', () => {
    const { server, room, conn, dropped } = fixture()
    expect(conn.emit('message', packet(server, doc => doc.getMap('scopes').delete('victim')))).toBe(true)
    expect(room.scope('victim')).toBeUndefined()
    room.setScope({ by: 'victim', byKind: 'agent', area: 'api', summary: 'restored', paths: ['api.ts'] })
    expect(conn.emit('message', packet(server, doc => {
      doc.getMap('scopes').delete('victim')
      doc.getMap('scopes').set('victim', { by: 'victim', byKind: 'agent', area: 'pwn', summary: 'forged', paths: [] })
    }))).toBe(false)
    expect(room.scope('victim')?.summary).toBe('restored')
    expect(dropped).toHaveLength(1)
    server.destroy()
  })

  it('accepts worker and lead bridge identities in the login namespace', () => {
    const { server, room, conn, dropped } = fixture()
    expect(conn.emit('message', packet(server, doc => {
      doc.getMap('scopes').set('octo+worker', { by: 'octo+worker', byKind: 'agent', area: 'tests', summary: 'worker', paths: ['a.ts'], at: 1 })
      doc.getMap('claims').set('bridge', { id: 'bridge', by: 'octo', byKind: 'agent', path: 'a.ts', from: 1, to: 1, intent: '[worker] test', at: 1, mirrorOf: 'worker' })
    }))).toBe(true)
    expect(room.scope('octo+worker')?.summary).toBe('worker')
    expect(room.claims.get('bridge')?.mirrorOf).toBe('worker')
    expect(dropped).toEqual([])
    server.destroy()
  })

  it('accepts only the enumerated room notice types, not ordinary speech from room', () => {
    const { server, room, conn, dropped } = fixture()
    expect(conn.emit('message', packet(server, doc => doc.getArray('bus').push([
      { id: 'notice', at: 1, type: 'contract', priority: 'notify', from: 'room', fromKind: 'agent', to: 'octo', path: 'a.ts', symbol: 'f', text: 'changed' },
    ])))).toBe(true)
    expect(conn.emit('message', packet(server, doc => doc.getArray('bus').push([
      { id: 'speech', at: 2, type: 'question', priority: 'notify', from: 'room', fromKind: 'agent', to: 'octo', text: 'forged' },
    ])))).toBe(false)
    expect(room.messages().some(message => message.id === 'notice')).toBe(true)
    expect(room.messages().some(message => message.id === 'speech')).toBe(false)
    expect(dropped).toHaveLength(1)
    server.destroy()
  })

  it('accepts numbered synthetic PR scopes from members, rejects lookalikes, and viewers cannot write them', () => {
    const { server, room, conn, dropped } = fixture()
    const prScope = (name: string) => ({ by: name, byKind: 'bot', area: 'api', summary: 'PR', paths: ['a.ts'], at: 1 })
    expect(conn.emit('message', packet(server, doc => {
      doc.getMap('prs').set('pr#12', { number: 12, title: 'PR', author: 'alice', head: 'feature', files: ['a.ts'], updatedAt: '2026-01-01', url: 'https://example.test/pr/12' })
      doc.getMap('scopes').set('pr#12', prScope('pr#12'))
    }))).toBe(true)
    for (const name of ['pr#x', 'pr#0']) expect(conn.emit('message', packet(server, doc => doc.getMap('scopes').set(name, prScope(name))))).toBe(false)
    expect(room.scope('pr#12')?.summary).toBe('PR')
    expect(room.scope('pr#x')).toBeUndefined(); expect(room.scope('pr#0')).toBeUndefined()
    expect(dropped).toHaveLength(2)

    const viewer = new EventEmitter()
    viewer.on('message', message => applyPacket(server, message))
    makeReadOnly(viewer, () => {})
    expect(viewer.emit('message', packet(server, doc => doc.getMap('scopes').set('pr#13', prScope('pr#13'))))).toBe(false)
    expect(room.scope('pr#13')).toBeUndefined()
    server.destroy()
  })

  it('accepts caller-owned repair after two clients concurrently choose the same colour', () => {
    const server = new Y.Doc(), guard = new DocumentIdentityGuard(() => server), violations: string[] = []
    const aliceDoc = new Y.Doc(), bobDoc = new Y.Doc()
    const alice = new RoomDoc(aliceDoc), bob = new RoomDoc(bobDoc)
    const aliceConn = connect(server, guard, 'alice', violations)
    const bobConn = connect(server, guard, 'bob', violations)

    expect(alice.assignColor('alice')).toBe(0)
    expect(bob.assignColor('bob')).toBe(0)
    expect(aliceConn.emit('message', updatePacket(Y.encodeStateAsUpdate(aliceDoc)))).toBe(true)
    expect(bobConn.emit('message', updatePacket(Y.encodeStateAsUpdate(bobDoc)))).toBe(true)

    const aliceBefore = Y.encodeStateVector(aliceDoc), bobBefore = Y.encodeStateVector(bobDoc)
    const merged = Y.encodeStateAsUpdate(server)
    Y.applyUpdate(aliceDoc, merged); Y.applyUpdate(bobDoc, merged)
    expect(aliceConn.emit('message', updatePacket(Y.encodeStateAsUpdate(aliceDoc, aliceBefore)))).toBe(true)
    expect(bobConn.emit('message', updatePacket(Y.encodeStateAsUpdate(bobDoc, bobBefore)))).toBe(true)

    expect(new RoomDoc(server).colors.toJSON()).toEqual({ alice: 0, bob: 1 })
    expect(violations).toEqual([])
    aliceDoc.destroy(); bobDoc.destroy(); server.destroy()
  })

  it('observes an objected member update and applies its causally following valid update', () => {
    const server = new Y.Doc(), guard = new DocumentIdentityGuard(() => server)
    const objections: string[] = [], logged: string[] = [], audited: string[] = []
    const aliceConn = connect(server, guard, 'alice', objections)
    const bob = new Y.Doc(), bobRoom = new RoomDoc(bob)
    const bobConn = new EventEmitter()
    bobConn.on('message', message => applyPacket(server, message))
    bindDocumentIdentity(bobConn, 'bob', guard, (_login, reason) => {
      objections.push(reason); logged.push(reason); audited.push(reason)
    })

    expect(aliceConn.emit('message', packet(server, doc => doc.getMap('scopes').set('alice', {
      by: 'alice', byKind: 'agent', area: 'api', summary: 'original', paths: ['a.ts'], at: 1,
    })))).toBe(true)
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(server))

    let before = Y.encodeStateVector(bob)
    bob.getMap('scopes').set('alice', { by: 'alice', byKind: 'agent', area: 'api', summary: 'objected', paths: ['a.ts'], at: 2 })
    expect(bobConn.emit('message', updatePacket(Y.encodeStateAsUpdate(bob, before)))).toBe(true)
    before = Y.encodeStateVector(bob)
    bobRoom.setScope({ by: 'bob', byKind: 'agent', area: 'tests', summary: 'valid next update', paths: ['b.ts'], at: 3 })
    expect(bobConn.emit('message', updatePacket(Y.encodeStateAsUpdate(bob, before)))).toBe(true)

    const room = new RoomDoc(server)
    expect(room.scope('alice')?.summary).toBe('objected')
    expect(room.scope('bob')?.summary).toBe('valid next update')
    expect((server.store as unknown as { pendingStructs: unknown }).pendingStructs).toBeNull()
    expect(objections).toEqual(['scopes mutation for alice'])
    expect(logged).toEqual(objections)
    expect(audited).toEqual(objections)
    bob.destroy(); server.destroy()
  })
})

it('a login owns itself and login+tag, nothing else', () => {
  expect(ownsName('rohanz', 'rohanz')).toBe(true)
  expect(ownsName('rohanz+codex', 'rohanz')).toBe(true)
  expect(ownsName('rohanz+', 'rohanz')).toBe(false)
  expect(ownsName('rohanzz', 'rohanz')).toBe(false)
  expect(ownsName('kieran', 'rohanz')).toBe(false)
})

it('capDocSize drops writes once the room is over the cap and keeps reads flowing', () => {
  const conn = new EventEmitter()
  const seen: string[] = []; const capped: number[] = []
  conn.on('message', (b: Uint8Array) => seen.push(isWriteMessage(b) ? 'write' : 'read'))
  let size = 10
  capDocSize(conn, () => size, 100, s => capped.push(s))
  const update = encoding.createEncoder(); encoding.writeVarUint(update, 0); encoding.writeVarUint(update, 2); encoding.writeVarUint8Array(update, new Uint8Array([1]))
  const step1 = encoding.createEncoder(); encoding.writeVarUint(step1, 0); encoding.writeVarUint(step1, 0); encoding.writeVarUint8Array(step1, new Uint8Array([]))
  conn.emit('message', encoding.toUint8Array(update)); conn.emit('message', encoding.toUint8Array(step1))
  size = 1000
  conn.emit('message', encoding.toUint8Array(update)); conn.emit('message', encoding.toUint8Array(step1))
  expect(seen).toEqual(['write', 'read', 'read'])
  expect(capped).toEqual([1000])
})
