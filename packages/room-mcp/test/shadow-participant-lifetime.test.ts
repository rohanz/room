import './shadow-controlled-fixture.js'
import { afterEach, expect, it, vi } from 'vitest'

const full = process.env.TEST_SCALE === '1' ? it : it.skip
import type { ConflictSlot } from '../src/conflict-set.js'
import { stabilityFixture, delayedConflict } from './shadow-stability-fixture.js'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import * as shadowAPI from '../src/conflict-shadow.js'
import { ConflictShadow, type ShadowEvent, type ShadowReservation } from '../src/conflict-shadow.js'
import { put } from './worker-refresh-fixture.js'

afterEach(() => vi.restoreAllMocks())

it('keeps one stable episode across a checkedAt-only slot refresh', async () => {
  const f = await stabilityFixture()
  try {
    const notices = f.t.messages().length
    const { old } = await delayedConflict(f)
    await f.internal.pass()
    f.advance(60_001); await f.internal.pass()
    expect(f.rows()).toHaveLength(1)
    // Today's answer, inputs, publications and observations are all unchanged.
    for (const [key, slot] of old) f.s.room.doc.getMap<ConflictSlot>('conflicts').set(key, { ...slot, checkedAt: slot.checkedAt + 1 })
    await f.internal.pass()
    f.advance(60_001); await f.internal.pass()
    expect(f.rows()).toHaveLength(1)
    expect(JSON.stringify(f.rows())).not.toMatch(/D\\n|U\\n/)
    expect(f.t.messages()).toHaveLength(notices)
  } finally { f.shadow.stop() }
})

full('drops pending episodes and identities when registry retirement removes an actor', async () => {
  const f = await stabilityFixture()
  const state = f.shadow as any
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'shared.txt', 'U\n')
    await f.publish(1); await f.internal.pass()
    const id = state.actors.get(f.d.name).id
    expect([...state.pending.keys()].some((key: any) => JSON.parse(key).includes(id))).toBe(true)
    const list = state.registry.list.bind(state.registry)
    // Registry lifecycle facts arrive independently of publication/slot cleanup.
    vi.spyOn(state.registry, 'list').mockImplementation(async () => {
      const inventory = await list()
      return { ...inventory, records: inventory.records.map((record: any) => record.id === f.d.id ? { ...record, phase: 'retired' } : record) }
    })
    await f.shadow.idle()
    expect(state.actors.has(f.d.name)).toBe(false)
    expect.soft([...state.pending.keys()].filter((key: any) => JSON.parse(key).includes(id))).toEqual([])
    expect.soft(state.identities.has(f.d.name)).toBe(false)
  } finally { f.shadow.stop() }
})


function absent(f: Awaited<ReturnType<typeof stabilityFixture>>, name: string, id: string) {
  const state = f.shadow as any
  expect(state.actors.has(name)).toBe(false)
  expect([...state.pending.keys()].some(key => JSON.parse(key as string).includes(id))).toBe(false)
  expect(state.identities.has(name)).toBe(false)
  expect([...state.queue.values()].some(ticket => state.ownerIds(ticket).includes(id))).toBe(false)
  expect((f.shadow.graph as any).pins.has(id)).toBe(false)
  expect(fs.existsSync(path.join(f.shadow.graph.root, id + '.index'))).toBe(false)
}

full.each(['retiring', 'discarding', 'abandoned', 'missing'])('forgets all participant-owned state on registry %s', async phase => {
  const f = await stabilityFixture(), state = f.shadow as any
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'shared.txt', 'U\n'); await f.publish(1); await f.internal.pass()
    const id = state.actors.get(f.d.name).id, list = state.registry.list.bind(state.registry)
    vi.spyOn(state.registry, 'list').mockImplementation(async () => {
      const inventory = await list()
      return { ...inventory, records: inventory.records.flatMap((r: any) => r.id !== f.d.id ? [r] : phase === 'missing' ? [] : [{ ...r, phase }]) }
    })
    await f.shadow.idle(); absent(f, f.d.name, id)
    expect(state.halted).toBe(false); expect(state.actors.has(f.u.name)).toBe(true)
    const payload = vi.fn(() => ({ kind: 'refresh' } as ShadowEvent))
    const late = f.shadow.reserve('refresh', undefined, f.d.id)!
    ConflictShadow.prototype.enqueue.call(f.shadow, payload, late)
    await f.shadow.idle(); expect(payload).not.toHaveBeenCalled(); absent(f, f.d.name, id)
  } finally { f.shadow.stop() }
})

function hooks(f: Awaited<ReturnType<typeof stabilityFixture>>) {
  const pending: { make: () => ShadowEvent; ticket: ShadowReservation }[] = []
  vi.stubEnv('ROOM_CONFLICT_SHADOW', '1')
  vi.spyOn(shadowAPI, 'reserveShadow').mockImplementation((_s, kind, beginning, owners) => f.shadow.reserve(kind, beginning, owners))
  vi.spyOn(shadowAPI, 'enqueueShadow').mockImplementation((s, make, _log, ticket) => { if (s === f.s && make) pending.push({ make, ticket: ticket! }) })
  return pending
}

full.each(['before', 'after'])('keeps siblings modelled when final collection completion arrives %s retirement notification', async arrival => {
  const f = await stabilityFixture(), state = f.shadow as any, pending = hooks(f)
  try {
    const id = state.actors.get(f.d.name).id
    put(f.d.dir, 'shared.txt', 'D\n'); await f.t.finish('d')
    expect(await f.t.call('room_collect', { tag: 'd' })).toContain('cleaned up d')
    expect(fs.existsSync(f.d.dir)).toBe(false)
    expect(pending).toHaveLength(1)
    if (arrival === 'after') {
      await f.shadow.idle()
      expect(state.actors.has(f.d.name)).toBe(true) // Earlier collection reservation still owns this history.
      expect([...state.queue.values()].map((r: ShadowReservation) => r.kind)).toEqual(['collection', 'remove'])
    }
    for (const h of pending) ConflictShadow.prototype.enqueue.call(f.shadow, h.make, h.ticket)
    await f.shadow.idle(); absent(f, f.d.name, id)
    expect(state.halted).toBe(false); expect(state.actors.has(f.u.name)).toBe(true)
    f.actors.splice(f.actors.findIndex(a => a.name === f.d.name), 1)
    await f.publish(2); f.advance(); await f.internal.pass()
    expect(state.actors.get(f.s.me.name).capture).toBeDefined()
    expect(state.actors.get(f.u.name).capture).toBeDefined()
    expect((await f.shadow.graph.compare(state.actors.get(f.s.me.name).node, state.actors.get(f.u.name).node)).paths).toEqual([])
  } finally { f.shadow.stop() }
})

full('handles a mixed final collection with one cleanup-kept worker and one ending worker', async () => {
  const f = await stabilityFixture(), state = f.shadow as any, pending = hooks(f)
  try {
    const id = state.actors.get(f.d.name).id
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'keep.txt', 'U\n')
    put(f.u.dir, '.gitignore', 'build/\nartifact.bin\n'); put(f.u.dir, 'artifact.bin', 'keep this artifact')
    await f.t.finish('d'); await f.t.finish('u')
    const reply = await f.t.call('room_collect', {})
    expect(reply).toContain('cleaned up d'); expect(reply).toContain('kept u')
    for (const h of pending) ConflictShadow.prototype.enqueue.call(f.shadow, h.make, h.ticket)
    await f.shadow.idle(); absent(f, f.d.name, id)
    expect(state.halted).toBe(false); expect(state.actors.has(f.u.name)).toBe(true)
    expect(fs.existsSync(f.u.dir)).toBe(true)
    expect(state.actors.get(f.u.name).events.some((event: string) => event.startsWith('delivery:'))).toBe(true)
  } finally { f.shadow.stop() }
})

full('forgets a permanently unmodelled worker, including its waiting reservations', async () => {
  const f = await stabilityFixture(), state = f.shadow as any
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'shared.txt', 'U\n'); await f.publish(1); await f.internal.pass()
    const actor = state.actors.get(f.d.name), ticket = f.shadow.reserve('refresh', undefined, f.d.id)!
    const payload = vi.fn(() => ({ kind: 'refresh' } as ShadowEvent))
    ConflictShadow.prototype.enqueue.call(f.shadow, payload, ticket)
    // Cleanup can finish after the budget walk lists the worker's private index/ref.
    // Force that interleaving instead of racing the enqueue timer against unlink.
    const readdir = fsp.readdir
    let removed = false
    vi.spyOn(fsp, 'readdir').mockImplementation((async (...args: Parameters<typeof readdir>) => {
      const entries = await readdir(...args)
      if (!removed && args[0] === f.shadow.graph.root) {
        removed = true
        await state.unmodelled(actor, 'worker HEAD moved')
      }
      return entries
    }) as typeof readdir)
    await f.shadow.idle(); absent(f, f.d.name, actor.id)
    expect(removed).toBe(true)
    expect(payload).not.toHaveBeenCalled(); expect(state.halted).toBe(false)
  } finally { f.shadow.stop() }
})

full('expires an unfilled worker reservation without stopping siblings', async () => {
  const f = await stabilityFixture(), state = f.shadow as any
  try {
    const id = state.actors.get(f.d.name).id
    const ticket = f.shadow.reserve('refresh', undefined, f.d.id)!
    ticket.expires = 0
    await f.shadow.idle(); absent(f, f.d.name, id)
    expect(state.halted).toBe(false); expect(state.actors.has(f.u.name)).toBe(true)
    expect(state.queue.size).toBe(0); expect(state.mutating).toBe(0)
  } finally { f.shadow.stop() }
})

full('forgets every participant on lead leave', async () => {
  const f = await stabilityFixture(), state = f.shadow as any
  const actors = [...state.actors.values()] as { name: string; id: string }[]
  f.shadow.reserve('refresh', undefined, f.d.id)
  f.shadow.stop(); await state.cleanup
  for (const actor of actors) absent(f, actor.name, actor.id)
  for (const map of [state.actors, state.pending, state.identities, state.queue, state.heads, state.spawns, state.anchors]) expect(map.size).toBe(0)
})

full('does not reset a pending episode for slot metadata or an unchanged aggregate status', async () => {
  const f = await stabilityFixture()
  try {
    const { old } = await delayedConflict(f); await f.internal.pass(); f.advance(30_000)
    for (const [key, slot] of old) {
      f.s.room.doc.getMap<ConflictSlot>('conflicts').set(key, { ...slot, inputs: 'different opaque key', factId: 'different fact', checkedAt: slot.checkedAt + 1, why: 'metadata' })
      f.s.room.doc.getMap<ConflictSlot>('conflicts').set(key + ':opposite', { ...slot, owner: f.u.name, other: f.d.name })
    }
    await f.internal.pass()
    f.advance(30_001); await f.internal.pass()
    expect(f.rows()).toHaveLength(1); expect(f.rows()[0].stableForMs).toBe(60_001)
  } finally { f.shadow.stop() }
})


full('forgets a discarded participant while keeping its siblings modelled', async () => {
  const f = await stabilityFixture(), state = f.shadow as any
  try {
    const id = state.actors.get(f.d.name).id
    await f.t.finish('d')
    expect(await f.t.call('room_collect', { tag: 'd', discard: true })).toContain('discarded d')
    await f.shadow.idle(); absent(f, f.d.name, id)
    expect(state.halted).toBe(false); expect(state.actors.has(f.u.name)).toBe(true)
  } finally { f.shadow.stop() }
})

full('clears the family and logs its reason once when the lead becomes permanently unmodelled', async () => {
  const f = await stabilityFixture(), state = f.shadow as any, log = vi.fn()
  state.log = log
  try {
    const actors = [...state.actors.values()] as { name: string; id: string }[]
    await state.unmodelled(state.actors.get(f.s.me.name), 'unmodelled history: coverage changed')
    for (const a of actors) absent(f, a.name, a.id)
    await f.shadow.idle(); await f.shadow.idle()
    expect(state.halted).toBe(true)
    expect(log.mock.calls.filter(([line]) => line.includes('family stopped for this session'))).toEqual([
      ['conflict shadow: family stopped for this session: unmodelled history: coverage changed; lead history lost (swallowed)'],
    ])
  } finally { f.shadow.stop() }
})

full('does not guess a final collection generation after a later lead mutation was reserved', async () => {
  const f = await stabilityFixture(), state = f.shadow as any, pending = hooks(f), log = vi.fn()
  state.log = log
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); await f.t.finish('d')
    expect(await f.t.call('room_collect', { tag: 'd' })).toContain('cleaned up d')
    const later = f.shadow.reserve('collection', undefined, f.u.id)!
    for (const h of pending) ConflictShadow.prototype.enqueue.call(f.shadow, h.make, h.ticket)
    await f.shadow.idle()
    expect(state.halted).toBe(true); expect(state.actors.size).toBe(0)
    expect(log.mock.calls.filter(([line]) => line.includes('family stopped for this session'))).toHaveLength(1)
    expect(later).toBeDefined()
  } finally { f.shadow.stop() }
})
