import { describe, expect, it } from 'vitest'
import { RoomDoc, type Claim } from '@room/shared'
import { claimDigest, reanchorClaims } from '../src/reanchor.js'

const original = 'first\nclaimed one\nclaimed two\nlast\n'
const claim = (by = 'Alice'): Claim => ({ id: `claim-${by}`, path: 'app.txt', from: 2, to: 3, by, byKind: 'agent', intent: 'edit', at: 1, claimedHash: claimDigest(original, 2, 3) })

describe('reanchorClaims', () => {
  it('hashes the exact covered lines with SHA-256', () => {
    expect(claimDigest('abc\n', 1, 1)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('retains only a digest after an overlay is cleared', () => {
    const room = new RoomDoc()
    room.setOverlay('Alice', 'app.txt', original)
    const made = room.addClaim({ path: 'app.txt', from: 2, to: 3, by: 'Alice', byKind: 'agent', intent: 'edit', claimedHash: claimDigest(original, 2, 3) })
    room.clearOverlay('Alice', 'app.txt')
    expect(room.claims.get(made.id)?.claimedHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(room.claims.get(made.id))).not.toContain('claimed one')
    expect(JSON.stringify(room.claims.get(made.id))).not.toContain('claimed two')
  })

  it('moves an unchanged claimed block down five lines', () => {
    const moved = 'added\n'.repeat(5) + original
    expect(reanchorClaims('Alice', [claim()], new Map([['app.txt', moved]]))).toEqual({
      moves: [{ id: 'claim-Alice', from: 7, to: 8 }], releases: [],
    })
  })

  it('releases a deleted block', () => {
    expect(reanchorClaims('Alice', [claim()], new Map([['app.txt', 'first\nlast\n']]))).toEqual({
      moves: [], releases: [{ id: 'claim-Alice', path: 'app.txt', from: 2, to: 3 }],
    })
  })

  it('releases an ambiguous duplicate', () => {
    expect(reanchorClaims('Alice', [claim()], new Map([['app.txt', original + original]]))).toEqual({
      moves: [], releases: [{ id: 'claim-Alice', path: 'app.txt', from: 2, to: 3 }],
    })
  })

  it('leaves another participant claim untouched', () => {
    expect(reanchorClaims('Alice', [claim('Bob')], new Map([['app.txt', 'gone\n']]))).toEqual({ moves: [], releases: [] })
  })
})
