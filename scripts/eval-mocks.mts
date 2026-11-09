// Regenerates the Room tool definitions the `claude plugin eval` suite mocks, from room-mcp's DEFS.
//
// Run:        npm run eval:mocks   (from the repository root; the output path resolves from this file). Needs `npm ci`.
// Overwrites: evals/mocks/room/_tools.json. Rerun after any tool name, description or schema change,
//             then rerun the eval suite (CLAUDE.md, "Running and testing").
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

// Every advertised tool needs a mock reply file next to _tools.json, or the eval agent cannot call it at all
// (the suite then scores the tool as never used, which looks like a routing failure).
const mockDir = fileURLToPath(new URL('../evals/mocks/room/', import.meta.url))
const missing = tools.map(t => t.name).filter(name => !fs.existsSync(`${mockDir}${name}.md`))
if (missing.length) {
  console.error(`Missing mock reply file(s) in evals/mocks/room: ${missing.map(n => `${n}.md`).join(', ')}`)
  process.exit(1)
}
