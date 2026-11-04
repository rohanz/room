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
  const settings = {
    maxRooms: count('ROOM_MAX_ROOMS', 100),
    maxConnections: count('ROOM_MAX_CONNECTIONS', 4000),
    maxConnectionsPerRoom: count('ROOM_MAX_CONNECTIONS_PER_ROOM', 200),
    maxConnectionsPerPrincipal: count('ROOM_MAX_CONNECTIONS_PER_PRINCIPAL', 100),
    maxPendingAdmissions: count('ROOM_MAX_PENDING_ADMISSIONS', 256),
    maxPendingPerAddress: count('ROOM_MAX_PENDING_PER_ADDRESS', 16),
    maxPendingLogins: count('ROOM_MAX_PENDING_LOGINS', 1000),
    docMaxBytes,
    // Default: the document cap plus 4 MB, so one full document can always be queued.
    maxQueuedBytes: mb('ROOM_MAX_QUEUED_MB', docMaxBytes / 1048576 + 4),
    maxTotalQueuedBytes: mb('ROOM_MAX_TOTAL_QUEUED_MB', 256),
    maxMessageBytes: mb('ROOM_MAX_MESSAGE_MB', 16),
    maxExports: count('ROOM_MAX_EXPORTS', 2),
    maxPrOperations: count('ROOM_MAX_PR_OPERATIONS', 8),
    maxHttpResponses: count('ROOM_MAX_HTTP_RESPONSES', 32),
    maxRoomLists: count('ROOM_MAX_ROOM_LISTS', 8),
    maxBodyReads: count('ROOM_MAX_BODY_READS', 32),
    viewTtlMs: read(() => envNumber(env, 'ROOM_VIEW_TTL_MS', 7 * DAY_MS), 7 * DAY_MS),
    viewMaxPerRoom: count('ROOM_VIEW_MAX_PER_ROOM', 200),
    viewMaxTotal: count('ROOM_VIEW_MAX_TOTAL', 10000),
    awarenessMessagesPerMinute: count('ROOM_AWARENESS_MESSAGES_PER_MINUTE', 6000),
    awarenessIdsPerRoom: count('ROOM_AWARENESS_IDS_PER_ROOM', 4096),
    /** 0 disables idle expiry (documented). */
    idleMs: read(() => envNumber(env, 'ROOM_IDLE_DAYS', 30, { zero: true }), 30) * DAY_MS,
    legacyMs: read(() => envNumber(env, 'ROOM_LEGACY_DAYS', 30), 30) * DAY_MS,
    /** Bytes one GET /audit may scan. */
    auditScanBytes: mb('ROOM_AUDIT_SCAN_MB', 64),
  }
  // Read elsewhere (store, cutover); validated here so a typo stops startup rather than a later write.
  mb('ROOM_AUDIT_ROTATE_MB', 64); auditKeepFiles(env, errors)
  mb('ROOM_LOAD_MAX_MB', 32); mb('ROOM_MIGRATION_MAX_READ_MB', 128)
  count('ROOM_MIGRATION_MAX_RECORDS', 100_000); count('ROOM_MIGRATION_MAX_SOURCES', 1000)
  if (errors.length) throw new RangeError(errors.join('\n'))
  return settings
}
