import { expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
// Host-owned source is audited under src/hosts; hook-codecs.test.ts checks these exact bundles for freshness.
// Generated from packages/room-mcp/src/hosts by scripts/build-plugin.mjs; hook-codecs.test.ts checks each is fresh.
const generatedCodecs = new Set(['plugins/room/hooks/claude-hook-codec.mjs', 'plugins/room/hooks/codex-hook-codec.mjs', 'plugins/room/hooks/session-host.mjs'])
const inventory = JSON.parse(fs.readFileSync(new URL('./host-branches.json', import.meta.url), 'utf8')) as {
  baseline: string; pattern: string; entries: { path: string; line: number; text: string }[]
  compatibility: { path: string; text: string; reason: string }[]
}

it('keeps host interpretation inside adapters or the explicit pre-extraction allowlist', () => {
  // Capture every match, including generic inbox policy, comments, schemas and compatibility readers.
  // Line numbers are audit aids only: moving unrelated code must not invalidate the inventory.
  // Removing baseline entries is allowed; adding interpretations outside adapters is not.
  // Imports/re-exports from adapters are the explicit temporary compatibility boundary.
  // The baseline was captured with rg -n -i; enforce the same expression in Node so CI and
  // contributors need only the repository's existing Node dependency. Walk includes new files.
  const matches: { file: string; line: number; text: string }[] = []
  const pattern = new RegExp(inventory.pattern, 'i')
  const walk = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`
      if (file.startsWith('packages/room-mcp/src/hosts/')) continue
      if (generatedCodecs.has(file)) continue
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) {
        const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)
        lines.forEach((text, index) => { if (pattern.test(text)) matches.push({ file, line: index + 1, text: text.trim() }) })
      }
    }
  }
  walk('packages/room-mcp/src')
  walk('plugins/room/hooks')
  const allowed = new Map<string, number>()
  for (const row of [...inventory.entries, ...inventory.compatibility]) {
    const key = `${row.path}\0${row.text}`
    allowed.set(key, (allowed.get(key) ?? 0) + 1)
  }
  const additions: string[] = []
  for (const { file, line, text } of matches) {
    if (/^(?:import|export)\b.*from ['"]\.\/hosts\//.test(text)) continue
    const key = `${file}\0${text}`, remaining = allowed.get(key) ?? 0
    if (remaining) allowed.set(key, remaining - 1)
    else additions.push(`${file}:${line}: ${text}`)
  }
  expect(additions, 'New host-specific lines need adapter ownership or an explicitly reviewed compatibility exclusion; shrink the baseline as mechanisms move.').toEqual([])
})
