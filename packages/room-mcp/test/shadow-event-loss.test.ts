import './shadow-controlled-fixture.js'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ConflictShadow } from '../src/conflict-shadow.js'
import * as shadowAPI from '../src/conflict-shadow.js'
import { delayedConflict, stabilityFixture } from './shadow-stability-fixture.js'
import { put } from './worker-refresh-fixture.js'

afterEach(() => vi.restoreAllMocks())

it('does not silently discard a sibling delivery when an earlier private refresh fails', async () => {
  const f = await stabilityFixture(), state = f.shadow as any, log = vi.fn()
  state.log = log
  try {
    // A completed public refresh has queued its private fact, but that fact has not run yet.
    const refresh = f.shadow.reserve('refresh', undefined, f.d.id)!
    ConflictShadow.prototype.enqueue.call(f.shadow, () => { throw new Error('one private refresh fault') }, refresh)
    clearTimeout(state.timer); state.timer = undefined
    const pending: (() => void)[] = []
    vi.stubEnv('ROOM_CONFLICT_SHADOW', '1')
    vi.spyOn(shadowAPI, 'reserveShadow').mockImplementation((_s, kind, beginning, owners) => f.shadow.reserve(kind, beginning, owners))
    vi.spyOn(shadowAPI, 'enqueueShadow').mockImplementation((s, make, _log, ticket) => {
      if (s === f.s && make) pending.push(() => ConflictShadow.prototype.enqueue.call(f.shadow, make, ticket))
    })
    put(f.d.dir, 'shared.txt', 'D\n'); put(f.u.dir, 'keep.txt', 'U\n')
    await f.t.finish('d'); await f.t.finish('u')
    const reply = await f.t.call('room_collect', { keep: true })
    expect(reply).toContain('kept d'); expect(reply).toContain('kept u')
    expect([...state.queue.values()].map((t: any) => t.kind)).toEqual(['refresh', 'collection'])
    for (const enqueue of pending) enqueue()
    await f.shadow.idle()
    expect(state.actors.has(f.d.name)).toBe(false)
    expect(state.halted).toBe(false)
    expect(state.actors.get(f.u.name)?.events.some((e: string) => e.startsWith('delivery:'))).toBe(true)
    expect(state.actors.has(f.s.me.name)).toBe(true)
    expect(log.mock.calls.filter(([line]) => line.includes('unmodelled history: collection') && line.includes(f.d.name))).toHaveLength(1)
    expect(log.mock.calls.some(([line]) => line.includes('family stopped'))).toBe(false)
  } finally { f.shadow.stop() }
})

it('cleans participant state and emits the family-stop reason at the shared journal cap', async () => {
  const f = await stabilityFixture(), state = f.shadow as any, log = vi.fn()
  state.log = log
  try {
    const id = state.actors.get(f.d.name).id
    await delayedConflict(f); await f.internal.pass(); f.advance(60_001)
    const stat = fsp.stat
    vi.spyOn(fsp, 'stat').mockImplementation(((file: any, ...args: any[]) =>
      String(file).endsWith('disagreements.jsonl')
        ? Promise.resolve({ size: 200 * 1024 * 1024 })
        : (stat as any)(file, ...args)) as any)
    await f.internal.pass(); await Promise.resolve()
    expect(state.halted).toBe(true)
    await f.t.finish('d')
    expect(await f.t.call('room_collect', { tag: 'd', discard: true })).toContain('discarded d')
    await f.shadow.idle()
    expect.soft(state.actors.has(f.d.name)).toBe(false)
    expect.soft([...state.pending.keys()].some((key: string) => JSON.parse(key).includes(id))).toBe(false)
    expect.soft(fs.existsSync(path.join(f.shadow.graph.root, id + '.index'))).toBe(false)
    expect.soft(log.mock.calls.filter(([line]) => line.includes('family stopped for this session'))).toHaveLength(1)
  } finally { f.shadow.stop() }
})
