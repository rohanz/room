import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { isWriteMessage, makeReadOnly, ownsName, capDocSize, filterAwareness, bindIdentity } from '../src/readonly.js'

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

  it('keeps null leaving entries for foreign clients', () => {
    const conn = new EventEmitter(), seen: Uint8Array[] = [], dropped: string[] = []
    const leaving = { ...foreign, state: null }
    conn.on('message', buf => seen.push(buf))
    bindIdentity(conn, 'octo', (_login, name) => dropped.push(name))
    conn.emit('message', pack([foreign, leaving]))
    expect(seen).toHaveLength(1)
    expect(unpack(seen[0])).toEqual([leaving])
    expect(dropped).toEqual([])
  })

  it('still drops sync writes when combined with the read-only wrapper', () => {
    const conn = new EventEmitter(), seen: Uint8Array[] = []
    let writes = 0
    conn.on('message', buf => seen.push(buf))
    makeReadOnly(conn, () => writes++)
    bindIdentity(conn, 'octo', () => {})
    for (const buf of [step1, step2, update, pack([own, foreign])]) conn.emit('message', buf)
    expect(writes).toBe(2)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual(step1)
    expect(unpack(seen[1])).toEqual([own])
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
