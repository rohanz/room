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

const normalized = (line: string) => line.trim().replace(/\s+/g, ' ')
const comparable = (line: string) => line.replace(/\s+/g, '')
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

function definitionLines(path: string, text: string, parse?: FileParser): Map<string, DefinitionLine> | undefined {
  const parsed = parse?.(path, text)
  if (parsed) {
    const out = new Map<string, DefinitionLine>()
    for (const definition of parsed.defs) {
      const name = definitionName(definition)
      const display = normalized(definition.signature)
      if (!out.has(name)) out.set(name, { display, canonical: comparable(display) })
    }
    return out
  }
  const ext = path.slice(path.lastIndexOf('.') + 1)
  const out = new Map<string, DefinitionLine>()
  const add = (name: string, raw: string, signature = raw) => {
    const display = normalized(raw)
    if (!out.has(name)) out.set(name, { display, canonical: comparable(normalized(signature)) })
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
  for (const [symbol, oldLine] of before) {
    const newLine = after.get(symbol)
    if (!newLine) changes.push({ symbol, kind: 'delete', detail: `was \`${oldLine.display}\`` })
    else if (oldLine.canonical !== newLine.canonical) changes.push({ symbol, kind: 'signature', detail: `was \`${oldLine.display}\` now \`${newLine.display}\`` })
  }
  for (const [symbol, newLine] of after) if (!before.has(symbol)) changes.push({ symbol, kind: 'add', detail: `now \`${newLine.display}\`` })
  return changes.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.kind.localeCompare(b.kind))
}

export interface Impact {
  symbol: string
  definedIn: string[]
  usedIn: string[]
}

export class SymbolGraph {
  private files = new Map<string, FileSymbols>()
  private definers = new Map<string, Set<string>>()
  private users = new Map<string, Set<string>>()
  constructor(private extract: Extractor = regexExtractor) {}

  get size(): number { return this.files.size }
  has(path: string): boolean { return this.files.has(path) }

  /** Index or re-index one file. Returns false when the extractor does not handle it. */
  set(path: string, text: string): boolean {
    this.remove(path)
    const syms = this.extract(path, text)
    if (!syms) return false
    this.files.set(path, syms)
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
  }

  symbolsOf(path: string): FileSymbols | undefined { return this.files.get(path) }
  definersOf(symbol: string): string[] { return Array.from(this.definers.get(symbol) ?? []).sort() }
  /** Files that reference a symbol defined elsewhere (a definer that also references itself is excluded). */
  usersOf(symbol: string): string[] {
    const defs = this.definers.get(symbol) ?? new Set()
    return Array.from(this.users.get(symbol) ?? []).filter(p => !defs.has(p)).sort()
  }
  /** Symbols a file uses that some other file defines. */
  dependenciesOf(path: string): Impact[] {
    const syms = this.files.get(path)
    if (!syms) return []
    const out: Impact[] = []
    for (const r of syms.refs) {
      const definedIn = this.definersOf(r).filter(p => p !== path)
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
      const usedIn = this.usersOf(d)
      if (usedIn.length) out.push({ symbol: d, definedIn: [path], usedIn })
    }
    return out.sort((a, b) => b.usedIn.length - a.usedIn.length || a.symbol.localeCompare(b.symbol))
  }
  impact(symbol: string): Impact { return { symbol, definedIn: this.definersOf(symbol), usedIn: this.usersOf(symbol) } }
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
