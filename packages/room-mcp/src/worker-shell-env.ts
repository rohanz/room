/** Temporary compatibility entry points; host encodings live with their worker adapters. */
import type { WorkerHost } from './worker-config.js'
import { workerAdapter } from './hosts/index.js'
import { claudeShellArtifacts as shellArtifacts } from './hosts/claude-shell.js'
import { writeWorkerArtifacts } from './worker-artifacts.js'
export { workerShellEnvScript, POWERSHELL_HOOK_ARGS } from './hosts/claude-shell.js'
export { CODEX_SHELL_FILTER, codexShellFilterWarning } from './hosts/codex-shell.js'

export interface WorkerShellEnv { file?: string; warning?: string }

/** Write beside the worker's log using the same secure path as shared launch. */
export function writeWorkerShellEnv(leadDir: string, tag: string, inherited = process.env.CLAUDE_ENV_FILE): WorkerShellEnv {
  const plan = shellArtifacts(leadDir, tag, inherited)
  const written = writeWorkerArtifacts(leadDir, { ...plan, envPatch: {} })
  const outcome = written.outcomes[0]
  return outcome.written ? { file: outcome.path } : { warning: plan.artifactWarnings(written.outcomes)[0] }
}

/** Compatibility warning reader; process-wide version caching remains host-owned. */
export async function workerShellEnvWarnings(host: WorkerHost, written: WorkerShellEnv,
  version?: () => Promise<string | undefined>): Promise<string[]> {
  return workerAdapter(host).shellWarnings(written, version)
}
