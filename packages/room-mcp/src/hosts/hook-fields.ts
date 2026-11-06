/** Identical field encodings accepted by both current hosts, also used before a host record exists.
 * Pure and dependency-free: the hook bundles must never initialize an MCP adapter or read a transcript. */
import type { HookEvent, HostAdapter, TranscriptEvidence, Runtime } from './types.js'

export type HookRuntime = Runtime & {
  transcript?: { path: string; mtimeMs: number; size: number };
  [key: string]: unknown;
}
export type HookCodec = Omit<NonNullable<HostAdapter['hooks']>, 'decode' | 'reduceRuntime'> & {
  decode(event: HookEvent['event'], raw: unknown, argv: readonly string[], incomplete?: boolean): HookEvent;
  reduceRuntime(event: HookEvent, evidence: TranscriptEvidence): HookRuntime;
  tool(name: string, input: unknown): NonNullable<HookEvent['tool']>;
  command(input: unknown): unknown;
  pathFields(input: unknown): string[];
}

// These casts preserve the legacy readers' acceptance; validation/receipt admission stays shared.
const fields = (raw: unknown) => raw as Record<string, unknown>
const runtimeString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : undefined

export function hookTool(originalName: string, input: unknown): NonNullable<HookEvent['tool']> {
  const shell = /^(?:Bash|PowerShell|shell|local_shell|exec|exec_command|unified_exec)$/.test(originalName)
  return { originalName, input,
    kind: shell ? 'shell' : /(?:^|__)apply_patch$/.test(originalName) ? 'patch'
      : /(?:^|__)(?:Write|Edit|MultiEdit|NotebookEdit)$/.test(originalName) ? 'write' : 'other',
    ...(shell ? { shellDialect: originalName === 'PowerShell' ? 'powershell' : 'posix' } : {}),
  }
}
export const hookCommand = (input: unknown): unknown => fields(input)?.command ?? fields(input)?.cmd ?? input
export function hookPathFields(input: unknown): string[] {
  return input && typeof input === 'object'
    ? ['file_path', 'path', 'filePath'].flatMap(key => { const value = fields(input)[key]; return typeof value === 'string' ? [value] : [] }) : []
}

export function decodeHookFields(event: HookEvent['event'], raw: unknown, incomplete = false): HookEvent {
  const ev = fields(raw) ?? {}
  // Startup aliases are deliberately broader than before-tool's required session_id.
  const id = event === 'start' ? ev.session_id ?? ev.thread_id ?? ev.sessionId : ev.session_id
  const model = runtimeString(ev.model), effort = runtimeString(fields(ev.effort)?.level)
  return { event, sessionId: typeof id === 'string' ? id : undefined, cwd: ev.cwd as string | undefined,
    source: typeof ev.source === 'string' ? ev.source : undefined,
    subagent: (typeof ev.agent_id === 'string' && ev.agent_id !== '') || incomplete, incomplete,
    runtime: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
    ...(event === 'before-tool' ? { tool: hookTool(ev.tool_name as string, ev.tool_input) } : {}),
  }
}

export function reduceHookEffort(event: HookEvent, evidence: TranscriptEvidence): HookRuntime {
  return { ...evidence.previousRuntime as HookRuntime, ...(event.runtime.effort ? { effort: event.runtime.effort } : {}) }
}

/** The common context-only envelope; neither codec supplies a permission decision. */
export function hookContext(event: HookEvent['event'], text: string) {
  return { hookSpecificOutput: { hookEventName: event === 'start' ? 'SessionStart' : 'PreToolUse', additionalContext: text } }
}

/** Missing/unknown session host retains the pre-record compatibility path, including early receipts.
 * It accepts shared fields but must not interpret an event model or transcript as a known host's. */
export function compatibilityHookCodec(host?: string): HookCodec {
  return { decode: (event, raw, _argv, incomplete) => decodeHookFields(event, raw, incomplete),
    reduceRuntime: reduceHookEffort, context: hookContext,
    tool: hookTool, command: hookCommand, pathFields: hookPathFields,
  }
}
