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
