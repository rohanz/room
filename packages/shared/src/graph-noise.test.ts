import { describe, expect, it } from 'vitest'
import { COMMON_SYMBOL_FILE_THRESHOLD, SymbolGraph, type Extractor } from './graph.js'
import { noiseFixture, trueNoiseFixtureEdges, type NoiseFixtureFile } from './graph-noise.fixture.js'

type RichSymbols = NoiseFixtureFile['symbols']

const fixtureExtractor = (files: NoiseFixtureFile[]): Extractor => {
  const byPath = new Map(files.map(file => [file.path, file.symbols]))
  return path => byPath.get(path)
}

const buildGraph = (files: NoiseFixtureFile[]): SymbolGraph => {
  const graph = new SymbolGraph(fixtureExtractor(files))
  for (const file of files) graph.set(file.path, '')
  return graph
}

const rawEdges = (files: NoiseFixtureFile[]) => {
  const definers = new Map<string, string[]>()
  for (const file of files) for (const symbol of file.symbols.defs) {
    const paths = definers.get(symbol) ?? []
    paths.push(file.path)
    definers.set(symbol, paths)
  }
  return files.flatMap(file => file.symbols.refs.flatMap(symbol =>
    (definers.get(symbol) ?? []).filter(source => source !== file.path)
      .map(source => ({ source, target: file.path, symbol }))))
}

const narrowedEdges = (graph: SymbolGraph, files: NoiseFixtureFile[]) => files.flatMap(file =>
  graph.dependenciesOf(file.path).flatMap(impact =>
    impact.definedIn.map(source => ({ source, target: file.path, symbol: impact.symbol }))))

const edgeKey = (edge: { source: string; target: string; symbol: string }) =>
  `${edge.source}->${edge.target}:${edge.symbol}`

describe('SymbolGraph noise controls', () => {
  it('cuts the 40-file fixture from 292 name edges to 12 true edges', () => {
    const graph = buildGraph(noiseFixture)
    const before = rawEdges(noiseFixture)
    const after = narrowedEdges(graph, noiseFixture)
    const actual = new Set(after.map(edgeKey))
    const trueEdgesLost = trueNoiseFixtureEdges.filter(edge => !actual.has(edgeKey(edge)))

    expect(noiseFixture).toHaveLength(40)
    expect(COMMON_SYMBOL_FILE_THRESHOLD).toBe(5)
    expect(before).toHaveLength(292)
    expect(after).toHaveLength(12)
    expect(trueEdgesLost).toEqual([])
    expect(new Set(after.map(edgeKey))).toEqual(new Set(trueNoiseFixtureEdges.map(edgeKey)))
  })

  it.each([
    ['Rust directory module', 'src/cfg/mod.rs', 'src/app.rs', 'use crate::cfg::Config'],
    ['Go package directory', 'internal/cfg/config.go', 'cmd/app/main.go', 'example.test/internal/cfg'],
    ['Python relative module', 'pkg/cfg.py', 'pkg/app.py', 'from .cfg import Config'],
    ['TypeScript relative module', 'src/cfg.ts', 'src/app.ts', './cfg'],
  ])('matches an imported defining module by %s', (_label, provider, consumer, imported) => {
    const files: NoiseFixtureFile[] = [
      { path: provider, symbols: { defs: ['Config'], refs: [], imports: [] } },
      { path: 'other/unrelated.ts', symbols: { defs: ['Config'], refs: [], imports: [] } },
      { path: consumer, symbols: { defs: [], refs: ['Config'], imports: [imported] } },
    ]
    expect(buildGraph(files).dependenciesOf(consumer)).toEqual([
      { symbol: 'Config', definedIn: [provider], usedIn: [consumer] },
    ])
  })

  it('preserves the legacy name-only behavior when imports are absent', () => {
    const rich: RichSymbols[] = Array.from({ length: 6 }, () => ({ defs: ['build'], refs: [], imports: [] }))
    const byPath = new Map(rich.map((symbols, index) => [`provider-${index}.ts`, symbols]))
    byPath.set('consumer.ts', { defs: [], refs: ['build'], imports: [] })
    const withoutImports = new Map(Array.from(byPath, ([path, symbols]) => [path, {
      defs: symbols.defs,
      refs: symbols.refs,
    }]))
    const graph = new SymbolGraph(path => withoutImports.get(path))
    for (const path of withoutImports.keys()) graph.set(path, '')

    expect(graph.dependenciesOf('consumer.ts')[0].definedIn).toHaveLength(6)
  })
})
