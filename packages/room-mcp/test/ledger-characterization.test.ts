// Ledger test 15: one receipt writer, and no hook takes message content from a file.
import { expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '../../..')
const files = (dir: string, match: RegExp): string[] => readdirSync(dir).flatMap(name => {
  const full = join(dir, name)
  if (statSync(full).isDirectory()) return name === 'node_modules' || name === 'test' ? [] : files(full, match)
  return match.test(name) && !/\.test\.ts$/.test(name) ? [full] : []
})

it('markSeen( appears only at confirmed delivery boundaries and in shared primitives', () => {
  const sources = readdirSync(join(ROOT, 'packages')).flatMap(p => { try { return files(join(ROOT, 'packages', p, 'src'), /\.ts$/) } catch { return [] } })
  const writers = sources.filter(f => readFileSync(f, 'utf8').includes('markSeen(')).map(f => relative(ROOT, f)).sort()
  const allowed = ['packages/room-mcp/src/ledger.ts', 'packages/room-mcp/src/worker-projector.ts',
    'packages/agent/src/runner.ts', 'packages/shared/src/delivery.ts', 'packages/shared/src/doc.ts']
  expect(writers.filter(f => !allowed.includes(f))).toEqual([])
})

it('no hook reads message content from a file', () => {
  for (const file of files(join(ROOT, 'plugins/room/hooks'), /\.mjs$/)) {
    const text = readFileSync(file, 'utf8')
    for (const legacy of [/room-hook-seen/, /room-state\.json/, /\bunread\b/, /pendingDisclosure/, /pendingNotice/, /notice-lock/]) {
      expect(text, `${relative(ROOT, file)} mentions ${legacy}`).not.toMatch(legacy)
    }
  }
})
