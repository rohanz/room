import { describe, it, expect } from 'vitest'
import { Areas, areaNameOf, parseCodeowners, patternToRegExp, sharesArea } from './areas.js'

const CODEOWNERS = `
# comment
*                 @rohanz
*.md              @docs-team
/docs/            @rohanz @kieran
packages/server/  @rohanz
packages/server/src/auth.ts @kieran
apps/**/*.ts      @kieran
build/            @ci-bot
/README.md        @rohanz
`

describe('parseCodeowners', () => {
  it('drops comments and blank lines, keeps owners in order, names areas by prefix', () => {
    const rules = parseCodeowners(CODEOWNERS)
    expect(rules.map(r => r.pattern)).toEqual(['*', '*.md', '/docs/', 'packages/server/', 'packages/server/src/auth.ts', 'apps/**/*.ts', 'build/', '/README.md'])
    expect(rules[2]).toEqual({ pattern: '/docs/', area: 'docs/', owners: ['@rohanz', '@kieran'] })
    expect(rules[5].area).toBe('apps/')
  })
  it('unescapes spaces and hashes in patterns', () => {
    expect(parseCodeowners('my\\ dir/ @a\nfoo\\#bar @b')).toEqual([
      { pattern: 'my dir/', area: 'my dir/', owners: ['@a'] },
      { pattern: 'foo#bar', area: 'foo#bar/', owners: ['@b'] },
    ])
  })
})

describe('areaNameOf', () => {
  it('is the literal prefix as a directory, "/" when the pattern starts with a wildcard, the file itself for exact files', () => {
    expect(areaNameOf('*')).toBe('/')
    expect(areaNameOf('*.md')).toBe('/')
    expect(areaNameOf('/docs/')).toBe('docs/')
    expect(areaNameOf('packages/server/')).toBe('packages/server/')
    expect(areaNameOf('packages/server/**')).toBe('packages/server/')
    expect(areaNameOf('apps/**/*.ts')).toBe('apps/')
    expect(areaNameOf('/README.md')).toBe('README.md')
    expect(areaNameOf('packages/server/src/auth.ts')).toBe('packages/server/src/auth.ts')
  })
})

describe('patternToRegExp', () => {
  const m = (pattern: string, path: string) => patternToRegExp(pattern).test(path)
  it('matches bare names at any depth and slashed patterns from the root', () => {
    expect(m('*.md', 'README.md')).toBe(true)
    expect(m('*.md', 'docs/guide/x.md')).toBe(true)
    expect(m('build/', 'build/a')).toBe(true)
    expect(m('build/', 'x/build/a')).toBe(true)
    expect(m('/build/', 'x/build/a')).toBe(false)
    expect(m('docs/*', 'docs/a.md')).toBe(true)
    expect(m('docs/*', 'docs/sub/a.md')).toBe(true) // docs/sub matches, and a match on a directory covers its contents
    expect(m('docs/*', 'x/docs/a.md')).toBe(false)
  })
  it('handles ** and ?', () => {
    expect(m('apps/**/*.ts', 'apps/x.ts')).toBe(true)
    expect(m('apps/**/*.ts', 'apps/a/b/x.ts')).toBe(true)
    expect(m('apps/**/*.ts', 'apps/a/b/x.js')).toBe(false)
    expect(m('a/**', 'a/b/c')).toBe(true)
    expect(m('a?c', 'abc')).toBe(true)
    expect(m('a?c', 'a/c')).toBe(false)
  })
})

describe('Areas from CODEOWNERS', () => {
  const areas = Areas.fromCodeowners(CODEOWNERS)
  it('picks the longest matching pattern', () => {
    expect(areas.areaOf('packages/server/src/index.ts')).toBe('packages/server/')
    expect(areas.areaOf('packages/server/src/auth.ts')).toBe('packages/server/src/auth.ts')
    expect(areas.areaOf('docs/guide.md')).toBe('docs/')
    expect(areas.areaOf('apps/web/main.ts')).toBe('apps/')
    expect(areas.areaOf('README.md')).toBe('README.md')
    expect(areas.areaOf('package.json')).toBe('/')
    expect(areas.areaOf('./package.json')).toBe('/')
  })
  it('lists areas, owners, and answers ownership by login', () => {
    expect(areas.areas).toEqual(['/', 'README.md', 'apps/', 'build/', 'docs/', 'packages/server/', 'packages/server/src/auth.ts'])
    expect(areas.ownersOf('docs/')).toEqual(['@rohanz', '@kieran'])
    expect(areas.ownersOf('/')).toEqual(['@rohanz', '@docs-team'])
    expect(areas.owns('Kieran', 'docs/')).toBe(true)
    expect(areas.owns('kieran', 'packages/server/')).toBe(false)
    expect(areas.ownersOf('nope/')).toEqual([])
  })
  it('areasOf dedupes and sorts', () => {
    expect(areas.areasOf(['docs/a.md', 'docs/b.md', 'packages/server/x.ts'])).toEqual(['docs/', 'packages/server/'])
  })
  it('falls back to the top-level dir for a path no pattern covers', () => {
    const a = Areas.fromCodeowners('docs/ @x')
    expect(a.areaOf('packages/web/main.ts')).toBe('packages/')
    expect(a.source).toBe('codeowners')
  })
})

describe('Areas without CODEOWNERS', () => {
  const areas = Areas.topLevel()
  it('uses top-level directories and "/" for root files', () => {
    expect(areas.source).toBe('toplevel')
    expect(areas.areaOf('packages/server/src/index.ts')).toBe('packages/')
    expect(areas.areaOf('README.md')).toBe('/')
    expect(areas.areasOf(['a/b', 'a/c', 'x', 'b/z'])).toEqual(['/', 'a/', 'b/'])
    expect(areas.ownersOf('a/')).toEqual([])
    expect(areas.areas).toEqual([])
  })
})

describe('sharesArea', () => {
  it('is true on overlap or when either side has no areas yet', () => {
    expect(sharesArea(['a/'], ['a/', 'b/'])).toBe(true)
    expect(sharesArea(['a/'], ['b/'])).toBe(false)
    expect(sharesArea([], ['b/'])).toBe(true)
    expect(sharesArea(undefined, ['b/'])).toBe(true)
  })
})
