export interface NoiseFixtureFile {
  path: string
  symbols: { defs: string[]; refs: string[]; imports: string[] }
}

export interface LabeledEdge {
  source: string
  target: string
  symbol: string
}

const languages = [
  {
    name: 'rust',
    path: (index: number) => `rust/src/rust_m${index}.rs`,
    imported: (index: number) => `use crate::rust_m${index}::build`,
  },
  {
    name: 'go',
    path: (index: number) => `go/pkg/go_m${index}/file.go`,
    imported: (index: number) => `example.test/go_m${index}`,
  },
  {
    name: 'python',
    path: (index: number) => `python/py_m${index}.py`,
    imported: (index: number) => `from .py_m${index} import build`,
  },
  {
    name: 'typescript',
    path: (index: number) => `typescript/ts_m${index}.ts`,
    imported: (index: number) => `./ts_m${index}`,
  },
] as const

/**
 * Forty parsed-file-shaped records. Each language contributes six definitions of the
 * noisy name `build`, two imported true uses, and one unrelated lexical use. The last
 * file imports its language-specific config definition and genuinely uses only that.
 */
export const noiseFixture: NoiseFixtureFile[] = languages.flatMap(language => {
  const config = `${language.name[0].toUpperCase()}${language.name.slice(1)}Config`
  return Array.from({ length: 10 }, (_, index): NoiseFixtureFile => {
    if (index < 6) return { path: language.path(index), symbols: { defs: ['build'], refs: [], imports: [] } }
    if (index === 6) return { path: language.path(index), symbols: { defs: [config], refs: [], imports: [] } }
    if (index < 9) return {
      path: language.path(index),
      symbols: { defs: [], refs: ['build'], imports: [language.imported(index - 5)] },
    }
    return {
      path: language.path(index),
      symbols: { defs: [], refs: ['build', config], imports: [language.imported(6)] },
    }
  })
})

export const trueNoiseFixtureEdges: LabeledEdge[] = languages.flatMap(language => {
  const config = `${language.name[0].toUpperCase()}${language.name.slice(1)}Config`
  return [
    { source: language.path(2), target: language.path(7), symbol: 'build' },
    { source: language.path(3), target: language.path(8), symbol: 'build' },
    { source: language.path(6), target: language.path(9), symbol: config },
  ]
})
