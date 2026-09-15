import { afterEach, expect, it, vi } from 'vitest'
import { formatCount } from '@room/shared'
import { reconnectStatus } from './reconnect.ts'

afterEach(() => vi.useRealTimers())
it.each([[0, '0 changed files'], [1, '1 changed file'], [3, '3 changed files']])('formats %s changed files', (count, expected) => {
  expect(formatCount(Number(count), 'changed file')).toBe(expected)
})
it('supports an explicit irregular plural', () => {
  expect(formatCount(2, 'person', 'people')).toBe('2 people')
})
it('shows initial failures immediately, then gives reconnects a two-second grace period', () => {
  vi.useFakeTimers()
  const banner = { hidden: true }
  const status = reconnectStatus(banner)
  status(false)
  expect(banner.hidden).toBe(false)
  status(true)
  status(false)
  vi.advanceTimersByTime(1999)
  expect(banner.hidden).toBe(true)
  status(false) // Repeated notifications must not restart the deadline.
  vi.advanceTimersByTime(1)
  expect(banner.hidden).toBe(false)
  status(true)
  expect(banner.hidden).toBe(true)
})
it('cancels a brief blip and starts a fresh grace period for the next outage', () => {
  vi.useFakeTimers()
  const banner = { hidden: false }
  const status = reconnectStatus(banner)
  status(true); status(false)
  vi.advanceTimersByTime(500)
  status(true)
  vi.advanceTimersByTime(2000)
  expect(banner.hidden).toBe(true)
  status(false)
  vi.advanceTimersByTime(1999)
  expect(banner.hidden).toBe(true)
  vi.advanceTimersByTime(1)
  expect(banner.hidden).toBe(false)
})
