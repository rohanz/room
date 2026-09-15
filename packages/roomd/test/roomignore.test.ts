import { describe, expect, it } from 'vitest'
import { parseRoomIgnore } from '../src/roomignore.js'
import { DEFAULT_IGNORED_DIRS, defaultIgnoredPath } from '../src/index.js'

describe('.roomignore', () => {
  const ig = parseRoomIgnore(`
# comments and blanks are skipped
*.snap
fixtures/
/generated
docs/**/*.pdf
!fixtures/keep.txt
data?.csv
`)
  it('matches gitignore-style patterns', () => {
    expect(ig.patterns).toBe(6)
    expect(ig.ignores('a.snap')).toBe(true)
    expect(ig.ignores('deep/dir/b.snap')).toBe(true)
    expect(ig.ignores('fixtures/x.json')).toBe(true)
    expect(ig.ignores('pkg/fixtures/x.json')).toBe(true)
    expect(ig.ignores('fixtures')).toBe(false)
    expect(ig.ignores('generated/out.ts')).toBe(true)
    expect(ig.ignores('pkg/generated/out.ts')).toBe(false)
    expect(ig.ignores('docs/a/b/c.pdf')).toBe(true)
    expect(ig.ignores('docs/c.pdf')).toBe(true)
    expect(ig.ignores('docs/c.md')).toBe(false)
    expect(ig.ignores('data1.csv')).toBe(true)
    expect(ig.ignores('data12.csv')).toBe(false)
  })
  it('honours negation in order', () => {
    expect(ig.ignores('fixtures/keep.txt')).toBe(false)
  })
  it('an empty file ignores nothing', () => {
    expect(parseRoomIgnore('').ignores('anything.ts')).toBe(false)
  })

  it('ignores dependency, VCS, build, framework, and coverage directories by default', () => {
    expect(Array.from(DEFAULT_IGNORED_DIRS).sort()).toEqual([
      '.git', '.next', '.room', '.venv', 'build', 'coverage', 'dist', 'node_modules', 'target',
    ])
    for (const dir of DEFAULT_IGNORED_DIRS) expect(defaultIgnoredPath(`pkg/${dir}/file.js`)).toBe(true)
    expect(defaultIgnoredPath('src/building/file.ts')).toBe(false)
  })
})
