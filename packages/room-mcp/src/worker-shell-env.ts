/**
 * Room's coordination variables (ROOM_WORKER_ID, ROOM_TOKEN, ROOM_REGISTRY and the rest of workerProcessEnv) are for
 * the worker's own Room MCP server. The commands the worker's shell runs must not see them: a test suite, or a Room
 * the worker is developing, would otherwise act as that worker. Both hosts give MCP servers their environment
 * separately from shell commands, so each host's shell is filtered and its MCP server is not:
 * - Claude Code runs CLAUDE_ENV_FILE in the Bash tool's shell before each command; MCP servers and hooks never read
 *   it, and SessionStart hooks get env files of their own, which Claude Code runs as well (verified on 2.1.286). The
 *   PowerShell tool does not run it: a worker-specific PreToolUse hook returns a visible scrub prefix through
 *   updatedInput (supported since 2.0.10), without approving the command. This is best-effort isolation: Claude
 *   may proceed if a hook cannot start or times out. CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is no substitute: it strips
 *   only credentials, and from MCP servers and hooks too.
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

// Standalone Node hook, installed only in this worker's settings. Exec-form args preserve Windows paths without
// shell quoting. Do not hide the original command in a script/encoded payload: normal permission review must see
// the modified command. No allow decision, no environment changes in the host/MCP/hook process.
const POWERSHELL_HOOK = String.raw`import fs from 'node:fs'
const deny = reason => console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
} }))
let event
try { event = JSON.parse(fs.readFileSync(0, 'utf8')) }
catch { deny('Room could not read the PowerShell hook input; retry the tool call.'); process.exit(0) }
if (event?.hook_event_name && event.hook_event_name !== 'PreToolUse') process.exit(0)
if (event?.tool_name && event.tool_name !== 'PowerShell') process.exit(0)
if (event?.hook_event_name !== 'PreToolUse' || event?.tool_name !== 'PowerShell') {
  deny('Room cannot identify this PowerShell hook event; retry the tool call.'); process.exit(0)
}
const input = event.tool_input
if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.command !== 'string') {
  deny('Room cannot isolate this malformed PowerShell input; supply a command string.'); process.exit(0)
}
// Deliberately conservative text check, not a PowerShell parser. Declarations can depend on being first; a
// prefix could invalidate them. This also rejects matches in strings/comments. Invoke a .ps1 file instead.
if (/\bparam\b|^\s*#requires\b|^\s*using\b/im.test(input.command)) {
  deny('Room cannot prefix PowerShell commands containing param, #requires or using declarations. Put the command in a .ps1 file and invoke that file instead.'); process.exit(0)
}
const prefix = 'Get-ChildItem Env:ROOM_* | Remove-Item -ErrorAction Stop\n'
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: {
  ...input, command: input.command.startsWith(prefix) ? input.command : prefix + input.command,
} } }))
`

export interface WorkerShellEnv { file?: string; hook?: string; warning?: string }

/** Write shell artifacts beside the worker's log (cleanupWorkerLogs removes them), never through a planted link. */
export function writeWorkerShellEnv(leadDir: string, tag: string, inherited = process.env.CLAUDE_ENV_FILE): WorkerShellEnv {
  const file = path.join(leadDir, '.room', 'workers', `${tag}.env.sh`)
  const hook = path.join(leadDir, '.room', 'workers', `${tag}.shell-env.mjs`)
  let writtenFile: string | undefined
  try {
    // `wx` guards only the last component: a linked `.room` or `workers` would move the write elsewhere.
    for (const dir of [path.join(leadDir, '.room'), path.dirname(file)]) {
      try { fs.mkdirSync(dir) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
      if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`)
    }
    fs.rmSync(file, { force: true })
    fs.writeFileSync(file, workerShellEnvScript(inherited), { mode: 0o600, flag: 'wx' })
    writtenFile = file
    fs.rmSync(hook, { force: true })
    fs.writeFileSync(hook, POWERSHELL_HOOK, { mode: 0o600, flag: 'wx' })
    return { file, hook }
  } catch (e) {
    return { ...(writtenFile ? { file: writtenFile } : {}), warning: `warning: could not write ${writtenFile ? hook : file} (${e instanceof Error ? e.message : String(e)}); ${tag}'s ${writtenFile ? 'PowerShell' : 'shell'} commands still see Room's ROOM_* variables.` }
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
export async function workerShellEnvWarnings(tag: string, host: WorkerHost, written: WorkerShellEnv,
  platform: NodeJS.Platform = process.platform, codex: () => Promise<string | undefined> = installedCodexVersion): Promise<string[]> {
  if (host === 'codex') return [codexShellFilterWarning(await codex())].filter((w): w is string => !!w)
  return [
    ...(written.warning ? [written.warning] : []),
    ...(platform === 'win32' && !written.hook ? [`note: Claude's PowerShell tool does not run CLAUDE_ENV_FILE and its scrub hook is unavailable, so ${tag}'s PowerShell commands still see Room's ROOM_* variables.`] : []),
  ]
}
