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

  it('moves an unchanged claimed block down five lines', async () => {
    const moved = 'added\n'.repeat(5) + original
    expect(await reanchorClaims('Alice', [claim()], new Map([['app.txt', moved]]))).toEqual({
      moves: [{ id: 'claim-Alice', from: 7, to: 8 }], releases: [], uncertain: [],
    })
  })

  it('releases a deleted block', async () => {
    expect(await reanchorClaims('Alice', [claim()], new Map([['app.txt', 'first\nlast\n']]))).toEqual({
      moves: [], releases: [{ id: 'claim-Alice', path: 'app.txt', from: 2, to: 3 }], uncertain: [],
    })
  })

  it('releases an ambiguous duplicate', async () => {
    expect(await reanchorClaims('Alice', [claim()], new Map([['app.txt', 'added\n' + original + original]]))).toEqual({
      moves: [], releases: [{ id: 'claim-Alice', path: 'app.txt', from: 2, to: 3 }], uncertain: [],
    })
  })

  it('keeps a claim whose digest already matches its range on retry', async () => {
    const moved = 'added\n' + original + original
    expect(await reanchorClaims('Alice', [{ ...claim(), from: 3, to: 4 }], new Map([['app.txt', moved]]))).toEqual({ moves: [], releases: [], uncertain: [] })
  })

  it('keeps a claim uncertain when its original digest could not be captured', async () => {
    const unknown = { ...claim(), claimedHash: undefined }
    expect(await reanchorClaims('Alice', [unknown], new Map([['app.txt', 'different\n']]))).toEqual({ moves: [], releases: [], uncertain: [unknown.id] })
  })

  it('leaves another participant claim untouched', async () => {
    expect(await reanchorClaims('Alice', [claim('Bob')], new Map([['app.txt', 'gone\n']]))).toEqual({ moves: [], releases: [], uncertain: [] })
  })

  it('keeps an uncertain claim when candidate work exceeds the total budget', async () => {
    const c = { ...claim(), from: 1, to: 4000, claimedHash: 'absent' }
    const result = await reanchorClaims('Alice', [c], new Map([['app.txt', 'different\n'.repeat(8000)]]), { workBudget: 100 })
    expect(result).toEqual({ moves: [], releases: [], uncertain: [c.id] })
  })

  it('filters rolling candidates before hashing a wide moved block', async () => {
    const block = Array.from({ length: 3000 }, (_, i) => `unique ${i}`).join('\n')
    const before = `${block}\n`
    const c = { ...claim(), from: 1, to: 3000, claimedHash: claimDigest(before, 1, 3000) }
    const after = `${'other\n'.repeat(3000)}${before}`
    const result = await reanchorClaims('Alice', [c], new Map([['app.txt', after]]),
      { originals: new Map([[c.id, block]]), workBudget: 300_000 })
    expect(result).toEqual({ moves: [{ id: c.id, from: 3001, to: 6000 }], releases: [], uncertain: [] })
  })

  it('resumes a digest-only candidate search and keeps a later cheap claim fair', async () => {
    const text = 'other\n'.repeat(100)
    const unknown = { ...claim(), id: 'unknown', path: 'unknown.txt', from: 1, to: 1, claimedHash: undefined }
    const wide = { ...claim(), id: 'wide', from: 1, to: 20, claimedHash: 'missing' }
    const cheap = { ...claim(), id: 'cheap', path: 'cheap.txt', from: 1, to: 1, claimedHash: 'missing' }
    const progress = new Map()
    const texts = new Map([['app.txt', text], ['cheap.txt', 'changed\n'], ['unknown.txt', 'changed\n']])
    const first = await reanchorClaims('Alice', [unknown, cheap, wide], texts, { workBudget: 1000, progress, searchKey: c => c.id })
    expect(first.uncertain).toContain(unknown.id)
    expect(first.uncertain).toContain(wide.id)
    expect(first.releases.map(release => release.id)).toContain(cheap.id)
    let result = first
    for (let tick = 0; tick < 100 && result.uncertain.includes(wide.id); tick++) {
      result = await reanchorClaims('Alice', [wide], texts, { workBudget: 1000, progress, searchKey: c => c.id })
    }
    expect(result.releases.map(release => release.id)).toContain(wide.id)
  })
})
