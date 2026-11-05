// packages/relay/src/windows-process-core.ts
import path from "node:path";
function windowsProcessName(name) {
  return path.win32.basename(name).toLowerCase().replace(/\.exe$/, "");
}
function parseWindowsProcessTable(output) {
  const table = /* @__PURE__ */ new Map();
  let parsed;
  try {
    parsed = JSON.parse(output.replace(/^\uFEFF/, "").trim());
  } catch {
    return table;
  }
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!row || typeof row !== "object") continue;
    const { pid, ppid, creationDate, name } = row;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    let startTime;
    if (typeof creationDate === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(creationDate)) {
      const millis = Date.parse(creationDate);
      if (Number.isFinite(millis) && new Date(millis).toISOString() === creationDate.slice(0, 23) + "Z") startTime = `windows:${creationDate}`;
    }
    const executable = typeof name === "string" && name ? windowsProcessName(name) || void 0 : void 0;
    table.set(pid, { ppid, startTime, executable });
  }
  return table;
}
function windowsProcessCommand(pid) {
  if (pid !== void 0 && (!Number.isSafeInteger(pid) || pid <= 0)) return void 0;
  const filter = pid === void 0 ? "" : ` WHERE ProcessId = ${pid}`;
  const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $searcher = [wmisearcher]'SELECT ProcessId, ParentProcessId, CreationDate, Name FROM Win32_Process${filter}'; $rows = foreach ($p in $searcher.Get()) { $c = if ($p.CreationDate) { '"' + [Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) + '"' } else { 'null' }; $n = [regex]::Replace(([string]$p.Name).Replace('\\', '\\\\').Replace('"', '\\"'), '[\\x00-\\x1f]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value }); '{"pid":' + [int]$p.ProcessId + ',"ppid":' + [int]$p.ParentProcessId + ',"creationDate":' + $c + ',"name":"' + $n + '"}' }; '[' + ($rows -join ',') + ']'`;
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}
export {
  parseWindowsProcessTable,
  windowsProcessCommand,
  windowsProcessName
};
