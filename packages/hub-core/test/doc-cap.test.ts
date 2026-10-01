import { describe, expect, it } from 'vitest'
import * as encoding from 'lib0/encoding'
import * as Y from 'yjs'
import { DOC_SIZE_CAP_CODE, MSG_HUB, encodeFrame, insertsNothing, sizeCapReason, sizeCapRefusal } from '../src/index.js'

/** A y-websocket sync message (type 0) of `sub` (0 step1, 1 step2, 2 update) carrying `n` payload bytes. */
function sync(sub: number, n = 4): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 0); encoding.writeVarUint(e, sub); encoding.writeVarUint8Array(e, new Uint8Array(n))
  return encoding.toUint8Array(e)
}

describe('the room document size cap (server and local relay)', () => {
  it('closes with 4413 and the visible reason', () => {
    expect(DOC_SIZE_CAP_CODE).toBe(4413)
    expect(sizeCapReason(64 * 1048576)).toBe('room is over its size cap (64 MB)')
  })

  it('refuses document writes only into a room already over the cap', () => {
    const asked: number[] = []
    const at = (size: number) => (bytes: number) => { asked.push(bytes); return size }
    const step2 = sync(1, 100), update = sync(2, 10)
    // Under or exactly at the cap: a whole-document initial sync and a deletion both go through.
    expect(sizeCapRefusal(step2, at(0), 500)).toBeUndefined()
    expect(sizeCapRefusal(update, at(500), 500)).toBeUndefined()
    // Over it: every write is refused, with the size that refused it.
    expect(sizeCapRefusal(update, at(501), 500)).toBe(501)
    expect(sizeCapRefusal(step2, at(900), 500)).toBe(900)
    // The meter is handed each write message's byte length.
    expect(asked).toEqual([step2.byteLength, update.byteLength, update.byteLength, step2.byteLength])
  })

  it('never refuses or meters reads, presence or hub frames; a malformed message counts as a write', () => {
    let asked = 0
    const over = () => { asked++; return 1000 }
    const awareness = encoding.createEncoder(); encoding.writeVarUint(awareness, 1); encoding.writeVarUint8Array(awareness, new Uint8Array(50))
    const hub = encodeFrame({ v: 1, id: 'h', op: 'hello' } as never)
    expect(hub[0]).toBe(MSG_HUB)
    for (const msg of [sync(0), encoding.toUint8Array(awareness), new Uint8Array([3]), hub]) expect(sizeCapRefusal(msg, over, 500)).toBeUndefined()
    expect(asked).toBe(0)
    expect(sizeCapRefusal(new Uint8Array([0x80]), over, 500)).toBe(1000)
  })
})

/** A sync message of `sub` carrying a real Yjs update. */
function syncUpdate(sub: number, update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 0); encoding.writeVarUint(e, sub); encoding.writeVarUint8Array(e, update)
  return encoding.toUint8Array(e)
}

describe('allowNonGrowing (the local relay): an over-cap room still syncs newcomers and shrinks', () => {
  const over = () => 1000
  const allow = { allowNonGrowing: true }
  const room = new Y.Doc()
  room.getMap('meta').set('big', 'x'.repeat(200))
  const before = Y.encodeStateVector(room)
  const updates: Uint8Array[] = []
  room.on('update', (u: Uint8Array) => updates.push(u))
  room.getMap('meta').delete('big')
  const deletion = updates[0]
  room.getMap('meta').set('more', 1)
  const insertion = updates[1]

  it('takes an empty update and a deletion-only update over the cap', () => {
    // A newcomer's step 2 when it has nothing the room lacks: no structs, no deletions.
    const empty = Y.encodeStateAsUpdate(new Y.Doc(), Y.encodeStateVector(room))
    expect(Y.decodeUpdate(empty).structs).toEqual([])
    expect(Y.decodeUpdate(deletion).structs).toEqual([])
    expect(Y.decodeUpdate(deletion).ds.clients.size).toBe(1)
    for (const msg of [syncUpdate(1, empty), syncUpdate(2, empty), syncUpdate(2, deletion), syncUpdate(1, deletion)]) {
      expect(sizeCapRefusal(msg, over, 500, allow)).toBeUndefined()
      expect(sizeCapRefusal(msg, over, 500)).toBe(1000) // the server's rule is unchanged
    }
    expect(Y.encodeStateVector(room)).not.toEqual(before)
  })

  it('still refuses an update that inserts anything, a malformed update and an oversized one', () => {
    expect(sizeCapRefusal(syncUpdate(2, insertion), over, 500, allow)).toBe(1000)
    expect(sizeCapRefusal(syncUpdate(1, Y.encodeStateAsUpdate(room)), over, 500, allow)).toBe(1000)
    // Truncated deletion, trailing garbage in the delete set, a bare struct count and an unreadable message.
    expect(sizeCapRefusal(syncUpdate(2, deletion.slice(0, deletion.byteLength - 1)), over, 500, allow)).toBe(1000)
    expect(sizeCapRefusal(syncUpdate(2, new Uint8Array([0])), over, 500, allow)).toBe(1000)
    expect(sizeCapRefusal(syncUpdate(2, new Uint8Array([0, 0, 7])), over, 500, allow)).toBe(1000)
    expect(sizeCapRefusal(new Uint8Array([0, 2, 0x80]), over, 500, allow)).toBe(1000)
    // A deletion bigger than the decode bound is refused without being decoded.
    const big = syncUpdate(2, deletion)
    expect(sizeCapRefusal(big, over, 500, { allowNonGrowing: true, maxDecodeBytes: big.byteLength - 1 })).toBe(1000)
    expect(sizeCapRefusal(big, over, 500, { allowNonGrowing: true, maxDecodeBytes: big.byteLength })).toBeUndefined()
  })

  it('insertsNothing accepts only the shape every Yjs encoder writes for "no structs": a zero client count and a whole delete set', () => {
    expect(insertsNothing(deletion)).toBe(true)
    expect(insertsNothing(insertion)).toBe(false)
    expect(insertsNothing(new Uint8Array([0, 0]))).toBe(true) // no clients, empty delete set
    expect(insertsNothing(new Uint8Array([0, 1, 5, 1, 0, 3]))).toBe(true) // client 5 deletes clocks 0..2
    expect(insertsNothing(new Uint8Array([0, 1, 5, 1, 0]))).toBe(false) // truncated delete set
    expect(insertsNothing(new Uint8Array([1, 0, 5, 0, 0]))).toBe(false) // a struct section, even an empty one
    expect(insertsNothing(new Uint8Array([]))).toBe(false)
  })
})
