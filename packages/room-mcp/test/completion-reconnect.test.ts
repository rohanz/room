import { afterEach, expect, it, vi } from 'vitest'
import { waitForCompletionReconnect } from '../src/completion-reconnect.js'
import type { Session } from '../src/session.js'

afterEach(() => vi.useRealTimers())
const session = (synced: boolean, extra = {}) => ({ provider: { synced }, ...extra }) as Session

it('follows a discarded replica through a gap to a fresh synced session', async () => {
  vi.useFakeTimers()
  let current: Session | null = session(false, { stale: { reason: 'compacted' }, lease: { state: 'ended' } })
  const done = waitForCompletionReconnect(() => current)
  await vi.advanceTimersByTimeAsync(100)
  current = null
  await vi.advanceTimersByTimeAsync(100)
  current = session(true)
  await vi.advanceTimersByTimeAsync(100)
  expect(await done).toBe('ready')
  expect(vi.getTimerCount()).toBe(0)
})

it('waits for the name lease as well as document sync', async () => {
  vi.useFakeTimers()
  let paused = true
  const s = session(true, { lease: { state: 'lapsed', paused: () => paused ? 'reconnecting' : undefined } })
  const done = waitForCompletionReconnect(() => s)
  await vi.advanceTimersByTimeAsync(500)
  paused = false
  await vi.advanceTimersByTimeAsync(100)
  expect(await done).toBe('ready')
})

it('bounds an outage and cancels without leaving a polling timer', async () => {
  vi.useFakeTimers()
  const s = session(false)
  const timed = waitForCompletionReconnect(() => s, undefined, 200)
  await vi.advanceTimersByTimeAsync(200)
  expect(await timed).toBe('timeout')
  const abort = new AbortController()
  const cancelled = waitForCompletionReconnect(() => s, abort.signal)
  abort.abort()
  expect(await cancelled).toBe('cancelled')
  expect(vi.getTimerCount()).toBe(0)
})

it.each([{ closed: { reason: 'access revoked' } }, { rejected: { reason: 'size cap' } }, { lease: { state: 'taken' } }])('does not wait through a terminal refusal: %o', async extra => {
  expect(await waitForCompletionReconnect(() => session(false, extra))).toBe('closed')
})
