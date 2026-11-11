import { describe, expect, it } from 'vitest'
import { classifyDoc, servedBy016 } from '../src/inventory.js'
import type { OpenRepo } from '../src/store.js'

const repo = 'github.com/o/r'
const registry: Record<string, OpenRepo> = { [repo]: { at: 1, branches: [`${repo}/main`] } }

describe('inventory classification', () => {
  it('matches the literal repository prefixes 0.16.40 admitted', () => {
    for (const name of [`${repo}/main`, 'local/demo/main', 'git/example.com/o/r/main']) expect(servedBy016(name)).toBe(true)
    for (const name of ['github.com%2Fo%2Fr%2Fmain', 'github.com%252Fo%252Fr%252Fmain', 'local%2Fdemo%2Fmain', '/local/demo', 'x', 'archive:invalid']) expect(servedBy016(name)).toBe(false)
    expect(classifyDoc('github.com%252Fo%252Fr%252Fmain', registry).kind).toBe('never-served')
    expect(classifyDoc(repo, registry).kind).toBe('canonical')
  })
  it('serves percent-containing suffixes and case aliases but never encoded repository prefixes', () => {
    for (const name of [`${repo}/feature%2Fx`, `${repo}/a%252Fb`, 'github.com/O/R/main', 'github.com/O/R', `${repo}/`]) {
      expect(servedBy016(name), name).toBe(true)
      expect(classifyDoc(name, registry)).toEqual({ repo, kind: 'served' })
    }
    for (const name of ['github.com%2Fo%2Fr%2Fmain', 'github.com%252Fo%252Fr%252Fmain']) {
      expect(servedBy016(name), name).toBe(false)
      expect(classifyDoc(name, registry).kind).toBe('never-served')
    }
    for (const name of ['/github.com/o/r/main', 'github.com/o!/r/main']) expect(servedBy016(name)).toBe(false)
  })
  it('only recognizes archives recorded by their owner', () => {
    const archive = `archive:${repo}:12345678-1234-1234-1234-123456789abc`
    expect(classifyDoc(archive, registry).kind).toBe('unregistered')
    expect(classifyDoc(archive, { [repo]: { ...registry[repo]!, legacy: [archive] } }).kind).toBe('archive')
    expect(classifyDoc(archive, { [repo]: { ...registry[repo]!, plan: { id: 'p', sources: [], moved: archive } } }).kind).toBe('archive')
    expect(classifyDoc('archive:invalid', registry).kind).toBe('unregistered')
  })
  it('requires recorded branches for local and non-GitHub repositories', () => {
    for (const key of ['local/demo', 'git/example.com/o/r']) {
      const name = `${key}/main`, rooms = { [key]: { at: 1, branches: [name] } }
      expect(classifyDoc(key, rooms).kind).toBe('canonical')
      expect(classifyDoc(name, rooms).kind).toBe('served')
      expect(classifyDoc(`${key}/other`, rooms).kind).toBe('unregistered')
      expect(classifyDoc(name.replaceAll('/', '%2F'), rooms).kind).toBe('unregistered')
      const percent = `${key}/feature%2Fx`
      expect(classifyDoc(percent, { [key]: { at: 1, branches: [percent] } }).kind).toBe('served')
    }
  })
})
