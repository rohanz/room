import { execFile } from 'node:child_process'

export const CODEX_SHELL_FILTER = 'shell_environment_policy.filters={"ROOM_*"="exclude"}'
const CODEX_SHELL_FILTER_SINCE = [0, 146, 0]

export function codexShellFilterWarning(version: string | undefined): string | undefined {
  const parts = version?.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number)
  if (!parts) return undefined
  for (let i = 0; i < 3; i++) if (parts[i] !== CODEX_SHELL_FILTER_SINCE[i]) {
    return parts[i] > CODEX_SHELL_FILTER_SINCE[i] ? undefined
      : `warning: ${version!.trim()} predates shell_environment_policy.filters (${CODEX_SHELL_FILTER_SINCE.join('.')}), so this worker's shell commands still see Room's ROOM_* variables; update Codex.`
  }
  return undefined
}

let codexVersion: Promise<string | undefined> | undefined
/** Read once per process, off the event loop: a synchronous read stalled every other tool call (R4, 2026-10-02). */
function installedCodexVersion(): Promise<string | undefined> {
  codexVersion ??= new Promise(resolve => execFile('codex', ['--version'], { encoding: 'utf8', timeout: 5000 },
    (error, stdout) => resolve(error ? undefined : stdout.trim())))
  return codexVersion
}

export async function codexShellWarnings(_written: { warning?: string },
  codex: () => Promise<string | undefined> = installedCodexVersion): Promise<string[]> {
  return [codexShellFilterWarning(await codex())].filter((w): w is string => !!w)
}
