import { describe, expect, it } from 'vitest'
import { classifyThreeWay, classifyMergedLines } from './merged.ts'

describe('merged line classification', () => {
  it('keeps common lines plain and marks competing replacement lines as conflicts', () => {
    const lines = classifyMergedLines('alpha\nfrom Ada\nomega\n', 'alpha\nfrom Rohan\nomega\n')
    expect(lines.map(line => [line.text, line.side, line.conflict])).toEqual([
      ['alpha', 'common', false],
      ['from Ada', 'a', true],
      ['from Rohan', 'b', true],
      ['omega', 'common', false],
    ])
  })

  it('classifies a one-sided insertion without a conflict', () => {
    const lines = classifyMergedLines('alpha\nomega\n', 'alpha\nnew\nomega\n')
    expect(lines.find(line => line.text === 'new')).toMatchObject({ side: 'b', conflict: false })
  })
})

describe('classifyThreeWay', () => {
  it('tints each side\'s additions, keeps untouched lines plain, and flags only real conflicts', () => {
    const base = 'def parse():\n    pass\n\ndef create():\n    x = parse()\n    y = 1\n    z = 2\n    return x\n'
    const a = base.replace('def parse():', 'def parse_payload():').replace('x = parse()', 'x = parse_payload()')
    const b = base.replace('    return x\n', '    if x: raise\n    return x\n')
    const out = classifyThreeWay(base, a, b)
    expect(out.map(l => l.side)).toEqual(['a', 'common', 'common', 'common', 'a', 'common', 'common', 'b', 'common'])
    expect(out.some(l => l.conflict)).toBe(false)
    expect(out[0]).toMatchObject({ aLine: 1 })
    expect(out[7]).toMatchObject({ bLine: 8 })
    expect(out[8]).toMatchObject({ aLine: 8, bLine: 9 })
    const c = base.replace('    return x\n', '    return None\n')
    const d = base.replace('    return x\n', '    return 1\n')
    const conflict = classifyThreeWay(base, c, d)
    expect(conflict.filter(l => l.conflict).map(l => l.text.trim())).toEqual(['return None', 'return 1'])
  })
})

import { lineHoverText } from './panels.ts'
describe('lineHoverText', () => {
  it('names the author, base lines, conflicts, and claims covering the line', () => {
    const names: [string, string] = ['Rohan', 'Kieran']
    const claim = { id: 'c1', path: 'a.py', from: 3, to: 5, by: 'Kieran', byKind: 'agent' as const, intent: 'guard', at: 1, plans: [{ kind: 'add' as const, symbol: 'limit' }] }
    const claimsAt = (person: string, line: number) => person === 'Kieran' && line >= 3 && line <= 5 ? [claim] : []
    expect(lineHoverText({ text: '', side: 'a', changedBy: null, conflict: false, aLine: 1 }, names)).toBe('added by Rohan')
    expect(lineHoverText({ text: '', side: 'common', changedBy: null, conflict: false, aLine: 4, bLine: 4 }, names, claimsAt)).toBe('unchanged from base\nclaimed by Kieran: guard (plans: add limit)')
    expect(lineHoverText({ text: '', side: 'b', changedBy: null, conflict: true, bLine: 9 }, names)).toMatch(/^CONFLICT: Rohan and Kieran changed this differently; this is Kieran's version$/)
  })
})

it('tracks each author against base, including identical edits and expanded conflicts', () => {
  const base = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`).join('')
  const a = base.replace('line 2\n', 'A only\n').replace('line 8\n', 'joint\n').replace('line 10\nline 11\n', 'A ten\nA eleven\n')
  const b = base.replace('line 5\n', 'B only\n').replace('line 8\n', 'joint\n').replace('line 10\nline 11\n', 'B ten\nB eleven\n')
  const out = classifyThreeWay(base, a, b)
  expect(out.map(l => [l.text, l.changedBy, l.conflict])).toEqual([
    ['line 1', null, false], ['A only', 'a', false], ['line 3', null, false],
    ['line 4', null, false], ['B only', 'b', false], ['line 6', null, false],
    ['line 7', null, false], ['joint', 'both', false], ['line 9', null, false],
    ['A ten', 'a', true], ['A eleven', 'a', true], ['B ten', 'b', true],
    ['B eleven', 'b', true], ['line 12', null, false],
  ])
  expect(lineHoverText(out[7], ['rohanz+a', 'rohanz+tiers'])).toBe('changed by rohanz+a and rohanz+tiers')
})
