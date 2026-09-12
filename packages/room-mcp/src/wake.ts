import { claimsOverlap, cursorInClaim, formatMsg, describeClaim, shouldWakeOnClaim, shouldWakeOnMsg } from '@room/shared'
import type { Claim, Cursor, Identity, Msg } from '@room/shared'

/** What gets pushed to the agent (channel notification or Codex turn input). */
export interface WakeEvent {
  content: string
  /** keys are [a-z0-9_] only, values are strings */
  meta: Record<string, string>
}

export type RoomEvent =
  | { kind: 'msg'; msg: Msg }
  | { kind: 'claim'; claim: Claim }
  | { kind: 'cursor'; who: Identity; cursor: Cursor }

function cleanMeta(m: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined || v === '') continue
    const key = k.toLowerCase().replace(/[^a-z0-9_]/g, '_')
    out[key] = String(v)
  }
  return out
}

/**
 * Decide whether an event should wake `me` (an agent) and, if so, how to present it.
 * `myClaims` = my currently open claims (used for overlap / cursor-entry rules).
 * Returns null when the agent should not be interrupted.
 */
export function shouldWake(me: Identity, ev: RoomEvent, myClaims: Claim[] = []): WakeEvent | null {
  if (ev.kind === 'msg') {
    const m = ev.msg
    if (!shouldWakeOnMsg(me, m, myClaims).wake) return null
    const path = 'path' in m ? m.path : 'paths' in m ? m.paths[0] : undefined
    return {
      content: `${formatMsg(m)}\n${JSON.stringify(m)}`,
      meta: cleanMeta({ type: m.type, from: m.from, from_kind: m.fromKind, path, msg_id: m.id }),
    }
  }
  if (ev.kind === 'claim') {
    const c = ev.claim
    if (!shouldWakeOnClaim(me, c, myClaims).wake) return null
    const hit = myClaims.find(mine => claimsOverlap(mine, c))
    if (!hit) return null
    return {
      content: `${describeClaim(c)} — overlaps your claim ${hit.id} (${hit.path}:${hit.from}-${hit.to})\n${JSON.stringify({ claim: c, mine: hit })}`,
      meta: cleanMeta({ type: 'claim_overlap', from: c.by, from_kind: c.byKind, path: c.path, msg_id: c.id }),
    }
  }
  if (ev.kind === 'cursor') {
    if (ev.who.kind !== 'human') return null
    if (ev.who.name === me.name) {
      // my own human editing inside my claim is still worth knowing about
    }
    const hit = myClaims.find(mine => cursorInClaim(ev.cursor, mine))
    if (!hit) return null
    return {
      content: `${ev.who.name} is editing ${ev.cursor.path}:${ev.cursor.from}-${ev.cursor.to}, inside your claim ${hit.id} (${hit.intent})\n${JSON.stringify({ cursor: ev.cursor, claim: hit })}`,
      meta: cleanMeta({ type: 'cursor_in_claim', from: ev.who.name, from_kind: 'human', path: ev.cursor.path, msg_id: hit.id }),
    }
  }
  return null
}
