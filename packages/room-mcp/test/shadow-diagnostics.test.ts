// These regressions run in default and TEST_SCALE=1; no machine Git configuration is consulted.
import './shadow-controlled-fixture.js'
import { expect, it, vi } from 'vitest'
import { ConflictShadow } from '../src/conflict-shadow.js'
import * as captures from '../src/shadow-snapshot.js'
import { registryForDir } from '../src/worker-registry.js'
import { stabilityFixture } from './shadow-stability-fixture.js'
import { repo, world } from './worker-refresh-fixture.js'

it.each([
  ['tree read before actor creation', 'unsupported tree entry'],
  ['snapshot policy before actor creation', 'unmodelled history: sparse checkout or partial clone'],
  ['private Git before actor creation', 'shadow Git step failed: ls-tree'],
  ['unexpected exception before actor creation', 'event failed'],
] as const)('logs a participant and reason exactly once for %s', async (_stage, reason) => {
  const t = world(), d = await t.spawn('d'), log = vi.fn(), shadow = new ConflictShadow(t.leadSession(), log), state = shadow as any
  try {
    await state.init()
    const record = (await (await registryForDir(repo)).read(d.id))!
    const fault = reason === 'event failed' ? 'FILE_CONTENTS_MUST_NOT_APPEAR\nsecret' : reason
    const spy = vi.spyOn(shadow.graph, 'entries').mockRejectedValue(new Error(fault))
    const ticket = shadow.reserve('spawn', shadow.preparation(), { id: d.id, name: d.name })!
    shadow.enqueue(() => ({ kind: 'spawn', record, supplied: false }), ticket)
    await shadow.idle(); await shadow.idle()
    expect(state.actors.size).toBe(0)
    expect(log.mock.calls.filter(([line]) => line.includes(d.name))).toEqual([
      [`conflict shadow: unmodelled history: spawn ${reason} (${d.name})`],
    ])
    expect(log.mock.calls.some(([line]) => line.includes('workers exist but none could be followed'))).toBe(true)
    expect(log.mock.calls.some(([line]) => line.includes('no workers spawned in this session'))).toBe(false)
    expect(JSON.stringify(log.mock.calls)).not.toContain('FILE_CONTENTS_MUST_NOT_APPEAR')
    spy.mockRestore()
  } finally { shadow.stop(); await shadow.idle() }
})

it.each(['payload exception', 'unfilled reservation expired', 'overlapping mutation', 'missing registry worker', 'ownership moved', 'unsupported sharing'])(
  'names a worker before its actor exists on %s', async failure => {
    const t = world(), d = await t.spawn('d'), log = vi.fn(), shadow = new ConflictShadow(t.leadSession(), log), state = shadow as any
    try {
      await state.init()
      const record = (await (await registryForDir(repo)).read(d.id))!
      if (failure === 'overlapping mutation') state.mutating = 1
      const ticket = shadow.reserve('spawn', shadow.preparation(), { id: d.id, name: d.name })!
      if (failure === 'unfilled reservation expired') ticket.expires = -1
      else {
        if (failure === 'missing registry worker') vi.spyOn(state.registry, 'read').mockResolvedValue(undefined)
        if (failure === 'ownership moved') vi.spyOn(state.registry, 'read').mockResolvedValue({ ...record, name: 'someone-else' })
        shadow.enqueue(() => {
          if (failure === 'payload exception') throw new Error('PRIVATE_CONTENT')
          return { kind: 'spawn', record: failure === 'unsupported sharing' ? { ...record, share: 'none' } : record, supplied: false }
        }, ticket)
      }
      await shadow.idle(); await shadow.idle()
      const expected = failure === 'payload exception' ? 'spawn event failed'
        : failure === 'unfilled reservation expired' ? 'spawn unfilled reservation expired'
        : failure === 'overlapping mutation' ? 'spawn missing generation or overlapping mutation'
        : failure === 'missing registry worker' ? 'worker missing or retired before spawn'
        : failure === 'ownership moved' ? 'spawn family ownership moved'
        : 'sharing is not full'
      expect(log.mock.calls.filter(([line]) => line.includes(d.name))).toEqual([
        [`conflict shadow: unmodelled history: ${expected} (${d.name})`],
      ])
      expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_CONTENT')
      expect(state.actors.size).toBe(0)
    } finally { shadow.stop(); await shadow.idle() }
  },
)

it.each(['initialization', 'inventory', 'queue ceiling'] as const)('names lead and pending/rejected workers when %s stops the family', async failure => {
  const t = world(), d = await t.spawn('d'), log = vi.fn(), shadow = new ConflictShadow(t.leadSession(), log), state = shadow as any
  try {
    if (failure === 'initialization') vi.spyOn(shadow.graph, 'init').mockRejectedValue(new Error('PRIVATE_CONTENT'))
    else await state.init()
    if (failure === 'inventory') vi.spyOn(state.registry, 'list').mockRejectedValue(new Error('PRIVATE_CONTENT'))
    if (failure === 'queue ceiling') for (let i = 0; i < 32; i++) shadow.reserve('spawn', shadow.preparation())
    shadow.reserve('spawn', shadow.preparation(), { id: d.id, name: d.name })
    await shadow.idle()
    const reason = failure === 'queue ceiling' ? 'event queue exhausted' : failure === 'inventory' ? 'worker inventory failed' : 'initialization failed'
    expect(log.mock.calls.filter(([line]) => line.includes(t.leadSession().me.name + ')') && line.includes('family stopped'))).toHaveLength(1)
    expect(log.mock.calls.filter(([line]) => line.includes(d.name))).toEqual([
      [expect.stringContaining(`family stopped: ${reason}`)],
    ])
    // A later worker cannot disappear behind the already-stopped fast return.
    shadow.stop() // Deadline/journal shutdown also closes a halted family.
    shadow.reserve('spawn', undefined, { id: 'late', name: 'rohanz+late' })
    shadow.reserve('spawn', undefined, { id: 'late', name: 'rohanz+late' })
    await Promise.resolve()
    expect(log.mock.calls.filter(([line]) => line.includes('rohanz+late'))).toEqual([
      [expect.stringContaining(`family already stopped: ${reason}`)],
    ])
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_CONTENT')
  } finally { shadow.stop(); await shadow.idle() }
})

it.each(['publication unavailable', 'moving snapshot', 'over budget: file count', 'worker checkout identity unavailable'])(
  'names every participant whose observation fails with %s', async reason => {
    const f = await stabilityFixture(), state = f.shadow as any, log = vi.fn()
    state.log = log
    try {
      if (reason === 'publication unavailable') vi.spyOn(state, 'publication').mockReturnValue(undefined)
      else {
        await f.publish(1)
        vi.spyOn(captures, 'captureShadow').mockRejectedValue(new Error(reason))
      }
      await f.internal.pass(); f.advance(60_001); await f.internal.pass()
      for (const name of [f.s.me.name, f.d.name, f.u.name]) {
        const lines = log.mock.calls.filter(([line]) => line.includes(`(${name})`) && line.includes(reason))
        expect(lines).toHaveLength(1)
      }
    } finally { f.shadow.stop(); await f.shadow.idle() }
  },
)

it('names followed workers whose registry records disappear before retirement', async () => {
  const f = await stabilityFixture(), state = f.shadow as any, log = vi.fn()
  state.log = log
  try {
    state.retire([])
    await f.shadow.idle()
    for (const name of [f.d.name, f.u.name]) expect(log.mock.calls.filter(([line]) => line.includes(name))).toEqual([
      [`conflict shadow: unmodelled history: worker registry record unavailable (${name})`],
    ])
  } finally { f.shadow.stop(); await f.shadow.idle() }
})

it('reports workers that cannot be followed even when the lead still has an actor', async () => {
  const f = await stabilityFixture(), state = f.shadow as any, log = vi.fn()
  state.log = log
  try {
    await f.publish(1)
    for (const name of [f.d.name, f.u.name]) await state.unmodelled(state.actors.get(name), 'worker HEAD moved')
    f.advance(60_001); await f.internal.pass()
    expect(state.actors.has(f.s.me.name)).toBe(true)
    expect(log.mock.calls.some(([line]) => line.includes('pairs=0') && line.includes('workers exist but none could be followed'))).toBe(true)
  } finally { f.shadow.stop(); await f.shadow.idle() }
})
