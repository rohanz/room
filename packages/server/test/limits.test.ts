import { afterEach, expect, it, vi } from 'vitest'
import { EXPORT_DEADLINE_MS, WS_TICKET_TTL_MS, limits, overrideLimitsForTest } from '../src/limits.js'

afterEach(() => {
  vi.stubEnv('NODE_ENV', 'test')
  overrideLimitsForTest({ EXPORT_DEADLINE_MS, WS_TICKET_TTL_MS })
  vi.unstubAllEnvs()
})

it.each(['production', 'development', undefined])('refuses overrides with NODE_ENV=%s without changing limits', mode => {
  vi.stubEnv('NODE_ENV', mode)
  expect(() => overrideLimitsForTest({ EXPORT_DEADLINE_MS: 1, WS_TICKET_TTL_MS: 1 })).toThrow('NODE_ENV=test')
  expect(limits.EXPORT_DEADLINE_MS).toBe(EXPORT_DEADLINE_MS)
  expect(limits.WS_TICKET_TTL_MS).toBe(WS_TICKET_TTL_MS)
})

it('makes test options visible to existing consumers while retaining fixed defaults', () => {
  expect(EXPORT_DEADLINE_MS).toBe(120_000)
  expect(WS_TICKET_TTL_MS).toBe(60_000)
  vi.stubEnv('NODE_ENV', 'test')
  overrideLimitsForTest({ EXPORT_DEADLINE_MS: 3000 })
  expect(limits.EXPORT_DEADLINE_MS).toBe(3000)
  expect(limits.WS_TICKET_TTL_MS).toBe(WS_TICKET_TTL_MS)
  overrideLimitsForTest({ WS_TICKET_TTL_MS: 2000 })
  expect(limits.EXPORT_DEADLINE_MS).toBe(3000)
  expect(limits.WS_TICKET_TTL_MS).toBe(2000)
  expect(EXPORT_DEADLINE_MS).toBe(120_000)
  expect(WS_TICKET_TTL_MS).toBe(60_000)
})
