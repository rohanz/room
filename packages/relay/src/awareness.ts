import * as decoding from 'lib0/decoding'
import type { Awareness } from 'y-protocols/awareness'
import { capacity } from './limits.js'

/** Mirrors server/src/limits.ts and the hosted server's awareness budget defaults. */
const DEFAULTS = {
  maxMessageBytes: 64 * 1024, maxStateBytes: 16 * 1024, maxMessagesPerMinute: 6000,
  maxIdsPerConnection: 16, maxIdsPerRoom: 4096,
}
export interface RelayAwarenessLimits {
  maxMessageBytes?: number
  maxStateBytes?: number
  maxMessagesPerMinute?: number
  maxIdsPerConnection?: number
  maxIdsPerRoom?: number
  now?: () => number
}
/** Resolve once before sockets/documents are allocated, so invalid options cannot leak a room. */
export function awarenessLimits(options: RelayAwarenessLimits = {}): typeof DEFAULTS & { now: () => number } {
  return {
    maxMessageBytes: capacity(options.maxMessageBytes, DEFAULTS.maxMessageBytes),
    maxStateBytes: capacity(options.maxStateBytes, DEFAULTS.maxStateBytes),
    maxMessagesPerMinute: capacity(options.maxMessagesPerMinute, DEFAULTS.maxMessagesPerMinute),
    maxIdsPerConnection: capacity(options.maxIdsPerConnection, DEFAULTS.maxIdsPerConnection),
    maxIdsPerRoom: capacity(options.maxIdsPerRoom, DEFAULTS.maxIdsPerRoom),
    now: options.now ?? Date.now,
  }
}
/** Retain removal clocks for a minute so an echo in flight cannot resurrect a departed client. */
const TOMBSTONE_MS = 60_000

/** Plaintext-frame guard: encrypted sockets cannot use the hosted server's emit wrapper.
 * Echoes do not spend a client's lifetime ID allowance; unknown removals do. All newly created
 * clock records spend room capacity, including IDs previously used by this same connection. */
export class RelayAwarenessBudget {
  private readonly limits: typeof DEFAULTS
  private readonly now: () => number
  constructor(private readonly awareness: Awareness, options: RelayAwarenessLimits = {}) {
    const resolved = awarenessLimits(options)
    this.limits = resolved
    this.now = resolved.now
  }
  prune(): void {
    const states = this.awareness.getStates(), now = this.now()
    for (const [id, record] of this.awareness.meta) {
      if (!states.has(id) && now - record.lastUpdated >= TOMBSTONE_MS) this.awareness.meta.delete(id)
    }
  }
  connection(close: (reason: string) => void): (frame: Uint8Array) => boolean {
    const added = new Set<number>()
    let window = this.now(), messages = 0, cut = false
    const refuse = (reason: string) => { if (!cut) { cut = true; close(reason) } return false }
    return frame => {
      if (cut) return false
      if (this.now() - window >= 60_000) { window = this.now(); messages = 0 }
      if (frame.byteLength > this.limits.maxMessageBytes || ++messages > this.limits.maxMessagesPerMinute) return refuse('presence budget exceeded')
      this.prune()
      const adding = new Set<number>(), fresh = new Set<number>()
      try {
        const outer = decoding.createDecoder(frame)
        decoding.readVarUint(outer)
        const inner = decoding.createDecoder(decoding.readVarUint8Array(outer))
        const count = decoding.readVarUint(inner), states = this.awareness.getStates()
        for (let i = 0; i < count; i++) {
          const id = decoding.readVarUint(inner), clock = decoding.readVarUint(inner), raw = decoding.readVarString(inner)
          if (Buffer.byteLength(raw) > this.limits.maxStateBytes) throw Error('presence state too large')
          const state: unknown = JSON.parse(raw), known = this.awareness.meta.get(id)
          if (known && clock <= known.clock) continue
          if (!known) fresh.add(id)
          if (!added.has(id) && (state === null ? !known : !states.has(id))) adding.add(id)
        }
        if (added.size + adding.size > this.limits.maxIdsPerConnection) throw Error('presence ID budget exceeded')
      } catch { return refuse('invalid or excessive presence') }
      // As on the hosted server, a full room drops the frame without closing the newcomer.
      // Its next heartbeat can retry once stale removal clocks have aged out.
      if (this.awareness.meta.size + fresh.size > this.limits.maxIdsPerRoom) return false
      for (const id of adding) added.add(id)
      return true
    }
  }
}
