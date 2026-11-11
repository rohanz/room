import { overrideSettingsForTest } from '../../src/settings.js'
import { overrideLimitsForTest } from '../../src/limits.js'

// Pass options as arguments so the production server has no environment shortcuts for fixed limits.
overrideLimitsForTest(JSON.parse(process.argv[2]))
overrideSettingsForTest(JSON.parse(process.argv[3] ?? '{}'))
await import('../../src/index.js')
