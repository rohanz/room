/**
 * Areas: folders of a repo that people work in, so a room can be folder-scoped without
 * splitting the doc. They come from CODEOWNERS when the repo has one (each pattern is an
 * area named by its path prefix, with its owners); otherwise every top-level directory is
 * an area and `/` holds the root files.
 */

export interface AreaRule {
  /** The CODEOWNERS pattern as written (gitignore-like). */
  pattern: string
  /** Area name: the pattern's path prefix, e.g. "packages/server/" or "/" for root-level patterns. */
  area: string
  /** Owners as written, e.g. "@rohanz", "@org/team", "dev@example.com". */
  owners: string[]
}

/** Where GitHub looks for CODEOWNERS, in order of precedence. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']

/** Parse CODEOWNERS text into rules (comments and blank lines dropped; `\#` and `\ ` unescaped). */
export function parseCodeowners(text: string): AreaRule[] {
  const rules: AreaRule[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const tokens = splitLine(line)
    if (!tokens.length) continue
    const [pattern, ...owners] = tokens
    rules.push({ pattern, area: areaNameOf(pattern), owners })
  }
  return rules
}

/** Tokens separated by unescaped whitespace; `\ ` and `\#` become literal characters. */
function splitLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; continue }
    if (ch === ' ' || ch === '\t') { if (cur) { out.push(cur); cur = '' }; continue }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** The literal path prefix of a pattern: everything before the first wildcard segment, as a directory ("/" when none). */
export function areaNameOf(pattern: string): string {
  const segs = pattern.replace(/^\//, '').split('/')
  const lit: string[] = []
  for (const seg of segs) {
    if (seg === '' || /[*?[\]]/.test(seg)) break
    lit.push(seg)
  }
  if (!lit.length) return '/'
  const last = segs[lit.length - 1]
  const isFile = lit.length === segs.length && !pattern.endsWith('/') && /\.[^/]+$/.test(last)
  return isFile ? lit.join('/') : `${lit.join('/')}/`
}

/** gitignore-style pattern -> regex over a repo-relative path. A match on a directory covers everything under it. */
export function patternToRegExp(pattern: string): RegExp {
  let p = pattern
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.slice(0, -1)
  const anchored = p.startsWith('/') || p.includes('/')
  if (p.startsWith('/')) p = p.slice(1)
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    if (ch === '*') {
      if (p[i + 1] === '*') {
        i++
        if (p[i + 1] === '/') { i++; re += '(?:.*/)?' } // "a/**/b": zero or more directories
        else re += '.*'
      } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += `\\${ch}`
    else re += ch
  }
  // Anchored patterns match from the root; bare names match at any depth (like CODEOWNERS/gitignore).
  const head = anchored ? '^' : '^(?:.*/)?'
  // Whatever matched is either the whole path or a directory prefix of it.
  return new RegExp(`${head}${re}(?:/.*)?$`)
}

export class Areas {
  readonly rules: readonly AreaRule[]
  private readonly res: RegExp[]
  /** 'codeowners' when built from a CODEOWNERS file; 'toplevel' when areas are top-level directories. */
  readonly source: 'codeowners' | 'toplevel'

  constructor(rules: AreaRule[] = []) {
    this.rules = rules
    this.res = rules.map(r => patternToRegExp(r.pattern))
    this.source = rules.length ? 'codeowners' : 'toplevel'
  }

  static fromCodeowners(text: string): Areas { return new Areas(parseCodeowners(text)) }
  static topLevel(): Areas { return new Areas([]) }

  /** Names of every declared area (top-level mode: derived per path, so none declared). */
  get areas(): string[] { return Array.from(new Set(this.rules.map(r => r.area))).sort() }

  /** The area a path belongs to: the longest matching pattern (later wins on ties); top-level dir without CODEOWNERS. */
  areaOf(path: string): string {
    const p = path.replace(/^\.?\//, '')
    if (this.source === 'codeowners') {
      let best: AreaRule | undefined
      for (let i = 0; i < this.rules.length; i++) {
        if (!this.res[i].test(p)) continue
        if (!best || this.rules[i].pattern.length >= best.pattern.length) best = this.rules[i]
      }
      if (best) return best.area
      return topLevelArea(p) // unowned paths still land somewhere sensible
    }
    return topLevelArea(p)
  }

  areasOf(paths: readonly string[]): string[] {
    return Array.from(new Set(paths.map(p => this.areaOf(p)))).sort()
  }

  /** Owners declared for an area (union over its patterns). Empty without CODEOWNERS. */
  ownersOf(area: string): string[] {
    const out = new Set<string>()
    for (const r of this.rules) if (r.area === area) for (const o of r.owners) out.add(o)
    return Array.from(out)
  }

  /** Does `login` own the area? Matches "@login" case-insensitively; team and email owners never match a login. */
  owns(login: string, area: string): boolean {
    const me = `@${login.toLowerCase()}`
    return this.ownersOf(area).some(o => o.toLowerCase() === me)
  }
}

export function topLevelArea(path: string): string {
  const i = path.indexOf('/')
  return i < 0 ? '/' : `${path.slice(0, i)}/`
}

/** Do two area lists share an area? Empty lists (no scope, no changes yet) count as "everywhere". */
export function sharesArea(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a?.length || !b?.length) return true
  return a.some(x => b.includes(x))
}
