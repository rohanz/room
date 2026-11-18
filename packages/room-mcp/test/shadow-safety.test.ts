// These safety regressions run in both default and TEST_SCALE=1 passes.
import './shadow-controlled-fixture.js'
import { expect, it, vi } from 'vitest'
import { ConflictShadow } from '../src/conflict-shadow.js'
import { stabilityFixture } from './shadow-stability-fixture.js'
import { registryForDir } from '../src/worker-registry.js'
import { git, put, repo, world } from './worker-refresh-fixture.js'

it('does not log literal attribute values from participant files', async () => {
  const t = world(), d = await t.spawn('d'), log = vi.fn()
  const shadow = new ConflictShadow(t.leadSession(), log), state = shadow as any
  try {
    await state.init()
    // No injected exception: checkAttributes constructs this error from a real file.
    put(d.dir, '.gitattributes', 'shared.txt filter=PRIVATE_ATTRIBUTE_VALUE\n')
    const record = (await (await registryForDir(repo)).read(d.id))!
    const ticket = shadow.reserve('spawn', shadow.preparation(), { id: d.id, name: d.name })!
    shadow.enqueue(() => ({ kind: 'spawn', record, supplied: false }), ticket)
    await shadow.idle()
    expect(log.mock.calls.some(([line]) => line.includes(d.name))).toBe(true)
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_ATTRIBUTE_VALUE')
  } finally { shadow.stop(); await shadow.idle() }
})

it('does not evaluate collection owner lists synchronously when its queue fills', async () => {
  const t = world(), shadow = new ConflictShadow(t.leadSession(), () => {})
  const owners = vi.fn(() => [{ id: 'worker-id', name: 'rohanz+worker' }])
  try {
    // This is the exact lazy owner-list shape used by tools/collect.ts.
    for (let i = 0; i < 32; i++) shadow.reserve('spawn', shadow.preparation())
    shadow.reserve('collection', undefined, owners)
    expect(owners).not.toHaveBeenCalled()
  } finally { shadow.stop(); await shadow.idle() }
})

it('never passes unknown exception prefixes or errno values through as reasons', async () => {
  const t = world(), shadow = new ConflictShadow(t.leadSession(), () => {}), state = shadow as any
  try {
    for (const message of [
      'unmodelled history: PRIVATE_EXCEPTION_TEXT',
      'unmodelled history: attribute filter=PRIVATE_ATTRIBUTE_VALUE on "shared.txt"',
      'unmodelled history: HEAD ancestry\nPRIVATE_EXCEPTION_TEXT',
      'over budget: PRIVATE_EXCEPTION_TEXT',
      'shadow Git step failed: ls-tree PRIVATE_EXCEPTION_TEXT',
    ]) expect(state.reason(new Error(message), 'event failed')).toBe('event failed')
    expect(state.reason(Object.assign(new Error('private'), { code: 'EPRIVATE_CONFIGURATION_VALUE' }), 'event failed')).toBe('event failed')
    expect(state.reason(new Error('unmodelled history: HEAD ancestry'), 'event failed')).toBe('unmodelled history: HEAD ancestry')
    expect(state.reason(Object.assign(new Error('private'), { code: 'ENOENT' }), 'event failed')).toBe('event failed: ENOENT')
  } finally { shadow.stop(); await shadow.idle() }
})

it('defers queued owner accessors too and preserves diagnostics when stop follows overflow', async () => {
  const t = world(), log = vi.fn(), shadow = new ConflictShadow(t.leadSession(), log), state = shadow as any
  let onCallerStack = true
  const owners = vi.fn(() => {
    expect(onCallerStack).toBe(false)
    return [{ id: 'worker-id', name: 'rohanz+worker' }]
  })
  try {
    shadow.reserve('collection', undefined, owners)
    for (let i = 0; i < 31; i++) shadow.reserve('spawn', shadow.preparation())
    shadow.reserve('spawn', shadow.preparation())
    expect(owners).not.toHaveBeenCalled()
    shadow.stop()
    expect(owners).not.toHaveBeenCalled()
    onCallerStack = false
    await shadow.idle()
    expect(owners).toHaveBeenCalledOnce()
    expect(log.mock.calls.filter(([line]) => line.includes('(rohanz+worker)'))).toEqual([
      ['conflict shadow: unmodelled history: family stopped: event queue exhausted; lead history lost (rohanz+worker)'],
    ])
  } finally { onCallerStack = false; shadow.stop(); await shadow.idle(); await state.cleanup }
})

it.each(['halted', 'closed'] as const)('defers late owner accessors for a %s family', async phase => {
  const t = world(), shadow = new ConflictShadow(t.leadSession(), () => {}), state = shadow as any
  const owners = vi.fn(() => [{ id: 'late-id', name: 'rohanz+late' }])
  try {
    for (let i = 0; i < 33; i++) shadow.reserve('spawn', shadow.preparation())
    if (phase === 'closed') shadow.stop()
    shadow.reserve('collection', undefined, owners)
    expect(owners).not.toHaveBeenCalled()
    await shadow.idle()
    expect(owners).toHaveBeenCalledOnce()
  } finally { shadow.stop(); await shadow.idle(); await state.cleanup }
})

it('omits participant configuration values from initial failure logs', async () => {
  const t = world(), d = await t.spawn('d'), log = vi.fn()
  const shadow = new ConflictShadow(t.leadSession(), log), state = shadow as any
  try {
    await state.init()
    git(d.dir, 'config', 'merge.default', 'PRIVATE_CONFIGURATION_VALUE')
    const record = (await (await registryForDir(repo)).read(d.id))!
    const ticket = shadow.reserve('spawn', shadow.preparation(), { id: d.id, name: d.name })!
    shadow.enqueue(() => ({ kind: 'spawn', record, supplied: false }), ticket)
    await shadow.idle()
    expect(log.mock.calls.some(([line]) => line.includes(d.name) && line.includes('attribute configuration on'))).toBe(true)
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_CONFIGURATION_VALUE')
  } finally { shadow.stop(); await shadow.idle() }
})

it('keeps aggregate summaries free of participant attribute paths and values', async () => {
  const f = await stabilityFixture(), state = f.shadow as any, log = vi.fn()
  state.log = log
  try {
    put(f.d.dir, '.gitattributes', 'shared.txt filter=PRIVATE_FILTER_VALUE\n')
    put(f.u.dir, '.gitattributes', 'keep.txt merge=PRIVATE_MERGE_VALUE\n')
    await f.publish(1); await f.internal.pass()
    const summaries = log.mock.calls.filter(([line]) => line.includes('pairs='))
    expect(summaries).toHaveLength(1)
    expect(summaries[0][0]).toContain(`participant="${f.s.me.name}"`)
    expect(summaries[0][0]).toContain('unmodelled history')
    expect(summaries[0][0]).not.toMatch(/shared\.txt|keep\.txt/)
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE_FILTER_VALUE|PRIVATE_MERGE_VALUE/)
  } finally { f.shadow.stop(); await f.shadow.idle() }
})
