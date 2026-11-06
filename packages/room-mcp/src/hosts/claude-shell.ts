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
import path from 'node:path'
import type { WorkerLaunchPlan } from './types.js'

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

// Inline Node hook, installed only in this worker's settings and run with `node -e`: a hook file in the lead's tree
// would be linted, formatted and type-checked by the project as its own code. Exec-form args need no shell quoting. Do not hide the original command in a script/encoded payload: normal permission review must see
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

/** The exec-form `node` arguments of the worker's PowerShell PreToolUse hook. */
export const POWERSHELL_HOOK_ARGS = ['--input-type=module', '-e', POWERSHELL_HOOK]

/** Pure shell-artifact encoding; shared launch owns validation, writes and conditional env. */
export function claudeShellArtifacts(logDir: string, tag: string, inherited?: string): Pick<WorkerLaunchPlan, 'artifacts' | 'artifactEnv' | 'artifactWarnings'> {
  const file = path.join(logDir, '.room', 'workers', `${tag}.env.sh`)
  return {
    artifacts: [{ id: 'shell-env', path: file, content: workerShellEnvScript(inherited), mode: 0o600 }],
    artifactEnv: [{ artifactId: 'shell-env', key: 'CLAUDE_ENV_FILE' }],
    artifactWarnings: outcomes => outcomes.filter(outcome => !outcome.written).map(outcome =>
      `warning: could not write ${outcome.path} (${outcome.error}); ${tag}'s Bash commands still see Room's ROOM_* variables.`),
  }
}

export function claudeShellEnv(file?: string): Record<string, string> { return file ? { CLAUDE_ENV_FILE: file } : {} }
export async function claudeShellWarnings(written: { warning?: string }): Promise<string[]> { return written.warning ? [written.warning] : [] }
