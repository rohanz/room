import { expect, it } from 'vitest'
import { planWindows } from './line-window.ts'
import type { MergedLine } from './merged.ts'
const fixture = (n: number, changed = true): MergedLine[] => Array.from({ length: n }, () => ({ text: 'x', side: 'common', changedBy: changed ? ['Ada'] : [], conflict: false }))
it('leaves small files untouched', () => {
  expect(planWindows(fixture(1500))).toEqual([{ kind: 'lines', from: 0, to: 1500 }])
})
it('pages a large all-changed file', () => {
  expect(planWindows(fixture(32000))).toEqual([{ kind: 'lines', from: 0, to: 500 }, { kind: 'gap', from: 500, to: 32000, reason: 'more' }])
})
it('retains context around two hunks and collapses unchanged runs', () => {
  const lines = fixture(4000, false)
  lines[100].changedBy = ['Ada']; lines[2000].conflict = true
  expect(planWindows(lines)).toEqual([
    { kind: 'gap', from: 0, to: 97, reason: 'unchanged' }, { kind: 'lines', from: 97, to: 104 },
    { kind: 'gap', from: 104, to: 1997, reason: 'unchanged' }, { kind: 'lines', from: 1997, to: 2004 },
    { kind: 'gap', from: 2004, to: 4000, reason: 'unchanged' },
  ])
})
it('expands unchanged gaps and successive more pages without mutating state', () => {
  const expanded = new Set(['0-4000', '500-4000'])
  expect(planWindows(fixture(4000, false), { expanded })).toEqual([{ kind: 'lines', from: 0, to: 1000 }, { kind: 'gap', from: 1000, to: 4000, reason: 'more' }])
  expect(expanded.size).toBe(2)
})
it('shows all on request', () => {
  expect(planWindows(fixture(32000), { all: true })).toEqual([{ kind: 'lines', from: 0, to: 32000 }])
})
