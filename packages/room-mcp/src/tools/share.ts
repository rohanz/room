import { type NoteMsg } from '@room/shared'
import { clampShare } from '@room/roomd'
import { resolveShare, sharingDescription } from '../config.js'
import type { Session } from '../session.js'
import { SHARE, RW, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_share', annotations: RW, description: 'Report or change sharing live; narrower levels withdraw file text. The server ceiling always applies.',
    inputSchema: { type: 'object', properties: { level: SHARE } } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, shareLine } = state
  const handlers: Record<string, Handler> = {
    async room_share(a) {
      const s = S()
      const before = s.daemon.share
      if (a.level === undefined) return shareLine(s)
      const resolved = resolveShare(a.level, 'level')
      const asked = resolved.level
      s.shareWarning = resolved.warning
      const level = clampShare(asked, s.shareMax)
      s.shareRequested = asked
      await s.daemon.setShare(level) // keep following the declared scope
      if (level !== before) s.room.post<NoteMsg>(s.me, { type: 'note', text: `now sharing ${sharingDescription(level)}`, priority: 'fyi' })
      const out = [level === before ? `sharing level unchanged: ${shareLine(s)}` : `changed sharing ${before} -> ${shareLine(s)}`]
      if (level === 'declared' && !s.room.scope(s.me.name)) out.push('no scope declared yet, so nothing is shared until room_scope(area, summary, paths)')
      return out.join('\n')
    }
  }
  return handlers
}


export function install(state: HandlerState): void {
  const shareLine = (s: Session): string => {
      const level = s.daemon.share ?? s.shareRequested ?? 'intent'
      const clamped = s.shareRequested && s.shareRequested !== level ? ` (asked for ${s.shareRequested}; the server caps sharing at ${s.shareMax}, ROOM_SHARE_MAX)` : ''
      const held = s.daemon.skipped?.().share ?? []
      return `${s.shareWarning ? s.shareWarning + "; " : ""}sharing: ${sharingDescription(level)}${clamped}${held.length ? `; withheld ${held.length} changed file(s): ${held.join(', ')}` : ''}`
    }
  Object.assign(state, { shareLine })
}
