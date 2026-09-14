/**
 * Read-only websocket connections (browser view keys). The y-websocket protocol carries two
 * message types: 0 = sync (sub-types 0 step1 = "send me your state", 1 step2 and 2 update =
 * writes) and 1 = awareness. A viewer may request state and announce presence; anything
 * that would change the document is dropped before the shared-doc handler sees it.
 */
import * as decoding from 'lib0/decoding'

const MESSAGE_SYNC = 0
const SYNC_STEP2 = 1
const SYNC_UPDATE = 2

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

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data as Buffer[]))
  return new Uint8Array()
}

interface EmitterLike { emit(event: string | symbol, ...args: unknown[]): boolean }

/** Wrap a ws connection so inbound write messages never reach its 'message' listeners. */
export function makeReadOnly(conn: EmitterLike, onDrop: () => void): void {
  const emit = conn.emit.bind(conn)
  conn.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === 'message' && isWriteMessage(toBytes(args[0]))) { onDrop(); return false }
    return emit(event, ...args)
  }) as EmitterLike['emit']
}

const MESSAGE_AWARENESS = 1

/** Awareness updates whose `user.name` is not the verified login (message type 1: count, then
 *  per client: clientID, clock, JSON state). `null` states (leaving) are fine. */
/** Legacy rule (clients without `owner`): a login may appear as `login` or `login+<label>`. Newer clients are admitted by `user.owner === login`. */
export function ownsName(name: string, login: string): boolean {
  return name === login || (name.startsWith(login + '+') && name.length > login.length + 1)
}

export function isForeignIdentity(buf: Uint8Array, login: string): boolean {
  try {
    const d = decoding.createDecoder(buf)
    if (decoding.readVarUint(d) !== MESSAGE_AWARENESS) return false
    const inner = decoding.createDecoder(decoding.readVarUint8Array(d))
    const n = decoding.readVarUint(inner)
    for (let i = 0; i < n; i++) {
      decoding.readVarUint(inner); decoding.readVarUint(inner)
      const raw = decoding.readVarString(inner)
      if (raw === 'null') continue
      const state = JSON.parse(raw) as { user?: { name?: string; owner?: string } }
      const name = state?.user?.name, owner = state?.user?.owner
      // The name must be one this login owns (login or login+label); a matching `owner` field alone proves nothing.
      if (name !== undefined && !ownsName(name, login)) return true
      if (owner !== undefined && owner !== login) return true
    }
    return false
  } catch {
    return true
  }
}

/** Wrap a ws connection so presence announced under any name but `login` is dropped. */
export function bindIdentity(conn: EmitterLike, login: string, onDrop: (name: string) => void): void {
  const emit = conn.emit.bind(conn)
  conn.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === 'message' && isForeignIdentity(toBytes(args[0]), login)) { onDrop(login); return false }
    return emit(event, ...args)
  }) as EmitterLike['emit']
}

/**
 * Refuse writes into a room whose document has grown past `maxBytes`: the connection keeps
 * reading, its sync updates are dropped, and `onCap` fires (rate-limit it in the caller). The
 * size is asked for lazily so callers can cache an O(doc) measurement.
 */
export function capDocSize(conn: EmitterLike, sizeBytes: () => number, maxBytes: number, onCap: (size: number) => void): void {
  const emit = conn.emit.bind(conn)
  conn.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === 'message' && isWriteMessage(toBytes(args[0]))) {
      const size = sizeBytes()
      if (size > maxBytes) { onCap(size); return false }
    }
    return emit(event, ...args)
  }) as EmitterLike['emit']
}
