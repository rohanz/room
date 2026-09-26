import { createHash } from 'node:crypto'
import type { Claim } from '@room/shared'

export interface ClaimMove { id: string; from: number; to: number }
export interface ClaimRelease { id: string; path: string; from: number; to: number }

function digestLines(lines: readonly string[]): string {
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')
}

/** SHA-256 of exact 1-based inclusive lines. The digest, never source, enters the shared claim. */
export function claimDigest(text: string, from: number, to: number): string | undefined {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) return undefined
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  if (to > lines.length) return undefined
  return digestLines(lines.slice(from - 1, to))
}

/** Locate the original block exactly once in each current file. No document or disk mutation. */
export function reanchorClaims(owner: string, claims: readonly Claim[], texts: ReadonlyMap<string, string | undefined>): {
  moves: ClaimMove[]; releases: ClaimRelease[]
} {
  const moves: ClaimMove[] = []
  const releases: ClaimRelease[] = []
  for (const claim of claims) {
    if (claim.by !== owner || claim.path.endsWith('/')) continue
    const text = texts.get(claim.path)
    const lines = text?.split('\n')
    if (text?.endsWith('\n')) lines?.pop()
    const width = claim.to - claim.from + 1
    let found = 0
    let at = -1
    if (lines && claim.claimedHash && Number.isSafeInteger(width) && width > 0) {
      for (let i = 0; i <= lines.length - width; i++) {
        const hash = digestLines(lines.slice(i, i + width))
        if (hash === claim.claimedHash) { found++; at = i }
        if (found > 1) break
      }
    }
    if (found === 1) moves.push({ id: claim.id, from: at + 1, to: at + width })
    else releases.push({ id: claim.id, path: claim.path, from: claim.from, to: claim.to })
  }
  return { moves, releases }
}
