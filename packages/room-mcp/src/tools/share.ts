import { type NoteMsg } from '@room/shared'
import { resolveShare, sharingDescription } from '../config.js'
import type { Session } from '../session.js'
import { SHARE, RW, type Handler, type HandlerState, type ToolDef } from './context.js'

export function publisherLine(s: Session): string | undefined {
  const head = s.room.manifestHead.get(s.me.name)
  const publisher = head?.coverage.kind === 'none' && head.coverage.reason === 'not-publisher' ? head.publisher : undefined
  if (typeof publisher !== 'string' || !publisher) return undefined
  const primary = [...s.awareness.getStates().values()].find(state => state?.user?.name === publisher && !state.publishUnder)
  const level = primary?.share === 'full' || primary?.share === 'declared' || primary?.share === 'intent' ? ` (${primary.share})` : ''
  return `This checkout's file text is published by ${publisher} and follows ${publisher}'s sharing settings${level}.`
}

export function retainedList(paths: string[]): string {
  return `${paths.slice(0, 8).join(', ')}${paths.length > 8 ? `, +${paths.length - 8} more` : ''}`
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
      if (a.level === undefined) return shareLine(s)
      const resolved = resolveShare(a.level, 'level')
      const asked = resolved.level
      s.shareWarning = resolved.warning
      const policy = await s.policyStore.setRequested(asked)
      const level = policy.level
      s.shareRequested = asked
      if (level !== before) await s.post<NoteMsg>(s.me, { type: 'note', text: `now sharing ${sharingDescription(level)}`, priority: 'fyi' })
      const out = [level === before ? `sharing level unchanged: ${shareLine(s)}` : `changed sharing ${before} -> ${shareLine(s)}`]
      const secondary = publisherLine(s)
      if (secondary) out.push(secondary)
      else if (level === 'declared' && !s.room.scope(s.me.name)) {
        const retained = [...s.policyStore.retained]
        out.push(retained.length
          ? `${retained.length} changed file(s) you declared earlier remain shared: ${retainedList(retained)}`
          : 'no scope declared yet, so nothing is shared until room_scope(area, summary, paths)')
      }
      return out.join('\n')
    }
  }
  return handlers
}


export function createShare(): Pick<HandlerState, 'shareLine'> {
  const shareLine = (s: Session): string => {
      const level = s.daemon.share ?? s.shareRequested ?? 'intent'
      const clamped = s.shareRequested && s.shareRequested !== level ? ` (asked for ${s.shareRequested}; the server caps sharing at ${s.shareMax}, ROOM_SHARE_MAX)` : ''
      const secondary = publisherLine(s)
      const retained = level === 'declared' && !secondary ? [...s.policyStore.retained] : []
      return `${s.shareWarning ? s.shareWarning + "; " : ""}sharing: ${secondary ?? sharingDescription(level)}${clamped}${retained.length ? `; still shared from earlier: ${retainedList(retained)}` : ''}`
    }
  return { shareLine }
}
