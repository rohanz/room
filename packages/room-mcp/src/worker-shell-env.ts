/**
 * Room's coordination variables (ROOM_WORKER_ID, ROOM_TOKEN, ROOM_REGISTRY and the rest of workerProcessEnv) are for
 * the worker's own Room MCP server. The commands the worker's shell runs must not see them: a test suite, or a Room
 * the worker is developing, would otherwise act as that worker. Both hosts give MCP servers their environment
 * separately from shell commands, so each host's shell is filtered and its MCP server is not:
 * - Claude Code runs CLAUDE_ENV_FILE in the Bash tool's shell before each command; MCP servers and hooks never read
 *   it, and SessionStart hooks get env files of their own, which Claude Code runs as well (verified on 2.1.286). The
 *   PowerShell tool does not run it. CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is no substitute: it strips only credentials,
 *   and from MCP servers and hooks too.
 * - Codex applies shell_environment_policy to the commands it runs (keyed `filters` since 0.146.0; older builds
 *   ignore the key) and passes its MCP servers the env_vars allow-list in plugins/room/codex-mcp.json. Filters merge
 *   with the user's own policy across config layers; the legacy `exclude` array would replace it.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { WorkerHost } from './worker-config.js'

export const CODEX_SHELL_FILTER = 'shell_environment_policy.filters={"ROOM_*"="exclude"}'
const CODEX_SHELL_FILTER_SINCE = [0, 146, 0]

// POSIX sh, bash and zsh alike: zsh splits an unquoted command substitution too, and has no compgen.
const UNSET_ROOM = `for v in $(env | sed -n 's/^\\(ROOM_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$v"; done`

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** The worker's CLAUDE_ENV_FILE: the lead's own env file first, if it had one, then no ROOM_ variable. */
export function workerShellEnvScript(inherited?: string): string {
  return [
    '# Written by Room for one worker. Claude Code runs this before each Bash command.',
    ...(inherited ? [`[ -f ${quote(inherited)} ] && . ${quote(inherited)}`] : []),
    UNSET_ROOM, '',
  ].join('\n')
}

/** Write the env file beside the worker's log (cleanupWorkerLogs removes it), never through a link planted there. */
export function writeWorkerShellEnv(leadDir: string, tag: string, inherited = process.env.CLAUDE_ENV_FILE): { file?: string; warning?: string } {
  const file = path.join(leadDir, '.room', 'workers', `${tag}.env.sh`)
  try {
    // `wx` guards only the last component: a linked `.room` or `workers` would move the write elsewhere.
    for (const dir of [path.join(leadDir, '.room'), path.dirname(file)]) {
      try { fs.mkdirSync(dir) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
      if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`)
    }
    fs.rmSync(file, { force: true })
    fs.writeFileSync(file, workerShellEnvScript(inherited), { mode: 0o600, flag: 'wx' })
    return { file }
  } catch (e) {
    return { warning: `warning: could not write ${file} (${e instanceof Error ? e.message : String(e)}); ${tag}'s shell commands still see Room's ROOM_* variables.` }
  }
}

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

/** What the spawn or resume reply says when the worker's shell commands will still see ROOM_ variables. */
export async function workerShellEnvWarnings(tag: string, host: WorkerHost, written: { file?: string; warning?: string },
  platform: NodeJS.Platform = process.platform, codex: () => Promise<string | undefined> = installedCodexVersion): Promise<string[]> {
  if (host === 'codex') return [codexShellFilterWarning(await codex())].filter((w): w is string => !!w)
  return [
    ...(written.warning ? [written.warning] : []),
    ...(platform === 'win32' ? [`note: Claude's PowerShell tool does not run CLAUDE_ENV_FILE, so ${tag}'s PowerShell commands still see Room's ROOM_* variables; its Bash commands do not.`] : []),
  ]
}
