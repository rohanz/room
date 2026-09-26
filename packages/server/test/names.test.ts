import { describe, expect, it } from 'vitest'
import { validParticipantName as sharedValidParticipantName } from '@room/shared'
import { docNameOf, roomNameOf, repoOf, githubRepoOf, validParticipantName, assertValidParticipantName } from '../src/names.js'

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
  it('repoOf and githubRepoOf agree on the repo segment', () => {
    expect(repoOf('github.com/a/b/feature/x')).toBe('github.com/a/b')
    expect(repoOf('local/dir/main')).toBe('local/dir')
    expect(githubRepoOf('/github.com%2Fa%2Fb%2Fmain')).toBe('a/b')
    expect(githubRepoOf('github.com/a/b')).toBe('a/b') // no branch: still that GitHub repo
    expect(githubRepoOf('github.community/a/b/main')).toBeUndefined()
  })
})
