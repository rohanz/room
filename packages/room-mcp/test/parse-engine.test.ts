import { afterAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { execFile as execFileCallback } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { ensureLanguages, languageLoadAttemptsForTest, parseFile } from '../src/parse/engine.js'
import { languageSpecs } from '../src/parse/index.js'

const execFile = promisify(execFileCallback)
const require = createRequire(import.meta.url)
const temporary: string[] = []

afterAll(async () => {
  await Promise.all(temporary.map(path => rm(path, { recursive: true, force: true })))
})

describe('tree-sitter parser engine', () => {
  it('registers exactly the fifteen requested grammars', () => {
    expect(languageSpecs.map(spec => spec.grammar)).toEqual([
      'rust', 'go', 'c', 'cpp', 'java', 'kotlin', 'c_sharp', 'swift', 'scala',
      'python', 'javascript', 'typescript', 'tsx', 'ruby', 'php',
    ])
  })

  it('loads a needed grammar only once', async () => {
    expect(languageLoadAttemptsForTest('rust')).toBe(0)
    await Promise.all([
      ensureLanguages(['src/main.rs']),
      ensureLanguages(['src/lib.rs']),
      ensureLanguages(['src/again.rs']),
    ])
    expect(languageLoadAttemptsForTest('rust')).toBe(1)
    expect(parseFile('src/main.rs', 'fn ready() {}')?.defs.map(definition => definition.name)).toContain('ready')
  })

  it('returns undefined for an unknown or not-yet-loaded extension', async () => {
    await ensureLanguages(['README.md'])
    expect(parseFile('README.md', 'fn nope() {}')).toBeUndefined()
    expect(parseFile('before.go', 'package main')).toBeUndefined()
  })

  it('recovers definitions from a syntax-error file', async () => {
    await ensureLanguages(['broken.py'])
    const parsed = parseFile('broken.py', 'def recovered():\n    return (1 + )\n')
    expect(parsed?.defs.map(definition => definition.name)).toContain('recovered')
  })

  it('excludes a nested expression-bodied arrow body from its signature', async () => {
    await ensureLanguages(['arrow.ts'])
    const parsed = parseFile('arrow.ts', 'export const tax = (price: number): number => price * .1\n')
    const tax = parsed?.defs.find(definition => definition.name === 'tax')
    expect(tax?.signature).toContain('=>')
    expect(tax?.signature).not.toContain('price * .1')
  })

  it('parses a 20,000-line file within a generous bound', async () => {
    await ensureLanguages(['large.rs'])
    const source = [...Array.from({ length: 19_999 }, () => '// filler'), 'fn last() {}'].join('\n')
    const started = performance.now()
    const parsed = parseFile('large.rs', source)
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(parsed?.defs.map(definition => definition.name)).toContain('last')
  }, 10_000)

  it('remembers a corrupt grammar failure and logs it once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'room-tree-sitter-corrupt-'))
    temporary.push(dir)
    await copyFile(require.resolve('web-tree-sitter/tree-sitter.wasm'), join(dir, 'tree-sitter.wasm'))
    await writeFile(join(dir, 'tree-sitter-rust.wasm'), 'not wasm')
    const engine = pathToFileURL(resolve('packages/room-mcp/src/parse/engine.ts')).href
    const program = `
      const warnings = [];
      console.warn = (...args) => warnings.push(args.join(' '));
      const { ensureLanguages, parseFile } = await import(${JSON.stringify(engine)});
      await ensureLanguages(['bad.rs']);
      await ensureLanguages(['again.rs']);
      process.stdout.write(JSON.stringify({ warnings, parsed: parseFile('bad.rs', 'fn x() {}') }));
    `
    const { stdout } = await execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
      cwd: resolve('.'), env: { ...process.env, ROOM_TREE_SITTER_WASM_DIR: dir },
    })
    const result = JSON.parse(stdout) as { warnings: string[]; parsed?: unknown }
    expect(result.parsed).toBeUndefined()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('cannot load rust')
  }, 10_000)

  it('resolves the runtime and grammar beside a standalone bundle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'room-tree-sitter-bundle-'))
    temporary.push(dir)
    const grammarDir = join(dir, 'grammars')
    await mkdir(grammarDir)
    await copyFile(require.resolve('web-tree-sitter/tree-sitter.wasm'), join(grammarDir, 'tree-sitter.wasm'))
    await copyFile(require.resolve('tree-sitter-wasms/out/tree-sitter-rust.wasm'), join(grammarDir, 'tree-sitter-rust.wasm'))
    const entry = join(dir, 'entry.ts')
    const engine = resolve('packages/room-mcp/src/parse/engine.ts')
    await writeFile(entry, `
      import { ensureLanguages, parseFile } from ${JSON.stringify(engine)};
      await ensureLanguages(['smoke.rs']);
      process.stdout.write(JSON.stringify(parseFile('smoke.rs', 'fn bundled() {}')));
    `)
    const outfile = join(dir, 'room-mcp.mjs')
    await build({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile,
      banner: { js: "import { createRequire as __roomCreateRequire } from 'node:module'; import { fileURLToPath as __roomFileURLToPath } from 'node:url'; import { dirname as __roomDirname } from 'node:path'; const require = __roomCreateRequire(import.meta.url); const __filename = __roomFileURLToPath(import.meta.url); const __dirname = __roomDirname(__filename);" },
      logLevel: 'silent',
    })
    const { stdout } = await execFile(process.execPath, [outfile], { cwd: dir })
    const parsed = JSON.parse(stdout) as { defs: { name: string }[] }
    expect(parsed.defs.map(definition => definition.name)).toContain('bundled')
  }, 20_000)
})
