import { describe, expect, it } from 'vitest'
import { SkipSummaryGate } from '../src/skip-summary.js'

describe('skip summary gate', () => {
  it('logs the initial set, at most one reminder per hour, and each change immediately', () => {
    let now = 0
    const gate = new SkipSummaryGate(() => now)
    const skipped = new Map([['a.txt', 'size']])
    const logged: number[] = []
    for (let minute = 0; minute < 120; minute++) {
      now = minute * 60_000
      if (gate.shouldLog(skipped)) logged.push(minute)
    }
    expect(logged).toEqual([0, 60])
    skipped.set('a.txt', 'budget')
    expect(gate.shouldLog(skipped)).toBe(true)
    expect(gate.shouldLog(skipped)).toBe(false)
    skipped.set('b.txt', 'ignore')
    expect(gate.shouldLog(skipped)).toBe(true)
    skipped.delete('a.txt')
    expect(gate.shouldLog(skipped)).toBe(true)
    skipped.clear()
    expect(gate.shouldLog(skipped)).toBe(false)
    skipped.set('b.txt', 'ignore')
    expect(gate.shouldLog(skipped)).toBe(true)
  })
})
