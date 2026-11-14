import { isAgentic } from './identity.js'
import { messageKind } from './messages.js'
import type { Claim, Identity, Msg } from './types.js'

export interface WakeDecision {
  wake: boolean
  /** True when the message is explicitly addressed to this agent. */
  mustAnswer: boolean
  reason: string
}

/** Bus wake policy for host wake transports. */
export function shouldWakeOnMsg(me: Identity, m: Msg, myClaims: Claim[] = [], hasUncommitted = false, ownWorkerNames?: ReadonlySet<string>): WakeDecision {
  if (m.type === 'plan' && m.priority === 'fyi') return { wake: false, mustAnswer: false, reason: 'ended plan' }
  if (m.from === me.name && m.fromKind !== 'human') return { wake: false, mustAnswer: false, reason: 'own message' }
  const addressed = m.to === me.name
  const kind = messageKind(m)
  if (kind.wakes === 'never') return { wake: false, mustAnswer: false, reason: 'feed-only event' }
  // Routine progress from this lead's own workers belongs in the inbox / next wait.
  // Keep interrupts, questions and completion events on the normal wake path.
  if (m.type === 'note' && m.priority !== 'interrupt' && addressed && m.fromKind === 'agent' && ownWorkerNames?.has(m.from)) {
    return { wake: false, mustAnswer: false, reason: 'own worker progress note' }
  }
  if ((m.type === 'done' || m.type === 'question') && addressed) return { wake: true, mustAnswer: true, reason: `${m.type} addressed to me` }
  if ((!m.to || addressed) && typeof kind.wakes === 'function' && kind.wakes(m, { me, hasUncommitted, myClaims })) {
    return { wake: true, mustAnswer: addressed, reason: 'message wake rule' }
  }
  // v2 priorities: fyi never wakes; notify wakes only when addressed; interrupt always (unless addressed elsewhere).
  if (m.priority === 'fyi') return { wake: false, mustAnswer: false, reason: 'fyi does not wake' }
  if (m.priority === 'notify' && !addressed) return { wake: false, mustAnswer: false, reason: m.to ? `addressed to ${m.to}` : 'broadcast notify is read on next action' }
  if (m.priority === 'interrupt') {
    if (m.to && !addressed) return { wake: false, mustAnswer: false, reason: `addressed to ${m.to}` }
    return { wake: true, mustAnswer: addressed, reason: addressed ? 'interrupt addressed to me' : 'broadcast interrupt' }
  }
  if (m.to && !addressed) return { wake: false, mustAnswer: false, reason: `addressed to ${m.to}` }
  if ((kind.wakes === 'interrupt' || typeof kind.wakes === 'function')) return { wake: false, mustAnswer: false, reason: `type ${m.type} does not wake` }
  if (kind.wakes === 'addressed' && !addressed) return { wake: false, mustAnswer: false, reason: 'not addressed to me' }
  if (kind.audience === 'claim-holders' && !addressed && !(m.from === me.name && m.fromKind === 'human')) {
    const path = 'path' in m && typeof m.path === 'string' ? m.path : ''
    const near = myClaims.some(c => c.by === me.name && isAgentic(c.byKind) && c.path === path)
    if (!near) return { wake: false, mustAnswer: false, reason: `${m.type} in ${path}, not near my claims` }
  }
  return { wake: true, mustAnswer: addressed, reason: addressed ? 'addressed to me' : 'broadcast' }
}
