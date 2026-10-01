// Compile the hosted server; native bindings and optional drivers resolve from runtime node_modules.
import { build } from 'esbuild'
import fs from 'node:fs/promises'

await build({
  entryPoints: ['packages/server/src/index.ts'],
  tsconfig: 'tsconfig.base.json',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: 'packages/server/dist/server.mjs',
  // level locates leveldown's .node binding relative to its package; pg can load pg-native.
  // ws has optional native accelerators. Keep one Yjs instance shared with external dependencies.
  external: ['level', 'leveldown', 'classic-level', 'pg', 'pg-native', 'ws', 'bufferutil', 'utf-8-validate', 'yjs'],
  banner: { js: "import { createRequire as __roomCreateRequire } from 'node:module'; import { fileURLToPath as __roomFileURLToPath } from 'node:url'; import { dirname as __roomDirname } from 'node:path'; const require = __roomCreateRequire(import.meta.url); const __filename = __roomFileURLToPath(import.meta.url); const __dirname = __roomDirname(__filename);" },
  logLevel: 'info',
})

// esbuild preserves the source's development tsx shebang; the packaged CLI runs Node.
const outfile = 'packages/server/dist/server.mjs'
await fs.writeFile(outfile, (await fs.readFile(outfile, 'utf8')).replace(/^#![^\n]*/, '#!/usr/bin/env node'))
await fs.chmod(outfile, 0o755)
