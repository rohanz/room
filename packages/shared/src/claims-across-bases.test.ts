import { describe, expect, it } from 'vitest'
import { claimInMyLines, mapRange } from './claims.js'

describe('claims across bases', () => {
  it('moves a claim past inserted lines and widens a changed hunk', () => {
    expect(claimInMyLines({ from: 1, to: 1 }, 'old\n', 'inserted\nold\n')).toEqual({ from: 2, to: 2, approximate: false })
    expect(mapRange('a\nb\nc\n', 'new\na\nb\nc\n', { from: 2, to: 2 })).toEqual({ from: 3, to: 3 })
    expect(mapRange('a\nb\nc\n', 'a\nB\nC\nc\n', { from: 2, to: 2 })).toEqual({ from: 2, to: 3 })
    expect(mapRange('a\nb\nc\n', 'a\nb\nnew\nc\n', { from: 2, to: 3 })).toEqual({ from: 2, to: 4 })
  })

  it('marks unavailable owner text approximate and covers the file', () => {
    expect(claimInMyLines({ from: 4, to: 6 }, undefined, 'a\nb\nc\n')).toEqual({ from: 1, to: 3, approximate: true })
  })

  it('marks the large-file whole-file fallback approximate', () => {
    const owner = Array.from({ length: 1001 }, (_, i) => `line ${i}`).join('\n')
    expect(claimInMyLines({ from: 500, to: 500 }, owner, `inserted\n${owner}`)).toEqual({ from: 1, to: 1002, approximate: true })
  })
})
