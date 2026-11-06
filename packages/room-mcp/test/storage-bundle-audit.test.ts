import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { EXECUTABLE_BUNDLES, verifyBundleDigests } from '../src/hosts/codex-install.js'

const plugin = fileURLToPath(new URL('../../../plugins/room/', import.meta.url))
function imports(file: string, code = fs.readFileSync(file, 'utf8')) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const result: { specifier: string; dynamic: boolean; position: number }[] = []
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      result.push({ specifier: node.moduleSpecifier.text, dynamic: false, position: node.pos })
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      expect(node.arguments.length, 'literal import required for audit').toBeGreaterThan(0)
      const argument = node.arguments[0]
      expect(ts.isStringLiteral(argument), 'no computed dependency before bootstrap').toBe(true)
      if (ts.isStringLiteral(argument)) result.push({ specifier: argument.text, dynamic: node.expression.kind === ts.SyntaxKind.ImportKeyword, position: node.pos })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}
it.each(['room-mcp', 'room-daemon', 'room-state'])('%s wrapper has only built-in static imports and a deferred application', name => {
  const file = path.join(plugin, 'server', `${name}.mjs`)
  const dependencies = imports(file)
  expect(dependencies.filter(d => !d.dynamic).every(d => d.specifier.startsWith('node:') && d.specifier !== 'node:sqlite')).toBe(true)
  expect(dependencies.filter(d => d.dynamic).map(d => d.specifier).sort()).toEqual([`./${name}-app.mjs`])
  const code = fs.readFileSync(file, 'utf8')
  expect(code).toContain('await bootstrap(')
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  // The isolated probe is embedded, not an adjacent asset: audit its dependency graph too.
  const worker = source.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
    .find(node => node.name.getText(source) === 'SQLITE_PROBE_SOURCE')?.initializer
  expect(worker && ts.isTaggedTemplateExpression(worker)).toBe(true)
  if (!worker || !ts.isTaggedTemplateExpression(worker)) throw new Error('missing embedded preflight worker')
  expect(worker.tag.getText(source)).toBe('String.raw')
  expect(ts.isNoSubstitutionTemplateLiteral(worker.template)).toBe(true)
  const workerCode = worker.template.getText(source).slice(1, -1)
  const workerImports = imports('preflight-worker.js', workerCode)
  expect(workerImports.filter(d => !d.dynamic).map(d => d.specifier).sort()).toEqual(['node:fs', 'node:path', 'node:worker_threads'])
  expect(workerImports.filter(d => d.dynamic).map(d => d.specifier)).toEqual(['node:sqlite'])
  expect(code).toMatch(/new Worker\(SQLITE_PROBE_SOURCE/)
  const barrier = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'bootstrap')
  expect(barrier?.body).toBeDefined()
  // esbuild may rename the load parameter to avoid another bootstrap-local binding.
  const callback = barrier!.parameters[1].name.getText(source)
  const body = barrier!.body!.getText(source)
  const probe = body.indexOf('await preflight('), load = body.indexOf(`await ${callback}(`)
  expect(probe).toBeGreaterThanOrEqual(0)
  expect(load).toBeGreaterThan(probe)
  const binding = barrier!.body!.statements.find(ts.isVariableStatement)!.declarationList.declarations[0].name.getText(source)
  expect(body.slice(probe, load)).toContain(`if (!${binding}.ok)`)
  expect(code).not.toContain('ROOM_TEST_PREFLIGHT')
})
it('hook imports are only built-ins and sibling hook files, never SQLite or application code', () => {
  for (const name of fs.readdirSync(path.join(plugin, 'hooks')).filter(n => n.endsWith('.mjs'))) {
    for (const dependency of imports(path.join(plugin, 'hooks', name))) {
      const specifier = dependency.specifier
      expect(specifier).not.toBe('node:sqlite')
      expect(specifier.startsWith('node:') || /^\.\/[a-z0-9-]+\.mjs$/.test(specifier), `${name}: ${specifier}`).toBe(true)
      if (specifier.startsWith('./')) expect(fs.existsSync(path.join(plugin, 'hooks', specifier))).toBe(true)
    }
  }
})
it('the descriptor authenticates every executed server bundle', () => {
  const server = path.join(plugin, 'server')
  const descriptor = JSON.parse(fs.readFileSync(path.join(server, 'compat.json'), 'utf8'))
  expect(descriptor.v).toBe(2)
  expect(fs.readdirSync(server).filter(n => n.endsWith('.mjs')).sort()).toEqual([...EXECUTABLE_BUNDLES].sort())
  expect(verifyBundleDigests(server, descriptor)).toBe(true)
})
