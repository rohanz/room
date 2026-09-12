/**
 * Symbol graph: which files define which symbols, and which files reference them.
 * The shape that recent code-graph tools for agents converge on (tree-sitter tag
 * maps: definitions + references per file), reduced to what coordination needs.
 *
 * The index is derived, never stored in the room doc. Each MCP process builds it from
 * the base commit plus everyone's overlays and refreshes one file at a time.
 */

export interface FileSymbols { defs: string[]; refs: string[] }
/** Read-only browser projection, published by each participant's local indexer. */
export interface GraphSnapshot {
  version: 1
  base: string
  at: number
  status: 'ready' | 'indexing' | 'error'
  paths: string[]
  /** Direction: definition/provider -> consumer. Names are inferred, not resolved imports. */
  edges: { source: string; target: string; symbols: string[] }[]
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
export function symbolRange(path: string, text: string, symbol: string): { from: number; to: number } | undefined {
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
