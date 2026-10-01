/**
 * The live room document size cap, one rule for the team server (ROOM_DOC_MAX_MB) and the local relay
 * (ROOM_DOC_MAX_BYTES): once a room's document is over the cap, every document write a client sends
 * is refused, the writer is closed with DOC_SIZE_CAP_CODE and sizeCapReason, and reads keep flowing.
 * A write is refused for the room it arrives in, not for the size it would reach: a client's first
 * sync may carry the whole document, and a room exactly at the cap still loads and takes the
 * deletions and trims that shrink it. The local relay also takes, over the cap, writes that insert
 * nothing (allowNonGrowing), so newcomers can sync and a room nobody operates can shrink.
 */
import * as decoding from 'lib0/decoding'

const MESSAGE_SYNC = 0
const SYNC_STEP2 = 1
const SYNC_UPDATE = 2

/** The close code for a writer into a room over its size cap; Room clients pause and retry on it. */
export const DOC_SIZE_CAP_CODE = 4413

export function sizeCapReason(maxBytes: number): string { return `room is over its size cap (${(maxBytes / 1048576).toFixed(0)} MB)` }

/** A y-websocket document write: sync step 2 or an update. A malformed message counts as one. */
export function isWriteMessage(buf: Uint8Array): boolean {
  try {
    const d = decoding.createDecoder(buf)
    if (decoding.readVarUint(d) !== MESSAGE_SYNC) return false
    const sub = decoding.readVarUint(d)
    return sub === SYNC_STEP2 || sub === SYNC_UPDATE
  } catch {
    return true // malformed: never let it through
  }
}

/**
 * True when a Yjs v1 update inserts no structs: a zero client count (the only form a Yjs encoder
 * writes for "no structs") followed by a well-formed delete set that ends the update. So it is
 * empty, as a newcomer's sync step 2 usually is, or deletions only. Anything else, malformed
 * included, is false.
 */
export function insertsNothing(update: Uint8Array): boolean {
  try {
    const d = decoding.createDecoder(update)
    if (decoding.readVarUint(d) !== 0) return false
    // The delete set: per client, its id and (clock, length) ranges.
    for (let clients = decoding.readVarUint(d); clients > 0; clients--) {
      decoding.readVarUint(d)
      for (let ranges = decoding.readVarUint(d); ranges > 0; ranges--) { decoding.readVarUint(d); decoding.readVarUint(d) }
    }
    return !decoding.hasContent(d)
  } catch {
    return false
  }
}

/** The largest write allowNonGrowing decodes; a larger one into a room over the cap is refused unread. */
export const NON_GROWING_MAX_DECODE_BYTES = 4 * 1048576

export interface SizeCapOptions {
  /**
   * Take a write into a room over the cap when its update inserts nothing (insertsNothing): a
   * newcomer's empty sync step 2 and deletions that shrink the room. The local relay sets this,
   * since a local room has no operator to shrink it; the team server does not.
   */
  allowNonGrowing?: boolean
  /** Decode at most this many message bytes for allowNonGrowing. Default NON_GROWING_MAX_DECODE_BYTES. */
  maxDecodeBytes?: number
}

/** A sync write whose update inserts nothing; any other message, malformed included, is false. */
function nonGrowingWrite(buf: Uint8Array): boolean {
  try {
    const d = decoding.createDecoder(buf)
    decoding.readVarUint(d); decoding.readVarUint(d) // message type and sync step, read by isWriteMessage
    const update = decoding.readVarUint8Array(d)
    return !decoding.hasContent(d) && insertsNothing(update)
  } catch {
    return false
  }
}

/**
 * The room's size when this message is a write it must refuse, else undefined. The size is asked for
 * lazily, with the write message's byte length, so callers can cache an O(doc) measurement and
 * refresh it by traffic (see DocSizeMeter).
 */
export function sizeCapRefusal(buf: Uint8Array, sizeBytes: (messageBytes: number) => number, maxBytes: number, o: SizeCapOptions = {}): number | undefined {
  if (!isWriteMessage(buf)) return undefined
  const size = sizeBytes(buf.byteLength)
  if (size <= maxBytes) return undefined
  if (o.allowNonGrowing && buf.byteLength <= (o.maxDecodeBytes ?? NON_GROWING_MAX_DECODE_BYTES) && nonGrowingWrite(buf)) return undefined
  return size
}

export interface DocSizeMeterOptions {
  /** Re-measure when the cached value is older than this. Default 30 s. */
  maxAgeMs?: number
  /** ... or after this many write messages since the last measurement. Default 200. */
  maxWrites?: number
  /** ... or after this many bytes of write messages since the last measurement. Default 8 MB. */
  maxBytes?: number
  now?: () => number
}

/**
 * A cached document-size measurement for one room. A purely time-based cache would let a
 * client push an unbounded amount through in the 30 s window between two measurements, so
 * the cache also expires by traffic: whichever of age, write count or bytes received trips
 * first forces a fresh measurement on the next write.
 */
export class DocSizeMeter {
  private cached?: { at: number; bytes: number }
  private writes = 0
  private received = 0
  private readonly maxAgeMs: number
  private readonly maxWrites: number
  private readonly maxBytes: number
  private readonly now: () => number

  constructor(private readonly measure: () => number, o: DocSizeMeterOptions = {}) {
    this.maxAgeMs = o.maxAgeMs ?? 30_000
    this.maxWrites = o.maxWrites ?? 200
    this.maxBytes = o.maxBytes ?? 8 * 1048576
    this.now = o.now ?? Date.now
  }

  /** Size of the document as of the last measurement, counting this write message towards the next one. */
  size(messageBytes = 0): number {
    const c = this.cached
    const stale = !c || this.now() - c.at >= this.maxAgeMs || this.writes >= this.maxWrites || this.received >= this.maxBytes
    if (stale) {
      const bytes = this.measure()
      this.cached = { at: this.now(), bytes }
      this.writes = 0
      this.received = 0
    }
    this.writes++
    this.received += messageBytes
    return this.cached!.bytes
  }
}
