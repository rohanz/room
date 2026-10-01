import { describe, expect, it } from 'vitest'
import * as encoding from 'lib0/encoding'
import { DOC_SIZE_CAP_CODE, MSG_HUB, encodeFrame, sizeCapReason, sizeCapRefusal } from '../src/index.js'

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
