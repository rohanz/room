// Bundles room-mcp into a single file so the Codex plugin runs from its cache dir with no node_modules.
import { build } from 'esbuild'
await build({
  entryPoints: ['packages/room-mcp/src/index.ts'],
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  outfile: 'plugins/room/server/room-mcp.mjs',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
})
