import fs from 'node:fs'
import { waitForPreviewSweepForTests } from '../../src/tools/files.js'
import { closeRegistryForDir } from '../../src/worker-registry.js'

/** Only for fixtures that start preview maintenance. Stop producers before closing their registries. */
export async function disposePreviewFixture(root: string, options: {
  registries?: string[]
  stop?: () => void | Promise<void>
} = {}): Promise<void> {
  await options.stop?.()
  for (const dir of options.registries ?? []) await closeRegistryForDir(dir)
  await waitForPreviewSweepForTests()
  await fs.promises.rm(root, { recursive: true, force: true })
}
