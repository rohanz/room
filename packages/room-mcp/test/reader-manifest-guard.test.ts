import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readers = [
  '../src/tools/state.ts', '../src/tools/context.ts', '../src/tools/combined-tree.ts',
  '../src/tools/files.ts', '../src/tools/scope.ts', '../src/tools/messaging.ts',
  '../src/tools/workers.ts', '../src/tools/join.ts', '../src/graph-index.ts', '../src/conflicts.ts',
  '../../shared/src/near.ts', '../../shared/src/views.ts',
]

describe('manifest reader boundary', () => {
  it('keeps direct overlay text access in versionOf and the daemon', () => {
    for (const relative of readers) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      expect(source, relative).not.toMatch(/\broom(?:Doc)?\.(?:overlays|overlayText|text)\b/)
    }
  })
})
