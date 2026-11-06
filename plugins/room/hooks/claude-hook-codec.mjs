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

// packages/room-mcp/src/hosts/claude-hook-codec.ts
function newestModelInTranscriptTail(tail, startsMidLine = false) {
  const lines = tail.split("\n");
  if (startsMidLine) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const model = typeof entry?.message?.model === "string" ? entry.message.model.trim() : "";
    if (model && !model.startsWith("<")) return model;
  }
}
var claudeHookCodec = {
  decode(event, raw, _argv, incomplete) {
    const decoded = decodeHookFields(event, raw, incomplete);
    const transcript = raw?.transcript_path;
    if (typeof transcript === "string" && (event === "before-tool" || transcript)) decoded.transcriptPath = transcript;
    return decoded;
  },
  reduceRuntime(event, evidence) {
    const next = reduceHookEffort(event, evidence);
    const transcript = evidence.transcript;
    if (transcript) {
      const model = newestModelInTranscriptTail(transcript.tail, transcript.startsMidFile);
      const session = evidence.sessionRecord;
      const previous = evidence.previousRuntime;
      if (model && !(typeof session?.model === "string" && session.model && !previous?.transcript)) next.model = model;
      next.transcript = { path: transcript.path, mtimeMs: transcript.mtimeMs, size: transcript.size };
    }
    return next;
  },
  context: hookContext,
  tool: hookTool,
  command: hookCommand,
  pathFields: hookPathFields
};
export {
  claudeHookCodec
};
