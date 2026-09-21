import { describe, expect, it } from 'vitest'
import { claimsOverlap, cursorInClaim } from './claims.js'

describe('directory claims', () => {
  const directory = { path: 'src/', from: 1, to: 1 }
  it('covers descendants and nested directories regardless of line ranges', () => {
    for (const path of ['src/a.ts', 'src/nested/b.ts', 'src/nested/', 'src/']) {
      const other = { path, from: 90, to: 100 }
      expect(claimsOverlap(directory, other)).toBe(true)
      expect(claimsOverlap(other, directory)).toBe(true)
    }
  })
  it('respects directory boundaries and file line ranges', () => {
    expect(claimsOverlap(directory, { path: 'src-other/a.ts', from: 1, to: 1 })).toBe(false)
    expect(claimsOverlap({ path: 'a.ts', from: 1, to: 2 }, { path: 'a.ts', from: 3, to: 4 })).toBe(false)
  })
  it('covers cursors in descendant files', () => {
    expect(cursorInClaim({ path: 'src/a.ts', from: 10, to: 10 }, { ...directory, by: 'A', byKind: 'agent', id: 'c', at: 1, intent: 'own src' })).toBe(true)
  })
})
