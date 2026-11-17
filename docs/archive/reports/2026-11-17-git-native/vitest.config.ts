import { defineConfig } from 'vitest/config'
import { shared } from '../../../../vitest.shared'
export default defineConfig({ test: { ...shared, include: ['docs/archive/reports/2026-11-17-git-native/correctness.test.ts'], fileParallelism: false, maxWorkers: 1, testTimeout: 60000 } })
