// packages/room-mcp/src/hosts/session-host.ts
var HOOK_INTERPRETER = /^(?:sh|bash|dash|zsh|fish|cmd|powershell|pwsh)(?:\.exe)?$/i;
var identity = (value) => !!value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.startTime === "string" && typeof value.executable === "string" && !!value.executable;
function sessionHostIdentity(record) {
  if (record.chain !== void 0) {
    if (!Array.isArray(record.chain) || !identity(record.chain[0])) return void 0;
    const first = record.chain[0];
    const host = HOOK_INTERPRETER.test(first.executable) ? record.chain[1] : first;
    return identity(host) && !(host !== first && HOOK_INTERPRETER.test(host.executable)) ? host : void 0;
  }
  return Number.isSafeInteger(record.hostPid) && Number(record.hostPid) > 0 ? { pid: Number(record.hostPid), startTime: "", executable: "" } : void 0;
}
export {
  sessionHostIdentity
};
