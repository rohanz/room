import { afterEach, expect, it, vi } from 'vitest'
import { ReadDiffCache } from '../src/read-diff-cache.js'

const cursorOf = (page: string) => /cursor="([^"]+)"/.exec(page)![1]
afterEach(() => { vi.useRealTimers() })

it('bounds entries globally, refreshes LRU only after validation, and clears one session', () => {
  const cache = new ReadDiffCache({ entries: 2, bytes: 100_000, entryBytes: 50_000, idleMs: 120_000 })
  const a = {}, b = {}
  const one = cursorOf(cache.start(a, 'one', 'a'.repeat(13_000), 'input'))
  const two = cursorOf(cache.start(b, 'two', 'b'.repeat(13_000), 'input'))
  cache.page(cache.get(a, 'one', one)!, one, 'input')
  const three = cursorOf(cache.start(a, 'three', 'c'.repeat(13_000), 'input'))
  expect(cache.get(b, 'two', two)).toBeUndefined()
  expect(cache.get(a, 'one', one)).toBeDefined()
  expect(cache.get(b, 'three', three)).toBeUndefined()
  expect(cache.get(a, 'wrong request', three)).toBeUndefined()
  cache.clear(a)
  expect(cache.get(a, 'one', one)).toBeUndefined()
  expect(cache.get(a, 'three', three)).toBeUndefined()
})

it('enforces aggregate and per-entry byte limits without retaining oversized replies', () => {
  const cache = new ReadDiffCache({ entries: 4, bytes: 60_000, entryBytes: 50_000, idleMs: 120_000 }), owner = {}
  const one = cursorOf(cache.start(owner, 'one', 'a'.repeat(20_000), 'input'))
  const two = cursorOf(cache.start(owner, 'two', 'b'.repeat(20_000), 'input'))
  expect(cache.get(owner, 'one', one)).toBeUndefined()
  expect(cache.get(owner, 'two', two)).toBeDefined()
  expect(cache.start(owner, 'large', 'c'.repeat(30_000), 'input')).toContain('exceeds the bounded continuation cache')
  expect(cache.get(owner, 'two', two)).toBeDefined()
  cache.clear(owner)
})

it('expires idle text, rejects an entry evicted during validation, and evicts changed inputs', () => {
  vi.useFakeTimers()
  const cache = new ReadDiffCache({ entries: 4, bytes: 100_000, entryBytes: 50_000, idleMs: 1_000 }), owner = {}
  const cursor = cursorOf(cache.start(owner, 'r', 'a'.repeat(13_000), 'input'))
  const entry = cache.get(owner, 'r', cursor)!
  vi.advanceTimersByTime(900)
  expect(cache.page(entry, cursor, 'input')).toContain('end of diff')
  vi.advanceTimersByTime(900)
  expect(cache.get(owner, 'r', cursor)).toBe(entry)
  vi.advanceTimersByTime(101)
  expect(cache.get(owner, 'r', cursor)).toBeUndefined()
  expect(cache.page(entry, cursor, 'input')).toContain('expired')
  const next = cursorOf(cache.start(owner, 'r', 'a'.repeat(13_000), 'input'))
  expect(cache.page(cache.get(owner, 'r', next)!, next, 'different')).toContain('diff changed')
  expect(cache.get(owner, 'r', next)).toBeUndefined()
})
