import { type NoteMsg } from '@room/shared'
import { clampShare, parseShare } from '@room/roomd'
import { SHARE, RO, RW, int, str, strs, type Handler, type HandlerState, type ToolDef } from './context.js'

export const defs: ToolDef[] = [
  { name: 'room_share', annotations: RW, description: 'Change how much of your clone the room sees, live. Lowering the level withdraws file text the new level no longer allows (intent: all of it; declared: everything outside your scope paths); raising it republishes what your disk holds. Never above the server\'s ceiling. Without `level`, reports the current level and what is withheld.',
    inputSchema: { type: 'object', properties: { level: SHARE } } }
]

export function handlers(state: HandlerState): Record<string, Handler> {
  const { S, shareLine } = state
  const handlers: Record<string, Handler> = {
    async room_share(a) {
      const s = S()
      const before = s.daemon.share
      if (a.level === undefined) return shareLine(s)
      const asked = parseShare(a.level)
      if (!asked) return `error: level must be intent, declared or full (got ${String(a.level)})`
      const level = clampShare(asked, s.shareMax)
      s.shareRequested = asked
      await s.daemon.setShare(level) // keep following the declared scope
      if (level !== before) s.room.post<NoteMsg>(s.me, { type: 'note', text: `now sharing ${level}${level === 'intent' ? ' (withdrew all file text)' : level === 'declared' ? ' (file text only under declared scope paths)' : ' (all changed files)'}`, priority: 'fyi' })
      const out = [level === before ? `sharing level unchanged: ${shareLine(s)}` : `changed sharing ${before} -> ${shareLine(s)}`]
      if (level === 'declared' && !s.room.scope(s.me.name)) out.push('no scope declared yet, so nothing is shared until room_scope(area, summary, paths)')
      return out.join('\n')
    }
  }
  return handlers
}
