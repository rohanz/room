import { describe, it, expect } from 'vitest'
import * as encoding from 'lib0/encoding'
import { EventEmitter } from 'node:events'
import { DocSizeMeter, capDocSize } from '../src/readonly.js'

/** A sync update message (type 0, sub-type 2) carrying `n` payload bytes. */
function update(n: number): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 0); encoding.writeVarUint(e, 2); encoding.writeVarUint8Array(e, new Uint8Array(n))
  return encoding.toUint8Array(e)
}

describe('DocSizeMeter', () => {
  it('re-measures after 30 s, 200 writes or 8 MB, whichever comes first', () => {
    let t = 0, measured = 0, size = 10
    const m = new DocSizeMeter(() => { measured++; return size }, { now: () => t })
    expect(m.size(1)).toBe(10)
    expect(measured).toBe(1)
    // cached: within 30 s, under 200 writes, under 8 MB
    size = 99
    for (let i = 0; i < 199; i++) expect(m.size(1)).toBe(10)
    expect(measured).toBe(1)
    // the 201st write since the last measurement forces one
    expect(m.size(1)).toBe(99)
    expect(measured).toBe(2)
    // bytes: 8 MB received since the last measurement
    size = 5
    m.size(4 * 1048576); m.size(4 * 1048576)
    expect(measured).toBe(2)
    expect(m.size(1)).toBe(5)
    expect(measured).toBe(3)
    // age
    size = 7
    t = 29_999; expect(m.size(0)).toBe(5)
    t = 30_000; expect(m.size(0)).toBe(7)
    expect(measured).toBe(4)
  })

  it('capDocSize hands the meter each write message\'s byte length', () => {
    let t = 0, measured = 0, size = 0
    const m = new DocSizeMeter(() => { measured++; return size }, { now: () => t, maxBytes: 1000 })
    const conn = new EventEmitter()
    const through: unknown[] = []
    conn.on('message', d => through.push(d))
    const capped: number[] = []
    capDocSize(conn, b => m.size(b), 500, s => capped.push(s))
    conn.emit('message', update(600)) // first write: measured (0), passes; ~600 bytes counted
    conn.emit('message', update(600)) // under the 1000-byte budget still: cached 0, passes; now ~1200 counted
    expect(measured).toBe(1)
    expect(through).toHaveLength(2)
    size = 900
    conn.emit('message', update(10)) // budget spent: re-measured, 900 > cap 500, dropped
    expect(measured).toBe(2)
    expect(through).toHaveLength(2)
    expect(capped).toEqual([900])
    // a non-write message (awareness) is neither counted nor blocked
    const awareness = encoding.createEncoder(); encoding.writeVarUint(awareness, 1); encoding.writeVarUint8Array(awareness, new Uint8Array(5000))
    conn.emit('message', encoding.toUint8Array(awareness))
    expect(through).toHaveLength(3)
    expect(measured).toBe(2)
  })
})
