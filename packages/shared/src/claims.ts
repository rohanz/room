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
  const { from, to } = prepareClaimLineMap(fromText, toText)(range)
  return { from, to }
}

/** A run of equal lines, 0-based: old[oldAt + k] === next[newAt + k] for k < length. */
type Run = { oldAt: number; newAt: number; length: number }

/** Bounds on one diff of the changed middle: Myers' edit-graph steps, then the cells of an LCS table. */
const MYERS_STEPS = 2_000_000
const LCS_CELLS = 1_000_000

/** Equal runs of old[lo..oldHi) and next[lo..newHi) by Myers' greedy diff, or undefined past MYERS_STEPS. */
function myersRuns(old: Int32Array, next: Int32Array, lo: number, oldHi: number, newHi: number): Run[] | undefined {
  const n = oldHi - lo, m = newHi - lo
  const trace: Int32Array[] = []
  let steps = 0
  for (let d = 0; d <= n + m; d++) {
    // v[k + d] is the furthest x on diagonal k = x - y after d edits.
    const v = new Int32Array(2 * d + 1), prev = trace[d - 1]
    for (let k = -d; k <= d; k += 2) {
      let x = d === 0 ? 0 : k === -d || (k !== d && prev![k - 1 + d - 1]! < prev![k + 1 + d - 1]!) ? prev![k + 1 + d - 1]! : prev![k - 1 + d - 1]! + 1
      let y = x - k
      while (x < n && y < m && old[lo + x] === next[lo + y]) { x++; y++; steps++ }
      v[k + d] = x
      if (x >= n && y >= m) {
        trace.push(v)
        const runs: Run[] = []
        // Walk back: each step's snake runs from just after its one edit to where the step ended.
        for (let e = d; e >= 0; e--) {
          const kk = x - y, before = trace[e - 1]
          const down = e > 0 && (kk === -e || (kk !== e && before![kk - 1 + e - 1]! < before![kk + 1 + e - 1]!))
          const startX = e === 0 ? 0 : down ? before![kk + 1 + e - 1]! : before![kk - 1 + e - 1]! + 1
          if (x > startX) runs.push({ oldAt: lo + startX, newAt: lo + startX - kk, length: x - startX })
          if (e > 0) { x = down ? startX : startX - 1; y = x - (down ? kk + 1 : kk - 1) }
        }
        return runs.reverse()
      }
    }
    trace.push(v)
    steps += 2 * d + 1
    if (steps > MYERS_STEPS) return undefined
  }
  return undefined
}

/** Equal runs of a small middle by an LCS table (the earlier mapping, kept where Myers runs out of steps). */
function lcsRuns(old: Int32Array, next: Int32Array, lo: number, oldHi: number, newHi: number): Run[] {
  const n = oldHi - lo, m = newHi - lo
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i]![j] = old[lo + i] === next[lo + j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const runs: Run[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (old[lo + i] === next[lo + j]) {
      const last = runs[runs.length - 1]
      if (last && last.oldAt + last.length === lo + i && last.newAt + last.length === lo + j) last.length++
      else runs.push({ oldAt: lo + i, newAt: lo + j, length: 1 })
      i++; j++
    } else if (dp[i]![j + 1]! >= dp[i + 1]![j]!) j++
    else i++
  }
  return runs
}

/** Prepare one owner-to-local diff, then map any number of the owner's claim ranges.
 *  Unknown owner text keeps the claim's own numbers, marked approximate: their lines may have shifted relative to mine.
 *  A claim touching a changed middle too large to diff degrades the same way; ranges in the common prefix and suffix
 *  always map exactly. */
export function prepareClaimLineMap(ownerVersion: string | undefined, myText: string): (range: { from: number; to: number }) => { from: number; to: number; approximate: boolean } {
  const nextLines = linesOf(myText)
  // Unclamped: past my end of file their numbers say nothing about my last line.
  if (ownerVersion === undefined) return range => ({ from: range.from, to: range.to, approximate: true })
  if (ownerVersion === myText) return range => ({ from: range.from, to: range.to, approximate: false })
  const oldLines = linesOf(ownerVersion)
  const ids = new Map<string, number>()
  const intern = (lines: string[]) => Int32Array.from(lines, line => { let id = ids.get(line); if (id === undefined) ids.set(line, id = ids.size); return id })
  const old = intern(oldLines), next = intern(nextLines)
  let prefix = 0
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  const oldHi = old.length - suffix, newHi = next.length - suffix
  const middle = oldHi === prefix || newHi === prefix ? [] : myersRuns(old, next, prefix, oldHi, newHi) ??
    ((oldHi - prefix) * (newHi - prefix) <= LCS_CELLS ? lcsRuns(old, next, prefix, oldHi, newHi) : undefined)
  const runs: Run[] = [{ oldAt: 0, newAt: 0, length: prefix }, ...middle ?? [], { oldAt: oldHi, newAt: newHi, length: suffix }]
  // Changed hunks between the runs, 0-based half-open; the undiffed middle is one approximate hunk.
  const hunks: { oldAt: number; oldEnd: number; newAt: number; newEnd: number }[] = []
  for (let r = 0; r + 1 < runs.length; r++) {
    const a = runs[r]!, b = runs[r + 1]!
    if (a.oldAt + a.length < b.oldAt || a.newAt + a.length < b.newAt) hunks.push({ oldAt: a.oldAt + a.length, oldEnd: b.oldAt, newAt: a.newAt + a.length, newEnd: b.newAt })
  }
  return range => {
    let start = Number.POSITIVE_INFINITY, end = 0
    const take = (from: number, to: number) => { start = Math.min(start, from); end = Math.max(end, to) }
    for (const run of runs) {
      const lo = Math.max(range.from - 1, run.oldAt), hi = Math.min(range.to - 1, run.oldAt + run.length - 1)
      if (lo <= hi) take(lo - run.oldAt + run.newAt + 1, hi - run.oldAt + run.newAt + 1)
    }
    for (const h of hunks) {
      const changed = h.oldEnd > h.oldAt && h.oldAt + 1 <= range.to && h.oldEnd >= range.from
      // A pure insertion belongs to a range that holds the lines on both sides of it.
      const inserted = h.oldEnd === h.oldAt && h.oldAt >= range.from && h.oldAt < range.to
      if (!changed && !inserted) continue
      const last = Math.max(h.newAt + 1, h.newEnd)
      if (middle !== undefined) { take(h.newAt + 1, last); continue }
      // Too large to diff: the holder's own numbers, unclamped, as for unknown text.
      return { from: range.from, to: range.to, approximate: true }
    }
    if (!Number.isFinite(start)) start = Math.min(Math.max(1, range.from), Math.max(1, nextLines.length))
    return { ...clampRange(start, Math.max(start, end), nextLines.length), approximate: false }
  }
}

/** Claim coordinates in the caller's text; missing owner text keeps the claim's numbers, marked approximate. */
export function claimInMyLines(claim: { from: number; to: number }, ownerVersion: string | undefined, myText: string): { from: number; to: number; approximate: boolean } {
  return prepareClaimLineMap(ownerVersion, myText)(claim)
}

export function describeClaim(c: Claim): string {
  const who = displayName({ name: c.by, kind: c.byKind })
  return `${who} · ${c.path}${c.path.endsWith('/') ? '' : `:${c.from}-${c.to}`} · ${c.intent}${c.plans?.length ? ` · plans: ${formatPlans(c.plans)}` : ''}`
}
