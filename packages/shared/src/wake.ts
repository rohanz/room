import { claimsOverlap } from './claims.js'
import type { Claim, ClaimMsg, Identity, Msg } from './types.js'

const WAKE_TYPES = new Set<Msg['type']>(['claim', 'release', 'changed', 'conflict', 'question', 'scope'])

export interface WakeDecision {
  wake: boolean
  /** True when the message is explicitly addressed to this agent. */
  mustAnswer: boolean
  reason: string
}

/** Shared bus wake policy for both reactive runners and MCP channel notifications. */
export function shouldWakeOnMsg(me: Identity, m: Msg, myClaims: Claim[] = []): WakeDecision {
  if (m.from === me.name && m.fromKind === 'agent') return { wake: false, mustAnswer: false, reason: 'own message' }
  const addressed = m.to === me.name
  if (m.type === 'answer') {
    return addressed
      ? { wake: true, mustAnswer: true, reason: 'answer addressed to me' }
      : { wake: false, mustAnswer: false, reason: m.to ? `addressed to ${m.to}` : 'broadcast answer does not wake' }
  }
  if (!WAKE_TYPES.has(m.type)) return { wake: false, mustAnswer: false, reason: `type ${m.type} does not wake` }
  if (m.to && !addressed) return { wake: false, mustAnswer: false, reason: `addressed to ${m.to}` }
  if ((m.type === 'claim' || m.type === 'release') && !addressed && !(m.from === me.name && m.fromKind === 'human')) {
    const near = myClaims.some(c => c.by === me.name && c.byKind === 'agent' && c.path === m.path)
    if (!near) return { wake: false, mustAnswer: false, reason: `${m.type} in ${m.path}, not near my claims` }
  }
  return { wake: true, mustAnswer: addressed, reason: addressed ? 'addressed to me' : 'broadcast' }
}

/** Shared claim-map wake policy: only another party overlapping one of our claims wakes. */
export function shouldWakeOnClaim(me: Identity, claim: Claim, myClaims: Claim[]): WakeDecision {
  if (claim.by === me.name && claim.byKind === 'agent') return { wake: false, mustAnswer: false, reason: 'own agent' }
  const hit = myClaims.find(c => c.by === me.name && c.byKind === 'agent' && c.id !== claim.id && claimsOverlap(c, claim))
  if (!hit) return { wake: false, mustAnswer: false, reason: 'no overlap with my claims' }
  return { wake: true, mustAnswer: false, reason: `overlaps my claim ${hit.id}` }
}

export function claimToMsg(c: Claim): ClaimMsg {
  return { id: `claim:${c.id}`, type: 'claim', priority: 'fyi', from: c.by, fromKind: c.byKind, at: c.at, claimId: c.id, path: c.path, from_line: c.from, to_line: c.to, intent: c.intent }
}
