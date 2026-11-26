import { openConflicts, type OpenConflict } from '@room/shared'
import type { Session } from '../session.js'

/** Each attached room supplies only its own current state. */
export function sessionConflicts(sessions: readonly Session[]): { session: Session; conflict: OpenConflict }[] {
  return sessions.flatMap(session => openConflicts(session.room, session.me.name).map(conflict => ({ session, conflict })))
}
