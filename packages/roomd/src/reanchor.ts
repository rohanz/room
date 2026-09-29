import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { Claim } from '@room/shared'

export interface ClaimMove { id: string; from: number; to: number }
export interface ClaimRelease { id: string; path: string; from: number; to: number }
export interface ReanchorResult { moves: ClaimMove[]; releases: ClaimRelease[]; uncertain: string[] }
export interface ReanchorOptions {
  originals?: ReadonlyMap<string, string>
  unreadable?: ReadonlySet<string>
  workBudget?: number
  valid?: () => boolean
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
    const lines = splitLines(text)
    const width = claim.to - claim.from + 1
    if (!claim.claimedHash || !Number.isSafeInteger(width) || width <= 0) {
      releases.push({ id: claim.id, path: claim.path, from: claim.from, to: claim.to }); continue
    }
    const current = lines.slice(claim.from - 1, claim.to)
    if (current.length === width && await tick(current.reduce((n, s) => n + s.length, 0)) && digestLines(current) === claim.claimedHash) continue
    if (work > budget || stale) { uncertain.push(claim.id); continue }
    const original = options.originals?.get(claim.id)
    if (original !== undefined && !await tick(original.length)) { uncertain.push(claim.id); continue }
    const originalLines = original === undefined ? undefined : original.split('\n')
    const filter = originalLines?.length === width && digestLines(originalLines) === claim.claimedHash
    let target = 0, rolling = 0, power = 1
    const hashes: number[] = []
    if (filter) {
      for (let i = 1; i < width; i++) {
        if (!await tick(1)) break
        power = Math.imul(power, BASE) >>> 0
      }
      if (work > budget || stale) { uncertain.push(claim.id); continue }
      for (const line of originalLines!) {
        if (!await tick(line.length + 1)) break
        target = (Math.imul(target, BASE) + lineHash(line)) >>> 0
      }
      if (work > budget || stale) { uncertain.push(claim.id); continue }
      for (const line of lines) {
        if (!await tick(line.length + 1)) break
        hashes.push(lineHash(line))
      }
    }
    if (work > budget || stale || filter && hashes.length !== lines.length) { uncertain.push(claim.id); continue }
    let found = 0, at = -1
    for (let i = 0; i <= lines.length - width; i++) {
      if (!await tick(1)) break
      if (filter) {
        if (i === 0) for (let j = 0; j < width; j++) rolling = (Math.imul(rolling, BASE) + hashes[j]) >>> 0
        else rolling = (Math.imul((rolling - Math.imul(hashes[i - 1], power)) >>> 0, BASE) + hashes[i + width - 1]) >>> 0
        if (rolling !== target) continue
      }
      const candidate = lines.slice(i, i + width)
      if (!await tick(candidate.reduce((n, s) => n + s.length, 0))) break
      if (digestLines(candidate) === claim.claimedHash) { found++; at = i }
      if (found > 1) break
    }
    if (work > budget || stale) uncertain.push(claim.id)
    else if (found === 1) moves.push({ id: claim.id, from: at + 1, to: at + width })
    else releases.push({ id: claim.id, path: claim.path, from: claim.from, to: claim.to })
  }
  return { moves, releases, uncertain }
}
