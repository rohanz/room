import { defineConfig } from 'vitest/config'
import { shared } from './vitest.shared'

export default defineConfig({
  test: { include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'], ...shared },
})
