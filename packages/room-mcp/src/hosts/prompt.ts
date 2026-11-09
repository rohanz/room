import { sessionHost } from './selection.js'
import { claudeWakeAvailable } from './claude-wake.js'
/** The exported inbox socket (Claude Code 2.1.224+, or 2.1.234+ on native Windows) enables wakes. */
export function wakeUnavailable(dir: string, host = sessionHost()): boolean {
  if (host !== 'claude') return false
  return !claudeWakeAvailable({ host })
}

/** Plain wording is separate from process detection so guidance can be checked. */
export function wakeText(off = false): string {
  if (off) return 'For your human: wake-ups are off in this process (ROOM_WAKE=off). Set ROOM_WAKE=auto to enable them.'
  return [
    'For your human: no wake path is available for this Claude Code session. Pending messages can arrive on Room tool replies and eligible edit hooks; an idle session may need another turn.',
    'First update Claude Code to 2.1.224 or later (2.1.234 or later on native Windows) so it can bind an inbox socket. Check /status for its Peer address.',
    'Organization settings can turn cross-session messaging off. Messages remain owed until delivered through Room tools or eligible hooks.',
  ].join('\n')
}

import type { DeliveryHealth } from '../wake-reconciler.js'
export function idleWakeAdvice(health?: DeliveryHealth): string | undefined {
  return health?.host === 'claude' && health.path?.availability === 'configured' && health.degraded === undefined
    ? 'Nothing owed; this session is woken when a worker finishes or asks you something, so end your turn instead of calling room_wait again. Call room_wait only with a questionId or claimId. A command of your own (including one the host moved to the background) reports through the host, not through room_wait.'
    : undefined
}
