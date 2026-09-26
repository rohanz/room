import { type NoteMsg } from '@room/shared'
import { clampShare } from '@room/roomd'
import { resolveShare, sharingDescription } from '../config.js'
import { rememberShare } from '../choice.js'
import type { Session } from '../session.js'
import { SHARE, RW, type Handler, type HandlerState, type ToolDef } from './context.js'

export function secondaryDeclaredLine(s: Session): string | undefined {
  const publisher = s.awareness.getLocalState()?.publishUnder
  return s.daemon.share === 'declared' && typeof publisher === 'string' && publisher
    ? `This checkout's file text is published by ${publisher} and follows ${publisher}'s declared area.` : undefined
}

export const defs: ToolDef[] = [
  { name: 'room_share', annotations: RW, description: 'Report or change sharing live. "share plans only" and "only my declared files" narrow file text; the server ceiling applies.',
    inputSchema: { type: 'object', properties: { level: SHARE } } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, shareLine } = state
  const handlers: Record<string, Handler> = {
    async room_share(a) {
      const s = S()
      const before = s.daemon.share
      if (a.level === undefined) return [shareLine(s), secondaryDeclaredLine(s)].filter(Boolean).join('\n')
      const resolved = resolveShare(a.level, 'level')
      const asked = resolved.level
      s.shareWarning = resolved.warning
      const level = clampShare(asked, s.shareMax)
      s.shareRequested = asked
      await s.daemon.setShare(level) // keep following the declared scope
      try { await rememberShare(s.dir, asked) } catch { /* not a repository: keep the live choice */ }
      if (level !== before) s.room.post<NoteMsg>(s.me, { type: 'note', text: `now sharing ${sharingDescription(level)}`, priority: 'fyi' })
      const out = [level === before ? `sharing level unchanged: ${shareLine(s)}` : `changed sharing ${before} -> ${shareLine(s)}`]
      const secondary = secondaryDeclaredLine(s)
      if (secondary) out.push(secondary)
      else if (level === 'declared' && !s.room.scope(s.me.name)) {
        const retained = s.daemon.retainedDeclared()
        out.push(retained.length
          ? `${retained.length} changed file(s) you declared earlier remain shared: ${retained.slice(0, 8).join(', ')}${retained.length > 8 ? `, +${retained.length - 8} more` : ''}`
          : 'no scope declared yet, so nothing is shared until room_scope(area, summary, paths)')
      }
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
      const publisher = level === 'declared' ? s.awareness.getLocalState()?.publishUnder : undefined
      const description = typeof publisher === 'string' && publisher
        ? `this checkout's file text follows ${publisher}'s declared area (published by ${publisher})`
        : sharingDescription(level)
      return `${s.shareWarning ? s.shareWarning + "; " : ""}sharing: ${description}${clamped}${held.length && !publisher ? `; withheld ${held.length} changed file(s): ${held.join(', ')}` : ''}`
    }
  Object.assign(state, { shareLine })
}
