import type { WakeResult } from './types.js'
import type { WakeVia } from './wake-types.js'
/** Preserve throws for the existing shared retry/error diagnostics. */
export function sendResult(via: WakeVia | 'uncertain-turn' | 'idle' | undefined): WakeResult {
  if (via === 'uncertain-turn') return { kind: 'uncertain', via: 'turn' }
  if (via === 'idle') return { kind: 'idle' }
  return via ? { kind: 'submitted', via } : { kind: 'unavailable' }
}
