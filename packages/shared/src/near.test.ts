import { expect, it } from 'vitest'
import { RoomDoc } from './doc.js'
import { manifestKey } from './manifest.js'
import * as Y from 'yjs'
import { containsPath, coordinationPaths, coversPath, nearPath, neighbours } from './near.js'

it('selects visible people, excluding self and PR mirrors', () => {
  const nb = neighbours([{ name: 'Me', fresh: true, visible: true }, { name: 'Ada', fresh: false, visible: true }, { name: 'Gone', fresh: false, visible: false }, { name: 'pr#7', fresh: false, visible: true }], 'Me')
  expect(nb.everyone).toBe(true)
  expect(nb.names()).toEqual(['Ada'])
  expect(nb.has('pr#7')).toBe(false)
})

it('keeps PR scope as evidence even when the neighbourhood excludes its identity', () => {
  const room = new RoomDoc()
  room.setScope({ by: 'pr#7', byKind: 'agent', area: 'src', summary: 'PR', paths: ['src/api.ts'] })
  room.setScope({ by: 'Ada', byKind: 'agent', area: 'src', summary: 'edit', paths: ['src/'] })
  const nb = { everyone: false, has: (name: string) => name === 'Ada', names: () => ['Ada'] }
  expect(nearPath('src/api.ts', coordinationPaths(room, nb, 'Me'))).toEqual([
    { by: 'pr#7', path: 'src/api.ts', reason: 'scope' },
    { by: 'Ada', path: 'src/', reason: 'scope' },
  ])
  room.doc.destroy()
})

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
  room.coordination.set('Ada', { paths: ['carried/'], workers: ['Ada+worker'], at: 1 })
  room.addClaim({ by: 'Ada', byKind: 'agent', path: 'src/file.ts', from: 1, to: 1, intent: 'edit' })
  room.addClaim({ by: 'Me', byKind: 'agent', path: 'own/file.ts', from: 1, to: 1, intent: 'edit' })
  room.manifestHead.set('Ada', { base: 'base', fence: 'ada-1', coverage: { kind: 'all' }, level: 'declared', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })
  const facts = new Y.Map<any>()
  room.manifest.set(manifestKey('Ada', 'ada-1'), facts)
  facts.set('src/file.ts', { change: 'M', state: 'held', held: 'scope', at: 1, fence: 'ada-1' })
  facts.set('src/old.ts', { change: 'D', state: 'shared', at: 1, fence: 'ada-1' })
  expect(coordinationPaths(room, neighbours([{ name: 'Ada', fresh: false, visible: true }], 'Me'), 'Me')).toEqual([
    { by: 'Ada', path: 'src/', reason: 'scope' },
    { by: 'Ada', path: 'carried/', reason: 'scope' },
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
  expect(coordinationPaths(room, neighbours([], 'Me'), 'Me', { includeOwnNonAgentClaims: true })).toEqual([
    { by: 'Me', path: 'human.ts', reason: 'claim' },
    { by: 'Me', path: 'legacy.ts', reason: 'claim' },
  ])
  room.doc.destroy()
})
