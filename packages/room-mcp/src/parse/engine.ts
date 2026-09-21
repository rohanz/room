import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type TreeSitter from 'web-tree-sitter'
import type { FileParser, ParsedDef, ParsedFile } from '@room/shared'
import { specForPath } from './index.js'
import type { LanguageSpec } from './spec.js'

const MAX_BYTES = 256 * 1024
const moduleRequire = createRequire(import.meta.url)
const moduleDir = dirname(fileURLToPath(import.meta.url))
const bundledGrammarDir = join(moduleDir, 'grammars')

type ParserConstructor = typeof TreeSitter
interface LoadedLanguage {
  parser: TreeSitter
  query: TreeSitter.Query
  spec: LanguageSpec
}

let runtimePromise: Promise<ParserConstructor | undefined> | undefined
const languages = new Map<string, Promise<LoadedLanguage | undefined>>()
const loadedByExtension = new Map<string, LoadedLanguage>()
const warned = new Set<string>()

/** Test-only visibility into the lazy-load cache; each grammar is inserted at most once. */
export const languageLoadAttemptsForTest = (grammar: string): number => languages.has(grammar) ? 1 : 0

function warnOnce(key: string, error: unknown): void {
  if (warned.has(key)) return
  warned.add(key)
  const detail = error instanceof Error ? error.message : String(error)
  console.warn(`tree-sitter: ${key}: ${detail}`)
}

function bundledAsset(name: string): string | undefined {
  const configured = process.env.ROOM_TREE_SITTER_WASM_DIR?.trim()
  if (configured) return join(configured, name)
  const candidate = join(bundledGrammarDir, name)
  return existsSync(candidate) ? candidate : undefined
}

function runtimePath(): string {
  return bundledAsset('tree-sitter.wasm') ?? moduleRequire.resolve('web-tree-sitter/tree-sitter.wasm')
}

function grammarPath(grammar: string): string {
  const name = `tree-sitter-${grammar}.wasm`
  return bundledAsset(name) ?? moduleRequire.resolve(`tree-sitter-wasms/out/${name}`)
}

function runtime(): Promise<ParserConstructor | undefined> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      try {
        const Parser = (await import('web-tree-sitter')).default
        const wasm = runtimePath()
        await Parser.init({ locateFile: () => wasm })
        return Parser
      } catch (error) {
        warnOnce('runtime unavailable', error)
        return undefined
      }
    })()
  }
  return runtimePromise
}

const extensionKey = (extension: string): string => extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`

async function loadLanguage(spec: LanguageSpec): Promise<LoadedLanguage | undefined> {
  let pending = languages.get(spec.grammar)
  if (!pending) {
    pending = (async () => {
      const Parser = await runtime()
      if (!Parser) return undefined
      try {
        const language = await Parser.Language.load(grammarPath(spec.grammar))
        const parser = new Parser()
        parser.setLanguage(language)
        return { parser, query: language.query(spec.query), spec }
      } catch (error) {
        warnOnce(`cannot load ${spec.grammar}`, error)
        return undefined
      }
    })()
    languages.set(spec.grammar, pending)
  }
  const loaded = await pending
  if (loaded) for (const extension of spec.extensions) loadedByExtension.set(extensionKey(extension), loaded)
  return loaded
}

/** Load the runtime once and only the grammars needed by these source paths. */
export async function ensureLanguages(paths: string[]): Promise<void> {
  const needed = new Map<string, LanguageSpec>()
  for (const path of paths) {
    const spec = specForPath(path)
    if (spec) needed.set(spec.grammar, spec)
  }
  await Promise.all([...needed.values()].map(loadLanguage))
}

function loadedForPath(path: string): LoadedLanguage | undefined {
  const lower = path.toLowerCase()
  let best: [number, LoadedLanguage] | undefined
  for (const [extension, loaded] of loadedByExtension) {
    if (lower.endsWith(extension) && (!best || extension.length > best[0])) best = [extension.length, loaded]
  }
  return best?.[1]
}

const contains = (outer: TreeSitter.SyntaxNode, inner: TreeSitter.SyntaxNode): boolean =>
  outer.startIndex <= inner.startIndex && outer.endIndex >= inner.endIndex

const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim()

function nestedBody(node: TreeSitter.SyntaxNode): TreeSitter.SyntaxNode | undefined {
  const direct = node.childForFieldName('body')
  if (direct) return direct
  let earliest: TreeSitter.SyntaxNode | undefined
  for (const child of node.namedChildren) {
    const candidate = nestedBody(child)
    if (candidate && (!earliest || candidate.startIndex < earliest.startIndex)) earliest = candidate
  }
  return earliest
}

function signatureOf(node: TreeSitter.SyntaxNode): string {
  // Arrow definitions are commonly captured at their containing declaration so that
  // @def contains @def.name; their body field therefore lives on a descendant.
  const body = nestedBody(node)
  let end = body ? Math.max(0, body.startIndex - node.startIndex) : node.text.indexOf('{')
  if (end < 0) {
    const newline = node.text.indexOf('\n')
    end = newline < 0 ? node.text.length : newline
  }
  return normalise(node.text.slice(0, end))
}

function inclusiveEndLine(node: TreeSitter.SyntaxNode): number {
  return Math.max(node.startPosition.row + 1, node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0))
}

function parsedDefinition(match: TreeSitter.QueryMatch, capture: TreeSitter.QueryCapture): ParsedDef | undefined {
  const names = match.captures.filter(candidate => candidate.name === 'def.name' && contains(capture.node, candidate.node))
  const name = names.sort((a, b) => a.node.startIndex - b.node.startIndex)[0]?.node.text.trim()
  if (!name) return undefined
  const container = match.captures.find(candidate => candidate.name === 'def.container')?.node.text.trim()
  return {
    name,
    ...(container ? { container } : {}),
    kind: capture.node.type,
    from: capture.node.startPosition.row + 1,
    to: inclusiveEndLine(capture.node),
    signature: signatureOf(capture.node),
  }
}

/** Parse synchronously after ensureLanguages has loaded the path's grammar. */
export const parseFile: FileParser = (path, text) => {
  const loaded = loadedForPath(path)
  if (!loaded || text.length > MAX_BYTES) return undefined
  let tree: TreeSitter.Tree | undefined
  try {
    tree = loaded.parser.parse(text)
    const matches = loaded.query.matches(tree.rootNode)
    const defs: ParsedDef[] = []
    const refs = new Set<string>()
    const imports = new Set<string>()
    const seenDefs = new Set<string>()
    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name === 'def') {
          const definition = parsedDefinition(match, capture)
          if (!definition) continue
          const key = `${definition.from}:${definition.to}:${definition.container ?? ''}:${definition.name}`
          if (!seenDefs.has(key)) { seenDefs.add(key); defs.push(definition) }
        } else if (capture.name === 'ref') {
          const reference = capture.node.text.trim()
          if (reference) refs.add(reference)
        } else if (capture.name === 'import') {
          const imported = capture.node.text.trim()
          if (imported) imports.add(imported)
        }
      }
    }
    const own = new Set(defs.map(definition => definition.name))
    const keywords = new Set(loaded.spec.keywords ?? [])
    for (const value of [...refs]) if (own.has(value) || keywords.has(value)) refs.delete(value)
    defs.sort((a, b) => a.from - b.from || a.to - b.to || a.name.localeCompare(b.name))
    return { defs, refs: [...refs].sort(), imports: [...imports].sort() } satisfies ParsedFile
  } catch (error) {
    warnOnce(`cannot parse ${loaded.spec.grammar}`, error)
    return undefined
  } finally {
    tree?.delete()
  }
}
