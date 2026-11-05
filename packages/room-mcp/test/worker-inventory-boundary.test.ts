import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const src = fileURLToPath(new URL('../src/', import.meta.url))
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(dir, entry.name)) : /\.(?:ts|mts|cts|js|mjs)$/.test(entry.name) ? [path.join(dir, entry.name)] : [])
}
const raw = new Set(['readFact', 'decodeFact', 'readCachedJson', 'cachedFiles', 'factRevision'])
/** Only the facade constructs the file adapter; raw decoders/scanners are private to its implementation. */
function violations(relative: string, source: string): string[] {
  if (relative === 'worker-file-store.ts') return []
  const failures: string[] = [], tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true)
  const fail = (node: ts.Node) => failures.push(`${relative}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.getText(tree)}`)
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && /worker-file-store(?:\.[cm]?[jt]s)?['"]$/.test(node.moduleSpecifier.getText(tree))) {
      // The facade imports the adapter and re-exports only types and log helpers.
      const allowed = new Set(['workerLogFile', 'backgroundAtExit'])
      const safeExport = ts.isExportDeclaration(node) && (node.isTypeOnly
        || node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(
          element => element.isTypeOnly || allowed.has((element.propertyName ?? element.name).text)))
      if (relative !== 'worker-registry.ts' || ts.isExportDeclaration(node) && !safeExport) fail(node)
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(tree)
      if (raw.has(name)) fail(node)
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && /worker-file-store/.test(node.arguments[0]?.getText(tree) ?? '')) fail(node)
      if (ts.isPropertyAccessExpression(node.expression) && /^(this\.file|this\.backend\(\)|FileWorkerStore(?:\.prototype)?)$/.test(node.expression.expression.getText(tree))
        && /^(read|list|reserved|reservedByTagOrName|worktreeOwner|checkoutUsers|status|occupancy|reports|exits)$/.test(name)) fail(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return failures
}
it('keeps raw worker file scanning behind the snapshot/inventory boundary', () => {
  expect(files(src).flatMap(file => violations(path.relative(src, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')))).toEqual([])
})
it('scans every supported source extension recursively', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-inventory-boundary-'))
  try {
    fs.mkdirSync(path.join(root, 'nested'))
    const names = ['consumer.ts', 'consumer.mts', 'consumer.cts', 'consumer.js', 'consumer.mjs']
    for (const name of [...names, 'ignored.json']) fs.writeFileSync(path.join(root, 'nested', name), '')
    expect(files(root).map(file => path.basename(file)).sort()).toEqual(names.sort())
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
it('rejects new scanner calls and adapter imports, including facade bypasses', () => {
  for (const source of ["import { FileWorkerStore } from './worker-file-store.js'", "export * from './worker-file-store.js'",
    "import('./worker-file-store.js')", 'decodeFact(file, valid)', 'reader.readFact(file, valid)', 'cachedFiles(root, suffix)',
    'this.file.list()', 'this.backend().read(id)']) expect(violations('new-consumer.ts', source)).toHaveLength(1)
  expect(violations('worker-registry.ts', 'this.file.list()')).toHaveLength(1)
  expect(violations('worker-registry.ts', "export { FileWorkerStore as Adapter } from './worker-file-store.js'")).toHaveLength(1)
  expect(violations('worker-registry.ts', "export * from './worker-file-store.js'")).toHaveLength(1)
})

it('makes raw scanners inaccessible to typed aliases, destructuring, indexing and re-exports', () => {
  const fixture = path.join(src, '__inventory_boundary__.ts')
  const source = `
import { FileWorkerStore } from './worker-file-store.js'
import { decodeFact, readCachedJson, cachedFiles } from './worker-file-store.js'
export { FileWorkerStore as Adapter } from './worker-registry.js'
declare const store: FileWorkerStore
const alias = store
alias.list()
const { read, reports, exits, reserved } = store
store['list']()
const key: string = 'list'
store[key]()
store.readFact('file', () => true)
store.factRevision()
store.snapshot()
`
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, noResolve: true, noLib: true, types: [] }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => file === fixture
    ? ts.createSourceFile(file, source, languageVersion, true)
    : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram([fixture, path.join(src, 'worker-file-store.ts'), path.join(src, 'worker-registry.ts')], options, host)
  const consumer = program.getSourceFile(fixture)!
  const diagnostics = program.getSemanticDiagnostics(consumer)
  const messages = diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  // No missing-module false positives: these are errors about the actual adapter's members/exports.
  expect(messages.some(message => /Cannot find module/.test(message))).toBe(false)
  for (const name of ['decodeFact', 'readCachedJson', 'cachedFiles', 'FileWorkerStore', 'list', 'read', 'reports', 'exits', 'reserved', 'readFact', 'factRevision'])
    expect(messages.some(message => message.includes(`'${name}'`)), name).toBe(true)
  const line = (diagnostic: ts.Diagnostic) => consumer.getLineAndCharacterOfPosition(diagnostic.start!).line
  expect(diagnostics.some(diagnostic => line(diagnostic) === source.split('\n').findIndex(text => text === "store['list']()"))).toBe(true)
  expect(diagnostics.some(diagnostic => line(diagnostic) === source.split('\n').findIndex(text => text === 'store[key]()'))).toBe(true)
  expect(diagnostics.some(diagnostic => line(diagnostic) === source.split('\n').findIndex(text => text === 'store.snapshot()'))).toBe(false)
})

it('does not expose scanners through a computed dynamic import at runtime', async () => {
  const modulePath = '../src/' + 'worker-file-store.js'
  const module = await import(modulePath)
  const store = await module.FileWorkerStore.openReader(src)
  try {
    for (const name of ['decodeFact', 'readCachedJson', 'cachedFiles']) expect(module[name], name).toBeUndefined()
    for (const name of ['readFact', 'read', 'inventory', 'list', 'reserved', 'reservedByTagOrName',
      'worktreeOwner', 'status', 'operationInProgress', 'occupancy', 'reports', 'exits', 'factRevision', 'statusLiveness'])
      expect(store[name], name).toBeUndefined()
    expect(typeof store.snapshot).toBe('function')
  } finally { store.close() }
})
