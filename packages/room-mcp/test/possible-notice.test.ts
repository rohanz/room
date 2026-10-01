/**
 * rc8 dogfood #5: envfix held two claims on workers.test.ts; an approximate line mapping maps every claim to
 * the whole file, so each claim's slot posted the same "you may have edited … inside envfix's claim" text under
 * its own id. A possible edit-in-claim is one notice per (owner, holder, path), naming the holder's claimed
 * ranges, with one "cleared" when the last of them clears. Exact conflicts stay per claim, naming its lines.
 */
import { expect, it, vi } from 'vitest'
import { RoomDoc, type Claim } from '@room/shared'
import { ConflictSlots, slotKey, type Evaluation } from '../src/conflict-set.js'

const PATH = 'packages/room-mcp/test/workers.test.ts'
const claim = (id: string, from: number, to: number): Claim => ({ id, by: 'rohanz+envfix', byKind: 'agent', path: PATH, from, to, intent: 'edit', at: 1 })

function fixture() {
  const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
  const slots = new ConflictSlots(room, post, '1')
  const add = (c: Claim) => room.claims.set(c.id, c)
  const settle = (id: string, status: Evaluation['status'], inputs = status) =>
    slots.settle(slotKey('rohanz', 'edit-in-claim', 'rohanz+envfix', PATH, id), {
      owner: 'rohanz', other: 'rohanz+envfix', kind: 'edit-in-claim', path: PATH, subject: id, status, inputs: `${id}:${inputs}`,
      factId: status === 'clean' ? '' : `${id}:${status}`, ...(status === 'clean' ? {} : { lines: [1], why: 'approximate range' }),
    })
  return { room, post, slots, add, settle }
}

it('one possible notice per (path, holder) names every claimed range; one cleared follows the last (rc8)', async () => {
  const { post, slots, add, settle } = fixture()
  add(claim('c1', 1808, 1821)); add(claim('c2', 2084, 2084))
  await settle('c1', 'possible')
  await settle('c2', 'possible')
  expect(post).toHaveBeenCalledTimes(1)
  expect(post.mock.calls[0][1]).toMatchObject({ type: 'conflict', to: 'rohanz', priority: 'fyi',
    text: `you may have edited ${PATH} inside rohanz+envfix's claims at lines 1808-1821, 2084; line mapping is approximate` })
  // A new claim by the same holder while the notice is open neither re-posts nor drops the cleared.
  add(claim('c3', 10, 20))
  await settle('c3', 'possible')
  expect(post).toHaveBeenCalledTimes(1)
  await settle('c1', 'clean'); await settle('c3', 'clean')
  await slots.replay('rohanz')
  expect(post.mock.calls.filter(c => c[1].clearedFrom)).toHaveLength(0)
  await settle('c2', 'clean')
  const cleared = post.mock.calls.filter(c => c[1].clearedFrom === 'possible')
  expect(cleared).toHaveLength(1)
  await slots.replay('rohanz')
  expect(new Set(post.mock.calls.map(c => c[2].id)).size).toBe(2) // replays reuse the same two ids
  // A later possibility is a new episode: a new notice.
  await settle('c1', 'possible', 'again')
  expect(new Set(post.mock.calls.map(c => c[2].id)).size).toBe(3)
})

it('a cleared slot whose inputs change again posts no second "cleared" on the next replay', async () => {
  for (const kind of ['edit-in-claim', 'merge'] as const) {
    const { post, slots, add } = fixture()
    add(claim('c1', 1, 2))
    const key = slotKey('rohanz', kind, 'rohanz+envfix', PATH, kind === 'merge' ? '' : 'c1')
    const base = { owner: 'rohanz', other: 'rohanz+envfix', kind, path: PATH, ...(kind === 'merge' ? {} : { subject: 'c1' }) }
    await slots.settle(key, { ...base, status: 'possible', inputs: 'a', factId: 'f' })
    await slots.settle(key, { ...base, status: 'clean', inputs: 'b', factId: '' })
    await slots.settle(key, { ...base, status: 'clean', inputs: 'c', factId: '' }) // the owner kept editing
    await slots.replay('rohanz')
    const cleared = post.mock.calls.filter(c => c[2].id.endsWith(':clean'))
    expect(new Set(cleared.map(c => c[2].id)).size).toBe(1)
    expect(cleared.every(c => c[1].clearedFrom === 'possible')).toBe(true)
  }
})

it('an exact edit-in-claim conflict is per claim and names that claim\'s lines', async () => {
  const { post, add, settle } = fixture()
  add(claim('c1', 1808, 1821)); add(claim('c2', 2084, 2084))
  await settle('c1', 'conflict'); await settle('c2', 'conflict')
  const texts = post.mock.calls.filter(c => c[1].to === 'rohanz').map(c => c[1].text)
  expect(texts).toEqual([
    `you edited ${PATH} inside rohanz+envfix's claim at lines 1808-1821 (approximate range)`,
    `you edited ${PATH} inside rohanz+envfix's claim at line 2084 (approximate range)`,
  ])
})

it('a possibility after an exact conflict is a new notice, not the first possibility\'s delivered id', async () => {
  const { post, add, settle } = fixture()
  add(claim('c1', 1, 2))
  await settle('c1', 'possible')
  await settle('c1', 'conflict')
  await settle('c1', 'possible', 'again')
  const possibleIds = post.mock.calls.filter(c => c[2].id.endsWith(':possible')).map(c => c[2].id)
  expect(possibleIds).toHaveLength(2)
  expect(new Set(possibleIds).size).toBe(2)
})
