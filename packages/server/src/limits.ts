// Stored bytes can expand several times in a Y.Doc; bound every cold load before decoding.
const loadMb = Number(process.env.ROOM_LOAD_MAX_MB ?? 32)
export const LOAD_MAX_BYTES = (Number.isFinite(loadMb) && loadMb > 0 ? loadMb : 32) * 1048576
// Bounds unauthenticated buffering while allowing login, room and view-key JSON requests.
export const MAX_BODY_BYTES = 64 * 1024
// Frees slow body readers after ten seconds, enough for small control requests to arrive.
export const BODY_TIMEOUT_MS = 10_000
// Fits a room ledger for an authenticated PR note without buffering an entire document.
export const PR_NOTE_MAX_BYTES = 4 * 1048576
// Fits batched presence updates while preventing presence from becoming a file transport.
export const AWARENESS_MAX_MESSAGE_BYTES = 64 * 1024
// Fits one participant's identity and sharing metadata while bounding JSON parsing work.
export const AWARENESS_MAX_STATE_BYTES = 16 * 1024
// Allows reconnecting client IDs while preventing one socket from filling the room's presence map.
export const AWARENESS_MAX_IDS_PER_CONNECTION = 16
// Allows several browser links per login and room without accumulating unlimited capabilities.
export const VIEW_MAX_PER_PRINCIPAL = 5
// Allows link renewal and sharing while bounding capability churn from one login.
export const VIEW_ISSUE_PER_HOUR = 20
// Gives a browser a minute to connect while limiting the usefulness of a stolen one-use ticket.
export const WS_TICKET_TTL_MS = 60_000
// Fits ordinary scopes, claims and messages while bounding each legacy record's parsing and copy cost.
export const MIGRATION_MAX_RECORD_BYTES = 64 * 1024
// Four halving retries fit an oversized migration without repeatedly rebuilding the whole document.
export const MIGRATION_MAX_REBUILDS = 4
// One export per identity leaves the other server slot available to another user's archive.
export const MAX_EXPORTS_PER_PRINCIPAL = 1
// Streams large archives in manageable writes without buffering another complete document.
export const EXPORT_CHUNK_BYTES = 64 * 1024
// Allows a large archive to load and stream while releasing slots held by stalled readers.
export const EXPORT_DEADLINE_MS = 120_000
// Allows parallel state requests while preventing one identity from holding every response slot.
export const MAX_HTTP_RESPONSES_PER_PRINCIPAL = 4
// Allows large state responses to stream while releasing slots and bytes held by stalled readers.
export const HTTP_RESPONSE_DEADLINE_MS = 120_000
// Allows normal room discovery and retries while bounding repeated permission scans per identity.
export const LISTS_PER_MINUTE = 10
// Suppresses repeated denied GitHub checks while allowing newly granted access within a minute.
export const GH_DENIAL_CACHE_MS = 60_000
// Allows two note submissions in parallel without letting one identity occupy the whole GitHub proxy.
export const MAX_PR_NOTES_PER_PRINCIPAL = 2
// Allows parallel PR discovery across repositories while leaving proxy slots for other identities.
export const MAX_PR_LISTS_PER_PRINCIPAL = 4
// Allows interactive PR lookup and notes while bounding one identity's GitHub API consumption.
export const PR_OPERATIONS_PER_MINUTE = 30

let testLimits: { WS_TICKET_TTL_MS?: number; EXPORT_DEADLINE_MS?: number } = {}

/** Only long lifetimes need shortening in spawned tests; all capacity tests use the fixed bounds. */
export const limits = Object.freeze({
  get WS_TICKET_TTL_MS(): number { return testLimits.WS_TICKET_TTL_MS ?? WS_TICKET_TTL_MS },
  get EXPORT_DEADLINE_MS(): number { return testLimits.EXPORT_DEADLINE_MS ?? EXPORT_DEADLINE_MS },
})

/** Called by the test entry before importing the server, never by a production entry. */
export function overrideLimitsForTest(overrides: typeof testLimits): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('limit overrides require NODE_ENV=test')
  testLimits = { ...testLimits, ...overrides }
}
