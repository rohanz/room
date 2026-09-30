import { overrideLimitsForTest } from '../../src/limits.js'

// Pass options as arguments so the production server has no environment shortcuts for fixed limits.
overrideLimitsForTest(JSON.parse(process.argv[2]))
await import('../../src/index.js')
