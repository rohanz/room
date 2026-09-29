import { displayName } from './identity.js'
import type { Claim, Cursor } from './types.js'
import { formatPlans } from './format.js'
import { containsPath, normalizeCoordinationPath } from './near.js'

export function rangesOverlap(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom <= bTo && bFrom <= aTo
}

export function claimsOverlap(a: Pick<Claim, 'path' | 'from' | 'to'>, b: Pick<Claim, 'path' | 'from' | 'to'>): boolean {
  if (/[\\/]$/.test(a.path) && containsPath(a.path, b.path)) return true
  if (/[\\/]$/.test(b.path) && containsPath(b.path, a.path)) return true
  return normalizeCoordinationPath(a.path) === normalizeCoordinationPath(b.path) && rangesOverlap(a.from, a.to, b.from, b.to)
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

const linesOf = (text: string): string[] => text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')

/** Map inclusive, 1-based lines through a line diff. A changed hunk owns its whole destination span. */
export function mapRange(fromText: string, toText: string, range: { from: number; to: number }): { from: number; to: number } {
  if (fromText === toText) return range
  const old = linesOf(fromText), next = linesOf(toText)
  // Large files degrade conservatively instead of allocating a quadratic diff table.
  if (old.length * next.length > 1_000_000) return { from: 1, to: Math.max(1, next.length) }
  const dp = Array.from({ length: old.length + 1 }, () => new Uint32Array(next.length + 1))
  for (let i = old.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--)
    dp[i]![j] = old[i] === next[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  let i = 0, j = 0, start = Number.POSITIVE_INFINITY, end = 0
  while (i < old.length || j < next.length) {
    if (i < old.length && j < next.length && old[i] === next[j]) {
      if (i + 1 >= range.from && i + 1 <= range.to) { start = Math.min(start, j + 1); end = Math.max(end, j + 1) }
      i++; j++; continue
    }
    const oldStart = i, newStart = j
    while (i < old.length || j < next.length) {
      if (i < old.length && j < next.length && old[i] === next[j]) break
      if (j < next.length && (i === old.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) j++
      else i++
    }
    if ((i > oldStart && oldStart + 1 <= range.to && i >= range.from) ||
        (i === oldStart && oldStart >= range.from && oldStart < range.to)) {
      start = Math.min(start, newStart + 1)
      end = Math.max(end, Math.max(newStart + 1, j))
    }
  }
  if (!Number.isFinite(start)) start = Math.min(Math.max(1, range.from), Math.max(1, next.length))
  return clampRange(start, Math.max(start, end), next.length)
}

/** Claim coordinates in the caller's text; missing owner text must not certify a narrow overlap. */
export function claimInMyLines(claim: { from: number; to: number }, ownerVersion: string | undefined, myText: string): { from: number; to: number; approximate: boolean } {
  if (ownerVersion === undefined) return { from: 1, to: Math.max(1, linesOf(myText).length), approximate: true }
  return { ...mapRange(ownerVersion, myText, claim), approximate: linesOf(ownerVersion).length * linesOf(myText).length > 1_000_000 && ownerVersion !== myText }
}

export function describeClaim(c: Claim): string {
  const who = displayName({ name: c.by, kind: c.byKind })
  return `${who} · ${c.path}${c.path.endsWith('/') ? '' : `:${c.from}-${c.to}`} · ${c.intent}${c.plans?.length ? ` · plans: ${formatPlans(c.plans)}` : ''}`
}
