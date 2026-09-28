import { describe, expect, it } from 'vitest'
import * as decoding from 'lib0/decoding'
import { COUNTER_LIMIT, MSG_HUB, decodeFrame, encodeFrame, encodeSeq, incarnationOf, type Req } from '../src/index.js'

describe('hub protocol', () => {
  it('frames are [varUint 7][varString json] and round-trip', () => {
    const req: Req = { v: 1, id: 'r1', op: 'renew', name: 'ada', epoch: 5 }
    const buf = encodeFrame(req)
    expect(buf[0]).toBe(MSG_HUB)
    expect(decodeFrame(buf)).toEqual(req)
    const dec = decoding.createDecoder(buf)
    expect(decoding.readVarUint(dec)).toBe(MSG_HUB)
    expect(decodeFrame(dec)).toEqual(req)
  })

  it('refuses a frame of another type', () => {
    expect(() => decodeFrame(new Uint8Array([0, 0]))).toThrow(/not a hub frame/)
  })

  it('counters order by (incarnation, n) and stay safe integers', () => {
    expect(encodeSeq(3, 0)).toBeGreaterThan(encodeSeq(2, COUNTER_LIMIT - 1))
    expect(incarnationOf(encodeSeq(7, 12))).toBe(7)
    const max = encodeSeq(2 ** 32 - 1, COUNTER_LIMIT - 1)
    expect(max).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => encodeSeq(1, COUNTER_LIMIT)).toThrow(RangeError)
    expect(() => encodeSeq(2 ** 32, 0)).toThrow(RangeError)
  })
})
