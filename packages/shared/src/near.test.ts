import { expect, it } from 'vitest'
import { coversPath, nearPath } from './near.js'

it.each([
  ['src/', 'src/a.ts', true], ['src/a.ts', 'src/', true],
  ['src', 'src2/a.ts', false], ['a.ts', 'a.ts', true],
  ['./src/', 'src/a.ts', true], ['src\\a.ts', 'src/', true],
  ['.', 'any/file', true], ['src/a.ts', 'src/b.ts', false],
])('path proximity respects directory boundaries: %s and %s', (a, b, expected) => {
  expect(coversPath(a, b)).toBe(expected)
})

it('preserves the evidence needed to explain why a claim is needed', () => {
  const entries = [
    { by: 'Ada', path: 'src/', reason: 'scope' as const },
    { by: 'Bea', path: 'src/api.ts', reason: 'changed' as const },
    { by: 'Cam', path: 'tests/', reason: 'claim' as const },
  ]
  expect(nearPath('src/api.ts', entries)).toEqual(entries.slice(0, 2))
})
