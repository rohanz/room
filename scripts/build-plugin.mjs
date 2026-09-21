// Bundles room-mcp (with @room/relay, the local relay) into a single file so the Codex plugin runs from its cache dir with no node_modules,
// and ships the built browser view next to it (plugins/room/web) so a local relay can serve it.
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const grammars = ['rust', 'go', 'c', 'cpp', 'java', 'kotlin', 'c_sharp', 'swift', 'scala', 'python', 'javascript', 'typescript', 'tsx', 'ruby', 'php']

await build({
  entryPoints: ['packages/room-mcp/src/index.ts'],
  tsconfig: 'tsconfig.base.json',
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  outfile: 'plugins/room/server/room-mcp.mjs',
  banner: { js: "import { createRequire as __roomCreateRequire } from 'node:module'; import { fileURLToPath as __roomFileURLToPath } from 'node:url'; import { dirname as __roomDirname } from 'node:path'; const require = __roomCreateRequire(import.meta.url); const __filename = __roomFileURLToPath(import.meta.url); const __dirname = __roomDirname(__filename);" },
  logLevel: 'info',
})

const grammarDir = 'plugins/room/server/grammars'
fs.rmSync(grammarDir, { recursive: true, force: true })
fs.mkdirSync(grammarDir, { recursive: true })
fs.copyFileSync(require.resolve('web-tree-sitter/tree-sitter.wasm'), path.join(grammarDir, 'tree-sitter.wasm'))
for (const grammar of grammars) {
  const name = `tree-sitter-${grammar}.wasm`
  fs.copyFileSync(require.resolve(`tree-sitter-wasms/out/${name}`), path.join(grammarDir, name))
}
console.log(`copied tree-sitter runtime + ${grammars.length} grammars -> ${grammarDir}`)

if (!process.argv.includes('--skip-web')) {
  execSync('npm run build -w @room/web', { stdio: 'inherit' })
  fs.rmSync('plugins/room/web', { recursive: true, force: true })
  fs.cpSync('packages/web/dist', 'plugins/room/web', { recursive: true })
  console.log('copied packages/web/dist -> plugins/room/web')
}
