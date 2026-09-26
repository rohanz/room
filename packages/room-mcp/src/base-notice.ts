import type { Msg } from '@room/shared'
import { git } from '@room/roomd/git'
import type { Session } from './session.js'

type Recipient = Pick<Session, 'dir' | 'room' | 'me'>

/** A base notice is satisfied only when its commit is in this recipient's HEAD; git errors leave it deliverable. */
export async function dropSatisfiedBaseNotice(s: Recipient, m: Msg): Promise<boolean> {
  if (m.type !== 'base') return false
  try {
    await git(s.dir, ['merge-base', '--is-ancestor', m.base, 'HEAD'])
    s.room.markSeen(s.me.name, [m.id])
    return true
  } catch { return false }
}
