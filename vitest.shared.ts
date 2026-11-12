import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * `TEST_SCALE=1` is a separate pass, not a superset: it runs only the files that hold scale and
 * responsiveness cases, one file at a time. Those cases build repositories of thousands of files and
 * measure event-loop stalls; beside the rest of the suite they starve it and are starved by it.
 */
const scale = process.env.TEST_SCALE === '1'

function scaleFiles(base: string, roots: string[]): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const at = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(at)
      else if (entry.name.endsWith('.test.ts') && fs.readFileSync(at, 'utf8').includes('TEST_SCALE')) found.push(path.relative(base, at).split(path.sep).join('/'))
    }
  }
  for (const root of roots) if (fs.existsSync(root)) walk(root)
  return found.sort()
}

export const shared = {
  testTimeout: 20000, setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))],
  ...(scale ? { fileParallelism: false } : {}),
}

/** Test files for a run started in `base`: every test file, or only the scale files when `TEST_SCALE=1`. */
export function testFiles(base: string, globs: string[], roots: string[]): string[] {
  return scale ? scaleFiles(base, roots.map(root => path.join(base, root))) : globs
}

/** vitest looks for a config only in its working directory: each package's vitest.config.ts is this one. */
export const packageConfig = defineConfig({
  test: { include: testFiles(process.cwd(), ['src/**/*.test.ts', 'test/**/*.test.ts'], ['src', 'test']), passWithNoTests: scale, ...shared },
})
