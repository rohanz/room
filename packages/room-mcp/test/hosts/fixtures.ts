/** Sanitized current-code captures, 2026-11-05, baseline cf81702d09.
 * These are protocol/argv fixtures, not evidence of live native-host acceptance.
 * Sources: worker-config.ts, wake-path.ts, doctor.ts, hooks/{session-start,before-edit,common}.mjs;
 * Claude common fields/cap: host-survey-2026-11-05-claude.md (2.1.318; main snapshot).
 * Codex PreToolUse cwd: docs/archive/reports/host-survey-2026-11-05-codex.md (0.166.0).
 */
import type {
  HostAdapter, HostId, Env, ProcessIdentity, Runtime, Target, PreBindingEvidence,
  StartupFacts, CallFacts, BindingEvidence, IdentityResult, TurnState, WakeVia,
  WakeResult, WakeStatus, WorkerInput, WorkerCommandInput, WorkerPlan, HookEvent,
  NormalizedLogFact, InstallEvidence, LogContext, TranscriptEvidence,
} from '../../src/hosts/types.js'

export const sessionId = '11111111-2222-4333-8444-555555555555'
const filter = 'shell_environment_policy.filters={"ROOM_*"="exclude"}'
const claudeTail = ['--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__room__*,mcp__plugin_room_room__*,Edit,Write,Read,Bash,Glob,Grep']
export const argvFixtures = [
  { host: 'claude', mode: 'fresh', args: ['-p', 'fixture task', ...claudeTail, '--model', 'fixture-model', '--effort', 'low', '--name', 'fixture', '--session-id', sessionId, '--max-budget-usd', '2.50'] },
  { host: 'claude', mode: 'resume', args: ['-p', '--resume', sessionId, 'fixture task', ...claudeTail, '--model', 'fixture-model', '--effort', 'low', '--name', 'fixture', '--max-budget-usd', '2.50'] },
  { host: 'codex', mode: 'fresh', args: ['exec', '-s', 'workspace-write', '-c', filter, '-m', 'fixture-model', '-c', 'model_reasoning_effort=minimal', '--json', 'fixture task'] },
  { host: 'codex', mode: 'resume', args: ['exec', 'resume', sessionId, '-c', 'sandbox_mode="workspace-write"', '-c', filter, '-m', 'fixture-model', '-c', 'model_reasoning_effort=minimal', '--json', 'fixture task'] },
] satisfies { host: HostId; mode: WorkerInput['mode']; args: string[] }[]

export const hookEnvelopes = [
  { host: 'claude', argv: ['--host', 'claude'], raw: { hook_event_name: 'SessionStart', session_id: sessionId, prompt_id: 'fixture-prompt', scratchpad_dir: '/fixture/scratch', permission_mode: 'acceptEdits', cwd: '/fixture/repo', source: 'startup', transcript_path: '/fixture/transcript.jsonl', model: 'fixture-model', effort: { level: 'high' } } },
  { host: 'codex', argv: [], raw: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: '/fixture/repo', source: 'startup', model: 'fixture-model' } },
] as const
export const toolEnvelopes = [
  { host: 'claude', raw: { session_id: sessionId, hook_event_name: 'PreToolUse', cwd: '/fixture/repo', tool_name: 'Bash', tool_input: { command: 'printf x > src/a.ts' } }, dialect: 'posix', paths: ['src/a.ts'] },
  { host: 'claude', raw: { session_id: sessionId, hook_event_name: 'PreToolUse', cwd: '/fixture/repo', tool_name: 'PowerShell', tool_input: { command: "Set-Content -Path 'src/a.ts' -Value x" } }, dialect: 'powershell', paths: ['src/a.ts'] },
  // Codex 0.166.0 supplies the command-local cwd, which can differ from SessionStart's cwd.
  { host: 'codex', raw: { session_id: sessionId, hook_event_name: 'PreToolUse', cwd: '/fixture/repo/subdir', tool_name: 'Bash', tool_input: { command: 'printf x > src/a.ts' } }, dialect: 'posix', paths: ['src/a.ts'] },
  { host: 'codex', raw: { session_id: sessionId, hook_event_name: 'PreToolUse', cwd: '/fixture/repo', tool_name: 'exec_command', tool_input: { cmd: 'printf x > src/a.ts' } }, dialect: 'posix', paths: ['src/a.ts'] },
  { host: 'codex', raw: { session_id: sessionId, hook_event_name: 'PreToolUse', cwd: '/fixture/repo', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch' } }, dialect: undefined, paths: ['src/a.ts'] },
  { host: 'claude', raw: { session_id: sessionId, hook_event_name: 'PreToolUse', cwd: '/fixture/repo', tool_name: 'Write', tool_input: { file_path: 'src/a.ts', content: 'x' } }, dialect: undefined, paths: ['src/a.ts'] },
] as const

/** Compile-time examples for every port, including absent optional capabilities. No runtime adapter. */
export const portExamples: {
  host: HostId; env: Env; process: ProcessIdentity; runtime: Runtime; target: Target;
  preBinding: PreBindingEvidence; startup: StartupFacts; call: CallFacts; binding: BindingEvidence;
  identity: IdentityResult; turn: TurnState; via: WakeVia; wake: WakeResult; status: WakeStatus;
  worker: WorkerInput; command: WorkerCommandInput; plan: WorkerPlan; hook: HookEvent;
  logs: readonly NormalizedLogFact[]; install: InstallEvidence; context: LogContext; transcript: TranscriptEvidence;
  optionalFacets: Pick<HostAdapter, 'wake' | 'worker' | 'hooks' | 'createLogDecoder'>;
} = {
  host: 'claude', env: {}, process: { pid: 42, startTime: 'start', executable: 'claude' },
  runtime: {}, target: { host: 'claude', id: sessionId, surface: 'interactive' },
  preBinding: { env: {}, processDir: '/fixture/repo', platform: 'linux' },
  startup: { fallbackDir: '/fixture/repo', deferWorkspace: false, presenceKind: 'interactive' },
  call: { toolSessionId: sessionId, workspaceCandidates: [] }, binding: { cwd: '/fixture/repo', env: {}, records: [] },
  identity: { kind: 'pending', reason: 'unbound', initialJoinWaitMs: 5000 }, turn: { kind: 'unknown', source: 'host', reason: 'unavailable' },
  via: 'socket', wake: { kind: 'uncertain', via: 'turn' },
  status: { mode: 'auto', transport: 'socket', availability: 'configured', limitation: 'write does not prove acceptance' },
  worker: { mode: 'fresh', prompt: 'fixture task', runtime: {}, tag: 'fixture', cwd: '/fixture/repo', logDir: '/fixture/logs', env: {}, shellEnvHook: false },
  command: { mode: 'resume', sessionId, prompt: 'fixture task', runtime: {}, tag: 'fixture', shellEnvHook: false },
  plan: { cmd: 'claude', args: ['-p', 'fixture task'], envPatch: {}, artifacts: [{ id: 'shell-env', path: '/fixture/logs/env.sh', content: '# fixture', mode: 0o600 }], artifactEnv: [{ artifactId: 'shell-env', key: 'CLAUDE_ENV_FILE' }], warnings: [] },
  hook: { event: 'before-tool', sessionId, cwd: '/fixture/repo', incomplete: false, subagent: false, runtime: {}, tool: { kind: 'shell', originalName: 'PowerShell', shellDialect: 'powershell', input: { command: 'Set-Content src/a.ts x' } } },
  logs: [
    { kind: 'session', id: sessionId }, { kind: 'resume-accepted', id: sessionId }, { kind: 'session-missing', id: sessionId },
    { kind: 'final', slot: 'preferred', text: 'done' }, { kind: 'final', slot: 'fallback', text: 'assistant' },
    { kind: 'activity', text: 'Edit src/a.ts', eventTimeMs: 1 }, { kind: 'activity', text: 'Edit src/a.ts' },
    { kind: 'failure', failure: { text: 'busy', transient: 'model capacity' } }, { kind: 'failure', failure: undefined },
    { kind: 'background', state: 'result-boundary' }, { kind: 'background', id: 'task', state: 'open', shell: true },
    { kind: 'background', id: 'task', state: 'backgrounded' }, { kind: 'background', id: 'task', state: 'closed' },
  ],
  install: { cli: 'unknown', listing: 'unknown', plugin: 'unknown', hookTrust: 'unknown', remedies: [] },
  context: { workerId: 'fixture', run: 2, logStart: 100, dir: '/fixture/repo', scope: 'diagnostic-suffix' },
  transcript: { sessionRecord: {}, previousRuntime: {}, transcript: { path: '/fixture/transcript.jsonl', mtimeMs: 1, size: 2, tail: '{}', startsMidFile: true } },
  optionalFacets: {},
}
