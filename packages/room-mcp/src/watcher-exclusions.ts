/** Warn when a root watcher configuration excludes Room's nested worker worktrees. */
import fs from 'node:fs'
import path from 'node:path'

const MAX_CONFIG_BYTES = 64 * 1024
// Only a whole path component is evidence of the worker directory. In particular,
// `.room-cache` and `.roomy` do not exclude `.room`.
const ROOM_TOKEN = /(?:^|[\\/'"`])\.room(?=$|[\\/'"`])/

function readSmallFile(root: string, name: string): string | undefined {
  try {
    const file = path.join(root, name)
    const stat = fs.statSync(file)
    return stat.isFile() && stat.size <= MAX_CONFIG_BYTES ? fs.readFileSync(file, 'utf8') : undefined
  } catch { return undefined }
}

/** Remove JS comments while leaving strings, templates, and regex literals intact. */
function stripComments(source: string): string {
  let result = ''
  let quote = ''
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (quote) {
      result += c
      if (c === '\\') result += source[++i] ?? ''
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c
      result += c
    } else if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      const line = source[++i] === '/'
      result += '  '
      while (++i < source.length) {
        if (line && source[i] === '\n') { i--; break }
        if (!line && source[i] === '*' && source[i + 1] === '/') { result += '  '; i++; break }
        result += source[i] === '\n' ? '\n' : ' '
      }
    } else if (c === '/') {
      let j = result.length - 1
      while (j >= 0 && /\s/.test(result[j])) j--
      let wordStart = j
      while (wordStart >= 0 && /[\w$]/.test(result[wordStart])) wordStart--
      const regexStart = j < 0 || '(,=:[!&|?{};+-*%<>~^'.includes(result[j])
        || /^(return|typeof|case)$/.test(result.slice(wordStart + 1, j + 1))
      result += c
      if (!regexStart) continue
      let inClass = false
      while (++i < source.length) {
        const next = source[i]
        result += next
        if (next === '\n') break // a regex literal never spans lines
        if (next === '\\') result += source[++i] ?? ''
        else if (next === '[') inClass = true
        else if (next === ']') inClass = false
        else if (next === '/' && !inClass) break
      }
      while (/[a-z]/i.test(source[i + 1] ?? '')) result += source[++i]
    } else result += c
  }
  return result
}

/** Text-level property extraction; check all candidates without evaluating configs. */
function propertyValues(source: string, key: string): string[] {
  const values: string[] = []
  const matches = source.matchAll(new RegExp(`\\b(?:["']?${key}["']?)\\s*:`, 'g'))
  for (const match of matches) {
    const value = propertyValueAt(source, match.index + match[0].length)
    if (value !== undefined) values.push(value)
  }
  return values
}

function propertyValueAt(source: string, start: number): string | undefined {
  let i = start
  while (/\s/.test(source[i] ?? '') && i < source.length) i++
  const opener = source[i]
  const closer = opener === '[' ? ']' : opener === '{' ? '}' : undefined
  if (!closer) {
    let quote = ''
    for (let j = i; j < source.length; j++) {
      const c = source[j]
      if (quote) {
        if (c === '\\') { j++; continue }
        if (c === quote) return source.slice(i, j + 1)
      } else if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === ',' || c === '}' || c === '\n') return source.slice(i, j)
    }
    return source.slice(i)
  }
  const stack = [closer]
  let quote = ''
  for (let j = i + 1; j < source.length; j++) {
    const c = source[j]
    if (quote) {
      if (c === '\\') { j++; continue }
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'" || c === '`') quote = c
    else if (c === '[' || c === '{') stack.push(c === '[' ? ']' : '}')
    else if (c === ']' || c === '}') {
      if (stack.pop() !== c) return undefined
      if (!stack.length) return source.slice(i, j + 1)
    }
  }
  return undefined
}

function excludesRoom(name: string, source: string): boolean {
  source = stripComments(source)
  if (!ROOM_TOKEN.test(source)) return false
  const nested = (keys: string[]) => {
    let values = [source]
    for (const key of keys) values = values.flatMap(value => propertyValues(value, key))
    return values.some(value => ROOM_TOKEN.test(value))
  }
  if (name.startsWith('vite.config.')) return nested(['server', 'watch', 'ignored'])
  if (name.startsWith('webpack.config.')) return nested(['watchOptions', 'ignored'])
  if (name === 'nodemon.json') return nested(['ignore'])
  if (name === 'package.json') return nested(['nodemonConfig', 'ignore'])
  if (name === 'tsconfig.json') return nested(['watchOptions', 'excludeDirectories']) || nested(['watchOptions', 'excludeFiles'])
  if (name === '.watchmanconfig') return nested(['ignore_dirs'])
  return false
}

/** Reads only small root config files. Missing, malformed, or unreadable files never block spawn. */
export function watcherExclusionWarning(repoRoot: string): string | undefined {
  let entries: Set<string>
  try { entries = new Set(fs.readdirSync(repoRoot)) }
  catch { return undefined }
  const vite = ['js', 'ts', 'mjs', 'mts', 'cjs'].map(ext => `vite.config.${ext}`)
  const webpack = [...entries].filter(name => /^webpack\.config\.[^/]+$/.test(name)).sort().slice(0, 16)
  for (const name of [...vite, ...webpack, 'nodemon.json', 'package.json', 'tsconfig.json', '.watchmanconfig']) {
    if (!entries.has(name)) continue
    const source = readSmallFile(repoRoot, name)
    if (source && excludesRoom(name, source)) {
      return `warning: ${name} appears to ignore .room: a dev server started inside the worker's worktree may not see its changes; run it with a config that watches .room.`
    }
  }
  return undefined
}
