import { describe, it, expect } from 'vitest'
import { envCount, envMegabytes, envNumber, settingsFromEnv } from '../src/settings.js'

describe('server settings', () => {
  it('uses the default when a setting is absent or empty', () => {
    expect(envCount({}, 'ROOM_MAX_ROOMS', 100)).toBe(100)
    expect(envCount({ ROOM_MAX_ROOMS: '' }, 'ROOM_MAX_ROOMS', 100)).toBe(100)
    expect(envCount({ ROOM_MAX_ROOMS: '  ' }, 'ROOM_MAX_ROOMS', 100)).toBe(100)
    expect(envCount({ ROOM_MAX_ROOMS: ' 7 ' }, 'ROOM_MAX_ROOMS', 100)).toBe(7)
  })

  it('refuses values that would make a cap comparison false or meaningless', () => {
    for (const bad of ['abc', 'NaN', 'Infinity', '-1', '0', '1.5', '1e400', '0x10', '9007199254740993'])
      expect(() => envCount({ ROOM_MAX_ROOMS: bad }, 'ROOM_MAX_ROOMS', 100), bad).toThrow(/ROOM_MAX_ROOMS must be a positive whole number/)
  })

  it('accepts zero only where zero is the documented off switch', () => {
    expect(envNumber({ ROOM_IDLE_DAYS: '0' }, 'ROOM_IDLE_DAYS', 30, { zero: true })).toBe(0)
    expect(envNumber({ ROOM_IDLE_DAYS: '0.5' }, 'ROOM_IDLE_DAYS', 30, { zero: true })).toBe(0.5)
    expect(() => envNumber({ ROOM_IDLE_DAYS: 'thirty' }, 'ROOM_IDLE_DAYS', 30, { zero: true })).toThrow(/ROOM_IDLE_DAYS must be zero or a positive number/)
    expect(() => envNumber({ ROOM_LEGACY_DAYS: '0' }, 'ROOM_LEGACY_DAYS', 30)).toThrow(/ROOM_LEGACY_DAYS must be a positive number/)
  })

  it('converts megabyte budgets to whole bytes and refuses non-finite or non-positive ones', () => {
    expect(envMegabytes({}, 'ROOM_DOC_MAX_MB', 64)).toBe(64 * 1048576)
    expect(envMegabytes({ ROOM_DOC_MAX_MB: '0.5' }, 'ROOM_DOC_MAX_MB', 64)).toBe(524288)
    for (const bad of ['x', 'Infinity', '0', '-3', '1e300'])
      expect(() => envMegabytes({ ROOM_DOC_MAX_MB: bad }, 'ROOM_DOC_MAX_MB', 64), bad).toThrow(/ROOM_DOC_MAX_MB must be a positive number of megabytes/)
  })

  it('reads every hosted capacity and budget, naming each invalid explicit setting', () => {
    const s = settingsFromEnv({})
    expect(s).toMatchObject({ maxRooms: 100, maxConnections: 4000, docMaxBytes: 64 * 1048576, maxQueuedBytes: 68 * 1048576, idleMs: 30 * 86400000 })
    expect(settingsFromEnv({ ROOM_DOC_MAX_MB: '8' }).maxQueuedBytes).toBe(12 * 1048576)
    let message = ''
    try { settingsFromEnv({ ROOM_MAX_CONNECTIONS: 'lots', ROOM_DOC_MAX_MB: '-1', ROOM_MIGRATION_MAX_SOURCES: 'NaN' }) } catch (e) { message = (e as Error).message }
    expect(message.split('\n')).toHaveLength(3)
    for (const name of ['ROOM_MAX_CONNECTIONS', 'ROOM_DOC_MAX_MB', 'ROOM_MIGRATION_MAX_SOURCES']) expect(message).toContain(`${name} must be`)
  })
})
