#!/usr/bin/env node
/** Only bootstrap-safe code runs before the daemon application is loaded. */
import fs from 'node:fs'
import { preflightDiagnostic } from '@room/local-state/preflight'
import { bootstrap } from '@room/local-state/bootstrap'

const args = process.argv.slice(2)
const index = args.indexOf('--common-dir')
const commonDir = index < 0 ? undefined : args[index + 1]
if (!commonDir || commonDir.startsWith('--')) {
  process.stderr.write('Room daemon: missing --common-dir\n')
  process.exitCode = 1
} else {
  const result = await bootstrap('daemon', async result => {
    const { main } = await import('./daemon-app.js')
    await main(args, result)
  }, { commonDir })
  if (!result.ok) {
    // The launcher ignores detached stdio. Its private temporary report is outside Room state.
    const report = args.indexOf('--startup-report')
    if (report >= 0 && args[report + 1]) {
      try { fs.writeFileSync(args[report + 1], preflightDiagnostic(result), { flag: 'wx', mode: 0o600 }) } catch { /* launcher still observes the failed exit */ }
    }
  }
}
