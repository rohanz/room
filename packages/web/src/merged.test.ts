import { describe, expect, it } from 'vitest'
import { classifyMergedLines } from './merged.ts'

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
  it('keeps exact alternatives for distant rewrites of JSON and 800-line source', () => {
    const jsonA = '[' + 'a'.repeat(60_000) + ']'
    const jsonB = '[' + 'b'.repeat(60_000) + ']'
    expect(classifyMergedLines(jsonA, jsonB).map(line => [line.text, line.side])).toEqual([[jsonA, 'a'], [jsonB, 'b']])
    const before = Array.from({ length: 800 }, (_, i) => `old-${i}\n`).join('')
    const after = Array.from({ length: 800 }, (_, i) => `new-${i}\n`).join('')
    const lines = classifyMergedLines(before, after)
    expect(lines.filter(line => line.side === 'a').map(line => line.text).join('\n') + '\n').toBe(before)
    expect(lines.filter(line => line.side === 'b').map(line => line.text).join('\n') + '\n').toBe(after)
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

import { classifyNWay } from './merged.ts'
describe('N-way merge', () => {
  const base = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n'
  const people = [
    { name: 'Ada', text: base.replace('one', 'Ada edit') },
    { name: 'Ben', text: base.replace('four', 'Ben edit') },
    { name: 'Cy', text: base.replace('seven', 'Cy edit') },
  ]
  it('carries all three disjoint authors with no conflicts', () => {
    const out = classifyNWay(base, people)
    expect(out.filter(l => l.changedBy.length).map(l => l.changedBy)).toEqual([['Ada'], ['Ben'], ['Cy']])
    expect(out.some(l => l.conflict)).toBe(false)
    expect(lineHoverText(out.at(-1)!, people.map(p => p.name))).toBe('changed by Cy')
  })
  it('retains one conflict region and its actual pair when a third edits elsewhere', () => {
    const out = classifyNWay(base, [people[0], { name: 'Ben', text: base.replace('one', 'Ben edit') }, people[2]])
    expect(out.filter(l => l.conflict).map(l => [l.text, l.conflictPair])).toEqual([
      ['Ada edit', ['Ada', 'Ben']], ['Ben edit', ['Ada', 'Ben']],
    ])
    expect(out.at(-1)).toMatchObject({ changedBy: ['Cy'], conflict: false })
  })
  it('recomputes without a toggled participant, including one and zero participants', () => {
    const out = classifyNWay(base, people.filter(p => p.name !== 'Ben'))
    expect(out.some(l => l.text === 'Ben edit')).toBe(false)
    expect(out.find(l => l.text === 'four')?.changedBy).toEqual([])
    expect(classifyNWay(base, [people[2]]).filter(l => l.changedBy.length).map(l => l.text)).toEqual(['Cy edit'])
    expect(classifyNWay(base, []).map(l => l.text).join('\n') + '\n').toBe(base)
  })
  it('keeps joint authorship and deleted lines out of the result', () => {
    const out = classifyNWay(base, [people[0], { name: 'Ben', text: people[0].text }, { name: 'Cy', text: base.replace('seven\n', '') }])
    expect(out[0].changedBy).toEqual(['Ada', 'Ben'])
    expect(out.some(l => l.text === 'seven')).toBe(false)
  })
  it('measures a carried worker against its own base, in either order', () => {
    const lead = { name: 'lead', text: 'carried\nkeep\n' }, worker = { name: 'worker', text: 'carried\nworker\n', base: 'carried\nkeep\n' }
    for (const order of [[lead, worker], [worker, lead]]) {
      const out = classifyNWay('base\nkeep\n', order)
      expect(out.map(l => [l.text, l.changedBy, l.conflict])).toEqual([['carried', ['lead'], false], ['worker', ['worker'], false]])
    }
    expect(classifyNWay('base\nkeep\n', [worker]).map(l => [l.text, l.changedBy])).toEqual([['carried', []], ['worker', ['worker']]])
    const far = { name: 'worker', text: 'carried\n1\n2\n3\nworker\n', base: 'carried\n1\n2\n3\nkeep\n' }
    for (const order of [[{ name: 'lead', text: 'lead2\n1\n2\n3\nkeep\n' }, far], [far, { name: 'lead', text: 'lead2\n1\n2\n3\nkeep\n' }]]) {
      const out = classifyNWay('base\n1\n2\n3\nkeep\n', order)
      expect(out.filter(l => l.changedBy.length).map(l => [l.text, l.changedBy, l.conflict])).toEqual([['lead2', ['lead'], false], ['worker', ['worker'], false]])
    }
  })
  it('names the deletion author in a delete/modify conflict', () => {
    const out = classifyNWay(base, [{ name: 'Ada', text: base.replace('one\n', '') }, { name: 'Ben', text: people[0].text }])
    expect(out.filter(l => l.conflict)[0].conflictPair).toEqual(['Ada', 'Ben'])
  })
})

it('attributes the final line even without a trailing newline', () => {
  expect(classifyNWay('one\ntwo', [{ name: 'Ada', text: 'one\nchanged' }])).toMatchObject([
    { text: 'one', changedBy: [] }, { text: 'changed', changedBy: ['Ada'], lineNumbers: { Ada: 2 } },
  ])
})
