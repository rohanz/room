import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

// A daemon started on its own holds no hub lease, so schema-2 readers reject what it publishes (its records carry
// no authoritative holder). roomd runs only inside a session that acquired its name: the plugin's MCP or roomagent.
it('ships no standalone roomd entry point', () => {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { bin?: unknown; scripts?: Record<string, string> }
  const root = JSON.parse(fs.readFileSync(path.join(pkgDir, '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  expect(pkg.bin).toBeUndefined()
  expect(pkg.scripts?.start).toBeUndefined()
  expect(root.scripts.roomd).toBeUndefined()
  expect(fs.existsSync(path.join(pkgDir, 'src', 'cli.ts'))).toBe(false)
})
