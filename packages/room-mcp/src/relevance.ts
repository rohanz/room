/**
 * Read-time relevance (ledger "The one selection function"): a `base` or `pushed` notice whose commit is
 * already in this clone's HEAD tells the reader nothing, so it is not owed. Nothing is written for it.
 * A commit this clone does not have stays relevant: show rather than hide. A 0.16 branch note
 * ("you switched to B; the room is for R") is never relevant: a repository room has no branch to follow,
 * and an upgraded room may still carry many of them.
 */
import { execFileSync } from 'node:child_process'
import { isLegacyBranchNotice, neighbours, participantsView, type Msg } from '@room/shared'
import type { Session } from './session.js'

/** A negative answer is checked again after this long, in case HEAD moved before the daemon observed it. */
const RECHECK_MS = 5_000

export function createRelevance(now: () => number = Date.now): (s: Session, m: Msg) => boolean {
  const integrated = new Map<string, true | number>()
  return (s, m) => {
    if (m.type === 'pushed' && !neighbours(participantsView(s.room, s.awareness, now()), s.me.name).has(m.from)) return false
    if (isLegacyBranchNotice(m)) return false
    const sha = m.type === 'base' ? m.base : m.type === 'pushed' ? m.toSha : undefined
    if (!sha) return true
    // Capture HEAD once: both the cache key and ancestry check must use this exact commit.
    // The daemon's last observed base can lag a commit and then miss a reset back to that base.
    let head: string
    try { head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: s.dir, encoding: 'utf8', timeout: 2000 }).trim() }
    catch { return true }
    const key = `${s.dir}\u0000${head}\u0000${sha}`
    const known = integrated.get(key)
    if (known === true) return false
    if (known !== undefined && now() - known < RECHECK_MS) return true
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, head], { cwd: s.dir, stdio: 'ignore', timeout: 2000 })
      integrated.set(key, true)
      return false
    } catch {
      integrated.set(key, now())
      return true
    }
  }
}
