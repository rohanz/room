import { expect, it } from 'vitest'
import { RoomDoc } from './doc.js'
import { containsPath, coordinationPaths, coversPath, nearPath } from './near.js'

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

it('collects room proximity evidence in scope, claim, changed order and excludes my work', () => {
  const room = new RoomDoc()
  room.setScope({ by: 'Ada', byKind: 'agent', area: 'src', summary: 'edit', paths: ['src/'] })
  room.setScope({ by: 'Me', byKind: 'agent', area: 'own', summary: 'edit', paths: ['own/'] })
  room.addClaim({ by: 'Ada', byKind: 'agent', path: 'src/file.ts', from: 1, to: 1, intent: 'edit' })
  room.addClaim({ by: 'Me', byKind: 'agent', path: 'own/file.ts', from: 1, to: 1, intent: 'edit' })
  room.setOverlay('Ada', 'src/file.ts', 'content')
  room.markDeleted('Ada', 'src/old.ts')
  room.setOverlay('Me', 'own/file.ts', 'content')
  expect(coordinationPaths(room, 'Me')).toEqual([
    { by: 'Ada', path: 'src/', reason: 'scope' },
    { by: 'Ada', path: 'src/file.ts', reason: 'claim' },
    { by: 'Ada', path: 'src/file.ts', reason: 'changed' },
    { by: 'Ada', path: 'src/old.ts', reason: 'changed' },
  ])
  room.doc.destroy()
})

it('can retain own non-agent claims, including legacy missing byKind, in a hook snapshot', () => {
  const room = new RoomDoc()
  room.addClaim({ by: 'Me', byKind: 'agent', path: 'agent.ts', from: 1, to: 1, intent: 'edit' })
  room.addClaim({ by: 'Me', byKind: 'human', path: 'human.ts', from: 1, to: 1, intent: 'edit' })
  room.addClaim({ by: 'Me', byKind: undefined as never, path: 'legacy.ts', from: 1, to: 1, intent: 'edit' })
  expect(coordinationPaths(room, 'Me', { includeOwnNonAgentClaims: true })).toEqual([
    { by: 'Me', path: 'human.ts', reason: 'claim' },
    { by: 'Me', path: 'legacy.ts', reason: 'claim' },
  ])
  room.doc.destroy()
})
