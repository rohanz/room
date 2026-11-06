// Emits bootstrap wrappers and isolated application bundles so the plugin runs from its cache with no node_modules,
// and ships the hosted assets plus a self-contained local viewer (plugins/room/web/viewer.html).
//
// Run:        npm run build:plugin   (from the repository root; paths are cwd-relative). Needs `npm ci`.
// Overwrites: plugins/room/server/{room-mcp,room-daemon,room-state}{,-app}.mjs, {parse,gate}-worker.mjs, compat.json,
// and hooks/{private-core,windows-process-core,*-hook-codec}.mjs;
// replaces plugins/room/server/grammars/ and (via packages/web/dist) plugins/room/web/.
// All generated plugin assets are committed; CI checks they are current.
// --skip-web  rebuilds only the server bundle (for sandboxes that cannot build the web view): partial output, never commit it.
// Installed plugins copy the bundle: reinstall room@room on each host after a rebuild.
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const release = JSON.parse(fs.readFileSync('plugins/room/.claude-plugin/plugin.json', 'utf8')).version
const grammars = ['rust', 'go', 'c', 'cpp', 'java', 'kotlin', 'c_sharp', 'swift', 'scala', 'python', 'javascript', 'typescript', 'tsx', 'ruby', 'php']

const bundleOptions = {
  tsconfig: 'tsconfig.base.json',
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  banner: { js: "import { createRequire as __roomCreateRequire } from 'node:module'; import { fileURLToPath as __roomFileURLToPath } from 'node:url'; import { dirname as __roomDirname } from 'node:path'; const require = __roomCreateRequire(import.meta.url); const __filename = __roomFileURLToPath(import.meta.url); const __dirname = __roomDirname(__filename);" },
  logLevel: 'info',
}
// Keep application imports external in each bootstrap bundle. Audits can inspect the complete
// bootstrap graph without accidentally evaluating the application before runtime qualification.
for (const [wrapper, application, name] of [
  ['packages/room-mcp/src/entry.ts', 'packages/room-mcp/src/index.ts', 'room-mcp'],
  ['packages/relay/src/daemon-bin.ts', 'packages/relay/src/daemon-app.ts', 'room-daemon'],
  ['packages/room-mcp/src/offline/entry.ts', 'packages/room-mcp/src/offline/room-state.ts', 'room-state'],
]) {
  await build({ ...bundleOptions, entryPoints: [wrapper], outfile: `plugins/room/server/${name}.mjs`,
    plugins: [{ name: 'defer-application', setup(build) {
      build.onResolve({ filter: /\.\/(?:index|daemon-app|room-state)\.js$/ }, args => {
        if (args.kind === 'dynamic-import' && path.resolve(path.dirname(args.importer), args.path).replace(/\.js$/, '.ts') === path.resolve(application))
          return { path: `./${name}-app.mjs`, external: true }
      })
    } }],
  })
  await build({ ...bundleOptions, entryPoints: [application], outfile: `plugins/room/server/${name}-app.mjs`,
    define: { __ROOM_DAEMON_RELEASE__: JSON.stringify(release) } })
}
await build({ ...bundleOptions, entryPoints: ['packages/room-mcp/src/parse/worker.ts'], outfile: 'plugins/room/server/parse-worker.mjs' })
await build({ ...bundleOptions, entryPoints: ['packages/local-state/src/gate-worker.ts'], outfile: 'plugins/room/server/gate-worker.mjs' })

// One builtins-only privacy policy for hooks and the relay; committed and checked with the other plugin assets.
await build({ entryPoints: ['packages/local-state/src/private-core.ts'], outfile: 'plugins/room/hooks/private-core.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'info' })
// One builtins-only Windows process table reader for hooks and the relay.
await build({ entryPoints: ['packages/local-state/src/windows-process-core.ts'], outfile: 'plugins/room/hooks/windows-process-core.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'info' })
await build({ entryPoints: ['packages/room-mcp/src/hosts/session-host.ts'], outfile: 'plugins/room/hooks/session-host.mjs', bundle: true, platform: 'node', format: 'esm' })

// Pure host hook codecs; shipped beside the frozen executable entry points, with no MCP dependency.
for (const host of ['claude', 'codex']) {
  await build({ entryPoints: [`packages/room-mcp/src/hosts/${host}-hook-codec.ts`], outfile: `plugins/room/hooks/${host}-hook-codec.mjs`,
    bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'info' })
}

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

// The active installed bundle carries its own immutable contract, independent of
// directory names/cache order. Worker preflight verifies this digest before use.
const { createHash } = await import('node:crypto')
const descriptorModule = await build({
  stdin: {
    contents: "export { CURRENT_COMPAT } from '@room/hub-core'; export { WORKER_RECORD_SCHEMA } from '@room/shared'",
    resolveDir: process.cwd(), sourcefile: 'compat-descriptor.mjs', loader: 'js',
  },
  tsconfig: 'tsconfig.base.json', bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false,
})
const { CURRENT_COMPAT, WORKER_RECORD_SCHEMA } = await import(`data:text/javascript;base64,${Buffer.from(descriptorModule.outputFiles[0].text).toString('base64')}`)
const descriptor = {
  v: 2, release, compat: CURRENT_COMPAT, workerRecordSchema: WORKER_RECORD_SCHEMA,
  bundleSha256: Object.fromEntries(['room-mcp.mjs', 'room-mcp-app.mjs', 'room-daemon.mjs', 'room-daemon-app.mjs', 'room-state.mjs', 'room-state-app.mjs', 'parse-worker.mjs', 'gate-worker.mjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join('plugins/room/server', file))).digest('hex')])),
}
fs.writeFileSync('plugins/room/server/compat.json', JSON.stringify(descriptor, null, 2) + '\n')
console.log('stamped plugins/room/server/compat.json')
