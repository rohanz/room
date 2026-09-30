import { describe, expect, it, vi } from 'vitest'
import { MAX_HUB_FRAME_BYTES, MAX_HUB_REQUESTS_PER_SECOND, encodeFrame } from '@room/hub-core'
import { hubReply } from '../src/index.js'

describe('relay hub frame guard', () => {
  const hello = (id: string) => encodeFrame({ v: 1, id, op: 'hello' } as never)

  it('rejects oversized raw frames before JSON.parse and does not echo long IDs', () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const conn = {} as never, doc = {} as never
      const huge = encodeFrame({ v: 1, id: 'x', op: 'hello', data: 'x'.repeat(MAX_HUB_FRAME_BYTES) } as never)
      const before = parse.mock.calls.length
      expect(hubReply(doc, conn, huge, false)).toMatchObject({ reason: 'too-large', re: '' })
      expect(parse).toHaveBeenCalledTimes(before)
      expect(hubReply(doc, conn, hello('x'.repeat(129)), false)).toMatchObject({ reason: 'not-authority', re: '' })
    } finally { parse.mockRestore() }
  })

  it('budgets unavailable and read-only requests per connection', () => {
    for (const readOnly of [false, true]) {
      const conn = {} as never, doc = {} as never
      for (let i = 0; i < MAX_HUB_REQUESTS_PER_SECOND; i++) hubReply(doc, conn, hello('r'), true, readOnly)
      expect(hubReply(doc, conn, hello('r'), true, readOnly)).toMatchObject({ reason: 'rate-limited', retryMs: expect.any(Number) })
    }
  })
})
