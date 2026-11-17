import './shadow-controlled-fixture.js'
import { expect, it, vi } from 'vitest'
import { ConflictShadow } from '../src/conflict-shadow.js'
import { world } from './worker-refresh-fixture.js'

it('discards queued payloads when registry reads fail instead of retaining completed reservations', async () => {
  const t = world(), shadow = new ConflictShadow(t.leadSession(), () => {})
  const state = shadow as any
  try {
    await state.init()
    vi.spyOn(state.registry, 'list').mockRejectedValue(new Error('registry unavailable'))
    const ticket = shadow.reserve('collection')!
    const payload = vi.fn(() => { throw new Error('must not build unknown history') })
    shadow.enqueue(payload, ticket)
    await shadow.idle()
    expect(payload).not.toHaveBeenCalled()
    expect(state.queue.size).toBe(0); expect(state.mutating).toBe(0)
    expect(shadow.reserve('spawn', shadow.preparation())).toBeUndefined()
  } finally { shadow.stop(); vi.restoreAllMocks() }
})
