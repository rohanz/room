import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const src = fileURLToPath(new URL('../src/', import.meta.url))
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : [])
}
const raw = new Set(['readFact', 'decodeFact', 'readCachedJson', 'cachedFiles', 'factRevision'])
/** Only the facade constructs the file adapter; raw decoders/scanners are private to its implementation. */
function violations(relative: string, source: string): string[] {
  if (relative === 'worker-file-store.ts') return []
  const failures: string[] = [], tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true)
  const fail = (node: ts.Node) => failures.push(`${relative}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.getText(tree)}`)
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && /worker-file-store(?:\.js)?['"]$/.test(node.moduleSpecifier.getText(tree)) && relative !== 'worker-registry.ts') fail(node)
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
it('rejects new scanner calls and adapter imports, including facade bypasses', () => {
  for (const source of ["import { FileWorkerStore } from './worker-file-store.js'", "export * from './worker-file-store.js'",
    "import('./worker-file-store.js')", 'decodeFact(file, valid)', 'reader.readFact(file, valid)', 'cachedFiles(root, suffix)',
    'this.file.list()', 'this.backend().read(id)']) expect(violations('new-consumer.ts', source)).toHaveLength(1)
  expect(violations('worker-registry.ts', 'this.file.list()')).toHaveLength(1)
})
