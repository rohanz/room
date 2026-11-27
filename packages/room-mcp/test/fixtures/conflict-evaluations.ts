import { vi } from 'vitest'
import type { ConflictSlots, ConflictSet, Evaluation } from '../../src/conflict-set.js'

/** Absence of a closed row alone cannot prove that detection actually evaluated it clean. */
export function recordEvaluations(set: ConflictSet) {
  const slots = (set as unknown as { slots: ConflictSlots }).slots, results: Evaluation[] = []
  const settle = slots.settle.bind(slots), pair = slots.settlePair.bind(slots)
  const one = vi.spyOn(slots, 'settle').mockImplementation(async (...args) => {
    const value = await settle(...args)
    results.push({ ...args[1], status: value.status })
    return value
  })
  const many = vi.spyOn(slots, 'settlePair').mockImplementation(async (...args) => {
    await pair(...args)
    results.push(...args[2].values())
  })
  return { results, stop() { one.mockRestore(); many.mockRestore() } }
}
