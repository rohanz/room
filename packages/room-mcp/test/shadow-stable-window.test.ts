import './shadow-controlled-fixture.js'
import fsp from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'

const full = process.env.TEST_SCALE === '1' ? it : it.skip
import type { ConflictSlot } from '../src/conflict-set.js'
import { stabilityFixture, delayedConflict } from './shadow-stability-fixture.js'

afterEach(() => vi.restoreAllMocks())
full('records a persistent disagreement exactly once, as a 60-second heuristic', async () => {
  const f = await stabilityFixture()
  try {
    await delayedConflict(f); await f.internal.pass(); expect(f.rows()).toEqual([])
    f.advance(59_000); await f.internal.pass(); expect(f.rows()).toEqual([])
    f.advance(1001); await f.internal.pass()
    expect(f.rows()).toHaveLength(1)
    expect(f.rows()[0]).toMatchObject({ today: 'conflict', shadow: 'clean', observation: '60-second-stable-heuristic', stableForMs: 60_001 })
    f.advance(60_001); await f.internal.pass(); expect(f.rows()).toHaveLength(1)
  } finally { f.shadow.stop() }
})
full('does not reset a stable path because another path has an unknown ordinary slot', async () => {
  const f = await stabilityFixture()
  try {
    const { old } = await delayedConflict(f); await f.internal.pass()
    for (const [key, slot] of old) f.s.room.doc.getMap<ConflictSlot>('conflicts').set(key + ':other-path', { ...slot, path: 'keep.txt', status: 'unknown', settled: 'none' })
    f.advance(60_001); await f.internal.pass()
    expect(f.rows()).toHaveLength(1); expect(f.rows()[0].path).toBe('shared.txt')
  } finally { f.shadow.stop() }
})
full('rechecks the stable episode after the final awaited size check and before append', async () => {
  const f = await stabilityFixture()
  try {
    const { old } = await delayedConflict(f); await f.internal.pass(); f.advance(60_001)
    const open = fsp.open; let changed = false
    vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('disagreements.jsonl')) {
        const stat = handle.stat.bind(handle)
        vi.spyOn(handle, 'stat').mockImplementation(async (...parts) => {
          const value = await stat(...parts)
          if (!changed) { changed = true; for (const [key, slot] of old) f.s.room.doc.getMap<ConflictSlot>('conflicts').set(key, { ...slot, status: 'clean', settled: 'clean' }) }
          return value
        })
      }
      return handle
    })
    await f.internal.pass(); expect(changed).toBe(true); expect(f.rows()).toEqual([])
  } finally { f.shadow.stop() }
})
