import { isAgentic } from './identity.js'
import { claimsOverlap } from './claims.js'
import { messageKind } from './messages.js'
import type { Claim, ClaimMsg, Identity, Msg } from './types.js'

export interface WakeDecision {
  wake: boolean
  /** True when the message is explicitly addressed to this agent. */
  mustAnswer: boolean
  reason: string
}

/** Shared bus wake policy for both reactive runners and MCP channel notifications. */
export function shouldWakeOnMsg(me: Identity, m: Msg, myClaims: Claim[] = [], hasUncommitted = false): WakeDecision {
  if (m.type === 'plan' && m.priority === 'fyi') return { wake: false, mustAnswer: false, reason: 'ended plan' }
  if (m.from === me.name && isAgentic(m.fromKind)) return { wake: false, mustAnswer: false, reason: 'own message' }
  const addressed = m.to === me.name
  const kind = messageKind(m)
  if (kind.wakes === 'never') return { wake: false, mustAnswer: false, reason: 'feed-only event' }
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

/** Shared claim-map wake policy: only another party overlapping one of our claims wakes. */
export function shouldWakeOnClaim(me: Identity, claim: Claim, myClaims: Claim[]): WakeDecision {
  if (claim.by === me.name && isAgentic(claim.byKind)) return { wake: false, mustAnswer: false, reason: 'own agent' }
  const hit = myClaims.find(c => c.by === me.name && isAgentic(c.byKind) && c.id !== claim.id && claimsOverlap(c, claim))
  if (!hit) return { wake: false, mustAnswer: false, reason: 'no overlap with my claims' }
  return { wake: true, mustAnswer: false, reason: `overlaps my claim ${hit.id}` }
}

export function claimToMsg(c: Claim): ClaimMsg {
  return { id: `claim:${c.id}`, type: 'claim', priority: 'fyi', from: c.by, fromKind: c.byKind, at: c.at, claimId: c.id, path: c.path, from_line: c.from, to_line: c.to, intent: c.intent }
}
