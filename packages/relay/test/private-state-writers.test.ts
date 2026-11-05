/** Directory creation is a single boundary: prevent a new writer bypassing native ACL initialization. */
import { expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const packages = fileURLToPath(new URL('../../', import.meta.url))
/** Audited mkdir calls outside the clone's room/ state: exact arguments and call counts. */
const nonState: Record<string, Record<string, number>> = {
  'room-mcp/src/prs.ts': { 'path.dirname(outputPath), { recursive: true }': 2 }, // user export destination
  'room-mcp/src/port-reservations.ts': { 'directory, { recursive: true, mode: 0o700 }': 1 }, // per-user config
  'room-mcp/src/worker-process.ts': { 'path.dirname(spec.logFile), { recursive: true }': 1 }, // checkout worker log
  'room-mcp/src/worker-shell-env.ts': { dir: 1 }, // temporary shell environment shim
  'room-mcp/src/worker-git.ts': { 'path.dirname(link.target), { recursive: true }': 1, 'path.dirname(dir), { recursive: true }': 1, 'path.dirname(target), { recursive: true }': 1, 'path.dirname(file), { recursive: true }': 1, dir: 1, target: 1, 'path.dirname(destination), { recursive: true }': 1 }, // checkout/worktree files
  'room-mcp/src/worker-deps.ts': { dst: 1, to: 2 }, // node_modules links inside a worktree
  'room-mcp/src/timing.ts': { 'markerDir, { recursive: true, mode: 0o700 }': 1 }, // tmpdir preview marker
  'room-mcp/src/tools/collect.ts': { 'path.dirname(dst), { recursive: true }': 1 }, // user checkout output
  'room-mcp/src/tools/files.ts': { at: 1, 'root, { recursive: true, mode: 0o700 }': 1 }, // checkout output and room-preview cache
  'room-mcp/src/preview-cache.ts': { 'path.dirname(file), { recursive: true, mode: 0o700 }': 1 }, // room-preview cache
}
const normalized = (text: string) => text.replace(/\s+/g, ' ').trim()
function files(dir: string): string[] { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : /\.(?:ts|mjs)$/.test(entry.name) ? [path.join(dir, entry.name)] : []) }
function directoryWriters(relative: string, source: string): string[] {
  const failures: string[] = []
  const allowances = new Map(Object.entries(nonState[relative] ?? {}).map(([args, count]) => [normalized(args), count]))
  if (relative === 'relay/src/private-state.ts') { allowances.set('private initializer', 1); allowances.set('windows inheriting directory', 1) }
  if (relative === 'relay/src/leases.ts') allowances.set('durable directory', 1)
  if (relative === '../plugins/room/hooks/common.mjs') allowances.set('hook initializer', 1)
  const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && /(?:^|\.)(?:mkdirSync|mkdir)$/.test(node.expression.getText(tree))) {
      const args = normalized(node.arguments.map(arg => arg.getText(tree)).join(', '))
      const statement = node.parent, branch = statement.parent
      let owner: ts.Node | undefined = node.parent
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent
      const durableExisting = relative === 'relay/src/leases.ts' && args === 'dir, { mode: 0o700 }'
        && owner && ts.isFunctionDeclaration(owner) && owner.name?.text === 'ensureDurableDirectory'
        && ts.isExpressionStatement(statement) && ts.isIfStatement(branch) && branch.elseStatement === statement
        && normalized(branch.expression.getText(tree)) === '!fs.existsSync(dir)'
        && normalized(branch.thenStatement.getText(tree)) === 'privateStateDirectory(dir)'
      const hookInitializer = relative === '../plugins/room/hooks/common.mjs' && args === 'directory, { mode: 0o700 }'
        && owner && ts.isFunctionDeclaration(owner) && owner.name?.text === 'privateHookDirectory'
      const privateInitializer = relative === 'relay/src/private-state.ts' && args === 'dir, { mode: 0o700 }'
        && owner && ts.isFunctionDeclaration(owner) && owner.name?.text === 'initializeDirectory'
      // Windows below the verified Room root: a plain directory inheriting the root's protected ACL.
      const inheriting = relative === 'relay/src/private-state.ts' && args === 'dir'
        && owner && ts.isFunctionDeclaration(owner) && owner.name?.text === 'inheritingDirectory'
      const key = privateInitializer ? 'private initializer' : inheriting ? 'windows inheriting directory' : durableExisting ? 'durable directory' : hookInitializer ? 'hook initializer' : args
      const remaining = allowances.get(key) ?? 0
      if (remaining > 0) allowances.set(key, remaining - 1)
      else failures.push(`${relative}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${args}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  for (const [key, remaining] of allowances) if (remaining > 0) failures.push(`${relative}: missing ${remaining} audited mkdir call(s): ${key}`)
  return failures
}
it('all clone room-state directory creation uses the shared private initializer or its plain-JS hook counterpart', () => {
  const failures = [...files(path.join(packages, 'relay/src')), ...files(path.join(packages, 'room-mcp/src')), ...files(path.join(packages, '../plugins/room/hooks'))]
    .flatMap(file => directoryWriters(path.relative(packages, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')))
  expect(failures).toEqual([])
})

it('does not exempt additional leases or hook mkdir calls', () => {
  for (const relative of ['relay/src/leases.ts', '../plugins/room/hooks/common.mjs']) {
    const source = fs.readFileSync(path.join(packages, relative), 'utf8')
    expect(directoryWriters(relative, source + '\nfs.mkdirSync(unprotected, { recursive: true })')).toHaveLength(1)
    const call = relative === 'relay/src/leases.ts'
      ? 'if (!fs.existsSync(dir)) privateStateDirectory(dir)\n    else fs.mkdirSync(dir, { mode: 0o700 })'
      : 'fs.mkdirSync(directory, { mode: 0o700 })'
    expect(source).toContain(call)
    expect(directoryWriters(relative, source.replace(call, `${call};\n${call}`))).toHaveLength(1)
  }
})

it('counts every non-state exemption, rejecting duplicate matching calls and stale allowances', () => {
  for (const [relative, calls] of Object.entries(nonState)) {
    const source = fs.readFileSync(path.join(packages, relative), 'utf8')
    for (const args of Object.keys(calls)) {
      expect(directoryWriters(relative, source + `\nfs.mkdirSync(${args})`)).toHaveLength(1)
    }
    expect(directoryWriters(relative, '')).toHaveLength(Object.keys(calls).length)
  }
})
