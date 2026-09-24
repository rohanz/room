import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFS } from '../packages/room-mcp/src/tools/index.js'

const mockPath = fileURLToPath(new URL('../evals/mocks/room/_tools.json', import.meta.url))
const tools = DEFS.map(({ name, annotations, description, inputSchema }) => ({
  name, annotations, description, inputSchema,
}))
const json = JSON.stringify({ tools }, null, 2).replace(/[^\x00-\x7F]/g, character =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
fs.writeFileSync(mockPath, json)
console.log(`Wrote ${tools.length} Room tool definitions to ${mockPath}`)
