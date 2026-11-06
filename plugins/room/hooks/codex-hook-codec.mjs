// packages/room-mcp/src/hosts/hook-fields.ts
var fields = (raw) => raw;
var runtimeString = (value) => typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : void 0;
function hookTool(originalName, input) {
  const shell = /^(?:Bash|PowerShell|shell|local_shell|exec|exec_command|unified_exec)$/.test(originalName);
  return {
    originalName,
    input,
    kind: shell ? "shell" : /(?:^|__)apply_patch$/.test(originalName) ? "patch" : /(?:^|__)(?:Write|Edit|MultiEdit|NotebookEdit)$/.test(originalName) ? "write" : "other",
    ...shell ? { shellDialect: originalName === "PowerShell" ? "powershell" : "posix" } : {}
  };
}
var hookCommand = (input) => fields(input)?.command ?? fields(input)?.cmd ?? input;
function hookPathFields(input) {
  return input && typeof input === "object" ? ["file_path", "path", "filePath"].flatMap((key) => {
    const value = fields(input)[key];
    return typeof value === "string" ? [value] : [];
  }) : [];
}
function decodeHookFields(event, raw, incomplete = false) {
  const ev = fields(raw) ?? {};
  const id = event === "start" ? ev.session_id ?? ev.thread_id ?? ev.sessionId : ev.session_id;
  const model = runtimeString(ev.model), effort = runtimeString(fields(ev.effort)?.level);
  return {
    event,
    sessionId: typeof id === "string" ? id : void 0,
    cwd: ev.cwd,
    source: typeof ev.source === "string" ? ev.source : void 0,
    subagent: typeof ev.agent_id === "string" && ev.agent_id !== "" || incomplete,
    incomplete,
    runtime: { ...model ? { model } : {}, ...effort ? { effort } : {} },
    ...event === "before-tool" ? { tool: hookTool(ev.tool_name, ev.tool_input) } : {}
  };
}
function reduceHookEffort(event, evidence) {
  return { ...evidence.previousRuntime, ...event.runtime.effort ? { effort: event.runtime.effort } : {} };
}
function hookContext(event, text) {
  return { hookSpecificOutput: { hookEventName: event === "start" ? "SessionStart" : "PreToolUse", additionalContext: text } };
}
function compatibilityHookCodec(host) {
  return {
    decode: (event, raw, _argv, incomplete) => decodeHookFields(event, raw, incomplete),
    reduceRuntime: reduceHookEffort,
    context: hookContext,
    tool: hookTool,
    command: hookCommand,
    pathFields: hookPathFields
  };
}

// packages/room-mcp/src/hosts/codex-hook-codec.ts
var codexHookCodec = {
  decode: (event, raw, _argv, incomplete) => decodeHookFields(event, raw, incomplete),
  reduceRuntime(event, evidence) {
    const next = reduceHookEffort(event, evidence);
    if (event.runtime.model) next.model = event.runtime.model;
    return next;
  },
  context: hookContext,
  tool: hookTool,
  command: hookCommand,
  pathFields: hookPathFields
};
export {
  codexHookCodec,
  compatibilityHookCodec
};
