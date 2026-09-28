/**
 * Read-time relevance (ledger "The one selection function"): a `base` or `pushed` notice whose commit is
 * already in this clone's HEAD tells the reader nothing, so it is not owed. Nothing is written for it.
 * A commit this clone does not have stays relevant: show rather than hide. A 0.16 branch note
 * ("you switched to B; the room is for R") is relevant only while the clone is still on B.
 */
import { execFileSync } from 'node:child_process'
import type { Msg } from '@room/shared'
import type { Session } from './session.js'

/** A negative answer is checked again after this long, in case HEAD moved before the daemon observed it. */
const RECHECK_MS = 5_000
const BRANCH_NOTE = /^you switched to (\S+); the room is for \S+;/

export function createRelevance(now: () => number = Date.now): (s: Session, m: Msg) => boolean {
  const integrated = new Map<string, true | number>()
  return (s, m) => {
    const branchNote = m.type === 'note' && m.from === 'room' ? BRANCH_NOTE.exec(m.text) : null
    if (branchNote) return !s.daemon?.branch || s.daemon.branch === branchNote[1]
    const sha = m.type === 'base' ? m.base : m.type === 'pushed' ? m.toSha : undefined
    if (!sha) return true
    // Keyed by the HEAD the daemon last observed: a reset, checkout or new commit asks again, both ways.
    const key = `${s.dir}\u0000${s.daemon?.base ?? ''}\u0000${sha}`
    const known = integrated.get(key)
    if (known === true) return false
    if (known !== undefined && now() - known < RECHECK_MS) return true
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: s.dir, stdio: 'ignore', timeout: 2000 })
      integrated.set(key, true)
      return false
    } catch {
      integrated.set(key, now())
      return true
    }
  }
}
