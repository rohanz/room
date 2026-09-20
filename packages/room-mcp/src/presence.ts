import type { Awareness } from 'y-protocols/awareness'

// Awareness renews heartbeats every 15s and expires states after its 30s outdatedTimeout.
// A clean roomd stop clears presence immediately; only a crash lingers up to 30s.
// A name blocked during that window simply yields a host tag.
const AWARENESS_FRESH_MS = 30_000

export function isFresh(awareness: Awareness, clientId: number, now: number): boolean {
  const lastUpdated = awareness.meta.get(clientId)?.lastUpdated
  return lastUpdated !== undefined && now - lastUpdated <= AWARENESS_FRESH_MS
}
