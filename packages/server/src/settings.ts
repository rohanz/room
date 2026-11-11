/**
 * Operator settings that bound the hosted server. A bare Number() turns a typo into NaN, and every
 * `count >= NaN` comparison is false, so a mistyped cap silently becomes no cap. Each setting is
 * therefore parsed once here: absent or empty selects the default, anything else must be a finite
 * positive value (zero only where zero is the documented off switch), or the server refuses to start.
 * Same rule as the relay's `capacity` (relay/src/limits.ts).
 */
type Env = Record<string, string | undefined>

function raw(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

/** A positive safe integer: connection, room, slot and entry counts. */
export function envCount(env: Env, name: string, fallback: number): number {
  const value = raw(env, name)
  if (value === undefined) return fallback
  const n = /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`${name} must be a positive whole number (got ${JSON.stringify(value)})`)
  return n
}

/** A finite positive number (durations in days, minutes, milliseconds); `zero` admits a documented 0 = off. */
export function envNumber(env: Env, name: string, fallback: number, o: { zero?: boolean } = {}): number {
  const value = raw(env, name)
  if (value === undefined) return fallback
  const n = /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !o.zero))
    throw new RangeError(`${name} must be ${o.zero ? 'zero or ' : ''}a positive number (got ${JSON.stringify(value)})`)
  return n
}

/** A byte budget given in megabytes (fractions allowed), returned as whole bytes. */
export function envMegabytes(env: Env, name: string, fallbackMb: number): number {
  const value = raw(env, name)
  const mb = value === undefined ? fallbackMb : /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN
  const bytes = Math.floor(mb * 1048576)
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new RangeError(`${name} must be a positive number of megabytes (got ${JSON.stringify(value)})`)
  return bytes
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Fixed fairness budgets; deployment capacity remains configurable below. */
export const SERVER_FAIRNESS = Object.freeze({
  maxPendingAdmissions: 256,
  maxPendingPerAddress: 16,
  maxPendingLogins: 1000,
  queuedDocumentHeadroomBytes: 4 * 1048576,
  maxExports: 2,
  maxPrOperations: 8,
  maxHttpResponses: 32,
  maxRoomLists: 8,
  maxBodyReads: 32,
  viewMaxPerRoom: 200,
  viewMaxTotal: 10000,
  awarenessMessagesPerMinute: 6000,
  awarenessIdsPerRoom: 4096,
  auditScanBytes: 64 * 1048576,
})

/** Rotated audit segments kept (ROOM_AUDIT_KEEP_FILES); unset keeps every one, so nothing is pruned. */
export function auditKeepFiles(env: Env, errors?: string[]): number | undefined {
  if (raw(env, 'ROOM_AUDIT_KEEP_FILES') === undefined) return undefined
  try { return envCount(env, 'ROOM_AUDIT_KEEP_FILES', 1) } catch (e) { if (!errors) throw e; errors.push((e as Error).message); return undefined }
}

/** Every capacity and budget the hosted entry point reads. Throws one error naming each invalid setting. */
export function settingsFromEnv(env: Env = process.env) {
  const errors: string[] = []
  const read = <T>(f: () => T, fallback: T): T => { try { return f() } catch (e) { errors.push((e as Error).message); return fallback } }
  const count = (name: string, fallback: number) => read(() => envCount(env, name, fallback), fallback)
  const mb = (name: string, fallbackMb: number) => read(() => envMegabytes(env, name, fallbackMb), fallbackMb * 1048576)
  const docMaxBytes = mb('ROOM_DOC_MAX_MB', 64)
  const maxQueuedBytes = docMaxBytes + SERVER_FAIRNESS.queuedDocumentHeadroomBytes
  if (!Number.isSafeInteger(maxQueuedBytes)) errors.push('ROOM_DOC_MAX_MB leaves no safe socket queue headroom')
  const settings = {
    maxRooms: count('ROOM_MAX_ROOMS', 100),
    maxConnections: count('ROOM_MAX_CONNECTIONS', 4000),
    maxConnectionsPerRoom: count('ROOM_MAX_CONNECTIONS_PER_ROOM', 200),
    maxConnectionsPerPrincipal: count('ROOM_MAX_CONNECTIONS_PER_PRINCIPAL', 100),
    maxPendingAdmissions: SERVER_FAIRNESS.maxPendingAdmissions,
    maxPendingPerAddress: SERVER_FAIRNESS.maxPendingPerAddress,
    maxPendingLogins: SERVER_FAIRNESS.maxPendingLogins,
    docMaxBytes,
    // Default: the document cap plus 4 MB, so one full document can always be queued.
    maxQueuedBytes,
    maxTotalQueuedBytes: mb('ROOM_MAX_TOTAL_QUEUED_MB', 256),
    maxMessageBytes: mb('ROOM_MAX_MESSAGE_MB', 16),
    maxExports: SERVER_FAIRNESS.maxExports,
    maxPrOperations: SERVER_FAIRNESS.maxPrOperations,
    maxHttpResponses: SERVER_FAIRNESS.maxHttpResponses,
    maxRoomLists: SERVER_FAIRNESS.maxRoomLists,
    maxBodyReads: SERVER_FAIRNESS.maxBodyReads,
    viewTtlMs: read(() => envNumber(env, 'ROOM_VIEW_TTL_MS', 7 * DAY_MS), 7 * DAY_MS),
    viewMaxPerRoom: SERVER_FAIRNESS.viewMaxPerRoom,
    viewMaxTotal: SERVER_FAIRNESS.viewMaxTotal,
    awarenessMessagesPerMinute: SERVER_FAIRNESS.awarenessMessagesPerMinute,
    awarenessIdsPerRoom: SERVER_FAIRNESS.awarenessIdsPerRoom,
    /** 0 disables idle expiry (documented). */
    idleMs: read(() => envNumber(env, 'ROOM_IDLE_DAYS', 30, { zero: true }), 30) * DAY_MS,
    /** Bytes one GET /audit may scan. */
    auditScanBytes: SERVER_FAIRNESS.auditScanBytes,
  }
  // Read elsewhere (store, document loading); validated here so a typo stops startup rather than a later write.
  mb('ROOM_AUDIT_ROTATE_MB', 64); auditKeepFiles(env, errors)
  mb('ROOM_LOAD_MAX_MB', 32)
  if (errors.length) throw new RangeError(errors.join('\n'))
  return { ...settings, ...testSettings }
}

let testSettings: Partial<Record<'maxPendingAdmissions' | 'maxPendingPerAddress' | 'maxRoomLists', number>> = {}

/** Test entry only: production settings never read environment shortcuts for fixed budgets. */
export function overrideSettingsForTest(overrides: typeof testSettings): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('settings overrides require NODE_ENV=test')
  testSettings = { ...overrides }
}
