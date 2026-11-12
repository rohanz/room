import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { shared, testFiles } from './vitest.shared'

const packages = fs.readdirSync(path.join(process.cwd(), 'packages')).flatMap(name => [`packages/${name}/src`, `packages/${name}/test`])

export default defineConfig({
  test: { include: testFiles(process.cwd(), ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'], packages), ...shared },
})
