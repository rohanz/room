import { expect, it, vi } from 'vitest'
import * as conflicts from '../src/conflict-set.js'
import { RoomDoc } from '@room/shared'
import type { Session } from '../src/session.js'

it('evicts large contract analyses by bytes before the entry limit, with LRU promotion', () => {
  const cache = new conflicts.ContractAnalysisCache(4 * 1024 * 1024)
  const value = { status: 'ok' as const, method: 'parsed' as const, changes: Array.from({ length: 2000 }, (_, i) =>
    ({ symbol: `synthetic${i}`, kind: 'signature' as const, detail: 'x'.repeat(400) })) }
  for (let i = 0; i < 6; i++) cache.set(`key${i}`, value)
  expect(cache.size).toBeLessThan(6)
  expect(cache.bytes).toBeLessThanOrEqual(4 * 1024 * 1024)
  expect(cache.get('key0')).toBeUndefined()
  expect(cache.get('key5')).toBe(value)
  cache.get('key3'); cache.set('key6', value)
  expect(cache.get('key3')).toBe(value)
  expect(cache.get('key2')).toBeUndefined()
  cache.clear(); expect(cache.bytes).toBe(0); expect(cache.size).toBe(0)
})

it('declines a single over-budget analysis and clears the integrated cache on stop', () => {
  const cache = new conflicts.ContractAnalysisCache(100)
  cache.set('oversized', { status: 'ok', method: 'parsed', changes: [{ symbol: 'f', kind: 'signature', detail: 'x'.repeat(200) }] })
  expect(cache.size).toBe(0)
  const clear = vi.spyOn(conflicts.ContractAnalysisCache.prototype, 'clear')
  const room = new RoomDoc()
  try {
    const set = new conflicts.ConflictSet({ room, me: { name: 'A' }, post: vi.fn() } as unknown as Session)
    set.stop()
    expect(clear).toHaveBeenCalledTimes(1)
  } finally { clear.mockRestore(); room.doc.destroy() }
})
