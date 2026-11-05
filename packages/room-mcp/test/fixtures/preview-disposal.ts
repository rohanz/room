import fs from 'node:fs'
import { waitForPreviewSweepForTests } from '../../src/tools/files.js'
import { closeRegistryForDir } from '../../src/worker-registry.js'
import { stopTestDaemons } from '../daemon-fixture.js'

/** Stop session, registry, preview and daemon producers before removing their owned fixture root. */
export async function disposePreviewFixture(root: string, options: {
  registries?: string[]
  stop?: () => void | Promise<void>
} = {}): Promise<void> {
  await options.stop?.()
  for (const dir of options.registries ?? []) await closeRegistryForDir(dir)
  await waitForPreviewSweepForTests()
  if (!await stopTestDaemons(root)) return // An unowned/replacement daemon keeps its fixture files.
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
