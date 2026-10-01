import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export const shared = { testTimeout: 20000, setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))] }
/** vitest looks for a config only in its working directory: each package's vitest.config.ts is this one. */
export const packageConfig = defineConfig({ test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'], ...shared } })
