import { expect, it } from 'vitest'
import { containsPath, coversPath, nearPath } from './near.js'

it('contains only explicit repo-relative root declarations', () => {
  expect(containsPath('', 'src/a.ts')).toBe(false)
  expect(containsPath('  ', 'src/a.ts')).toBe(false)
  expect(containsPath('/', 'src/a.ts')).toBe(false)
  expect(containsPath('/..', 'src/a.ts')).toBe(false)
  expect(containsPath('C:\\..', 'src/a.ts')).toBe(false)
  expect(containsPath('.', 'src/a.ts')).toBe(true)
  expect(containsPath('./', 'src/a.ts')).toBe(true)
})

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
