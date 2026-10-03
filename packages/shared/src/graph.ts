/**
 * Symbol graph: which files define which symbols, and which files reference them.
 * The shape that recent code-graph tools for agents converge on (tree-sitter tag
 * maps: definitions + references per file), reduced to what coordination needs.
 *
 * The index is derived, never stored in the room doc. Each MCP process builds it from
 * the base commit plus everyone's overlays and refreshes one file at a time.
 */

import type { FileParser, ParsedDef } from './parsed.js'

export interface FileSymbols { defs: string[]; refs: string[]; imports?: string[] }
export type ObservedContractKind = 'signature' | 'delete' | 'add'
export interface ObservedContractChange { path: string; symbol: string; kind: ObservedContractKind; detail: string }
/** Read-only browser projection, published by each participant's local indexer. */
export interface GraphSnapshot {
  version: 1
  base: string
  /** Manifest incarnation that authorized this derived content. */
  sourceFence?: string
  sourceRev?: number
  at: number
  status: 'ready' | 'indexing' | 'error'
  paths: string[]
  /** Direction: definition/provider -> consumer. Names are inferred, not resolved imports. */
  edges: { source: string; target: string; symbols: string[] }[]
  /** Contract-level changes inferred from this participant's overlay. */
  observed?: ObservedContractChange[]
  observedTruncated?: boolean
  truncated: boolean
}
export type Extractor = (path: string, text: string) => FileSymbols | undefined

const WORD = /[A-Za-z_][A-Za-z0-9_]*/g
const PY_DEF = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm
const PY_ASSIGN = /^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/gm
const JS_DEF = /\b(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)|\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g
const KEYWORDS = new Set(('def class return if else elif for while in not and or import from as with try except finally raise pass break continue lambda yield await async None True False self cls ' +
  'function const let var new this export default import from return if else for while do switch case break continue typeof instanceof void null undefined true false async await class extends super interface type enum implements').split(' '))

/** Regex extractor: good enough for Python, JS and TS; a real parser can replace it per language. */
export const regexExtractor: Extractor = (path, text) => {
  const ext = path.slice(path.lastIndexOf('.') + 1)
  const defs = new Set<string>()
  if (ext === 'py') {
    for (const m of text.matchAll(PY_DEF)) defs.add(m[1])
    for (const m of text.matchAll(PY_ASSIGN)) defs.add(m[1])
  } else if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'mts', 'cjs'].includes(ext)) {
    for (const m of text.matchAll(JS_DEF)) defs.add(m[1] ?? m[2])
  } else return undefined
  const refs = new Set<string>()
  for (const m of text.matchAll(WORD)) {
    const w = m[0]
    if (w.length < 3 || KEYWORDS.has(w) || defs.has(w)) continue
    refs.add(w)
  }
  return { defs: Array.from(defs), refs: Array.from(refs) }
}

export const bareSymbol = (symbol: string): string => symbol.trim().split(/[.:]+/).filter(Boolean).at(-1)?.toLowerCase() ?? ''

interface DefinitionLine { display: string; canonical: string }

function whitespaceOutsideLiterals(text: string, separator: string): string {
  let out = '', quote = '', escaped = false, pending = false
  for (const ch of text.trim()) {
    if (quote) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'" || ch === '`') {
      if (pending && out) out += separator
      pending = false; quote = ch; out += ch
    } else if (/\s/.test(ch)) pending = true
    else {
      if (pending && out) out += separator
      pending = false; out += ch
    }
  }
  return out
}

const normalized = (line: string) => whitespaceOutsideLiterals(line, ' ')
const comparable = (line: string) => whitespaceOutsideLiterals(line, '')
const lineContaining = (text: string, index: number) => {
  const from = text.lastIndexOf('\n', index - 1) + 1
  const to = text.indexOf('\n', index)
  return text.slice(from, to < 0 ? text.length : to)
}

function pythonHeader(line: string): string {
  let depth = 0, quote = '', escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1)
    else if (ch === ':' && depth === 0) return line.slice(0, i + 1)
  }
  return line
}

const definitionName = (definition: ParsedDef): string => definition.container ? `${definition.container}.${definition.name}` : definition.name

function definitionLines(path: string, text: string, parse?: FileParser): Map<string, DefinitionLine[]> | undefined {
  const parsed = parse?.(path, text)
  if (parsed) {
    const out = new Map<string, DefinitionLine[]>()
    for (const definition of parsed.defs) {
      const name = definitionName(definition)
      const display = normalized(definition.signature)
      const lines = out.get(name) ?? []
      const line = { display, canonical: comparable(display) }
      if (!lines.some(existing => existing.canonical === line.canonical)) lines.push(line)
      out.set(name, lines)
    }
    return out
  }
  const ext = path.slice(path.lastIndexOf('.') + 1)
  const out = new Map<string, DefinitionLine[]>()
  const add = (name: string, raw: string, signature = raw) => {
    const display = normalized(raw)
    const lines = out.get(name) ?? []
    const line = { display, canonical: comparable(normalized(signature)) }
    if (!lines.some(existing => existing.canonical === line.canonical)) lines.push(line)
    out.set(name, lines)
  }
  if (ext === 'py') {
    for (const match of text.matchAll(PY_DEF)) {
      const nameIndex = match.index! + match[0].lastIndexOf(match[1])
      add(match[1], pythonHeader(lineContaining(text, nameIndex)))
    }
    for (const match of text.matchAll(PY_ASSIGN)) {
      const line = lineContaining(text, match.index!)
      add(match[1], line.slice(0, line.indexOf('=') + 1))
    }
  } else if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'mts', 'cjs'].includes(ext)) {
    for (const match of text.matchAll(JS_DEF)) {
      const name = match[1] ?? match[2]
      const line = lineContaining(text, match.index!)
      let signature = line
      const declaration = match[0]
      if (/\b(?:const|let|var)\b/.test(declaration)) {
        const arrow = line.indexOf('=>')
        const equals = line.indexOf('=')
        signature = arrow >= 0 ? line.slice(0, arrow + 2) : line.slice(0, equals + 1)
      } else if (/\b(?:function\*?|class|interface|enum)\b/.test(declaration)) {
        const brace = line.indexOf('{')
        if (brace >= 0) signature = line.slice(0, brace)
      }
      add(name, line, signature)
    }
  } else return undefined
  return out
}

/** Definition-line changes inferred from an overlay; ordinary body edits are intentionally ignored. */
export function observedContractChanges(baseText: string, overlayText: string, path: string, parse?: FileParser): Omit<ObservedContractChange, 'path'>[] {
  const before = definitionLines(path, baseText, parse), after = definitionLines(path, overlayText, parse)
  if (!before || !after) return []
  const changes: Omit<ObservedContractChange, 'path'>[] = []
  const signatureSet = (lines: DefinitionLine[]) => lines.map(line => line.canonical).sort().join('\0')
  const displaySet = (lines: DefinitionLine[]) => lines.map(line => line.display).sort().join(' | ')
  for (const [symbol, oldLines] of before) {
    const newLines = after.get(symbol)
    if (!newLines) changes.push({ symbol, kind: 'delete', detail: `was \`${displaySet(oldLines)}\`` })
    else if (signatureSet(oldLines) !== signatureSet(newLines)) changes.push({ symbol, kind: 'signature', detail: `was \`${displaySet(oldLines)}\` now \`${displaySet(newLines)}\`` })
  }
  for (const [symbol, newLines] of after) if (!before.has(symbol)) changes.push({ symbol, kind: 'add', detail: `now \`${displaySet(newLines)}\`` })
  return changes.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.kind.localeCompare(b.kind))
}

export interface Impact {
  symbol: string
  definedIn: string[]
  usedIn: string[]
}

/** Symbols defined in more files than this are treated as noise for parsed inputs. */
export const COMMON_SYMBOL_FILE_THRESHOLD = 5

export class SymbolGraph {
  private files = new Map<string, FileSymbols>()
  private definers = new Map<string, Set<string>>()
  private users = new Map<string, Set<string>>()
  private modules = new Map<string, Set<string>>()
  private basenames = new Map<string, Set<string>>()
  private goPackages = new Map<string, Set<string>>()
  private providers = new Map<string, { modules: string[]; goPackage?: string }>()
  private imports = new Map<string, PreparedImport[]>()
  constructor(private extract: Extractor = regexExtractor) {}

  get size(): number { return this.files.size }
  has(path: string): boolean { return this.files.has(path) }

  /** Index or re-index one file. Returns false when the extractor does not handle it. */
  set(path: string, text: string): boolean {
    this.remove(path)
    const syms = this.extract(path, text)
    if (!syms) return false
    this.files.set(path, syms)
    const provider = providerPaths(path)
    this.providers.set(path, provider)
    for (const module of provider.modules) { add(this.modules, module, path); add(this.basenames, basenameOf(module), path) }
    if (provider.goPackage !== undefined) add(this.goPackages, provider.goPackage, path)
    if (syms.imports !== undefined) this.imports.set(path, syms.imports.map(value => prepareImport(value, path)))
    for (const d of syms.defs) add(this.definers, d, path)
    for (const r of syms.refs) add(this.users, r, path)
    return true
  }

  remove(path: string): void {
    const prev = this.files.get(path)
    if (!prev) return
    for (const d of prev.defs) del(this.definers, d, path)
    for (const r of prev.refs) del(this.users, r, path)
    this.files.delete(path)
    const provider = this.providers.get(path)
    for (const module of provider?.modules ?? []) { del(this.modules, module, path); del(this.basenames, basenameOf(module), path) }
    if (provider?.goPackage !== undefined) del(this.goPackages, provider.goPackage, path)
    this.providers.delete(path)
    this.imports.delete(path)
  }

  symbolsOf(path: string): FileSymbols | undefined { return this.files.get(path) }
  definersOf(symbol: string): string[] { return Array.from(this.definers.get(symbol) ?? []).sort() }
  /** Files that reference a symbol defined elsewhere (a definer that also references itself is excluded). */
  usersOf(symbol: string): string[] {
    const defs = this.definers.get(symbol) ?? new Set()
    // A name nobody defines yet (a rename in flight) still reports its users, as before.
    return Array.from(this.users.get(symbol) ?? [])
      .filter(path => !defs.has(path) && (defs.size === 0 || this.resolvedDefiners(symbol, path).length > 0))
      .sort()
  }
  /** Symbols a file uses that some other file defines. */
  dependenciesOf(path: string): Impact[] {
    const syms = this.files.get(path)
    if (!syms) return []
    const out: Impact[] = []
    for (const r of syms.refs) {
      const definedIn = this.resolvedDefiners(r, path)
      if (definedIn.length) out.push({ symbol: r, definedIn, usedIn: [path] })
    }
    return out.sort((a, b) => a.symbol.localeCompare(b.symbol))
  }
  /** Symbols a file defines and the other files that use them. */
  dependentsOf(path: string): Impact[] {
    const syms = this.files.get(path)
    if (!syms) return []
    const out: Impact[] = []
    for (const d of syms.defs) {
      const usedIn = Array.from(this.users.get(d) ?? [])
        .filter(consumer => consumer !== path && this.resolvedDefiners(d, consumer).includes(path))
        .sort()
      if (usedIn.length) out.push({ symbol: d, definedIn: [path], usedIn })
    }
    return out.sort((a, b) => b.usedIn.length - a.usedIn.length || a.symbol.localeCompare(b.symbol))
  }
  impact(symbol: string): Impact { return { symbol, definedIn: this.definersOf(symbol), usedIn: this.usersOf(symbol) } }

  private resolvedDefiners(symbol: string, consumer: string): string[] {
    const candidates = this.definers.get(symbol)
    if (!candidates?.size) return []
    const imports = this.imports.get(consumer)
    // Regex inputs have no import facts. Preserve their name-only graph.
    if (imports === undefined) return [...candidates].filter(path => path !== consumer).sort()
    const scores = new Map<string, number>()
    let best = 0
    const consider = (paths: Set<string> | undefined, score: number) => {
      for (const path of paths ?? []) if (path !== consumer && candidates.has(path)) {
        if (score > (scores.get(path) ?? 0)) scores.set(path, score)
        if (score > best) best = score
      }
    }
    const lower = symbol.toLowerCase()
    for (const imported of imports) {
      const value = imported.symbol === lower ? imported.withoutSymbol! : imported.path
      if (value.relative) { consider(this.modules.get(value.direct), 3); continue }
      consider(this.modules.get(value.direct), value.pathSpecific ? 3 : 1)
      // A qualified import can end with a provider's module path. Index lookups
      // replace the old candidate × import cross-product and repeated normalization.
      for (let slash = value.direct.indexOf('/'); slash >= 0; slash = value.direct.indexOf('/', slash + 1))
        consider(this.modules.get(value.direct.slice(slash + 1)), 2)
      consider(this.goPackages.get(basenameOf(value.direct)), 1)
      if (!value.direct.includes('/')) consider(this.basenames.get(value.direct), 1)
    }
    if (best) return [...scores].filter(([, score]) => score === best).map(([path]) => path).sort()
    return candidates.size > COMMON_SYMBOL_FILE_THRESHOLD ? [] : [...candidates].filter(path => path !== consumer).sort()
  }
}

function normalizedPath(value: string): string {
  const parts: string[] = []
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/').toLowerCase()
}

const withoutExtension = (value: string): string => value.replace(/\.[a-z0-9]+$/i, '')
const directoryOf = (value: string): string => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : ''
const basenameOf = (value: string): string => value.slice(value.lastIndexOf('/') + 1)

function providerPaths(path: string): { modules: string[]; goPackage?: string } {
  const provider = normalizedPath(path), module = withoutExtension(provider), dir = directoryOf(provider)
  const stem = basenameOf(module)
  const modules = [...new Set([...(stem === 'mod' || stem === 'index' ? [] : [module]), dir].filter(Boolean))]
  return { modules, ...(provider.endsWith('.go') ? { goPackage: basenameOf(dir) } : {}) }
}

interface ImportPath { direct: string; relative: boolean; pathSpecific: boolean }
interface PreparedImport { path: ImportPath; symbol?: string; withoutSymbol?: ImportPath }
function prepareImport(value: string, consumer: string): PreparedImport {
  const raw = value.trim().replace(/^['"]|['"]$/g, '').toLowerCase()
  const python = raw.match(/\bfrom\s+([.a-z0-9_$\-/]+)\s+import\b/)?.[1]
  const imported = python ?? raw.replace(/^use\s+/, '').replace(/;$/, '').replace(/::/g, '/')
  const compile = (input: string): ImportPath => {
    input = input.replace(/^(?:crate|self)\//, '')
    if (input.startsWith('.')) {
      const relative = input.startsWith('./') || input.startsWith('../') ? input
        : input.replace(/^(\.+)/, dots => '../'.repeat(Math.max(0, dots.length - 1)) + './')
      return { direct: withoutExtension(normalizedPath(directoryOf(normalizedPath(consumer)) + '/' + relative)), relative: true, pathSpecific: true }
    }
    return { direct: withoutExtension(normalizedPath(input)), relative: false, pathSpecific: /[\\/]/.test(input) || /\.[a-z0-9]+$/i.test(input) }
  }
  const slash = imported.lastIndexOf('/')
  return { path: compile(imported), ...(slash >= 0 ? { symbol: imported.slice(slash + 1), withoutSymbol: compile(imported.slice(0, slash)) } : {}) }
}

function add(m: Map<string, Set<string>>, k: string, v: string) { let s = m.get(k); if (!s) { s = new Set(); m.set(k, s) } s.add(v) }
function del(m: Map<string, Set<string>>, k: string, v: string) { const s = m.get(k); if (!s) return; s.delete(v); if (!s.size) m.delete(k) }

/**
 * 1-based inclusive line range of a top-level or nested definition named `symbol`, or
 * undefined. Python: the def/class line through the last line indented deeper than it.
 * JS/TS: the declaration line through its matching closing brace.
 */
export function symbolRange(path: string, text: string, symbol: string, parse?: FileParser): { from: number; to: number } | undefined {
  const parsed = parse?.(path, text)
  if (parsed) {
    const definition = parsed.defs.find(candidate => candidate.name === symbol || definitionName(candidate) === symbol)
    return definition ? { from: definition.from, to: definition.to } : undefined
  }
  const lines = text.split('\n')
  const ext = path.slice(path.lastIndexOf('.') + 1)
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (ext === 'py') {
    const re = new RegExp(`^(\\s*)(?:async\\s+)?(?:def|class)\\s+${esc}\\b`)
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re)
      if (!m) continue
      const indent = m[1].length
      let end = i
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() === '') continue
        const ind = l.length - l.trimStart().length
        if (ind <= indent) break
        end = j
      }
      return { from: i + 1, to: end + 1 }
    }
    const assign = new RegExp(`^${esc}\\s*(?::[^=]+)?=`)
    for (let i = 0; i < lines.length; i++) if (assign.test(lines[i])) return { from: i + 1, to: i + 1 }
    return undefined
  }
  const re = new RegExp(`\\b(?:function\\*?|class|interface|type|enum|const|let|var)\\s+${esc}\\b`)
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue
    let depth = 0, seen = false
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) { if (ch === '{') { depth++; seen = true } else if (ch === '}') depth-- }
      if (seen && depth <= 0) return { from: i + 1, to: j + 1 }
      if (!seen && j > i && /;\s*$/.test(lines[j])) return { from: i + 1, to: j + 1 }
    }
    return { from: i + 1, to: i + 1 }
  }
  return undefined
}
