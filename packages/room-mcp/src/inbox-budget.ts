/**
 * How much inbox one handoff carries. Claude Code caps a hook's `additionalContext` at 10,000 characters and
 * replaces a longer one with a file path and a 2,000-character preview it does not ask the model to read
 * (hooks reference, "JSON output"); a receipt for such output would record a loss. Hooks and tool replies
 * therefore select, in inbox order, only what fits this budget, and the rest stays owed.
 */
import type { Msg, Priority } from '@room/shared'
import type { Batch, Ledger } from './ledger.js'
import type { Session } from './session.js'

/** Characters of inbox items and notices in one hook output or tool reply. */
export const INBOX_BUDGET = 6_000

const rank: Record<Priority, number> = { interrupt: 0, notify: 1, fyi: 2 }
/** Interrupts, then questions, then notify, then fyi; oldest first within each. */
const inboxOrder = (m: Msg): number => m.priority === 'interrupt' ? 0 : m.type === 'question' ? 1 : 2 + rank[m.priority]

export interface Chosen { s: Session; m: Msg }

/**
 * Reserve into `batch`, in inbox order, what `sources` owe while `cost` (the rendered size) fits `budget`,
 * stopping at the first item that does not. `atLeastOne` takes the first item whatever its size (a tool
 * reply has room for it; a hook does not). `more` counts what stays owed among what `filter` accepts.
 */
export function selectWithin(ledger: Ledger, sources: readonly Session[], batch: Batch, budget: number, cost: (c: Chosen) => number, atLeastOne = false, filter?: (s: Session) => (m: Msg) => boolean): { chosen: Chosen[]; more: number } {
  const all: Chosen[] = sources.flatMap(s => ledger.available(s, batch, filter?.(s)).map(m => ({ s, m })))
  all.sort((a, b) => inboxOrder(a.m) - inboxOrder(b.m) || a.m.at - b.m.at)
  const chosen: Chosen[] = []
  let used = 0
  for (const c of all) {
    const size = cost(c)
    if (used + size > budget && !(atLeastOne && !chosen.length)) break
    chosen.push(c); used += size
  }
  for (const s of sources) {
    const ids = new Set(chosen.filter(c => c.s === s).map(c => c.m.id))
    if (ids.size) ledger.select(s, batch, m => ids.has(m.id))
  }
  return { chosen, more: all.length - chosen.length }
}

/** The line that tells the reader where the rest is. */
export const moreLine = (more: number): string => `${more} more: call room_state`
