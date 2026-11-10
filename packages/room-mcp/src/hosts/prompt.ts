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

/**
 * A session whose process ends with its turn: nothing can wake it afterwards, even with an inbox socket bound.
 * Room workers run as `claude -p` / `codex exec`; Claude Code reports print and Agent SDK sessions as the
 * `sdk-cli`, `sdk-ts` and `sdk-py` entrypoints (monitoring-usage.md, app.entrypoint; observed on 2.1.322).
 */
function headlessSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.ROOM_WORKER_ID?.trim() || !!env.CLAUDE_CODE_ENTRYPOINT?.startsWith('sdk-')
}

import type { DeliveryHealth } from '../wake-reconciler.js'
/** Advice for a bare room_wait that timed out; undefined keeps the generic advice. */
export function idleWakeAdvice(health?: DeliveryHealth, opts: { workersRunning?: boolean; env?: NodeJS.ProcessEnv } = {}): string | undefined {
  const headless = headlessSession(opts.env)
  const availability = health?.path?.availability
  if (opts.workersRunning && (headless || availability === 'off' || availability === 'unavailable')) {
    return `${headless ? 'This session is headless: it ends with its turn and cannot be woken' : 'No wake path is available to this session'}, so call room_wait again (timeoutMs up to 100000) to keep supervising; it returns as soon as a worker finishes or asks you something. Continue independent work between waits if you have any.`
  }
  return !headless && health?.host === 'claude' && availability === 'configured' && health.degraded === undefined
    ? 'Nothing owed; this session is woken when a worker finishes or asks you something, so end your turn instead of calling room_wait again. Call room_wait only with a questionId or claimId. A command of your own (including one the host moved to the background) reports through the host, not through room_wait.'
    : undefined
}
