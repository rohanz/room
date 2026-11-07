import { expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
// Host-owned source is audited under src/hosts; hook-codecs.test.ts checks these exact bundles for freshness.
// Generated from packages/room-mcp/src/hosts by scripts/build-plugin.mjs; hook-codecs.test.ts checks each is fresh.
const generatedCodecs = new Set(['plugins/room/hooks/claude-hook-codec.mjs', 'plugins/room/hooks/codex-hook-codec.mjs', 'plugins/room/hooks/session-host.mjs'])
const inventory = JSON.parse(fs.readFileSync(new URL('./host-branches.json', import.meta.url), 'utf8')) as {
  pattern: string; entries: { path: string; line: number; text: string; reason: string }[]
}

const hostIdentifier = /\b(?:Claude|Codex)[A-Z][A-Za-z0-9_]*\b/
it.each(['new CodexTurnProbe()', 'value: CodexWakeProbe', 'new ClaudeWorker()'])(
  'audits host-specific PascalCase identifiers: %s', text => { expect(hostIdentifier.test(text)).toBe(true) },
)

it('keeps host interpretation inside adapters or the documented compatibility boundaries', () => {
  // Audit executable host identifiers; generic inbox policy and comments are not host interpretation.
  // Adapter imports are entry points; every remaining literal must name an explicit boundary.
  // Match counts also reject stale entries, while line numbers remain review aids only.
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
        lines.forEach((text, index) => { if ((pattern.test(text) || hostIdentifier.test(text)) && !/^\s*(?:\/\/|\/\*|\*)/.test(text)) matches.push({ file, line: index + 1, text: text.trim() }) })
      }
    }
  }
  walk('packages/room-mcp/src')
  walk('plugins/room/hooks')
  const allowed = new Map<string, number>()
  for (const row of inventory.entries) {
    expect(row.reason).toMatch(/persisted format|frozen hook invocation contract|wire protocol/)
    const key = `${row.path}\0${row.text}`
    allowed.set(key, (allowed.get(key) ?? 0) + 1)
  }
  const additions: string[] = []
  for (const { file, line, text } of matches) {
    if (/^(?:import|export)\b.*from ['"].*hosts\//.test(text)) continue
    const key = `${file}\0${text}`, remaining = allowed.get(key) ?? 0
    if (remaining) allowed.set(key, remaining - 1)
    else additions.push(`${file}:${line}: ${text}`)
  }
  expect([...allowed.entries()].filter(([, count]) => count > 0), 'Remove obsolete boundary entries').toEqual([])
  expect(additions, 'New host-specific lines need adapter ownership or an explicitly reviewed compatibility exclusion; shrink the baseline as mechanisms move.').toEqual([])
})
