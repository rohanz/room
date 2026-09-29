import { describe, expect, it } from 'vitest'
import { validParticipantName as sharedValidParticipantName } from '@room/shared'
import { docNameOf, roomNameOf, repoRoomOf, githubRepoOf, validParticipantName, assertValidParticipantName } from '../src/names.js'

describe('participant names', () => {
  it.each([
    ['', false],
    ['rohan', true],
    ['rohan+codex', true],
    ['Zoë 李', true],
    ['rohan\u0000', false],
    ['rohan\u0001', false],
    ['rohan\n', false],
    ['rohan\u001f', false],
    ['rohan\u007f', false],
    ['rohan\u0080', false],
    ['rohan\u009f', false],
  ] as const)('server and shared validators agree for %j', (name, expected) => {
    expect(validParticipantName(name)).toBe(expected)
    expect(sharedValidParticipantName(name)).toBe(expected)
    if (expected) expect(() => assertValidParticipantName(name)).not.toThrow()
    else expect(() => assertValidParticipantName(name)).toThrow('participant name must be nonempty and contain no control characters')
  })
})

describe('room names', () => {
  it('a websocket request path is keyed by its decoded room name, query dropped', () => {
    expect(docNameOf('/github.com%2Fa%2Fb%2Fmain?session=abc')).toBe('github.com/a/b/main')
    expect(docNameOf('/github.com%252Fa%252Fb%252Fmain')).toBe('github.com/a/b/main') // browser double-encoding
    expect(docNameOf('/local%2Fshop%2Fmain')).toBe('local/shop/main')
    // the same key admission and the size cap use
    expect(docNameOf('/github.com%2Fa%2Fb%2Fmain?view=x')).toBe(roomNameOf('/github.com%2Fa%2Fb%2Fmain'))
  })
  it('uses an open prefix to distinguish a legacy branch from a repository name', () => {
    const open = new Set(['git/h/grp/repo', 'github.com/o/r'])
    const repo = (name: string) => repoRoomOf(name, key => open.has(key))
    expect(repo('git/h/grp/repo/main')).toBe('git/h/grp/repo')
    expect(repo('git/h/repo/main')).toBe('git/h/repo/main')
    expect(repo('git/h/grp/app')).toBe('git/h/grp/app')
    expect(repo('github.com/O/R/feature/x')).toBe('github.com/o/r')
    expect(repo('local/x/special')).toBe('local/x/special')
    expect(githubRepoOf('/github.com%2Fa%2Fb%2Fmain')).toBe('a/b')
    expect(githubRepoOf('github.com/a/b')).toBe('a/b') // no branch: still that GitHub repo
    expect(githubRepoOf('github.community/a/b/main')).toBeUndefined()
  })
})
