// Stamp a new Room release version into every file that carries it.
// Usage: npm run bump -- 0.17.16
// Sites: both plugin manifests, the marketplace entry and the hooks version
// constant (hooks.json is frozen, so the hook scripts carry their own stamp).
// The server bundle copies the Claude manifest at build time: rebuild after bumping.
// packages/room-mcp/test/release-version.test.ts checks the sites agree.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/bump-version.mjs <major.minor.patch>')
  process.exit(2)
}

const json = (rel, edit) => {
  const file = path.join(root, rel)
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  edit(data)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  console.log(`${rel}: ${version}`)
}

json('plugins/room/.claude-plugin/plugin.json', d => { d.version = version })
json('plugins/room/.codex-plugin/plugin.json', d => { d.version = version })
json('.claude-plugin/marketplace.json', d => { d.plugins.find(p => p.name === 'room').version = version })

const hooks = path.join(root, 'plugins/room/hooks/common.mjs')
const text = fs.readFileSync(hooks, 'utf8')
const next = text.replace(/export const HOOKS_VERSION = '[^']+'/, `export const HOOKS_VERSION = '${version}'`)
if (next === text) throw new Error('HOOKS_VERSION not found in plugins/room/hooks/common.mjs')
fs.writeFileSync(hooks, next)
console.log(`plugins/room/hooks/common.mjs: ${version}`)
console.log('now: npm run build:plugin, and add the CHANGELOG heading')
