// Bundles room-mcp (with @room/relay, the local relay) into a single file so the Codex plugin runs from its cache dir with no node_modules,
// and ships the built browser view next to it (plugins/room/web) so a local relay can serve it.
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
await build({
  entryPoints: ['packages/room-mcp/src/index.ts'],
  tsconfig: 'tsconfig.base.json',
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  outfile: 'plugins/room/server/room-mcp.mjs',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
})
execSync('npm run build -w @room/web', { stdio: 'inherit' })
fs.rmSync('plugins/room/web', { recursive: true, force: true })
fs.cpSync('packages/web/dist', 'plugins/room/web', { recursive: true })
console.log('copied packages/web/dist -> plugins/room/web')
