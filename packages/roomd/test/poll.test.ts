import { afterEach, expect, it, vi } from 'vitest'
import { CoalescedPoll, MAX_POLL_BACKOFF_MS, POLL_DIAGNOSTIC_MS } from '../src/poll.js'

afterEach(() => vi.useRealTimers())
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

it('keeps the base cadence when git is fast', async () => {
  vi.useFakeTimers()
  const git = vi.fn(async () => {})
  const poll = new CoalescedPoll('HEAD poll', 3_000, git, () => {})
  await vi.advanceTimersByTimeAsync(9_000)
  expect(git).toHaveBeenCalledTimes(3)
  poll.stop()
})

it('never overlaps slow runs and coalesces skipped ticks into one follow-up', async () => {
  vi.useFakeTimers()
  const finish: Array<() => void> = []
  let active = 0
  let maxActive = 0
  const git = vi.fn(() => new Promise<void>(resolve => {
    active++
    maxActive = Math.max(maxActive, active)
    finish.push(() => { active--; resolve() })
  }))
  const poll = new CoalescedPoll('tracked refresh', 10, git, () => {})
  vi.advanceTimersByTime(100)
  expect(git).toHaveBeenCalledTimes(1)
  expect(maxActive).toBe(1)
  finish.shift()!(); await flush()
  expect(git).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(100)
  expect(git).toHaveBeenCalledTimes(2)
  finish.shift()!(); await flush()
  expect(git).toHaveBeenCalledTimes(3)
  expect(maxActive).toBe(1)
  poll.stop()
  finish.shift()!(); await flush()
  expect(git).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(0)
})

it('doubles failure spacing to a cap and resets on success', async () => {
  vi.useFakeTimers()
  const start = Date.now()
  let fail = true
  const calls: number[] = []
  const poll = new CoalescedPoll('HEAD poll', 3_000, async () => {
    calls.push(Date.now())
    if (fail) throw new Error('git rev-parse failed: timed out after 30000ms')
  }, () => {})
  for (const delay of [3_000, 6_000, 12_000, 24_000, 48_000, MAX_POLL_BACKOFF_MS, MAX_POLL_BACKOFF_MS]) {
    await vi.advanceTimersByTimeAsync(delay)
  }
  expect(calls.map(time => time - start)).toEqual([3_000, 9_000, 21_000, 45_000, 93_000, 153_000, 213_000])
  fail = false
  await vi.advanceTimersByTimeAsync(MAX_POLL_BACKOFF_MS)
  await vi.advanceTimersByTimeAsync(3_000)
  expect(calls.slice(-2).map(time => time - start)).toEqual([273_000, 276_000])
  poll.stop()
})

it('holds external triggers during backoff until one retry tick', async () => {
  vi.useFakeTimers()
  const run = vi.fn().mockRejectedValueOnce(new Error('git failed')).mockResolvedValue(undefined)
  const poll = new CoalescedPoll('HEAD poll', 1_000, run, () => {})
  await vi.advanceTimersByTimeAsync(1_000)
  for (let i = 0; i < 5; i++) poll.trigger()
  await flush()
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1_999)
  expect(run).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(2)
  await flush()
  expect(run).toHaveBeenCalledTimes(2)
  poll.stop()
})

it('logs the first timeout, summarizes repetition, and logs one recovery', async () => {
  vi.useFakeTimers()
  const logs: string[] = []
  let fail = true
  const poll = new CoalescedPoll('tracked refresh', 1_000, async () => {
    if (fail) throw new Error('git ls-files failed: timed out after 30000ms')
  }, line => logs.push(line))
  await vi.advanceTimersByTimeAsync(POLL_DIAGNOSTIC_MS + 1_000)
  expect(logs.filter(line => line.includes('timed out'))).toHaveLength(2)
  expect(logs[1]).toMatch(/timed out \d+ times in (?:the )?last 5 min \(tracked refresh\)/)
  fail = false
  await vi.advanceTimersByTimeAsync(MAX_POLL_BACKOFF_MS)
  expect(logs.filter(line => line.includes('recovered'))).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(logs.filter(line => line.includes('recovered'))).toHaveLength(1)
  poll.stop()
})

it('stop discards a dirty follow-up while Git is still running', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const poll = new CoalescedPoll('HEAD poll', 1_000, run, () => {})
  vi.advanceTimersByTime(5_000)
  poll.stop()
  finish(); await flush()
  await vi.advanceTimersByTimeAsync(POLL_DIAGNOSTIC_MS * 2)
  expect(run).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it("stop clears a failed poll's retry and diagnostic timers", async () => {
  vi.useFakeTimers()
  const run = vi.fn(async () => { throw new Error('git status failed: timed out after 30000ms') })
  const poll = new CoalescedPoll('tracked refresh', 1_000, run, () => {})
  await vi.advanceTimersByTimeAsync(1_000)
  expect(vi.getTimerCount()).toBe(2)
  poll.stop()
  await vi.advanceTimersByTimeAsync(POLL_DIAGNOSTIC_MS * 2)
  expect(run).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
