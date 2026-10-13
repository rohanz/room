/** Local relays normally serve one repository; leave room for migration and viewer routes.
 * Hosted defaults are 100 rooms, 4000 connections total and 200 per room (server/src/index.ts).
 * Retained idle documents count too: memory snapshots can shed live state, so eviction is unsafe. */
const RELAY_MAX_ROOMS = 8
const RELAY_MAX_CONNECTIONS = 200
const RELAY_MAX_CONNECTIONS_PER_ROOM = 100

export interface RelayAdmissionLimits {
  maxRooms?: number
  maxConnections?: number
  maxConnectionsPerRoom?: number
}

/** Reject invalid overrides rather than allowing NaN/Infinity to silently disable a bound. */
export function capacity(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1) throw new RangeError('relay limits must be positive safe integers')
  return result
}

/** Includes every accepted socket, even before secure authentication creates a document. */
export class RelayAdmission {
  private total = 0
  private readonly rooms = new Map<string, number>()
  private readonly maxRooms: number
  private readonly maxConnections: number
  private readonly maxConnectionsPerRoom: number
  constructor(private readonly docs: ReadonlyMap<string, unknown>, options: RelayAdmissionLimits = {}) {
    this.maxRooms = capacity(options.maxRooms, RELAY_MAX_ROOMS)
    this.maxConnections = capacity(options.maxConnections, RELAY_MAX_CONNECTIONS)
    this.maxConnectionsPerRoom = capacity(options.maxConnectionsPerRoom, RELAY_MAX_CONNECTIONS_PER_ROOM)
  }
  refusal(name: string): string | undefined {
    if (this.total >= this.maxConnections) return 'relay connection limit reached'
    if ((this.rooms.get(name) ?? 0) >= this.maxConnectionsPerRoom) return 'relay room connection limit reached'
    if (!this.docs.has(name) && !this.rooms.has(name)) {
      let count = this.docs.size
      for (const pending of this.rooms.keys()) if (!this.docs.has(pending)) count++
      if (count >= this.maxRooms) return 'relay room limit reached'
    }
    return undefined
  }
  /** Caller checks refusal first; reservation and upgrade are synchronous on the same event loop. */
  reserve(name: string): () => void {
    this.total++
    this.rooms.set(name, (this.rooms.get(name) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.total--
      const left = this.rooms.get(name)! - 1
      if (left) this.rooms.set(name, left)
      else this.rooms.delete(name)
    }
  }
}
