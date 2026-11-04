import { expect, it } from 'vitest'
import { RecentKeys } from '../src/recent-keys.js'

it('suppresses a repeat inside the window and allows it after expiry', () => {
  let now = 0
  const recent = new RecentKeys(300_000, 8, () => now)
  expect(recent.hit('a')).toBe(false)
  now = 299_999
  expect(recent.hit('a')).toBe(true)
  now = 300_000
  expect(recent.hit('a')).toBe(false)
})

it('forgets expired keys instead of retaining them for the process lifetime', () => {
  let now = 0
  const recent = new RecentKeys(1_000, 10_000, () => now)
  for (let i = 0; i < 500; i++) recent.hit(`dir\0${i}`)
  now = 1_000
  recent.hit('later')
  expect(recent.size).toBe(1)
})

it('holds at most its capacity, evicting the oldest key', () => {
  const recent = new RecentKeys(60_000, 3, () => 0)
  for (const key of ['a', 'b', 'c', 'd']) recent.hit(key)
  expect(recent.size).toBe(3)
  expect(recent.hit('a')).toBe(false)
  expect(recent.hit('d')).toBe(true)
})

it('clear resets recovered keys', () => {
  const recent = new RecentKeys(60_000, 3, () => 0)
  recent.hit('error')
  recent.clear()
  expect(recent.hit('error')).toBe(false)
})
