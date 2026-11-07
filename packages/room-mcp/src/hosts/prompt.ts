import { sessionHost } from './selection.js'
import { claudeWakeAvailable } from './claude-wake.js'
/** The exported inbox socket (Claude Code 2.1.224+) or an admitted channel enables wakes. */
export function wakeUnavailable(dir: string, host = sessionHost(), parentArgs?: string): boolean {
  if (host !== 'claude') return false
  return !claudeWakeAvailable({ host, parentArgs })
}

/** Plain wording is separate from process detection so shell-specific setup can be checked. */
export function wakeText(shell?: string, off = false): string {
  if (off) return 'For your human: wake-ups are off in this process (ROOM_WAKE=off). Set ROOM_WAKE=auto to enable them.'
  const rc = shell?.endsWith('bash') ? '~/.bashrc' : '~/.zshrc'
  return [
    'For your human: no wake path is available for this Claude Code session. Pending messages can arrive on Room tool replies and eligible edit hooks; an idle session may need another turn.',
    'First update Claude Code to 2.1.224 or later (2.1.234 or later on native Windows) so it can bind an inbox socket. Check /status for its Peer address.',
    `If a socket is unavailable, start Claude Code with \`claude-room\`. If that command is not found, add it: \`echo "alias claude-room='claude --dangerously-load-development-channels plugin:room@room'" >> ${rc}\``,
    'For claude-room channels on a claude.ai Team or Enterprise account, an Owner must enable channels; organization settings can also turn cross-session messaging off.',
  ].join('\n')
}

import type { DeliveryHealth } from '../wake-reconciler.js'
export function idleWakeAdvice(health?: DeliveryHealth): string | undefined {
  return health?.host === 'claude' && health.path?.availability === 'configured' && health.degraded === undefined
    ? 'Nothing owed; this session is woken when a worker finishes or asks you something, so end your turn instead of calling room_wait again. Call room_wait only with a questionId or claimId. A command of your own (including one the host moved to the background) reports through the host, not through room_wait.'
    : undefined
}
