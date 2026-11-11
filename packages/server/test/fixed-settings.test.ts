import { expect, it } from 'vitest'
import { settingsFromEnv } from '../src/settings.js'

const retired = [
  'ROOM_MAX_PENDING_ADMISSIONS', 'ROOM_MAX_PENDING_PER_ADDRESS', 'ROOM_MAX_PENDING_LOGINS',
  'ROOM_MAX_QUEUED_MB', 'ROOM_MAX_EXPORTS', 'ROOM_MAX_PR_OPERATIONS', 'ROOM_MAX_HTTP_RESPONSES',
  'ROOM_MAX_ROOM_LISTS', 'ROOM_MAX_BODY_READS', 'ROOM_VIEW_MAX_PER_ROOM', 'ROOM_VIEW_MAX_TOTAL',
  'ROOM_AWARENESS_MESSAGES_PER_MINUTE', 'ROOM_AWARENESS_IDS_PER_ROOM', 'ROOM_AUDIT_SCAN_MB',
]
it('keeps every retired fairness budget at its old default even when set or malformed', () => {
  const expected = {
    maxPendingAdmissions: 256, maxPendingPerAddress: 16, maxPendingLogins: 1000,
    maxQueuedBytes: 68 * 1048576, maxExports: 2, maxPrOperations: 8, maxHttpResponses: 32,
    maxRoomLists: 8, maxBodyReads: 32, viewMaxPerRoom: 200, viewMaxTotal: 10000,
    awarenessMessagesPerMinute: 6000, awarenessIdsPerRoom: 4096, auditScanBytes: 64 * 1048576,
  }
  expect(settingsFromEnv({})).toMatchObject(expected)
  for (const value of ['1', 'NaN', '']) {
    expect(settingsFromEnv(Object.fromEntries(retired.map(name => [name, value])))).toMatchObject(expected)
  }
})
it('derives the fixed socket queue budget from the configured document cap, preserving fractional-byte rounding', () => {
  for (const value of ['8', '0.000003', '1.5', '900']) {
    const settings = settingsFromEnv({ ROOM_DOC_MAX_MB: value, ROOM_MAX_QUEUED_MB: '1' })
    expect(settings.maxQueuedBytes).toBe(settings.docMaxBytes + 4 * 1048576)
  }
})

it('still refuses a document cap whose default socket queue overflows safe byte counts', () => {
  expect(() => settingsFromEnv({ ROOM_DOC_MAX_MB: '8589934591' })).toThrow()
})
