import { fileURLToPath } from 'node:url'

/** Executable startup fixture, independent of whether Vitest runs from the root or package. */
export const mcpEntrypoint = fileURLToPath(new URL('../../src/index.ts', import.meta.url))
