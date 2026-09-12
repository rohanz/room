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
})
