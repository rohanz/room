/**
 * `.roomignore` at the clone root: gitignore-style patterns for files that are tracked in git
 * but should never be shared with the room (fixtures, generated code, large data). Applied on
 * top of gitignore. Supported: `#` comments, `!` negation, `*`, `**`, `?`, a leading `/` to
 * anchor at the root, a trailing `/` to match directories, and patterns without `/` matching at
 * any depth.
 */
export interface RoomIgnore { ignores(relpath: string): boolean; readonly patterns: number }

export function parseRoomIgnore(text: string): RoomIgnore {
  const rules: { re: RegExp; negate: boolean }[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line || line.startsWith('#')) continue
    const negate = line.startsWith('!')
    let pat = negate ? line.slice(1) : line
    const dirOnly = pat.endsWith('/')
    if (dirOnly) pat = pat.slice(0, -1)
    const anchored = pat.startsWith('/') || pat.slice(0, -1).includes('/')
    if (pat.startsWith('/')) pat = pat.slice(1)
    let re = ''
    for (let i = 0; i < pat.length; i++) {
      const c = pat[i]
      if (c === '*' && pat[i + 1] === '*') {
        const slash = pat[i + 2] === '/'
        re += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else if (c === '*') re += '[^/]*'
      else if (c === '?') re += '[^/]'
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    const prefix = anchored ? '^' : '^(?:.*/)?'
    // A directory pattern matches everything beneath it; a file pattern also matches a directory of that name.
    rules.push({ re: new RegExp(`${prefix}${re}${dirOnly ? '/.+' : '(?:/.*)?'}$`), negate })
  }
  return {
    patterns: rules.length,
    ignores(relpath: string): boolean {
      let ignored = false
      for (const r of rules) if (r.re.test(relpath)) ignored = !r.negate
      return ignored
    },
  }
}
