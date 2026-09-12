/** Python extractor backed by the stdlib ast module; falls back to the regex extractor when python3 is missing or the file does not parse. */
import { execFile } from 'node:child_process'
import { regexExtractor, type Extractor, type FileSymbols } from '@room/shared'

const SCRIPT = `
import ast, json, sys
src = sys.stdin.read()
try:
    tree = ast.parse(src)
except SyntaxError:
    print("null"); sys.exit(0)
defs, refs = set(), set()
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        defs.add(node.name)
    elif isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name): defs.add(t.id)
    elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        defs.add(node.target.id)
    elif isinstance(node, ast.Name):
        refs.add(node.id)
    elif isinstance(node, ast.Attribute):
        refs.add(node.attr)
    elif isinstance(node, ast.ImportFrom):
        for a in node.names: refs.add(a.name)
print(json.dumps({"defs": sorted(defs), "refs": sorted(refs - defs)}))
`

let pythonOk: boolean | undefined
async function runPython(text: string): Promise<FileSymbols | null | undefined> {
  if (pythonOk === false) return undefined
  return new Promise(resolve => {
    const p = execFile('python3', ['-c', SCRIPT], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') pythonOk = false; return resolve(undefined) }
      pythonOk = true
      try { resolve(JSON.parse(stdout) as FileSymbols | null) } catch { resolve(undefined) }
    })
    p.stdin?.end(text)
  })
}

/** Async extractor: Python via ast, everything else via regex. */
export async function extractSymbols(path: string, text: string): Promise<FileSymbols | undefined> {
  if (path.endsWith('.py')) {
    const r = await runPython(text)
    if (r) return r
    if (r === null) return regexExtractor(path, text) // syntax error mid-edit: best effort
  }
  return regexExtractor(path, text)
}

/** Sync extractor for SymbolGraph.set when results were precomputed. */
export const precomputed = (cache: Map<string, FileSymbols | undefined>): Extractor => (path) => cache.get(path)
