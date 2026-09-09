import type { Claim, ClaimMsg, Identity, Msg } from '@room/shared'
import { claimsOverlap } from '@room/shared'

/** Bus message types that wake an agent when broadcast or addressed to it. */
const WAKE_TYPES = new Set<Msg['type']>(['claim', 'release', 'changed', 'conflict', 'question'])

export interface WakeDecision {
  wake: boolean
  /** true when the message is addressed to us explicitly (must answer). */
  mustAnswer: boolean
  reason: string
}

/**
 * Wake rules for a bus message (spec §5 / §12):
 * - skip anything from ourselves (same name, agent kind)
 * - wake on claim/release/changed/conflict/question when `to` is empty or is our name
 * - answer only when `to` is our name
 */
export function shouldWakeOnMsg(me: Identity, m: Msg): WakeDecision {
  if (m.from === me.name && m.fromKind === 'agent') return { wake: false, mustAnswer: false, reason: 'own message' }
  if (!WAKE_TYPES.has(m.type)) return { wake: false, mustAnswer: false, reason: `type ${m.type} does not wake` }
  const addressed = m.to === me.name
  if (m.to && !addressed) return { wake: false, mustAnswer: false, reason: `addressed to ${m.to}` }
  return { wake: true, mustAnswer: addressed, reason: addressed ? 'addressed to me' : 'broadcast' }
}

/**
 * Wake rule for a new claim in the claims map: wake if it was made by another party and
 * overlaps one of our own open claims.
 */
export function shouldWakeOnClaim(me: Identity, claim: Claim, allClaims: Claim[]): WakeDecision {
  if (claim.by === me.name) return { wake: false, mustAnswer: false, reason: 'own party' }
  const mine = allClaims.filter(c => c.by === me.name && c.byKind === 'agent' && c.id !== claim.id)
  const hit = mine.find(c => claimsOverlap(c, claim))
  if (!hit) return { wake: false, mustAnswer: false, reason: 'no overlap with my claims' }
  return { wake: true, mustAnswer: false, reason: `overlaps my claim ${hit.id}` }
}

/** Synthesise a bus-shaped message for a claim seen only in the claims map. */
export function claimToMsg(c: Claim): ClaimMsg {
  return { id: `claim:${c.id}`, type: 'claim', from: c.by, fromKind: c.byKind, at: c.at, claimId: c.id, path: c.path, from_line: c.from, to_line: c.to, intent: c.intent }
}
