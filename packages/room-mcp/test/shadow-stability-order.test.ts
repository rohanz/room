import './shadow-controlled-fixture.js'
import { stabilityFixture as fixture, delayedConflict } from './shadow-stability-fixture.js'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const full = process.env.TEST_SCALE === '1' ? it : it.skip
import * as shadowAPI from '../src/conflict-shadow.js'
import { ConflictShadow, type ShadowEvent, type ShadowReservation } from '../src/conflict-shadow.js'
import { type ConflictSlot } from '../src/conflict-set.js'
import { registryForDir } from '../src/worker-registry.js'
import { repo, put, world } from './worker-refresh-fixture.js'


afterEach(() => vi.restoreAllMocks())

full('rejects a later slot evaluated on an older worker replica', async () => {
  const f = await fixture()
  try {
    const { old, receivedAt } = await delayedConflict(f)
    expect(old.some(([, s]) => s.settled === 'conflict')).toBe(true)
    await f.internal.pass()
    expect(old[0][1].checkedAt).toBeGreaterThan(receivedAt)
    expect(f.rows()).toEqual([])
    f.advance(30_000); await f.settle(); await f.internal.pass()
    f.advance(60_001); await f.internal.pass(); expect(f.rows()).toEqual([])
  } finally { f.shadow.stop() }
})

full('does not inherit a kept delivery when real spawn preparation predates it but its hook follows it', async () => {
  const f = await fixture()
  let release = () => {}
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); await f.t.finish('d')
    const registry = await registryForDir(repo), original = registry.command.bind(registry)
    let prepared!: () => void
    const reached = new Promise<void>(resolve => { prepared = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(registry, 'command').mockImplementation(async (id, command, ...rest) => {
      const result = await original(id, command, ...rest)
      if (command.type === 'prepare-finish' && (await registry.read(id))?.tag === 'v') {
        prepared(); await barrier
      }
      return result
    })
    const hooks: { make: () => ShadowEvent; ticket: ShadowReservation }[] = []
    vi.spyOn(shadowAPI, 'shadowPreparation').mockImplementation(() => f.shadow.preparation())
    vi.spyOn(shadowAPI, 'reserveShadow').mockImplementation((_s, kind, beginning) => f.shadow.reserve(kind, beginning))
    const enqueue = ConflictShadow.prototype.enqueue
    vi.stubEnv('ROOM_CONFLICT_SHADOW', '1')
    vi.spyOn(ConflictShadow.prototype, 'enqueue').mockImplementation((event, ticket) => { if (event) hooks.push({ make: event, ticket: ticket! }) })
    const spawning = f.t.spawn('v')
    await reached
    try { expect(await f.t.call('room_collect', { tag: 'd', keep: true })).toContain('kept d') }
    finally { release() }
    const v = await spawning
    const events = hooks.map(h => h.make())
    expect(events.map(e => e.kind)).toEqual(['collection', 'spawn'])
    for (const h of hooks) enqueue.call(f.shadow, h.make, h.ticket)
    await f.shadow.idle()
    put(v.dir, 'shared.txt', 'V\n')
    f.actors.push(v); await f.publish(1); await f.settle(); await f.internal.pass()
    const d = f.internal.actors.get(f.d.name)!, late = f.internal.actors.get(v.name)!
    // D and V both edited O independently. Delayed hook order is not delivery to V.
    const pair = [...f.s.room.doc.getMap<ConflictSlot>('conflicts').values()].filter(s => s.owner === f.d.name && s.other === v.name)
    expect(pair.some(s => s.settled === 'conflict')).toBe(true)
    expect(f.rows().filter(row => row.participants.includes(f.d.name) && row.participants.includes(v.name))).toEqual([])
    expect((await f.shadow.graph.compare(d.node, late.node)).paths).toEqual(['shared.txt'])
  } finally { release(); f.shadow.stop() }
})

full('bounds shared journal overshoot to one record per concurrent writer', async () => {
  const f = await fixture()
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'shared.txt', 'U\n')
    await f.publish(1); await f.internal.pass()
    f.advance(60_001)
    const file = path.join(path.dirname(f.shadow.graph.root), 'disagreements.jsonl'), cap = 200 * 1024 * 1024
    const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, cap - 4096); fs.closeSync(fd)
    const open = fsp.open
    let competingAppend = false
    let recordBytes = 0
    vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]) === file) {
        const write = handle.write.bind(handle)
        vi.spyOn(handle, 'write').mockImplementation(((data: Buffer) => {
          if (!competingAppend) { competingAppend = true; recordBytes = data.length; fs.appendFileSync(file, 'x'.repeat(4096)) }
          return write(data)
        }) as typeof handle.write)
      }
      return handle
    })
    await f.internal.pass()
    expect(competingAppend).toBe(true)
    expect(fs.statSync(file).size).toBeGreaterThan(cap)
    expect(fs.statSync(file).size).toBeLessThanOrEqual(cap + 2 * Math.max(4096, recordBytes))
  } finally { f.shadow.stop() }
})

full('does not compare while an earlier reservation is unfinished, and expires it without a leak', async () => {
  const f = await fixture()
  try {
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'shared.txt', 'U\n'); await f.publish(1)
    const ticket = f.shadow.reserve('spawn', f.shadow.preparation())!
    const compare = vi.spyOn(f.shadow.graph, 'compare')
    await f.shadow.idle(); expect(compare).not.toHaveBeenCalled()
    ticket.expires = 0
    await f.shadow.idle()
    const state = f.shadow as any
    expect(state.queue.size).toBe(0); expect(state.mutating).toBe(0); expect(state.halted).toBe(true)
    expect(f.shadow.reserve('spawn', f.shadow.preparation())).toBeUndefined()
  } finally { f.shadow.stop() }
})

full('releases a refused/no-op reservation so later boundaries can be applied', async () => {
  const f = await fixture()
  try {
    const first = f.shadow.reserve('refresh')!
    f.shadow.release(first); await f.shadow.idle()
    const next = f.shadow.reserve('spawn', f.shadow.preparation())!
    expect(next.ambiguous).toBe(false)
    f.shadow.release(next); await f.shadow.idle()
    expect((f.shadow as any).queue.size).toBe(0)
    expect((f.shadow as any).halted).toBe(false)
  } finally { f.shadow.stop() }
})

full('skips a preparation overlapping a mutation, even if that mutation later becomes a no-op', async () => {
  const f = await fixture()
  try {
    const beginning = f.shadow.preparation(), mutating = f.shadow.reserve('refresh')!
    const v = await f.t.spawn('v'), record = (await (await registryForDir(repo)).read(v.id))!
    const prepared = f.shadow.reserve('spawn', beginning)!
    expect(prepared.ambiguous).toBe(true)
    f.shadow.release(mutating)
    ConflictShadow.prototype.enqueue.call(f.shadow, () => ({ kind: 'spawn', record, supplied: false }), prepared)
    await f.shadow.idle()
    expect(f.internal.actors.has(v.name)).toBe(false)
    expect((f.shadow as any).queue.size).toBe(0)
  } finally { f.shadow.stop() }
})

full('does not reconstruct a missing preparation counter from hook arrival', async () => {
  const f = await fixture()
  try {
    const v = await f.t.spawn('v'), record = (await (await registryForDir(repo)).read(v.id))!
    ConflictShadow.prototype.enqueue.call(f.shadow, () => ({ kind: 'spawn', record, supplied: false }))
    await f.shadow.idle()
    expect(f.internal.actors.has(v.name)).toBe(false)
  } finally { f.shadow.stop() }
})

it('captures a reservation without enumerating snapshot entries or doing Git work', async () => {
  const t = world(), shadow = new ConflictShadow(t.leadSession(), () => {}), entries = new Map()
  const state = shadow as any
  state.actors.set(t.leadSession().me.name, { id: 'lead', entries, events: [] })
  try {
    Object.defineProperty(entries, Symbol.iterator, { configurable: true, value: () => { throw new Error('must not copy snapshot bytes/entries on the hook') } })
    const run = vi.spyOn(shadow.graph, 'run')
    const ticket = shadow.reserve('spawn', shadow.preparation())!
    expect(ticket).toBeDefined(); expect(run).not.toHaveBeenCalled()
    delete (entries as any)[Symbol.iterator]
    shadow.release(ticket)
    expect(ticket.make).toBeDefined()
    expect(state.mutating).toBe(0)
  } finally { delete (entries as any)[Symbol.iterator]; shadow.stop(); await state.cleanup }
})
