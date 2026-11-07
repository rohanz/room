/** Bootstrap-safe entry barrier. Loading the application is deliberately a callback. */
import { preflight, preflightDiagnostic, type PreflightOptions } from './preflight.js'
import type { PreflightResult, PreflightSurface } from './protocol.js'

export async function bootstrap(
  surface: PreflightSurface,
  load: (result: Extract<PreflightResult, { ok: true }>) => Promise<unknown>,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const result = await preflight(surface, options)
  if (!result.ok) {
    process.stderr.write(`${preflightDiagnostic(result)}\n`)
    process.exitCode = 1
    return result
  }
  await load(result)
  return result
}
