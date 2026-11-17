/** Shadow checkout reads must not depend on the host's Git/LFS installation. */
import path from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'

beforeEach(() => {
  // vitest.setup.ts owns this empty configuration directory for the test file.
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(process.env.XDG_CONFIG_HOME!, 'shadow-no-global-config'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_ATTR_NOSYSTEM', '1')
})
afterEach(() => vi.unstubAllEnvs())
