import { displayName } from './identity.js'
import type { Claim, Cursor } from './types.js'
import { formatPlans } from './format.js'

export function rangesOverlap(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom <= bTo && bFrom <= aTo
}

export function claimsOverlap(a: Pick<Claim, 'path' | 'from' | 'to'>, b: Pick<Claim, 'path' | 'from' | 'to'>): boolean {
  if (a.path.endsWith('/') && b.path.startsWith(a.path)) return true
  if (b.path.endsWith('/') && a.path.startsWith(b.path)) return true
  return a.path === b.path && rangesOverlap(a.from, a.to, b.from, b.to)
}

export function cursorInClaim(c: Cursor, claim: Claim): boolean {
  return claimsOverlap(c, claim)
}

/** Clamp a 1-based inclusive range to a file of `lineCount` lines. */
export function clampRange(from: number, to: number, lineCount: number): { from: number; to: number } {
  const max = Math.max(1, lineCount)
  const f = Math.min(Math.max(1, Math.floor(from)), max)
  const t = Math.min(Math.max(f, Math.floor(to)), max)
  return { from: f, to: t }
}

export function describeClaim(c: Claim): string {
  const who = displayName({ name: c.by, kind: c.byKind })
  return `${who} · ${c.path}${c.path.endsWith('/') ? '' : `:${c.from}-${c.to}`} · ${c.intent}${c.plans?.length ? ` · plans: ${formatPlans(c.plans)}` : ''}`
}
