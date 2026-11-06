#!/usr/bin/env node
import { bootstrap } from '@room/local-state/bootstrap'
import { preflight, preflightDiagnostic } from '@room/local-state/preflight'

const argv = process.argv.slice(2)
const index = argv.indexOf('--common-dir')
const commonDir = index < 0 ? undefined : argv[index + 1]
if (index >= 0 && (!commonDir || commonDir.startsWith('--'))) {
  process.stderr.write('Room preflight: --common-dir requires a directory\n')
  process.exitCode = 1
} else if (argv[0] === 'preflight') {
  const result = await preflight('offline', { commonDir })
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`)
  else if (result.ok) process.stdout.write(`Room preflight OK: ${result.evidence.executable}, Node ${result.evidence.node}, SQLite ${result.evidence.sqlite}; storage ${result.storage}\n`)
  if (!result.ok) process.stderr.write(`${preflightDiagnostic(result)}\n`)
  process.exitCode = result.ok ? 0 : 1
} else {
  await bootstrap('offline', async () => {
    const { main } = await import('./room-state.js')
    process.exitCode = await main(argv)
  }, argv[0] === 'status' ? {} : { commonDir })
}
