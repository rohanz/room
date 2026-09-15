import { describe, expect, it } from 'vitest'
import { docNameOf, roomNameOf, repoOf, githubRepoOf } from '../src/names.js'

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
  })
})
