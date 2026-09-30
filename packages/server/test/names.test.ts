import { describe, expect, it } from 'vitest'
import { validParticipantName as sharedValidParticipantName } from '@room/shared'
import { docNameOf, roomNameOf, githubRepoOf, parseRoomName, archiveOwnerOf, validParticipantName, assertValidParticipantName } from '../src/names.js'

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
  it('never infers non-GitHub ownership from an open prefix', () => {
    // git/h/grp/repo and github.com/o/r may be open: an open prefix decides nothing, only the name's own shape.
    const repo = (name: string) => parseRoomName(name)?.repo
    expect(repo('git/h/grp/repo/main')).toBe('git/h/grp/repo/main')
    expect(repo('git/h/repo/main')).toBe('git/h/repo/main')
    expect(repo('git/h/grp/app')).toBe('git/h/grp/app')
    expect(repo('github.com/O/R/feature/x')).toBe('github.com/o/r')
    expect(repo('local/x/special')).toBe('local/x/special')
    expect(githubRepoOf('/github.com%2Fa%2Fb%2Fmain')).toBe('a/b')
    expect(githubRepoOf('github.com/a/b')).toBe('a/b') // no branch: still that GitHub repo
    expect(githubRepoOf('github.community/a/b/main')).toBeUndefined()
  })
  it.each([
    ['github.com/Owner/Repo', true, 'github.com/owner/repo'],
    ['GitHub.com/Owner/Repo', true, 'github.com/owner/repo'],
    ['github.com%2FOwner%2FRepo', true, 'github.com/owner/repo'],
    ['github.com%252FOwner%252FRepo', true, 'github.com/owner/repo'],
    ['github.com/o/r/main', false, 'github.com/o/r'],
    ['git/gitlab.example/team/repo', true, 'git/gitlab.example/team/repo'],
    ['local/room-redesign/redesign-wave0', true, 'local/room-redesign/redesign-wave0'],
    ['github.com', false, undefined],
    ['github.com/owner', false, undefined],
    ['github.com//repo', false, undefined],
    ['//github.com/o/r', false, undefined],
    ['github.com/../repo', false, undefined],
    ['github.com/o/.', false, undefined],
    ['github.com/o/r/feature', false, 'github.com/o/r'],
    ['GitHub.com/o/r2', true, 'github.com/o/r2'],
    ['git', false, undefined], ['git/host', false, undefined],
    ['git/host/repo', true, 'git/host/repo'], ['git/host:2222/repo', true, 'git/host:2222/repo'], ['git/host/a/../b', false, undefined],
    ['local', false, undefined], ['local//a', false, undefined],
    ['local/a\n', false, undefined], ['local/a%250A', false, undefined],
    ['archive:github.com/o/r:123', false, undefined],
    ['unknown/a/b', false, undefined],
    [`local/${'a'.repeat(510)}`, false, undefined],
  ] as const)('validates %j for schema 2', (name, valid, repo) => {
    expect(!!parseRoomName(name, true)).toBe(valid)
    expect(parseRoomName(name)?.repo).toBe(repo)
  })
  it('resolves an archive key to only its exact owner', () => {
    expect(archiveOwnerOf('archive:github.com/O/R:123e4567-e89b-12d3-a456-426614174000')).toBe('github.com/o/r')
    expect(archiveOwnerOf('archive:github.com/o:123e4567-e89b-12d3-a456-426614174000')).toBeUndefined()
  })
})
