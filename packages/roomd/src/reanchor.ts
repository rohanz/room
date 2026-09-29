import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { Claim } from '@room/shared'
import { diffArrays } from 'diff'

export interface ClaimMove { id: string; from: number; to: number }
export interface ClaimRelease { id: string; path: string; from: number; to: number }
export interface ReanchorResult { moves: ClaimMove[]; releases: ClaimRelease[]; uncertain: string[] }
export interface ReanchorOptions {
  originals?: ReadonlyMap<string, string>
  previousTexts?: ReadonlyMap<string, string>
  unreadable?: ReadonlySet<string>
  workBudget?: number
  valid?: () => boolean
  progress?: Map<string, ClaimSearchProgress>
  searchKey?: (claim: Claim) => string
}
export interface ClaimSearchProgress {
  key: string
  lines: string[]
  prefix: number[]
  next: number
  found: number
  at: number
  firstLineHash?: number
  candidate?: number
}

const DEFAULT_WORK_BUDGET = 4_000_000
const BASE = 16777619
const digestLines = (lines: readonly string[]): string => createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')
const splitLines = (text: string): string[] => {
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

/** SHA-256 of exact 1-based inclusive lines. The digest, never source, enters the shared claim. */
export function claimDigest(text: string, from: number, to: number): string | undefined {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) return undefined
  const lines = splitLines(text)
  return to <= lines.length ? digestLines(lines.slice(from - 1, to)) : undefined
}

function lineHash(line: string): number {
  let h = 2166136261
  for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), BASE)
  return h >>> 0
}

/** A line diff only proposes a range; the caller verifies its digest and scans for duplicates. */
function mappedCandidate(claim: Claim, before: string, after: string, budget: number): number | undefined {
  if (claimDigest(before, claim.from, claim.to) !== claim.claimedHash) return undefined
  const oldLines = splitLines(before), newLines = splitLines(after)
  const maxEditLength = Math.floor(budget / Math.max(1, oldLines.length + newLines.length))
  if (maxEditLength < 1) return undefined
  const changes = diffArrays(oldLines, newLines, { maxEditLength })
  if (!changes) return undefined
  let oldAt = 1, newAt = 1, mapped: number | undefined
  for (const change of changes) {
    const count = change.value.length
    if (change.removed) oldAt += count
    else if (change.added) newAt += count
    else {
      if (claim.from >= oldAt && claim.to < oldAt + count) mapped = newAt + claim.from - oldAt
      oldAt += count
      newAt += count
    }
  }
  return mapped
}

/** Yield and count actual inspected characters, including exact candidate verification. */
export async function reanchorClaims(owner: string, claims: readonly Claim[], texts: ReadonlyMap<string, string | undefined>, options: ReanchorOptions = {}): Promise<ReanchorResult> {
  const moves: ClaimMove[] = [], releases: ClaimRelease[] = [], uncertain: string[] = []
  const budget = options.workBudget ?? DEFAULT_WORK_BUDGET
  let work = 0, steps = 0, stale = false
  const tick = async (units: number): Promise<boolean> => {
    work += units
    if (++steps % 128 === 0) await setImmediate()
    if (options.valid && !options.valid()) stale = true
    return work <= budget && !stale
  }
  for (const claim of claims) {
    await setImmediate()
    if (claim.by !== owner || claim.path.endsWith('/')) continue
    if (options.unreadable?.has(claim.path)) { uncertain.push(claim.id); continue }
    const text = texts.get(claim.path)
    if (text === undefined) { releases.push({ id: claim.id, path: claim.path, from: claim.from, to: claim.to }); continue }
    if (!await tick(text.length)) { uncertain.push(claim.id); continue }
    const key = options.searchKey?.(claim) ?? ''
    let progress = options.progress?.get(claim.id)
    if (progress && progress.key !== key) { options.progress?.delete(claim.id); progress = undefined }
    const lines = progress?.lines ?? splitLines(text)
    const width = claim.to - claim.from + 1
    if (!claim.claimedHash) { uncertain.push(claim.id); continue }
    if (!Number.isSafeInteger(width) || width <= 0) {
      releases.push({ id: claim.id, path: claim.path, from: claim.from, to: claim.to }); continue
    }
    const current = lines.slice(claim.from - 1, claim.to)
    if (current.length === width && await tick(current.reduce((n, s) => n + s.length, 0)) && digestLines(current) === claim.claimedHash) {
      options.progress?.delete(claim.id)
      continue
    }
    if (work > budget || stale) { uncertain.push(claim.id); continue }
    // Previous text can supply a first-line filter when an exact anchor was not captured.
    // It never decides identity: every relocated range must pass the full uniqueness scan.
    let original = options.originals?.get(claim.id)
    const previous = options.previousTexts?.get(claim.id)
    if (original === undefined && previous !== undefined && !progress) {
      if (!await tick(previous.length)) { uncertain.push(claim.id); continue }
      const oldLines = splitLines(previous)
      const block = oldLines.slice(claim.from - 1, claim.to)
      if (block.length === width && digestLines(block) === claim.claimedHash) original = block.join('\n')
    }
    if (!progress) {
      if (original !== undefined && !await tick(original.length)) { uncertain.push(claim.id); continue }
      const prefix = [0]
      for (const line of lines) prefix.push(prefix[prefix.length - 1] + line.length)
      const originalLines = original?.split('\n')
      const firstLineHash = originalLines?.length === width && digestLines(originalLines) === claim.claimedHash
        ? lineHash(originalLines[0]) : undefined
      progress = { key, lines, prefix, next: 0, found: 0, at: -1, firstLineHash }
      if (previous !== undefined) {
        if (!await tick(previous.length + text.length)) { uncertain.push(claim.id); continue }
        await setImmediate()
        if (options.valid && !options.valid()) { uncertain.push(claim.id); continue }
        const candidate = mappedCandidate(claim, previous, text, Math.max(1, budget - work))
        if (options.valid && !options.valid()) { uncertain.push(claim.id); continue }
        if (candidate !== undefined && candidate >= 1 && candidate + width - 1 <= lines.length) {
          const at = candidate - 1
          const chars = prefix[at + width] - prefix[at]
          if (!await tick(chars + width + 1)) { uncertain.push(claim.id); continue }
          if (digestLines(lines.slice(at, at + width)) === claim.claimedHash) {
            progress.found = 1
            progress.at = at
            progress.candidate = at
            progress.firstLineHash ??= lineHash(lines[at])
          }
        }
      }
      options.progress?.set(claim.id, progress)
    }
    // Search resumes at the next candidate. The prefix table makes the per-candidate
    // work charge constant-time even when the claimed block spans thousands of lines.
    while (progress.next <= lines.length - width && progress.found <= 1) {
      const i = progress.next
      if (i === progress.candidate) { progress.next++; continue }
      if (progress.firstLineHash !== undefined) {
        const first = lines[i]
        if (work + first.length + 1 > budget || stale) break
        if (!await tick(first.length + 1)) break
        if (lineHash(first) !== progress.firstLineHash) { progress.next++; continue }
      }
      const chars = progress.prefix[i + width] - progress.prefix[i]
      if (work + chars + width + 1 > budget || stale) break
      if (!await tick(chars + width + 1)) break
      const candidate = lines.slice(i, i + width)
      if (digestLines(candidate) === claim.claimedHash) { progress.found++; progress.at = i }
      progress.next++
    }
    if (stale || progress.next <= lines.length - width && progress.found <= 1) uncertain.push(claim.id)
    else {
      options.progress?.delete(claim.id)
      if (progress.found === 1) moves.push({ id: claim.id, from: progress.at + 1, to: progress.at + width })
      else releases.push({ id: claim.id, path: claim.path, from: claim.from, to: claim.to })
    }
  }
  return { moves, releases, uncertain }
}
