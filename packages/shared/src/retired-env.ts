/** Retired environment settings, shared by the entry points that formerly accepted them. */
export const RETIRED_ENVIRONMENT = Object.freeze({
  server: [
    'ROOM_ARCHIVE_LIST_MAX_KEYS',
    'ROOM_AUDIT_SCAN_MB',
    'ROOM_AWARENESS_IDS_PER_ROOM',
    'ROOM_AWARENESS_MESSAGES_PER_MINUTE',
    'ROOM_MAX_BODY_READS',
    'ROOM_MAX_EXPORTS',
    'ROOM_MAX_HTTP_RESPONSES',
    'ROOM_MAX_PENDING_ADMISSIONS',
    'ROOM_MAX_PENDING_LOGINS',
    'ROOM_MAX_PENDING_PER_ADDRESS',
    'ROOM_MAX_PR_OPERATIONS',
    'ROOM_MAX_QUEUED_MB',
    'ROOM_MAX_ROOM_LISTS',
    'ROOM_VIEW_MAX_PER_ROOM',
    'ROOM_VIEW_MAX_TOTAL',
    'ROOM_LEGACY_DAYS',
    'ROOM_MIGRATION_MAX_READ_MB',
    'ROOM_MIGRATION_MAX_RECORDS',
    'ROOM_MIGRATION_MAX_SOURCES',
  ],
  client: [
    'ROOM_GIT_TIMEOUT_MS',
    'ROOM_IDLE_LEASE_MS',
    'ROOM_STALE_DAYS',
  ],
} as const)

/** Call once at process startup. Presence (even an empty value) merits a warning; never log values. */
export function warnRetiredEnvironment(target: keyof typeof RETIRED_ENVIRONMENT,
  env: Record<string, string | undefined>, log: (line: string) => void): void {
  for (const name of RETIRED_ENVIRONMENT[target]) {
    if (env[name] !== undefined) log(`${name} is retired and no longer has an effect`)
  }
}
