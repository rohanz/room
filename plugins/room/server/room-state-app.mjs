import { createRequire as __roomCreateRequire } from 'node:module'; import { fileURLToPath as __roomFileURLToPath } from 'node:url'; import { dirname as __roomDirname } from 'node:path'; const require = __roomCreateRequire(import.meta.url); const __filename = __roomFileURLToPath(import.meta.url); const __dirname = __roomDirname(__filename);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to2, from2, except, desc) => {
  if (from2 && typeof from2 === "object" || typeof from2 === "function") {
    for (let key of __getOwnPropNames(from2))
      if (!__hasOwnProp.call(to2, key) && key !== except)
        __defProp(to2, key, { get: () => from2[key], enumerable: !(desc = __getOwnPropDesc(from2, key)) || desc.enumerable });
  }
  return to2;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// packages/local-state/src/private-core.ts
import fs from "node:fs";
import path from "node:path";
function privateDirectoryPath(dir) {
  dir = path.resolve(dir);
  const directories = [dir];
  let root = dir;
  while (path.basename(root) !== "room" && path.dirname(root) !== root) {
    root = path.dirname(root);
    directories.unshift(root);
    if (directories.length > 64) throw new Error(`Room state directory path is too deep: ${dir}`);
  }
  return { directories, root, inState: path.basename(root) === "room" };
}
function verifyPosixPath(file, stat = fs.lstatSync(file)) {
  if (stat.isSymbolicLink() || !process.getuid || stat.uid !== process.getuid() || (stat.mode & 63) !== 0) {
    throw new Error(`Room state must be owned by the current user and private: ${file}`);
  }
}
function initializePrivateDirectory(dir, repair) {
  let created = false;
  try {
    fs.mkdirSync(dir, { mode: 448 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Room state path must be a directory, not a symlink or junction: ${dir}`);
  if (process.platform === "win32") return;
  if (!process.getuid || stat.uid !== process.getuid()) throw new Error(`Room state must be owned by the current user and private: ${dir}`);
  if (created || repair && (stat.mode & 511) !== 448) {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.uid !== process.getuid()) throw new Error(`Room state must be owned by the current user and private: ${dir}`);
      fs.fchmodSync(fd, 448);
    } finally {
      fs.closeSync(fd);
    }
    if (!created) console.error(`Room repaired private state directory: ${dir}`);
  }
  verifyPosixPath(dir);
}
var init_private_core = __esm({
  "packages/local-state/src/private-core.ts"() {
    "use strict";
  }
});

// packages/local-state/src/private-state.ts
import fs2 from "node:fs";
import path2 from "node:path";
import { execFile, execFileSync } from "node:child_process";
function checkWindowsAcl(report, file) {
  const allowed = /* @__PURE__ */ new Set([report.user, "S-1-5-18", "S-1-5-32-544"]);
  if (report.owner !== report.user && report.owner !== "S-1-5-32-544" || report.directory !== false && !report.protected || report.grants.some((sid) => !allowed.has(sid))) {
    throw new Error(`Room state is not private: ${file}; owner ${report.owner}; offending grants ${report.grants.filter((sid) => !allowed.has(sid)).join(", ") || "none"}; DACL must be protected and access restricted to the current user, SYSTEM and Administrators. Use a private local clone, remove broad inherited grants and protect its Room state DACL, then retry`);
  }
}
function windowsIdentity(file) {
  try {
    const stat = fs2.lstatSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return void 0;
  }
}
function windowsPowerShellEnv(file) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (key.toLowerCase() !== "psmodulepath") env[key] = value;
  env.ROOM_PRIVATE_PATH = file;
  return env;
}
function windowsAclScript(protectNew, createDirectory, repair) {
  return `$ErrorActionPreference='Stop'; $p=$env:ROOM_PRIVATE_PATH; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $trusted=@($u.Value,'S-1-5-18','S-1-5-32-544');
    function IsDir($path) { ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) -ne 0 };
    function Gone($path) { -not ([IO.File]::Exists($path) -or [IO.Directory]::Exists($path)) };
    function ReadAcl($path) { if (IsDir $path) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) } };
    function WriteAcl($path, $acl) { if (IsDir $path) { [IO.Directory]::SetAccessControl($path, $acl) } else { [IO.File]::SetAccessControl($path, $acl) } };
    function Rules($acl) { @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) };
    function Grants($acl) { @(Rules $acl | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Value}) };
    function PrivateAcl($directory) {
      if ($directory) { $acl=[Security.AccessControl.DirectorySecurity]::new(); $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
      else { $acl=[Security.AccessControl.FileSecurity]::new(); $inherit=[Security.AccessControl.InheritanceFlags]::None };
      $acl.SetOwner($u); $acl.SetAccessRuleProtection($true,$false);
      foreach ($sid in $trusted) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl',$inherit,'None','Allow'))
      }; return $acl
    };
    $created=$false; $repaired=$false;
    ${createDirectory ? "if (!([IO.Directory]::Exists($p) -or [IO.File]::Exists($p))) { [IO.Directory]::CreateDirectory($p,(PrivateAcl $true)) | Out-Null; $created=$true };" : ""}
    if ([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) { throw 'Room state must not be a reparse point' };
    $isDir=IsDir $p;
    $a=ReadAcl $p; $g=Grants $a;
    $o=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;
    # An elevated administrator's new directories are owned by BUILTIN\\Administrators (Windows Server default); that
    # user can already rewrite the ACL, so the repair may take ownership back for them.
    $elevated=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
    $owned=($o -eq $u.Value) -or ($o -eq 'S-1-5-32-544' -and $elevated);
    $broad=@($g | Where-Object {$_ -notin $trusted});
    ${repair ? `$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';
    $inheritable=@(Rules $a | Where-Object {
      $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -eq $u.Value -and
      ($_.InheritanceFlags -band $inherit) -eq $inherit -and $_.PropagationFlags -eq 'None' -and
      ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl
    }).Count -gt 0;` : ""}
    ${repair ? `# Count and reject reparse points before the root ACL can propagate through an oversized subtree. Other Room
    # processes create and remove entries meanwhile: an entry (or directory) that is gone needs no verification;
    # any other failure still refuses.
    $pending=[System.Collections.Generic.Stack[string]]::new(); $pending.Push($p);
    $children=[System.Collections.Generic.List[string]]::new();
    while ($pending.Count -gt 0) {
      $dir=$pending.Pop();
      try {
        foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($dir)) {
          if ($children.Count -ge 20000) { throw "Room state subtree exceeds the 20000 entry inspection limit: $p (at $child)" };
          try { $attributes=[IO.File]::GetAttributes($child) } catch { if (Gone $child) { continue }; throw };
          if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Room state must not be a symlink or junction: $child" };
          $children.Add($child);
          if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($child) }
        }
      } catch { if (($dir -ne $p) -and (Gone $dir)) { continue }; throw }
    };` : ""}
    ${protectNew || repair ? `if ($owned -and (${protectNew ? "$true" : "!$a.AreAccessRulesProtected -or $broad.Count -gt 0 -or !$inheritable"})) {
      WriteAcl $p (PrivateAcl $isDir); $repaired=!$created;
      ${repair ? "$inheritable=$true;" : ""}
      $a=ReadAcl $p; $g=Grants $a
    };` : ""}
    ${repair ? `# Establish inheritance for the whole existing subtree before caching this root. Never follow reparse points.
    if (!$inheritable -or !$a.AreAccessRulesProtected -or @($g | Where-Object {$_ -notin $trusted}).Count -gt 0 -or
        $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($u.Value,'S-1-5-32-544')) { throw "Room state is not private: $p" };
    $icacls=[IO.Path]::Combine($env:SystemRoot, 'System32', 'icacls.exe');
    foreach ($child in $children) {
      try {
        if ([IO.File]::GetAttributes($child) -band [IO.FileAttributes]::ReparsePoint) { throw "Room state must not be a symlink or junction: $child" };
        $childAcl=ReadAcl $child; $rules=Rules $childAcl;
        # A foreign owner can rewrite its own DACL later, whatever the parent grants: refuse it outright.
        $childOwner=$childAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
        if ($childOwner -ne $u.Value -and !($childOwner -eq 'S-1-5-32-544' -and $elevated)) { throw "Room state is owned by $childOwner : $child" };
        $explicitBroad=@($rules | Where-Object {!$_.IsInherited -and $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $trusted});
        if ($childAcl.AreAccessRulesProtected -or @($rules | Where-Object {$_.IsInherited}).Count -eq 0 -or $explicitBroad.Count -gt 0) {
          # icacls /reset re-enables inheritance and removes every explicit entry. Writing back an ACL that was
          # read with its inherited entries would persist those entries as explicit ones.
          & $icacls $child /reset /q | Out-Null;
          if ($LASTEXITCODE -ne 0) { throw "Cannot reset Room state ACL ($LASTEXITCODE): $child" };
          $childAcl=ReadAcl $child; $rules=Rules $childAcl
        };
        if ($childAcl.AreAccessRulesProtected -or @($rules | Where-Object {$_.IsInherited}).Count -eq 0 -or
            @($rules | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $trusted}).Count -gt 0) { throw "Room state descendant is not private: $child" };
      } catch { if (Gone $child) { continue }; throw }
    };` : ""}
    # SIDs and booleans only, so the report is built without ConvertTo-Json.
    $bool={ param($v) if ($v) { 'true' } else { 'false' } };
    '{"owner":"' + $a.GetOwner([Security.Principal.SecurityIdentifier]).Value + '","user":"' + $u.Value + '","protected":' + (& $bool $a.AreAccessRulesProtected) +
      ',"directory":' + (& $bool $isDir) + ',"repaired":' + (& $bool $repaired) + ',"grants":[' + ((@($g) | ForEach-Object { '"' + $_ + '"' }) -join ',') + ']}'`;
}
function windowsAclError(file, error) {
  const e = error;
  const cause = e.code === "ETIMEDOUT" || e.signal ? "PowerShell timed out" : (String(e.stderr ?? "").trim().split(/\r?\n/).find(Boolean) ?? e.message).slice(0, 300);
  return new Error(`Cannot verify the Windows owner/DACL for ${file} (${cause}); use a private local state directory and permit bounded ACL inspection, then retry`);
}
function rememberWindowsAcl(file, output, repair) {
  let report;
  try {
    report = JSON.parse(output);
  } catch (error) {
    throw windowsAclError(file, error);
  }
  if (!report || !Array.isArray(report.grants) || typeof report.user !== "string") throw new Error(`Invalid Windows ACL inspection for ${file}`);
  checkWindowsAcl(report, file);
  if (repair && report.repaired) console.error(`Room repaired private state directory: ${file}`);
  const identity = windowsIdentity(file);
  if (identity) verifiedWindows.set(windowsKey(file), { identity, subtree: repair });
}
function windowsVerified(file, subtree = false) {
  const known = verifiedWindows.get(windowsKey(file));
  return !!known && (!subtree || known.subtree) && known.identity === windowsIdentity(file);
}
function windowsAcl(file, protectNew = false, createDirectory = false, repair = false) {
  if (!protectNew && windowsVerified(file, repair)) return;
  let output;
  try {
    output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsAclScript(protectNew, createDirectory, repair)], { env: windowsPowerShellEnv(file), timeout: 2e4, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw windowsAclError(file, error);
  }
  rememberWindowsAcl(file, output, repair);
}
function privateStateDirectory(dir) {
  dir = path2.resolve(dir);
  const { directories, root, inState } = privateDirectoryPath(dir);
  if (!fs2.statSync(path2.dirname(inState ? root : dir)).isDirectory()) throw new Error(`Room state parent must be a directory: ${dir}`);
  for (const directory of inState ? directories : [dir]) {
    if (process.platform === "win32" && (!inState || directory === root)) {
      if (fs2.existsSync(directory)) {
        const stat = fs2.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Room state path must be a directory, not a symlink or junction: ${directory}`);
      }
      windowsAcl(directory, false, true, inState);
    } else initializePrivateDirectory(directory, inState);
  }
}
var verifiedWindows, windowsKey;
var init_private_state = __esm({
  "packages/local-state/src/private-state.ts"() {
    "use strict";
    init_private_core();
    verifiedWindows = /* @__PURE__ */ new Map();
    windowsKey = (file) => path2.resolve(file).toLowerCase();
  }
});

// packages/local-state/src/windows-process-core.ts
import path3 from "node:path";
function windowsProcessName(name) {
  return path3.win32.basename(name).toLowerCase().replace(/\.exe$/, "");
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
var init_windows_process_core = __esm({
  "packages/local-state/src/windows-process-core.ts"() {
    "use strict";
  }
});

// packages/local-state/src/process.ts
import { execFile as execFile2, execFileSync as execFileSync2 } from "node:child_process";
import fs3 from "node:fs";
import path4 from "node:path";
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function readWindowsProcessTable(readers, pid, timeout = 3e3) {
  const args2 = windowsProcessCommand(pid);
  return args2 ? parseWindowsProcessTable(readers.exec("powershell.exe", args2, { timeout, maxBuffer: WINDOWS_MAX_BUFFER })) : /* @__PURE__ */ new Map();
}
function sameStartTime(a, b) {
  if (a === b) return true;
  const x = /^darwin:(\d+):(\d+)$/.exec(a), y = /^darwin:(\d+):(\d+)$/.exec(b);
  return !!x && !!y && x[2] === y[2] && Math.abs(Number(x[1]) - Number(y[1])) <= 60;
}
function parsePsLstartUtc(line) {
  const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(line.trim());
  if (!match) return void 0;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[1]);
  const seconds = Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1e3;
  return Number.isInteger(seconds) ? seconds : void 0;
}
function linuxProcessName(files2) {
  const read2 = (file) => {
    try {
      return file();
    } catch {
      return void 0;
    }
  };
  let name = read2(files2.comm)?.replace(/\n$/, "") || void 0;
  if (!name || name.length >= 15) {
    const argv0 = read2(files2.cmdline)?.split("\0")[0];
    const invoked = argv0 ? path4.basename(argv0) : void 0;
    if (invoked && (!name || invoked.startsWith(name))) name = invoked;
  }
  if (name && !/^\d+(?:\.\d+)+/.test(name)) return name;
  const exe = read2(files2.exe)?.replace(/ \(deleted\)$/, "");
  if (exe && /[\\/]claude[\\/]versions[\\/][^\\/]+$/.test(exe)) return "claude";
  return name ?? (exe ? path4.basename(exe) : void 0);
}
function probeProcess(pid, readers) {
  return readers ? probeUncached(pid, readers) : systemProbe(pid);
}
function probeUncached(pid, readers, boottime = () => readers.exec("sysctl", ["-n", "kern.boottime"])) {
  if (!pid || pid <= 0) return void 0;
  const unreadable = () => pidAlive(pid) ? {} : void 0;
  try {
    if (readers.platform === "linux") {
      const stat = readers.readFile(`/proc/${pid}/stat`);
      const close = stat.lastIndexOf(")");
      if (close < 0) return unreadable();
      const startTicks = stat.slice(close + 1).trim().split(/\s+/)[19];
      if (!/^\d+$/.test(startTicks ?? "")) return unreadable();
      const bootId = readers.readFile("/proc/sys/kernel/random/boot_id").trim();
      if (!bootId) return unreadable();
      const executable = linuxProcessName({
        comm: () => readers.readFile(`/proc/${pid}/comm`),
        cmdline: () => readers.readFile(`/proc/${pid}/cmdline`),
        exe: () => readers.readLink(`/proc/${pid}/exe`)
      });
      return { startTime: `linux:${bootId}:${startTicks}`, executable };
    }
    if (readers.platform === "win32") {
      const info = readWindowsProcessTable(readers, pid, WINDOWS_SYNC_READ_MS).get(pid);
      return info ? { startTime: info.startTime, executable: info.executable } : unreadable();
    }
    if (readers.platform === "darwin") {
      const lstart = readers.exec("ps", ["-o", "lstart=", "-p", String(pid)]).trim();
      const startSeconds2 = parsePsLstartUtc(lstart);
      if (startSeconds2 === void 0) return unreadable();
      const boot = boottime().match(/sec\s*=\s*(\d+)/)?.[1];
      if (!boot) return unreadable();
      let executable;
      try {
        executable = path4.basename(readers.exec("ps", ["-o", "comm=", "-p", String(pid)]).trim());
      } catch {
      }
      return { startTime: `darwin:${boot}:${startSeconds2}`, executable };
    }
  } catch {
  }
  return unreadable();
}
function createProcessProbe(readers, options = {}) {
  if (readers.platform !== "darwin" && readers.platform !== "win32") {
    const read3 = (pid) => probeUncached(pid, readers);
    return Object.assign(read3, { confirm: read3, fresh: read3, read: async (pid) => read3(pid) });
  }
  const now = options.now ?? (() => performance.now()), wall = options.wall ?? Date.now, alive = readers.alive ?? pidAlive;
  const cache = /* @__PURE__ */ new Map();
  let reads2 = 0;
  const confirmed = /* @__PURE__ */ new Map();
  let boot;
  const boottime = () => {
    if (!boot || now() - boot.at >= BOOTTIME_TTL_MS) boot = { text: readers.exec("sysctl", ["-n", "kern.boottime"]), at: now() };
    return boot.text;
  };
  const store = (pid, info, read3) => {
    const started = startSeconds(info?.startTime);
    if (info && (readers.platform === "win32" || info.executable && Number.isFinite(started))) {
      if (cache.size >= 1024) cache.clear();
      cache.set(pid, { info, read: read3, until: now() + (info.executable && Number.isFinite(started) && wall() / 1e3 - started >= SETTLED_AFTER_S ? PROBE_TTL_MS : YOUNG_TTL_MS) });
    } else cache.delete(pid);
    return info;
  };
  const fresh = (pid) => {
    const read3 = ++reads2;
    return store(pid, probeUncached(pid, readers, boottime), read3);
  };
  const inFlight2 = /* @__PURE__ */ new Map();
  const readInBackground = (pid) => {
    const pending2 = inFlight2.get(pid);
    if (pending2) return pending2;
    const args2 = windowsProcessCommand(pid);
    if (!args2 || !readers.execAsync || inFlight2.size >= WINDOWS_MAX_IN_FLIGHT) return Promise.resolve({});
    const started = ++reads2, execAsync = readers.execAsync;
    let settled = false;
    const read3 = new Promise((resolve) => {
      const done = (error, stdout) => {
        if (settled) return;
        settled = true;
        inFlight2.delete(pid);
        const row = error ? void 0 : parseWindowsProcessTable(stdout).get(pid);
        const info = row ? { startTime: row.startTime, executable: row.executable } : alive(pid) ? {} : void 0;
        const current = cache.get(pid);
        resolve(current && current.read > started ? current.info : store(pid, info, started));
      };
      try {
        execAsync("powershell.exe", args2, { timeout: WINDOWS_ASYNC_READ_MS, maxBuffer: WINDOWS_MAX_BUFFER }, done);
      } catch (error) {
        done(error, "");
      }
    });
    if (!settled) inFlight2.set(pid, read3);
    return read3;
  };
  const probe = (pid) => {
    const hit = cache.get(pid);
    if (!pid || pid <= 0 || !alive(pid)) {
      cache.delete(pid);
      return void 0;
    }
    if (hit && now() < hit.until) return hit.info;
    if (readers.platform !== "win32") return fresh(pid);
    void readInBackground(pid);
    return { pending: true };
  };
  const read2 = async (pid) => {
    const info = probe(pid);
    return info?.pending ? readInBackground(pid) : info;
  };
  const confirm = (pid, recorded) => {
    if (!pid || pid <= 0 || !alive(pid)) return void 0;
    const key = `${pid}\0${recorded.startTime ?? ""}\0${recorded.executable ?? ""}`;
    const hit = confirmed.get(key);
    if (hit && now() < hit.until) return hit.info;
    const info = fresh(pid);
    if (info && !agrees(info, recorded) && wall() / 1e3 - startSeconds(info.startTime) >= SETTLED_AFTER_S) {
      if (confirmed.size >= 1024) confirmed.clear();
      confirmed.set(key, { info, until: now() + CONFIRMED_TTL_MS });
    } else confirmed.delete(key);
    return info;
  };
  return Object.assign(probe, { confirm, fresh, read: read2 });
}
function probeOwnProcess() {
  if (ownIdentity?.startTime && ownIdentity.executable) return ownIdentity;
  const info = ownRead ? systemProbe(process.pid) : systemProbe.fresh(process.pid);
  ownRead = true;
  if (info?.startTime && info.executable) ownIdentity = info;
  return info?.pending ? {} : info;
}
function probeProcessConfirm(pid, recorded) {
  return systemProbe.confirm(pid, recorded);
}
var systemProcessReaders, WINDOWS_SYNC_READ_MS, WINDOWS_ASYNC_READ_MS, WINDOWS_MAX_BUFFER, WINDOWS_MAX_IN_FLIGHT, PROBE_TTL_MS, YOUNG_TTL_MS, SETTLED_AFTER_S, BOOTTIME_TTL_MS, CONFIRMED_TTL_MS, startSeconds, agrees, systemProbe, ownIdentity, ownRead;
var init_process = __esm({
  "packages/local-state/src/process.ts"() {
    "use strict";
    init_windows_process_core();
    systemProcessReaders = {
      platform: process.platform,
      readFile: (file) => fs3.readFileSync(file, "utf8"),
      readLink: (file) => fs3.readlinkSync(file),
      exec: (file, args2, options) => execFileSync2(file, args2, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3e3,
        ...options,
        ...file === "ps" ? { env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" } } : {}
      }),
      execAsync: (file, args2, options, done) => {
        execFile2(file, args2, { encoding: "utf8", windowsHide: true, ...options }, (error, stdout) => done(error, stdout));
      }
    };
    WINDOWS_SYNC_READ_MS = 1e4;
    WINDOWS_ASYNC_READ_MS = 15e3;
    WINDOWS_MAX_BUFFER = 8 * 1024 * 1024;
    WINDOWS_MAX_IN_FLIGHT = 4;
    PROBE_TTL_MS = 2e3;
    YOUNG_TTL_MS = 250;
    SETTLED_AFTER_S = 5;
    BOOTTIME_TTL_MS = 6e4;
    CONFIRMED_TTL_MS = 6e4;
    startSeconds = (startTime) => startTime?.startsWith("windows:") ? Date.parse(startTime.slice("windows:".length)) / 1e3 : Number(/^darwin:\d+:(\d+)$/.exec(startTime ?? "")?.[1]);
    agrees = (info, recorded) => (!info.startTime || !recorded.startTime || sameStartTime(info.startTime, recorded.startTime)) && (!info.executable || !recorded.executable || info.executable === recorded.executable);
    systemProbe = createProcessProbe(systemProcessReaders);
    ownRead = false;
  }
});

// packages/local-state/src/leases.ts
import fs4 from "node:fs";
import path5 from "node:path";
import { createHash, randomUUID } from "node:crypto";
function liveness(identity, probe = probeProcess) {
  const verdict = livenessBy(identity, probe);
  return verdict === "dead" && probe === probeProcess && pidAlive(identity.pid) ? livenessBy(identity, (pid) => probeProcessConfirm(pid, identity)) : verdict;
}
function livenessBy(identity, probe) {
  const observed = probe(identity.pid);
  if (!observed) return "dead";
  if (observed.startTime && identity.startTime && !sameStartTime(observed.startTime, identity.startTime)) return "dead";
  if (observed.executable && identity.executable && observed.executable !== identity.executable) return "dead";
  if (!observed.startTime || !observed.executable || !identity.startTime || !identity.executable) return "unknown";
  return "alive";
}
function syncDirectory(dir) {
  let fd;
  try {
    fd = fs4.openSync(dir, "r");
    fs4.fsyncSync(fd);
  } catch (e) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(e.code ?? "")) throw e;
  } finally {
    if (fd !== void 0) fs4.closeSync(fd);
  }
}
function ensureDurableDirectory(dir, holdsFile, boundary, durable = true) {
  const parent = path5.dirname(dir);
  if (parent === dir || dir === boundary) {
    if (!fs4.statSync(dir).isDirectory()) throw Object.assign(new Error(`Not a directory: ${dir}`), { code: "ENOTDIR" });
    return;
  }
  ensureDurableDirectory(parent, false, boundary, durable);
  try {
    if (process.platform === "win32" && !holdsFile) fs4.mkdirSync(dir);
    else if (!fs4.existsSync(dir)) privateStateDirectory(dir);
    else fs4.mkdirSync(dir, { mode: 448 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  if (durable) syncDirectory(parent);
}
function cleanupOrphanTemps(dir, probe = probeProcess, durable = true) {
  let removed = 0;
  for (const name of fs4.readdirSync(dir)) {
    const match = tempPattern.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const observed = probe(pid);
    if (observed && (match[2] === "u" || !observed.startTime || startMarker(observed.startTime) === match[2])) continue;
    if (pidAlive(pid)) continue;
    try {
      fs4.unlinkSync(path5.join(dir, name));
      removed++;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  if (removed && durable) syncDirectory(dir);
  return removed;
}
function writeTemp(file, content, durable) {
  const dir = path5.resolve(path5.dirname(file));
  const namespace = privateDirectoryPath(dir);
  ensureDurableDirectory(dir, true, namespace.inState ? path5.dirname(namespace.root) : void 0, durable);
  cleanupOrphanTemps(dir, probeProcess, durable);
  const start = probeOwnProcess()?.startTime;
  const temp = `${file}.roomtmp-p${process.pid}-s${start ? startMarker(start) : "u"}-n${randomUUID()}.tmp`;
  const fd = fs4.openSync(temp, "wx", 384);
  try {
    fs4.writeFileSync(fd, JSON.stringify(content) + "\n");
    if (durable) fs4.fsyncSync(fd);
  } catch (e) {
    fs4.closeSync(fd);
    fs4.rmSync(temp, { force: true });
    if (durable) syncDirectory(dir);
    throw e;
  }
  fs4.closeSync(fd);
  return temp;
}
function createExclusive(file, content, { durable = true } = {}) {
  const temp = writeTemp(file, content, durable);
  try {
    try {
      fs4.linkSync(temp, file);
    } catch (e) {
      if (e.code === "EEXIST") return false;
      throw e;
    }
    if (durable) syncDirectory(path5.dirname(file));
    return true;
  } finally {
    fs4.rmSync(temp, { force: true });
    if (durable) syncDirectory(path5.dirname(file));
  }
}
function writeAtomic(file, content, { durable = true } = {}) {
  const temp = writeTemp(file, content, durable);
  try {
    renameAtomic(temp, file);
    if (durable) syncDirectory(path5.dirname(file));
  } finally {
    fs4.rmSync(temp, { force: true });
    if (durable) syncDirectory(path5.dirname(file));
  }
}
function renameAtomic(temp, file) {
  const until = performance.now() + 2e3;
  let sleeper;
  let attempts = 0;
  for (; ; ) {
    try {
      fs4.renameSync(temp, file);
      return;
    } catch (error) {
      const remaining = until - performance.now();
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code ?? "") || remaining <= 0) throw error;
      const delay = Math.min(remaining, Math.min(100, ++attempts * 10) + Math.random() * 10);
      Atomics.wait(sleeper ??= new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}
function read(file) {
  try {
    return JSON.parse(fs4.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return void 0;
    throw e;
  }
}
function leaseToken(value) {
  const candidate = value.holder ?? value;
  return candidate && typeof candidate.pid === "number" && typeof candidate.startTime === "string" && typeof candidate.executable === "string" && typeof candidate.sessionId === "string" && typeof candidate.nonce === "string" ? candidate : void 0;
}
function ownToken() {
  const current = probeOwnProcess();
  return { pid: process.pid, startTime: current?.startTime ?? "", executable: current?.executable ?? "", sessionId: `mcp:${process.pid}:${current?.startTime ?? "unknown"}`, nonce: randomUUID() };
}
function acquireGuard(file, probe, depth = 0, durable = true) {
  if (depth > 12) throw new Error(`too many stale lease guards at ${file}`);
  const token = ownToken();
  if (createExclusive(file, token, { durable })) return token;
  const previous = read(file);
  const previousHolder = previous && leaseToken(previous);
  if (!previousHolder || liveness(previousHolder, probe) !== "dead") throw new Error(`lease guard busy: ${file}`);
  const outer = acquireGuard(`${file}.guard`, probe, depth + 1, durable);
  try {
    const latest = read(file);
    const latestHolder = latest && leaseToken(latest);
    if (latestHolder && liveness(latestHolder, probe) === "dead") {
      fs4.unlinkSync(file);
      if (durable) syncDirectory(path5.dirname(file));
    }
  } finally {
    releaseGuard(`${file}.guard`, outer, durable);
  }
  if (createExclusive(file, token, { durable })) return token;
  throw new Error(`lease guard busy: ${file}`);
}
function releaseGuard(file, token, durable) {
  const current = read(file);
  if (current && leaseToken(current)?.nonce === token.nonce) {
    fs4.unlinkSync(file);
    if (durable) syncDirectory(path5.dirname(file));
  }
}
function withGuard(file, fn, probe = probeProcess, { durable = true } = {}) {
  const guard = `${file}.guard`;
  const token = acquireGuard(guard, probe, 0, durable);
  try {
    const result = fn();
    if (result && typeof result.then === "function") throw new TypeError("lease guard callback must be synchronous");
    return result;
  } finally {
    releaseGuard(guard, token, durable);
  }
}
function compareAndRelease(file, token) {
  return withGuard(file, () => {
    const current = read(file);
    if (!current || leaseToken(current)?.nonce !== token.nonce) return false;
    fs4.unlinkSync(file);
    syncDirectory(path5.dirname(file));
    return true;
  });
}
function recover(file, orphan, probe = probeProcess) {
  return withGuard(file, () => {
    const current = read(file);
    const owner = current && leaseToken(current);
    if (!current || !owner || liveness(owner, probe) !== "dead" || !orphan(current)) return false;
    fs4.unlinkSync(file);
    syncDirectory(path5.dirname(file));
    return true;
  });
}
var startMarker, tempPattern;
var init_leases = __esm({
  "packages/local-state/src/leases.ts"() {
    "use strict";
    init_private_state();
    init_private_core();
    init_process();
    startMarker = (startTime) => createHash("sha256").update(startTime).digest("hex").slice(0, 24);
    tempPattern = /\.roomtmp-p(\d+)-s([a-f0-9]{24}|u)-n[0-9a-f-]{36}\.tmp$/;
  }
});

// packages/local-state/src/protocol.ts
var STORAGE_BUILD, GATE_LIMITS, STORAGE_PATHS, StorageRefused;
var init_protocol = __esm({
  "packages/local-state/src/protocol.ts"() {
    "use strict";
    STORAGE_BUILD = 1;
    GATE_LIMITS = {
      /** Registered processes (MCPs, helpers, daemon, maintenance) per clone; the cap refuses, never evicts. */
      registrations: 256,
      /** Concurrent admission tickets per clone; the cap refuses admission, never drops a ticket. */
      tickets: 4096,
      /** Records examined per yielded drain/status pass. */
      scanBatch: 200,
      /** Wait for the short gate guard before `unavailable` (decided, not in spec). */
      guardWaitMs: 2e3,
      /** Explicit migration drain. Timeout leaves the gate draining; it never reopens automatically. */
      drainMs: 12e4,
      /** MCP/daemon startup maintenance check, including preflight; refuses rather than waits longer. */
      startupMs: 1e4,
      /** Runtime/filesystem preflight, including asynchronous BUSY retries. */
      preflightMs: 1e4,
      /** migration.lock ownership wait (existing 30 s rule). */
      migrationLockWaitMs: 3e4
    };
    STORAGE_PATHS = {
      /** Gate record. Initialization, registration and phase/generation transitions serialize on `${gate}.guard`; admission is lock-free against them. */
      gate: "room/storage-gate.json",
      /** One private file per registration, named `<instance nonce>.json`. */
      registrations: "room/storage-gate/registrations",
      /** One private file per live ticket, named `<holder nonce>.<ticket id>.json`; finish removes it. */
      tickets: "room/storage-gate/tickets",
      /** Append-only bounded audit of dead-ticket resolutions (decided, not in spec). */
      resolutions: "room/storage-gate/resolutions",
      /** Existing exclusive migration ownership and stable pre-registry assignments; never moved. */
      migrationLock: "room/registry/migration.lock",
      migrationMap: "room/registry/migration.json",
      /** Activation evidence. Any of these without a readable gate refuses operation; slice 2 never creates them. */
      database: "room/state.sqlite",
      activationMarker: "room/state.active.json",
      /** Private preflight scratch; each probe uses and removes only its own `<nonce>` subdirectory. */
      preflightScratch: "room/preflight"
    };
    StorageRefused = class extends Error {
      constructor(reason, detail, remedy) {
        super(`Room storage ${reason}: ${detail}${remedy ? `; ${remedy}` : ""}`);
        this.reason = reason;
        this.detail = detail;
        this.remedy = remedy;
      }
      reason;
      detail;
      remedy;
      name = "StorageRefused";
    };
  }
});

// packages/local-state/src/filesystem.ts
import fs6 from "node:fs";
import os from "node:os";
import { execFile as execFile3 } from "node:child_process";
var COMMAND_TIMEOUT_MS, run, systemFilesystemReaders;
var init_filesystem = __esm({
  "packages/local-state/src/filesystem.ts"() {
    "use strict";
    COMMAND_TIMEOUT_MS = 3e3;
    run = (command, args2) => new Promise((resolve, reject) => {
      execFile3(
        command,
        args2,
        { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout) => error ? reject(error) : resolve(stdout)
      );
    });
    systemFilesystemReaders = {
      platform: process.platform,
      realpath: (file) => fs6.promises.realpath(file),
      statfsType: (file) => fs6.promises.statfs(file).then((stat) => stat.type, () => void 0),
      macMounts: () => run("/sbin/mount", []),
      linuxMountinfo: () => fs6.promises.readFile("/proc/self/mountinfo", "utf8"),
      windowsDriveType: (drive) => run("fsutil", ["fsinfo", "drivetype", drive]),
      windowsVolumeInfo: (drive) => run("fsutil", ["fsinfo", "volumeinfo", `${drive}\\`]),
      home: () => os.homedir(),
      env: process.env
    };
  }
});

// packages/local-state/src/preflight.ts
var SQLITE_PROBE_SOURCE;
var init_preflight = __esm({
  "packages/local-state/src/preflight.ts"() {
    "use strict";
    init_filesystem();
    init_private_state();
    init_protocol();
    SQLITE_PROBE_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const expired = () => performance.now() >= workerData.deadline;
const check = () => { if (expired()) throw Object.assign(new Error('preflight deadline expired'), { failure: 'timeout' }); };
const step = fn => { check(); const value = fn(); check(); return value; };
let sqlite;
function fail(failure, detail) { return { failure, detail }; }
async function runtimeProbe() {
  const original = process.emitWarning;
  process.emitWarning = function(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? (warning instanceof Error ? warning.name : undefined);
    if (type === 'ExperimentalWarning' && /\bSQLite\b/i.test(text ?? '')) return;
    return original.call(process, warning, ...rest);
  };
  try {
    check();
    sqlite = await (workerData.importSqlite ? (0, eval)('(' + workerData.importSqlite + ')')() : import('node:sqlite'));
    check();
  } catch (error) { return fail(error.failure ?? 'sqlite-import', error.message); }
  finally { process.emitWarning = original; }
  if (typeof sqlite?.DatabaseSync !== 'function') return fail('sqlite-api', 'node:sqlite has no DatabaseSync');
  let db;
  try {
    db = step(() => new sqlite.DatabaseSync(':memory:', { enableForeignKeyConstraints: true, allowExtension: false }));
    for (const method of ['exec', 'prepare', 'close', 'loadExtension'])
      if (typeof db[method] !== 'function') return fail('sqlite-api', 'DatabaseSync.' + method + ' missing');
    const get = sql => { const statement = step(() => db.prepare(sql)); return step(() => Object.values(statement.get() ?? {})[0]); };
    const version = String(get('SELECT sqlite_version() AS v'));
    const parts = version.split('.').map(Number), floor = workerData.sqliteFloor.split('.').map(Number);
    const comparison = parts[0] - floor[0] || parts[1] - floor[1] || parts[2] - floor[2];
    if (comparison < 0) return { ...fail('sqlite-version', 'SQLite ' + version + ' is below the minimum ' + workerData.sqliteFloor), sqlite: version };
    step(() => db.exec('PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;'));
    if (Number(get('PRAGMA foreign_keys')) !== 1) return fail('pragma', 'foreign_keys could not be enabled');
    if (Number(get('PRAGMA trusted_schema')) !== 0) return fail('pragma', 'trusted_schema could not be disabled');
    try { step(() => db.loadExtension(path.join(path.sep, 'room-preflight-no-such-extension'))); return fail('pragma', 'extension loading is enabled'); }
    catch (error) {
      check();
      if (!/not allowed|disabled|ERR_LOAD_SQLITE_EXTENSION|ERR_INVALID_STATE/i.test((error.code ?? '') + ' ' + error.message))
        return fail('pragma', 'extension loading check failed: ' + error.message);
    }
    return { sqlite: version };
  } catch (error) { return fail(error.failure ?? 'sqlite-api', 'SQLite probe failed: ' + error.message); }
  finally { if (db && !expired()) step(() => db.close()); }
}
function walProbe(dir) {
  check();
  const file = path.join(dir, 'probe.sqlite'), open = new Set();
  const connect = () => { const db = step(() => new sqlite.DatabaseSync(file, { enableForeignKeyConstraints: true, allowExtension: false, timeout: 0 })); open.add(db); return db; };
  const close = db => { step(() => db.close()); open.delete(db); };
  const get = (db, sql) => { const statement = step(() => db.prepare(sql)); return step(() => Object.values(statement.get() ?? {})[0]); };
  try {
    const a = connect();
    const mode = get(a, 'PRAGMA journal_mode = WAL');
    if (String(mode).toLowerCase() !== 'wal') return fail('journal', 'journal_mode is ' + mode + ', not wal');
    step(() => a.exec('PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE probe (n INTEGER PRIMARY KEY) STRICT;'));
    step(() => a.exec('BEGIN IMMEDIATE; INSERT INTO probe (n) VALUES (1); COMMIT;'));
    const b = connect();
    if (Number(get(b, 'SELECT count(*) AS c FROM probe')) !== 1) return fail('journal', 'second connection did not see the committed row');
    close(b); close(a);
    const c = connect();
    if (String(get(c, 'PRAGMA journal_mode')).toLowerCase() !== 'wal') return fail('journal', 'journal_mode changed after reopen');
    if (Number(get(c, 'SELECT count(*) AS c FROM probe')) !== 1) return fail('journal', 'row missing after reopen');
    return {};
  } finally {
    // On timeout termination owns connection teardown; leave scratch for inspection, never do late I/O.
    if (!expired()) {
      for (const db of open) close(db);
      for (const name of ['probe.sqlite', 'probe.sqlite-wal', 'probe.sqlite-shm']) step(() => fs.rmSync(path.join(dir, name), { force: true }));
      step(() => fs.rmdirSync(dir));
    }
  }
}
parentPort.on('message', async message => {
  let result;
  try { check(); result = message.kind === 'runtime' ? await runtimeProbe() : walProbe(message.dir); check(); }
  catch (error) { result = fail(error.failure ?? 'journal', error.message); }
  parentPort.postMessage(result);
});
`;
  }
});

// node_modules/lib0/map.js
var create, copy, setIfUndefined, any;
var init_map = __esm({
  "node_modules/lib0/map.js"() {
    "use strict";
    create = () => /* @__PURE__ */ new Map();
    copy = (m) => {
      const r = create();
      m.forEach((v, k) => {
        r.set(k, v);
      });
      return r;
    };
    setIfUndefined = (map, key, createT) => {
      let set = map.get(key);
      if (set === void 0) {
        map.set(key, set = createT());
      }
      return set;
    };
    any = (m, f) => {
      for (const [key, value] of m) {
        if (f(value, key)) {
          return true;
        }
      }
      return false;
    };
  }
});

// node_modules/lib0/set.js
var create2;
var init_set = __esm({
  "node_modules/lib0/set.js"() {
    "use strict";
    create2 = () => /* @__PURE__ */ new Set();
  }
});

// node_modules/lib0/array.js
var last, appendTo, from, isArray;
var init_array = __esm({
  "node_modules/lib0/array.js"() {
    "use strict";
    last = (arr) => arr[arr.length - 1];
    appendTo = (dest, src) => {
      for (let i = 0; i < src.length; i++) {
        dest.push(src[i]);
      }
    };
    from = Array.from;
    isArray = Array.isArray;
  }
});

// node_modules/lib0/observable.js
var ObservableV2;
var init_observable = __esm({
  "node_modules/lib0/observable.js"() {
    "use strict";
    init_map();
    init_set();
    init_array();
    ObservableV2 = class {
      constructor() {
        this._observers = create();
      }
      /**
       * @template {keyof EVENTS & string} NAME
       * @param {NAME} name
       * @param {EVENTS[NAME]} f
       */
      on(name, f) {
        setIfUndefined(
          this._observers,
          /** @type {string} */
          name,
          create2
        ).add(f);
        return f;
      }
      /**
       * @template {keyof EVENTS & string} NAME
       * @param {NAME} name
       * @param {EVENTS[NAME]} f
       */
      once(name, f) {
        const _f = (...args2) => {
          this.off(
            name,
            /** @type {any} */
            _f
          );
          f(...args2);
        };
        this.on(
          name,
          /** @type {any} */
          _f
        );
      }
      /**
       * @template {keyof EVENTS & string} NAME
       * @param {NAME} name
       * @param {EVENTS[NAME]} f
       */
      off(name, f) {
        const observers = this._observers.get(name);
        if (observers !== void 0) {
          observers.delete(f);
          if (observers.size === 0) {
            this._observers.delete(name);
          }
        }
      }
      /**
       * Emit a named event. All registered event listeners that listen to the
       * specified name will receive the event.
       *
       * @todo This should catch exceptions
       *
       * @template {keyof EVENTS & string} NAME
       * @param {NAME} name The event name.
       * @param {Parameters<EVENTS[NAME]>} args The arguments that are applied to the event listener.
       */
      emit(name, args2) {
        return from((this._observers.get(name) || create()).values()).forEach((f) => f(...args2));
      }
      destroy() {
        this._observers = create();
      }
    };
  }
});

// node_modules/lib0/math.js
var floor, abs, min, max, isNaN, isNegativeZero;
var init_math = __esm({
  "node_modules/lib0/math.js"() {
    "use strict";
    floor = Math.floor;
    abs = Math.abs;
    min = (a, b) => a < b ? a : b;
    max = (a, b) => a > b ? a : b;
    isNaN = Number.isNaN;
    isNegativeZero = (n) => n !== 0 ? n < 0 : 1 / n < 0;
  }
});

// node_modules/lib0/binary.js
var BIT1, BIT2, BIT3, BIT4, BIT6, BIT7, BIT8, BIT18, BIT19, BIT20, BIT21, BIT22, BIT23, BIT24, BIT25, BIT26, BIT27, BIT28, BIT29, BIT30, BIT31, BIT32, BITS5, BITS6, BITS7, BITS17, BITS18, BITS19, BITS20, BITS21, BITS22, BITS23, BITS24, BITS25, BITS26, BITS27, BITS28, BITS29, BITS30, BITS31;
var init_binary = __esm({
  "node_modules/lib0/binary.js"() {
    "use strict";
    BIT1 = 1;
    BIT2 = 2;
    BIT3 = 4;
    BIT4 = 8;
    BIT6 = 32;
    BIT7 = 64;
    BIT8 = 128;
    BIT18 = 1 << 17;
    BIT19 = 1 << 18;
    BIT20 = 1 << 19;
    BIT21 = 1 << 20;
    BIT22 = 1 << 21;
    BIT23 = 1 << 22;
    BIT24 = 1 << 23;
    BIT25 = 1 << 24;
    BIT26 = 1 << 25;
    BIT27 = 1 << 26;
    BIT28 = 1 << 27;
    BIT29 = 1 << 28;
    BIT30 = 1 << 29;
    BIT31 = 1 << 30;
    BIT32 = 1 << 31;
    BITS5 = 31;
    BITS6 = 63;
    BITS7 = 127;
    BITS17 = BIT18 - 1;
    BITS18 = BIT19 - 1;
    BITS19 = BIT20 - 1;
    BITS20 = BIT21 - 1;
    BITS21 = BIT22 - 1;
    BITS22 = BIT23 - 1;
    BITS23 = BIT24 - 1;
    BITS24 = BIT25 - 1;
    BITS25 = BIT26 - 1;
    BITS26 = BIT27 - 1;
    BITS27 = BIT28 - 1;
    BITS28 = BIT29 - 1;
    BITS29 = BIT30 - 1;
    BITS30 = BIT31 - 1;
    BITS31 = 2147483647;
  }
});

// node_modules/lib0/number.js
var MAX_SAFE_INTEGER, MIN_SAFE_INTEGER, LOWEST_INT32, isInteger, isNaN2, parseInt2;
var init_number = __esm({
  "node_modules/lib0/number.js"() {
    "use strict";
    init_math();
    MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
    MIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
    LOWEST_INT32 = 1 << 31;
    isInteger = Number.isInteger || ((num) => typeof num === "number" && isFinite(num) && floor(num) === num);
    isNaN2 = Number.isNaN;
    parseInt2 = Number.parseInt;
  }
});

// node_modules/lib0/string.js
var fromCharCode, fromCodePoint, MAX_UTF16_CHARACTER, toLowerCase, trimLeftRegex, trimLeft, fromCamelCaseRegex, fromCamelCase, _encodeUtf8Polyfill, utf8TextEncoder, _encodeUtf8Native, encodeUtf8, utf8TextDecoder;
var init_string = __esm({
  "node_modules/lib0/string.js"() {
    "use strict";
    fromCharCode = String.fromCharCode;
    fromCodePoint = String.fromCodePoint;
    MAX_UTF16_CHARACTER = fromCharCode(65535);
    toLowerCase = (s) => s.toLowerCase();
    trimLeftRegex = /^\s*/g;
    trimLeft = (s) => s.replace(trimLeftRegex, "");
    fromCamelCaseRegex = /([A-Z])/g;
    fromCamelCase = (s, separator) => trimLeft(s.replace(fromCamelCaseRegex, (match) => `${separator}${toLowerCase(match)}`));
    _encodeUtf8Polyfill = (str2) => {
      const encodedString = unescape(encodeURIComponent(str2));
      const len = encodedString.length;
      const buf = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        buf[i] = /** @type {number} */
        encodedString.codePointAt(i);
      }
      return buf;
    };
    utf8TextEncoder = /** @type {TextEncoder} */
    typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
    _encodeUtf8Native = (str2) => utf8TextEncoder.encode(str2);
    encodeUtf8 = utf8TextEncoder ? _encodeUtf8Native : _encodeUtf8Polyfill;
    utf8TextDecoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    if (utf8TextDecoder && utf8TextDecoder.decode(new Uint8Array()).length === 1) {
      utf8TextDecoder = null;
    }
  }
});

// node_modules/lib0/encoding.js
var Encoder, createEncoder, length, toUint8Array, verifyLen, write, writeUint8, writeVarUint, writeVarInt, _strBuffer, _maxStrBSize, _writeVarStringNative, _writeVarStringPolyfill, writeVarString, writeUint8Array, writeVarUint8Array, writeOnDataView, writeFloat32, writeFloat64, writeBigInt64, floatTestBed, isFloat32, writeAny, RleEncoder, flushUintOptRleEncoder, UintOptRleEncoder, flushIntDiffOptRleEncoder, IntDiffOptRleEncoder, StringEncoder;
var init_encoding = __esm({
  "node_modules/lib0/encoding.js"() {
    "use strict";
    init_math();
    init_number();
    init_binary();
    init_string();
    init_array();
    Encoder = class {
      constructor() {
        this.cpos = 0;
        this.cbuf = new Uint8Array(100);
        this.bufs = [];
      }
    };
    createEncoder = () => new Encoder();
    length = (encoder3) => {
      let len = encoder3.cpos;
      for (let i = 0; i < encoder3.bufs.length; i++) {
        len += encoder3.bufs[i].length;
      }
      return len;
    };
    toUint8Array = (encoder3) => {
      const uint8arr = new Uint8Array(length(encoder3));
      let curPos = 0;
      for (let i = 0; i < encoder3.bufs.length; i++) {
        const d = encoder3.bufs[i];
        uint8arr.set(d, curPos);
        curPos += d.length;
      }
      uint8arr.set(new Uint8Array(encoder3.cbuf.buffer, 0, encoder3.cpos), curPos);
      return uint8arr;
    };
    verifyLen = (encoder3, len) => {
      const bufferLen = encoder3.cbuf.length;
      if (bufferLen - encoder3.cpos < len) {
        encoder3.bufs.push(new Uint8Array(encoder3.cbuf.buffer, 0, encoder3.cpos));
        encoder3.cbuf = new Uint8Array(max(bufferLen, len) * 2);
        encoder3.cpos = 0;
      }
    };
    write = (encoder3, num) => {
      const bufferLen = encoder3.cbuf.length;
      if (encoder3.cpos === bufferLen) {
        encoder3.bufs.push(encoder3.cbuf);
        encoder3.cbuf = new Uint8Array(bufferLen * 2);
        encoder3.cpos = 0;
      }
      encoder3.cbuf[encoder3.cpos++] = num;
    };
    writeUint8 = write;
    writeVarUint = (encoder3, num) => {
      while (num > BITS7) {
        write(encoder3, BIT8 | BITS7 & num);
        num = floor(num / 128);
      }
      write(encoder3, BITS7 & num);
    };
    writeVarInt = (encoder3, num) => {
      const isNegative = isNegativeZero(num);
      if (isNegative) {
        num = -num;
      }
      write(encoder3, (num > BITS6 ? BIT8 : 0) | (isNegative ? BIT7 : 0) | BITS6 & num);
      num = floor(num / 64);
      while (num > 0) {
        write(encoder3, (num > BITS7 ? BIT8 : 0) | BITS7 & num);
        num = floor(num / 128);
      }
    };
    _strBuffer = new Uint8Array(3e4);
    _maxStrBSize = _strBuffer.length / 3;
    _writeVarStringNative = (encoder3, str2) => {
      if (str2.length < _maxStrBSize) {
        const written = utf8TextEncoder.encodeInto(str2, _strBuffer).written || 0;
        writeVarUint(encoder3, written);
        for (let i = 0; i < written; i++) {
          write(encoder3, _strBuffer[i]);
        }
      } else {
        writeVarUint8Array(encoder3, encodeUtf8(str2));
      }
    };
    _writeVarStringPolyfill = (encoder3, str2) => {
      const encodedString = unescape(encodeURIComponent(str2));
      const len = encodedString.length;
      writeVarUint(encoder3, len);
      for (let i = 0; i < len; i++) {
        write(
          encoder3,
          /** @type {number} */
          encodedString.codePointAt(i)
        );
      }
    };
    writeVarString = utf8TextEncoder && /** @type {any} */
    utf8TextEncoder.encodeInto ? _writeVarStringNative : _writeVarStringPolyfill;
    writeUint8Array = (encoder3, uint8Array) => {
      const bufferLen = encoder3.cbuf.length;
      const cpos = encoder3.cpos;
      const leftCopyLen = min(bufferLen - cpos, uint8Array.length);
      const rightCopyLen = uint8Array.length - leftCopyLen;
      encoder3.cbuf.set(uint8Array.subarray(0, leftCopyLen), cpos);
      encoder3.cpos += leftCopyLen;
      if (rightCopyLen > 0) {
        encoder3.bufs.push(encoder3.cbuf);
        encoder3.cbuf = new Uint8Array(max(bufferLen * 2, rightCopyLen));
        encoder3.cbuf.set(uint8Array.subarray(leftCopyLen));
        encoder3.cpos = rightCopyLen;
      }
    };
    writeVarUint8Array = (encoder3, uint8Array) => {
      writeVarUint(encoder3, uint8Array.byteLength);
      writeUint8Array(encoder3, uint8Array);
    };
    writeOnDataView = (encoder3, len) => {
      verifyLen(encoder3, len);
      const dview = new DataView(encoder3.cbuf.buffer, encoder3.cpos, len);
      encoder3.cpos += len;
      return dview;
    };
    writeFloat32 = (encoder3, num) => writeOnDataView(encoder3, 4).setFloat32(0, num, false);
    writeFloat64 = (encoder3, num) => writeOnDataView(encoder3, 8).setFloat64(0, num, false);
    writeBigInt64 = (encoder3, num) => (
      /** @type {any} */
      writeOnDataView(encoder3, 8).setBigInt64(0, num, false)
    );
    floatTestBed = new DataView(new ArrayBuffer(4));
    isFloat32 = (num) => {
      floatTestBed.setFloat32(0, num);
      return floatTestBed.getFloat32(0) === num;
    };
    writeAny = (encoder3, data) => {
      switch (typeof data) {
        case "string":
          write(encoder3, 119);
          writeVarString(encoder3, data);
          break;
        case "number":
          if (isInteger(data) && abs(data) <= BITS31) {
            write(encoder3, 125);
            writeVarInt(encoder3, data);
          } else if (isFloat32(data)) {
            write(encoder3, 124);
            writeFloat32(encoder3, data);
          } else {
            write(encoder3, 123);
            writeFloat64(encoder3, data);
          }
          break;
        case "bigint":
          write(encoder3, 122);
          writeBigInt64(encoder3, data);
          break;
        case "object":
          if (data === null) {
            write(encoder3, 126);
          } else if (isArray(data)) {
            write(encoder3, 117);
            writeVarUint(encoder3, data.length);
            for (let i = 0; i < data.length; i++) {
              writeAny(encoder3, data[i]);
            }
          } else if (data instanceof Uint8Array) {
            write(encoder3, 116);
            writeVarUint8Array(encoder3, data);
          } else {
            write(encoder3, 118);
            const keys2 = Object.keys(data);
            writeVarUint(encoder3, keys2.length);
            for (let i = 0; i < keys2.length; i++) {
              const key = keys2[i];
              writeVarString(encoder3, key);
              writeAny(encoder3, data[key]);
            }
          }
          break;
        case "boolean":
          write(encoder3, data ? 120 : 121);
          break;
        default:
          write(encoder3, 127);
      }
    };
    RleEncoder = class extends Encoder {
      /**
       * @param {function(Encoder, T):void} writer
       */
      constructor(writer) {
        super();
        this.w = writer;
        this.s = null;
        this.count = 0;
      }
      /**
       * @param {T} v
       */
      write(v) {
        if (this.s === v) {
          this.count++;
        } else {
          if (this.count > 0) {
            writeVarUint(this, this.count - 1);
          }
          this.count = 1;
          this.w(this, v);
          this.s = v;
        }
      }
    };
    flushUintOptRleEncoder = (encoder3) => {
      if (encoder3.count > 0) {
        writeVarInt(encoder3.encoder, encoder3.count === 1 ? encoder3.s : -encoder3.s);
        if (encoder3.count > 1) {
          writeVarUint(encoder3.encoder, encoder3.count - 2);
        }
      }
    };
    UintOptRleEncoder = class {
      constructor() {
        this.encoder = new Encoder();
        this.s = 0;
        this.count = 0;
      }
      /**
       * @param {number} v
       */
      write(v) {
        if (this.s === v) {
          this.count++;
        } else {
          flushUintOptRleEncoder(this);
          this.count = 1;
          this.s = v;
        }
      }
      /**
       * Flush the encoded state and transform this to a Uint8Array.
       *
       * Note that this should only be called once.
       */
      toUint8Array() {
        flushUintOptRleEncoder(this);
        return toUint8Array(this.encoder);
      }
    };
    flushIntDiffOptRleEncoder = (encoder3) => {
      if (encoder3.count > 0) {
        const encodedDiff = encoder3.diff * 2 + (encoder3.count === 1 ? 0 : 1);
        writeVarInt(encoder3.encoder, encodedDiff);
        if (encoder3.count > 1) {
          writeVarUint(encoder3.encoder, encoder3.count - 2);
        }
      }
    };
    IntDiffOptRleEncoder = class {
      constructor() {
        this.encoder = new Encoder();
        this.s = 0;
        this.count = 0;
        this.diff = 0;
      }
      /**
       * @param {number} v
       */
      write(v) {
        if (this.diff === v - this.s) {
          this.s = v;
          this.count++;
        } else {
          flushIntDiffOptRleEncoder(this);
          this.count = 1;
          this.diff = v - this.s;
          this.s = v;
        }
      }
      /**
       * Flush the encoded state and transform this to a Uint8Array.
       *
       * Note that this should only be called once.
       */
      toUint8Array() {
        flushIntDiffOptRleEncoder(this);
        return toUint8Array(this.encoder);
      }
    };
    StringEncoder = class {
      constructor() {
        this.sarr = [];
        this.s = "";
        this.lensE = new UintOptRleEncoder();
      }
      /**
       * @param {string} string
       */
      write(string) {
        this.s += string;
        if (this.s.length > 19) {
          this.sarr.push(this.s);
          this.s = "";
        }
        this.lensE.write(string.length);
      }
      toUint8Array() {
        const encoder3 = new Encoder();
        this.sarr.push(this.s);
        this.s = "";
        writeVarString(encoder3, this.sarr.join(""));
        writeUint8Array(encoder3, this.lensE.toUint8Array());
        return toUint8Array(encoder3);
      }
    };
  }
});

// node_modules/lib0/error.js
var create3, methodUnimplemented, unexpectedCase;
var init_error = __esm({
  "node_modules/lib0/error.js"() {
    "use strict";
    create3 = (s) => new Error(s);
    methodUnimplemented = () => {
      throw create3("Method unimplemented");
    };
    unexpectedCase = () => {
      throw create3("Unexpected case");
    };
  }
});

// node_modules/lib0/decoding.js
var errorUnexpectedEndOfArray, errorIntegerOutOfRange, Decoder, createDecoder, hasContent, readUint8Array, readVarUint8Array, readUint8, readVarUint, readVarInt, _readVarStringPolyfill, _readVarStringNative, readVarString, readFromDataView, readFloat32, readFloat64, readBigInt64, readAnyLookupTable, readAny, RleDecoder, UintOptRleDecoder, IntDiffOptRleDecoder, StringDecoder;
var init_decoding = __esm({
  "node_modules/lib0/decoding.js"() {
    "use strict";
    init_binary();
    init_math();
    init_number();
    init_string();
    init_error();
    errorUnexpectedEndOfArray = create3("Unexpected end of array");
    errorIntegerOutOfRange = create3("Integer out of Range");
    Decoder = class {
      /**
       * @param {Uint8Array<Buf>} uint8Array Binary data to decode
       */
      constructor(uint8Array) {
        this.arr = uint8Array;
        this.pos = 0;
      }
    };
    createDecoder = (uint8Array) => new Decoder(uint8Array);
    hasContent = (decoder) => decoder.pos !== decoder.arr.length;
    readUint8Array = (decoder, len) => {
      const view = new Uint8Array(decoder.arr.buffer, decoder.pos + decoder.arr.byteOffset, len);
      decoder.pos += len;
      return view;
    };
    readVarUint8Array = (decoder) => readUint8Array(decoder, readVarUint(decoder));
    readUint8 = (decoder) => decoder.arr[decoder.pos++];
    readVarUint = (decoder) => {
      let num = 0;
      let mult = 1;
      const len = decoder.arr.length;
      while (decoder.pos < len) {
        const r = decoder.arr[decoder.pos++];
        num = num + (r & BITS7) * mult;
        mult *= 128;
        if (r < BIT8) {
          return num;
        }
        if (num > MAX_SAFE_INTEGER) {
          throw errorIntegerOutOfRange;
        }
      }
      throw errorUnexpectedEndOfArray;
    };
    readVarInt = (decoder) => {
      let r = decoder.arr[decoder.pos++];
      let num = r & BITS6;
      let mult = 64;
      const sign = (r & BIT7) > 0 ? -1 : 1;
      if ((r & BIT8) === 0) {
        return sign * num;
      }
      const len = decoder.arr.length;
      while (decoder.pos < len) {
        r = decoder.arr[decoder.pos++];
        num = num + (r & BITS7) * mult;
        mult *= 128;
        if (r < BIT8) {
          return sign * num;
        }
        if (num > MAX_SAFE_INTEGER) {
          throw errorIntegerOutOfRange;
        }
      }
      throw errorUnexpectedEndOfArray;
    };
    _readVarStringPolyfill = (decoder) => {
      let remainingLen = readVarUint(decoder);
      if (remainingLen === 0) {
        return "";
      } else {
        let encodedString = String.fromCodePoint(readUint8(decoder));
        if (--remainingLen < 100) {
          while (remainingLen--) {
            encodedString += String.fromCodePoint(readUint8(decoder));
          }
        } else {
          while (remainingLen > 0) {
            const nextLen = remainingLen < 1e4 ? remainingLen : 1e4;
            const bytes = decoder.arr.subarray(decoder.pos, decoder.pos + nextLen);
            decoder.pos += nextLen;
            encodedString += String.fromCodePoint.apply(
              null,
              /** @type {any} */
              bytes
            );
            remainingLen -= nextLen;
          }
        }
        return decodeURIComponent(escape(encodedString));
      }
    };
    _readVarStringNative = (decoder) => (
      /** @type any */
      utf8TextDecoder.decode(readVarUint8Array(decoder))
    );
    readVarString = utf8TextDecoder ? _readVarStringNative : _readVarStringPolyfill;
    readFromDataView = (decoder, len) => {
      const dv = new DataView(decoder.arr.buffer, decoder.arr.byteOffset + decoder.pos, len);
      decoder.pos += len;
      return dv;
    };
    readFloat32 = (decoder) => readFromDataView(decoder, 4).getFloat32(0, false);
    readFloat64 = (decoder) => readFromDataView(decoder, 8).getFloat64(0, false);
    readBigInt64 = (decoder) => (
      /** @type {any} */
      readFromDataView(decoder, 8).getBigInt64(0, false)
    );
    readAnyLookupTable = [
      (decoder) => void 0,
      // CASE 127: undefined
      (decoder) => null,
      // CASE 126: null
      readVarInt,
      // CASE 125: integer
      readFloat32,
      // CASE 124: float32
      readFloat64,
      // CASE 123: float64
      readBigInt64,
      // CASE 122: bigint
      (decoder) => false,
      // CASE 121: boolean (false)
      (decoder) => true,
      // CASE 120: boolean (true)
      readVarString,
      // CASE 119: string
      (decoder) => {
        const len = readVarUint(decoder);
        const obj = {};
        for (let i = 0; i < len; i++) {
          const key = readVarString(decoder);
          obj[key] = readAny(decoder);
        }
        return obj;
      },
      (decoder) => {
        const len = readVarUint(decoder);
        const arr = [];
        for (let i = 0; i < len; i++) {
          arr.push(readAny(decoder));
        }
        return arr;
      },
      readVarUint8Array
      // CASE 116: Uint8Array
    ];
    readAny = (decoder) => readAnyLookupTable[127 - readUint8(decoder)](decoder);
    RleDecoder = class extends Decoder {
      /**
       * @param {Uint8Array} uint8Array
       * @param {function(Decoder):T} reader
       */
      constructor(uint8Array, reader) {
        super(uint8Array);
        this.reader = reader;
        this.s = null;
        this.count = 0;
      }
      read() {
        if (this.count === 0) {
          this.s = this.reader(this);
          if (hasContent(this)) {
            this.count = readVarUint(this) + 1;
          } else {
            this.count = -1;
          }
        }
        this.count--;
        return (
          /** @type {T} */
          this.s
        );
      }
    };
    UintOptRleDecoder = class extends Decoder {
      /**
       * @param {Uint8Array} uint8Array
       */
      constructor(uint8Array) {
        super(uint8Array);
        this.s = 0;
        this.count = 0;
      }
      read() {
        if (this.count === 0) {
          this.s = readVarInt(this);
          const isNegative = isNegativeZero(this.s);
          this.count = 1;
          if (isNegative) {
            this.s = -this.s;
            this.count = readVarUint(this) + 2;
          }
        }
        this.count--;
        return (
          /** @type {number} */
          this.s
        );
      }
    };
    IntDiffOptRleDecoder = class extends Decoder {
      /**
       * @param {Uint8Array} uint8Array
       */
      constructor(uint8Array) {
        super(uint8Array);
        this.s = 0;
        this.count = 0;
        this.diff = 0;
      }
      /**
       * @return {number}
       */
      read() {
        if (this.count === 0) {
          const diff = readVarInt(this);
          const hasCount = diff & 1;
          this.diff = floor(diff / 2);
          this.count = 1;
          if (hasCount) {
            this.count = readVarUint(this) + 2;
          }
        }
        this.s += this.diff;
        this.count--;
        return this.s;
      }
    };
    StringDecoder = class {
      /**
       * @param {Uint8Array} uint8Array
       */
      constructor(uint8Array) {
        this.decoder = new UintOptRleDecoder(uint8Array);
        this.str = readVarString(this.decoder);
        this.spos = 0;
      }
      /**
       * @return {string}
       */
      read() {
        const end = this.spos + this.decoder.read();
        const res = this.str.slice(this.spos, end);
        this.spos = end;
        return res;
      }
    };
  }
});

// node_modules/lib0/webcrypto.node.js
import { webcrypto } from "node:crypto";
var subtle, getRandomValues;
var init_webcrypto_node = __esm({
  "node_modules/lib0/webcrypto.node.js"() {
    "use strict";
    subtle = /** @type {any} */
    webcrypto.subtle;
    getRandomValues = /** @type {any} */
    webcrypto.getRandomValues.bind(webcrypto);
  }
});

// node_modules/lib0/random.js
var uint32, uuidv4Template, uuidv4;
var init_random = __esm({
  "node_modules/lib0/random.js"() {
    "use strict";
    init_webcrypto_node();
    uint32 = () => getRandomValues(new Uint32Array(1))[0];
    uuidv4Template = "10000000-1000-4000-8000" + -1e11;
    uuidv4 = () => uuidv4Template.replace(
      /[018]/g,
      /** @param {number} c */
      (c) => (c ^ uint32() & 15 >> c / 4).toString(16)
    );
  }
});

// node_modules/lib0/time.js
var getUnixTime;
var init_time = __esm({
  "node_modules/lib0/time.js"() {
    "use strict";
    getUnixTime = Date.now;
  }
});

// node_modules/lib0/promise.js
var create4, all;
var init_promise = __esm({
  "node_modules/lib0/promise.js"() {
    "use strict";
    create4 = (f) => (
      /** @type {Promise<T>} */
      new Promise(f)
    );
    all = Promise.all.bind(Promise);
  }
});

// node_modules/lib0/conditions.js
var undefinedToNull;
var init_conditions = __esm({
  "node_modules/lib0/conditions.js"() {
    "use strict";
    undefinedToNull = (v) => v === void 0 ? null : v;
  }
});

// node_modules/lib0/storage.js
var VarStoragePolyfill, _localStorage, usePolyfill, varStorage;
var init_storage = __esm({
  "node_modules/lib0/storage.js"() {
    "use strict";
    VarStoragePolyfill = class {
      constructor() {
        this.map = /* @__PURE__ */ new Map();
      }
      /**
       * @param {string} key
       * @param {any} newValue
       */
      setItem(key, newValue) {
        this.map.set(key, newValue);
      }
      /**
       * @param {string} key
       */
      getItem(key) {
        return this.map.get(key);
      }
    };
    _localStorage = new VarStoragePolyfill();
    usePolyfill = true;
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        _localStorage = localStorage;
        usePolyfill = false;
      }
    } catch (e) {
    }
    varStorage = _localStorage;
  }
});

// node_modules/lib0/trait/equality.js
var EqualityTraitSymbol, equals;
var init_equality = __esm({
  "node_modules/lib0/trait/equality.js"() {
    "use strict";
    EqualityTraitSymbol = /* @__PURE__ */ Symbol("Equality");
    equals = (a, b) => a === b || !!a?.[EqualityTraitSymbol]?.(b) || false;
  }
});

// node_modules/lib0/object.js
var assign, keys, forEach, size, isEmpty, every, hasProperty, equalFlat, freeze, deepFreeze;
var init_object = __esm({
  "node_modules/lib0/object.js"() {
    "use strict";
    init_equality();
    assign = Object.assign;
    keys = Object.keys;
    forEach = (obj, f) => {
      for (const key in obj) {
        f(obj[key], key);
      }
    };
    size = (obj) => keys(obj).length;
    isEmpty = (obj) => {
      for (const _k in obj) {
        return false;
      }
      return true;
    };
    every = (obj, f) => {
      for (const key in obj) {
        if (!f(obj[key], key)) {
          return false;
        }
      }
      return true;
    };
    hasProperty = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    equalFlat = (a, b) => a === b || size(a) === size(b) && every(a, (val, key) => (val !== void 0 || hasProperty(b, key)) && equals(b[key], val));
    freeze = Object.freeze;
    deepFreeze = (o) => {
      for (const key in o) {
        const c = o[key];
        if (typeof c === "object" || typeof c === "function") {
          deepFreeze(o[key]);
        }
      }
      return freeze(o);
    };
  }
});

// node_modules/lib0/function.js
var callAll, isOneOf;
var init_function = __esm({
  "node_modules/lib0/function.js"() {
    "use strict";
    callAll = (fs9, args2, i = 0) => {
      try {
        for (; i < fs9.length; i++) {
          fs9[i](...args2);
        }
      } finally {
        if (i < fs9.length) {
          callAll(fs9, args2, i + 1);
        }
      }
    };
    isOneOf = (value, options) => options.includes(value);
  }
});

// node_modules/lib0/environment.js
var isNode, isMac, params, args, computeParams, hasParam, getVariable, hasConf, production, forceColor, supportsColor;
var init_environment = __esm({
  "node_modules/lib0/environment.js"() {
    "use strict";
    init_map();
    init_string();
    init_conditions();
    init_storage();
    init_function();
    isNode = typeof process !== "undefined" && process.release && /node|io\.js/.test(process.release.name) && Object.prototype.toString.call(typeof process !== "undefined" ? process : 0) === "[object process]";
    isMac = typeof navigator !== "undefined" ? /Mac/.test(navigator.platform) : false;
    args = [];
    computeParams = () => {
      if (params === void 0) {
        if (isNode) {
          params = create();
          const pargs = process.argv;
          let currParamName = null;
          for (let i = 0; i < pargs.length; i++) {
            const parg = pargs[i];
            if (parg[0] === "-") {
              if (currParamName !== null) {
                params.set(currParamName, "");
              }
              currParamName = parg;
            } else {
              if (currParamName !== null) {
                params.set(currParamName, parg);
                currParamName = null;
              } else {
                args.push(parg);
              }
            }
          }
          if (currParamName !== null) {
            params.set(currParamName, "");
          }
        } else if (typeof location === "object") {
          params = create();
          (location.search || "?").slice(1).split("&").forEach((kv) => {
            if (kv.length !== 0) {
              const [key, value] = kv.split("=");
              params.set(`--${fromCamelCase(key, "-")}`, value);
              params.set(`-${fromCamelCase(key, "-")}`, value);
            }
          });
        } else {
          params = create();
        }
      }
      return params;
    };
    hasParam = (name) => computeParams().has(name);
    getVariable = (name) => isNode ? undefinedToNull(process.env[name.toUpperCase().replaceAll("-", "_")]) : undefinedToNull(varStorage.getItem(name));
    hasConf = (name) => hasParam("--" + name) || getVariable(name) !== null;
    production = hasConf("production");
    forceColor = isNode && isOneOf(process.env.FORCE_COLOR, ["true", "1", "2"]);
    supportsColor = forceColor || !hasParam("--no-colors") && // @todo deprecate --no-colors
    !hasConf("no-color") && (!isNode || process.stdout.isTTY) && (!isNode || hasParam("--color") || getVariable("COLORTERM") !== null || (getVariable("TERM") || "").includes("color"));
  }
});

// node_modules/lib0/buffer.js
var createUint8ArrayFromLen, copyUint8Array;
var init_buffer = __esm({
  "node_modules/lib0/buffer.js"() {
    "use strict";
    createUint8ArrayFromLen = (len) => new Uint8Array(len);
    copyUint8Array = (uint8Array) => {
      const newBuf = createUint8ArrayFromLen(uint8Array.byteLength);
      newBuf.set(uint8Array);
      return newBuf;
    };
  }
});

// node_modules/lib0/symbol.js
var create5;
var init_symbol = __esm({
  "node_modules/lib0/symbol.js"() {
    "use strict";
    create5 = Symbol;
  }
});

// node_modules/lib0/logging.common.js
var BOLD, UNBOLD, BLUE, GREY, GREEN, RED, PURPLE, ORANGE, UNCOLOR, computeNoColorLoggingArgs, lastLoggingTime;
var init_logging_common = __esm({
  "node_modules/lib0/logging.common.js"() {
    "use strict";
    init_symbol();
    init_time();
    BOLD = create5();
    UNBOLD = create5();
    BLUE = create5();
    GREY = create5();
    GREEN = create5();
    RED = create5();
    PURPLE = create5();
    ORANGE = create5();
    UNCOLOR = create5();
    computeNoColorLoggingArgs = (args2) => {
      if (args2.length === 1 && args2[0]?.constructor === Function) {
        args2 = /** @type {Array<string|Symbol|Object|number>} */
        /** @type {[function]} */
        args2[0]();
      }
      const strBuilder = [];
      const logArgs = [];
      let i = 0;
      for (; i < args2.length; i++) {
        const arg = args2[i];
        if (arg === void 0) {
          break;
        } else if (arg.constructor === String || arg.constructor === Number) {
          strBuilder.push(arg);
        } else if (arg.constructor === Object) {
          break;
        }
      }
      if (i > 0) {
        logArgs.push(strBuilder.join(""));
      }
      for (; i < args2.length; i++) {
        const arg = args2[i];
        if (!(arg instanceof Symbol)) {
          logArgs.push(arg);
        }
      }
      return logArgs;
    };
    lastLoggingTime = getUnixTime();
  }
});

// node_modules/lib0/logging.node.js
var _nodeStyleMap, computeNodeLoggingArgs, computeLoggingArgs, print, warn;
var init_logging_node = __esm({
  "node_modules/lib0/logging.node.js"() {
    "use strict";
    init_environment();
    init_logging_common();
    init_logging_common();
    _nodeStyleMap = {
      [BOLD]: "\x1B[1m",
      [UNBOLD]: "\x1B[2m",
      [BLUE]: "\x1B[34m",
      [GREEN]: "\x1B[32m",
      [GREY]: "\x1B[37m",
      [RED]: "\x1B[31m",
      [PURPLE]: "\x1B[35m",
      [ORANGE]: "\x1B[38;5;208m",
      [UNCOLOR]: "\x1B[0m"
    };
    computeNodeLoggingArgs = (args2) => {
      if (args2.length === 1 && args2[0]?.constructor === Function) {
        args2 = /** @type {Array<string|Symbol|Object|number>} */
        /** @type {[function]} */
        args2[0]();
      }
      const strBuilder = [];
      const logArgs = [];
      let i = 0;
      for (; i < args2.length; i++) {
        const arg = args2[i];
        const style = _nodeStyleMap[arg];
        if (style !== void 0) {
          strBuilder.push(style);
        } else {
          if (arg === void 0) {
            break;
          } else if (arg.constructor === String || arg.constructor === Number) {
            strBuilder.push(arg);
          } else {
            break;
          }
        }
      }
      if (i > 0) {
        strBuilder.push("\x1B[0m");
        logArgs.push(strBuilder.join(""));
      }
      for (; i < args2.length; i++) {
        const arg = args2[i];
        if (!(arg instanceof Symbol)) {
          logArgs.push(arg);
        }
      }
      return logArgs;
    };
    computeLoggingArgs = supportsColor ? computeNodeLoggingArgs : computeNoColorLoggingArgs;
    print = (...args2) => {
      console.log(...computeLoggingArgs(args2));
    };
    warn = (...args2) => {
      console.warn(...computeLoggingArgs(args2));
    };
  }
});

// node_modules/lib0/iterator.js
var createIterator, iteratorFilter, iteratorMap;
var init_iterator = __esm({
  "node_modules/lib0/iterator.js"() {
    "use strict";
    createIterator = (next) => ({
      /**
       * @return {IterableIterator<T>}
       */
      [Symbol.iterator]() {
        return this;
      },
      // @ts-ignore
      next
    });
    iteratorFilter = (iterator, filter) => createIterator(() => {
      let res;
      do {
        res = iterator.next();
      } while (!res.done && !filter(res.value));
      return res;
    });
    iteratorMap = (iterator, fmap) => createIterator(() => {
      const { done, value } = iterator.next();
      return { done, value: done ? void 0 : fmap(value) };
    });
  }
});

// node_modules/yjs/dist/yjs.mjs
function* lazyStructReaderGenerator(decoder) {
  const numOfStateUpdates = readVarUint(decoder.restDecoder);
  for (let i = 0; i < numOfStateUpdates; i++) {
    const numberOfStructs = readVarUint(decoder.restDecoder);
    const client = decoder.readClient();
    let clock = readVarUint(decoder.restDecoder);
    for (let i2 = 0; i2 < numberOfStructs; i2++) {
      const info = decoder.readInfo();
      if (info === 10) {
        const len = readVarUint(decoder.restDecoder);
        yield new Skip(createID(client, clock), len);
        clock += len;
      } else if ((BITS5 & info) !== 0) {
        const cantCopyParentInfo = (info & (BIT7 | BIT8)) === 0;
        const struct = new Item(
          createID(client, clock),
          null,
          // left
          (info & BIT8) === BIT8 ? decoder.readLeftID() : null,
          // origin
          null,
          // right
          (info & BIT7) === BIT7 ? decoder.readRightID() : null,
          // right origin
          // @ts-ignore Force writing a string here.
          cantCopyParentInfo ? decoder.readParentInfo() ? decoder.readString() : decoder.readLeftID() : null,
          // parent
          cantCopyParentInfo && (info & BIT6) === BIT6 ? decoder.readString() : null,
          // parentSub
          readItemContent(decoder, info)
          // item content
        );
        yield struct;
        clock += struct.length;
      } else {
        const len = decoder.readLen();
        yield new GC(createID(client, clock), len);
        clock += len;
      }
    }
  }
}
var DeleteItem, DeleteSet, iterateDeletedStructs, findIndexDS, isDeleted, sortAndMergeDeleteSet, mergeDeleteSets, addToDeleteSet, createDeleteSet, writeDeleteSet, readDeleteSet, readAndApplyDeleteSet, generateNewClientId, Doc, DSDecoderV1, UpdateDecoderV1, DSDecoderV2, UpdateDecoderV2, DSEncoderV1, UpdateEncoderV1, DSEncoderV2, UpdateEncoderV2, writeStructs, writeClientsStructs, readClientsStructRefs, integrateStructs, writeStructsFromTransaction, readUpdateV2, applyUpdateV2, applyUpdate, EventHandler, createEventHandler, addEventHandlerListener, removeEventHandlerListener, callEventHandlerListeners, ID, compareIDs, createID, findRootTypeKey, RelativePosition, relativePositionToJSON, createRelativePositionFromJSON, AbsolutePosition, createAbsolutePosition, createRelativePosition, createRelativePositionFromTypeIndex, getItemWithOffset, createAbsolutePositionFromRelativePosition, Snapshot, createSnapshot, emptySnapshot, isVisible, splitSnapshotAffectedStructs, StructStore, getStateVector, getState, addStruct, findIndexSS, find, getItem, findIndexCleanStart, getItemCleanStart, getItemCleanEnd, replaceStruct, iterateStructs, Transaction, writeUpdateMessageFromTransaction, addChangedTypeToTransaction, tryToMergeWithLefts, tryGcDeleteSet, tryMergeDeleteSet, cleanupTransactions, transact, LazyStructReader, LazyStructWriter, sliceStruct, mergeUpdatesV2, flushLazyStructWriter, writeStructToLazyStructWriter, finishLazyStructWriting, errorComputeChanges, YEvent, getPathTo, warnPrematureAccess, maxSearchMarker, globalSearchMarkerTimestamp, ArraySearchMarker, refreshMarkerTimestamp, overwriteMarker, markPosition, findMarker, updateMarkerChanges, callTypeObservers, AbstractType, typeListSlice, typeListToArray, typeListForEach, typeListMap, typeListCreateIterator, typeListGet, typeListInsertGenericsAfter, lengthExceeded, typeListInsertGenerics, typeListPushGenerics, typeListDelete, typeMapDelete, typeMapSet, typeMapGet, typeMapGetAll, typeMapHas, typeMapGetAllSnapshot, createMapIterator, YArrayEvent, YArray, readYArray, YMapEvent, YMap, readYMap, equalAttrs, ItemTextListPosition, findNextPosition, findPosition, insertNegatedAttributes, updateCurrentAttributes, minimizeAttributeChanges, insertAttributes, insertText, formatText, cleanupFormattingGap, cleanupContextlessFormattingGap, cleanupYTextFormatting, cleanupYTextAfterTransaction, deleteText, YTextEvent, YText, readYText, YXmlTreeWalker, YXmlFragment, readYXmlFragment, YXmlElement, readYXmlElement, YXmlEvent, YXmlHook, readYXmlHook, YXmlText, readYXmlText, AbstractStruct, structGCRefNumber, GC, ContentBinary, readContentBinary, ContentDeleted, readContentDeleted, createDocFromOpts, ContentDoc, readContentDoc, ContentEmbed, readContentEmbed, ContentFormat, readContentFormat, ContentJSON, readContentJSON, isDevMode, ContentAny, readContentAny, ContentString, readContentString, typeRefs, YArrayRefID, YMapRefID, YTextRefID, YXmlElementRefID, YXmlFragmentRefID, YXmlHookRefID, YXmlTextRefID, ContentType, readContentType, followRedone, splitItem, Item, readItemContent, contentRefs, structSkipRefNumber, Skip, glo, importIdentifier;
var init_yjs = __esm({
  "node_modules/yjs/dist/yjs.mjs"() {
    "use strict";
    init_observable();
    init_array();
    init_math();
    init_map();
    init_encoding();
    init_decoding();
    init_random();
    init_promise();
    init_buffer();
    init_error();
    init_binary();
    init_function();
    init_function();
    init_set();
    init_logging_node();
    init_iterator();
    init_object();
    init_environment();
    DeleteItem = class {
      /**
       * @param {number} clock
       * @param {number} len
       */
      constructor(clock, len) {
        this.clock = clock;
        this.len = len;
      }
    };
    DeleteSet = class {
      constructor() {
        this.clients = /* @__PURE__ */ new Map();
      }
    };
    iterateDeletedStructs = (transaction, ds, f) => ds.clients.forEach((deletes, clientid) => {
      const structs = (
        /** @type {Array<GC|Item>} */
        transaction.doc.store.clients.get(clientid)
      );
      if (structs != null) {
        const lastStruct = structs[structs.length - 1];
        const clockState = lastStruct.id.clock + lastStruct.length;
        for (let i = 0, del = deletes[i]; i < deletes.length && del.clock < clockState; del = deletes[++i]) {
          iterateStructs(transaction, structs, del.clock, del.len, f);
        }
      }
    });
    findIndexDS = (dis, clock) => {
      let left = 0;
      let right = dis.length - 1;
      while (left <= right) {
        const midindex = floor((left + right) / 2);
        const mid = dis[midindex];
        const midclock = mid.clock;
        if (midclock <= clock) {
          if (clock < midclock + mid.len) {
            return midindex;
          }
          left = midindex + 1;
        } else {
          right = midindex - 1;
        }
      }
      return null;
    };
    isDeleted = (ds, id2) => {
      const dis = ds.clients.get(id2.client);
      return dis !== void 0 && findIndexDS(dis, id2.clock) !== null;
    };
    sortAndMergeDeleteSet = (ds) => {
      ds.clients.forEach((dels) => {
        dels.sort((a, b) => a.clock - b.clock);
        let i, j;
        for (i = 1, j = 1; i < dels.length; i++) {
          const left = dels[j - 1];
          const right = dels[i];
          if (left.clock + left.len >= right.clock) {
            dels[j - 1] = new DeleteItem(left.clock, max(left.len, right.clock + right.len - left.clock));
          } else {
            if (j < i) {
              dels[j] = right;
            }
            j++;
          }
        }
        dels.length = j;
      });
    };
    mergeDeleteSets = (dss) => {
      const merged = new DeleteSet();
      for (let dssI = 0; dssI < dss.length; dssI++) {
        dss[dssI].clients.forEach((delsLeft, client) => {
          if (!merged.clients.has(client)) {
            const dels = delsLeft.slice();
            for (let i = dssI + 1; i < dss.length; i++) {
              appendTo(dels, dss[i].clients.get(client) || []);
            }
            merged.clients.set(client, dels);
          }
        });
      }
      sortAndMergeDeleteSet(merged);
      return merged;
    };
    addToDeleteSet = (ds, client, clock, length2) => {
      setIfUndefined(ds.clients, client, () => (
        /** @type {Array<DeleteItem>} */
        []
      )).push(new DeleteItem(clock, length2));
    };
    createDeleteSet = () => new DeleteSet();
    writeDeleteSet = (encoder3, ds) => {
      writeVarUint(encoder3.restEncoder, ds.clients.size);
      from(ds.clients.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, dsitems]) => {
        encoder3.resetDsCurVal();
        writeVarUint(encoder3.restEncoder, client);
        const len = dsitems.length;
        writeVarUint(encoder3.restEncoder, len);
        for (let i = 0; i < len; i++) {
          const item = dsitems[i];
          encoder3.writeDsClock(item.clock);
          encoder3.writeDsLen(item.len);
        }
      });
    };
    readDeleteSet = (decoder) => {
      const ds = new DeleteSet();
      const numClients = readVarUint(decoder.restDecoder);
      for (let i = 0; i < numClients; i++) {
        decoder.resetDsCurVal();
        const client = readVarUint(decoder.restDecoder);
        const numberOfDeletes = readVarUint(decoder.restDecoder);
        if (numberOfDeletes > 0) {
          const dsField = setIfUndefined(ds.clients, client, () => (
            /** @type {Array<DeleteItem>} */
            []
          ));
          for (let i2 = 0; i2 < numberOfDeletes; i2++) {
            dsField.push(new DeleteItem(decoder.readDsClock(), decoder.readDsLen()));
          }
        }
      }
      return ds;
    };
    readAndApplyDeleteSet = (decoder, transaction, store) => {
      const unappliedDS = new DeleteSet();
      const numClients = readVarUint(decoder.restDecoder);
      for (let i = 0; i < numClients; i++) {
        decoder.resetDsCurVal();
        const client = readVarUint(decoder.restDecoder);
        const numberOfDeletes = readVarUint(decoder.restDecoder);
        const structs = store.clients.get(client) || [];
        const state = getState(store, client);
        for (let i2 = 0; i2 < numberOfDeletes; i2++) {
          const clock = decoder.readDsClock();
          const clockEnd = clock + decoder.readDsLen();
          if (clock < state) {
            if (state < clockEnd) {
              addToDeleteSet(unappliedDS, client, state, clockEnd - state);
            }
            let index = findIndexSS(structs, clock);
            let struct = structs[index];
            if (!struct.deleted && struct.id.clock < clock) {
              structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock));
              index++;
            }
            while (index < structs.length) {
              struct = structs[index++];
              if (struct.id.clock < clockEnd) {
                if (!struct.deleted) {
                  if (clockEnd < struct.id.clock + struct.length) {
                    structs.splice(index, 0, splitItem(transaction, struct, clockEnd - struct.id.clock));
                  }
                  struct.delete(transaction);
                }
              } else {
                break;
              }
            }
          } else {
            addToDeleteSet(unappliedDS, client, clock, clockEnd - clock);
          }
        }
      }
      if (unappliedDS.clients.size > 0) {
        const ds = new UpdateEncoderV2();
        writeVarUint(ds.restEncoder, 0);
        writeDeleteSet(ds, unappliedDS);
        return ds.toUint8Array();
      }
      return null;
    };
    generateNewClientId = uint32;
    Doc = class _Doc extends ObservableV2 {
      /**
       * @param {DocOpts} opts configuration
       */
      constructor({ guid = uuidv4(), collectionid = null, gc = true, gcFilter = () => true, meta = null, autoLoad = false, shouldLoad = true } = {}) {
        super();
        this.gc = gc;
        this.gcFilter = gcFilter;
        this.clientID = generateNewClientId();
        this.guid = guid;
        this.collectionid = collectionid;
        this.share = /* @__PURE__ */ new Map();
        this.store = new StructStore();
        this._transaction = null;
        this._transactionCleanups = [];
        this.subdocs = /* @__PURE__ */ new Set();
        this._item = null;
        this.shouldLoad = shouldLoad;
        this.autoLoad = autoLoad;
        this.meta = meta;
        this.isLoaded = false;
        this.isSynced = false;
        this.isDestroyed = false;
        this.whenLoaded = create4((resolve) => {
          this.on("load", () => {
            this.isLoaded = true;
            resolve(this);
          });
        });
        const provideSyncedPromise = () => create4((resolve) => {
          const eventHandler = (isSynced) => {
            if (isSynced === void 0 || isSynced === true) {
              this.off("sync", eventHandler);
              resolve();
            }
          };
          this.on("sync", eventHandler);
        });
        this.on("sync", (isSynced) => {
          if (isSynced === false && this.isSynced) {
            this.whenSynced = provideSyncedPromise();
          }
          this.isSynced = isSynced === void 0 || isSynced === true;
          if (this.isSynced && !this.isLoaded) {
            this.emit("load", [this]);
          }
        });
        this.whenSynced = provideSyncedPromise();
      }
      /**
       * Notify the parent document that you request to load data into this subdocument (if it is a subdocument).
       *
       * `load()` might be used in the future to request any provider to load the most current data.
       *
       * It is safe to call `load()` multiple times.
       */
      load() {
        const item = this._item;
        if (item !== null && !this.shouldLoad) {
          transact(
            /** @type {any} */
            item.parent.doc,
            (transaction) => {
              transaction.subdocsLoaded.add(this);
            },
            null,
            true
          );
        }
        this.shouldLoad = true;
      }
      getSubdocs() {
        return this.subdocs;
      }
      getSubdocGuids() {
        return new Set(from(this.subdocs).map((doc) => doc.guid));
      }
      /**
       * Changes that happen inside of a transaction are bundled. This means that
       * the observer fires _after_ the transaction is finished and that all changes
       * that happened inside of the transaction are sent as one message to the
       * other peers.
       *
       * @template T
       * @param {function(Transaction):T} f The function that should be executed as a transaction
       * @param {any} [origin] Origin of who started the transaction. Will be stored on transaction.origin
       * @return T
       *
       * @public
       */
      transact(f, origin = null) {
        return transact(this, f, origin);
      }
      /**
       * Define a shared data type.
       *
       * Multiple calls of `ydoc.get(name, TypeConstructor)` yield the same result
       * and do not overwrite each other. I.e.
       * `ydoc.get(name, Y.Array) === ydoc.get(name, Y.Array)`
       *
       * After this method is called, the type is also available on `ydoc.share.get(name)`.
       *
       * *Best Practices:*
       * Define all types right after the Y.Doc instance is created and store them in a separate object.
       * Also use the typed methods `getText(name)`, `getArray(name)`, ..
       *
       * @template {typeof AbstractType<any>} Type
       * @example
       *   const ydoc = new Y.Doc(..)
       *   const appState = {
       *     document: ydoc.getText('document')
       *     comments: ydoc.getArray('comments')
       *   }
       *
       * @param {string} name
       * @param {Type} TypeConstructor The constructor of the type definition. E.g. Y.Text, Y.Array, Y.Map, ...
       * @return {InstanceType<Type>} The created type. Constructed with TypeConstructor
       *
       * @public
       */
      get(name, TypeConstructor = (
        /** @type {any} */
        AbstractType
      )) {
        const type = setIfUndefined(this.share, name, () => {
          const t = new TypeConstructor();
          t._integrate(this, null);
          return t;
        });
        const Constr = type.constructor;
        if (TypeConstructor !== AbstractType && Constr !== TypeConstructor) {
          if (Constr === AbstractType) {
            const t = new TypeConstructor();
            t._map = type._map;
            type._map.forEach(
              /** @param {Item?} n */
              (n) => {
                for (; n !== null; n = n.left) {
                  n.parent = t;
                }
              }
            );
            t._start = type._start;
            for (let n = t._start; n !== null; n = n.right) {
              n.parent = t;
            }
            t._length = type._length;
            this.share.set(name, t);
            t._integrate(this, null);
            return (
              /** @type {InstanceType<Type>} */
              t
            );
          } else {
            throw new Error(`Type with the name ${name} has already been defined with a different constructor`);
          }
        }
        return (
          /** @type {InstanceType<Type>} */
          type
        );
      }
      /**
       * @template T
       * @param {string} [name]
       * @return {YArray<T>}
       *
       * @public
       */
      getArray(name = "") {
        return (
          /** @type {YArray<T>} */
          this.get(name, YArray)
        );
      }
      /**
       * @param {string} [name]
       * @return {YText}
       *
       * @public
       */
      getText(name = "") {
        return this.get(name, YText);
      }
      /**
       * @template T
       * @param {string} [name]
       * @return {YMap<T>}
       *
       * @public
       */
      getMap(name = "") {
        return (
          /** @type {YMap<T>} */
          this.get(name, YMap)
        );
      }
      /**
       * @param {string} [name]
       * @return {YXmlElement}
       *
       * @public
       */
      getXmlElement(name = "") {
        return (
          /** @type {YXmlElement<{[key:string]:string}>} */
          this.get(name, YXmlElement)
        );
      }
      /**
       * @param {string} [name]
       * @return {YXmlFragment}
       *
       * @public
       */
      getXmlFragment(name = "") {
        return this.get(name, YXmlFragment);
      }
      /**
       * Converts the entire document into a js object, recursively traversing each yjs type
       * Doesn't log types that have not been defined (using ydoc.getType(..)).
       *
       * @deprecated Do not use this method and rather call toJSON directly on the shared types.
       *
       * @return {Object<string, any>}
       */
      toJSON() {
        const doc = {};
        this.share.forEach((value, key) => {
          doc[key] = value.toJSON();
        });
        return doc;
      }
      /**
       * Emit `destroy` event and unregister all event handlers.
       */
      destroy() {
        this.isDestroyed = true;
        from(this.subdocs).forEach((subdoc) => subdoc.destroy());
        const item = this._item;
        if (item !== null) {
          this._item = null;
          const content = (
            /** @type {ContentDoc} */
            item.content
          );
          content.doc = new _Doc({ guid: this.guid, ...content.opts, shouldLoad: false });
          content.doc._item = item;
          transact(
            /** @type {any} */
            item.parent.doc,
            (transaction) => {
              const doc = content.doc;
              if (!item.deleted) {
                transaction.subdocsAdded.add(doc);
              }
              transaction.subdocsRemoved.add(this);
            },
            null,
            true
          );
        }
        this.emit("destroyed", [true]);
        this.emit("destroy", [this]);
        super.destroy();
      }
    };
    DSDecoderV1 = class {
      /**
       * @param {decoding.Decoder} decoder
       */
      constructor(decoder) {
        this.restDecoder = decoder;
      }
      resetDsCurVal() {
      }
      /**
       * @return {number}
       */
      readDsClock() {
        return readVarUint(this.restDecoder);
      }
      /**
       * @return {number}
       */
      readDsLen() {
        return readVarUint(this.restDecoder);
      }
    };
    UpdateDecoderV1 = class extends DSDecoderV1 {
      /**
       * @return {ID}
       */
      readLeftID() {
        return createID(readVarUint(this.restDecoder), readVarUint(this.restDecoder));
      }
      /**
       * @return {ID}
       */
      readRightID() {
        return createID(readVarUint(this.restDecoder), readVarUint(this.restDecoder));
      }
      /**
       * Read the next client id.
       * Use this in favor of readID whenever possible to reduce the number of objects created.
       */
      readClient() {
        return readVarUint(this.restDecoder);
      }
      /**
       * @return {number} info An unsigned 8-bit integer
       */
      readInfo() {
        return readUint8(this.restDecoder);
      }
      /**
       * @return {string}
       */
      readString() {
        return readVarString(this.restDecoder);
      }
      /**
       * @return {boolean} isKey
       */
      readParentInfo() {
        return readVarUint(this.restDecoder) === 1;
      }
      /**
       * @return {number} info An unsigned 8-bit integer
       */
      readTypeRef() {
        return readVarUint(this.restDecoder);
      }
      /**
       * Write len of a struct - well suited for Opt RLE encoder.
       *
       * @return {number} len
       */
      readLen() {
        return readVarUint(this.restDecoder);
      }
      /**
       * @return {any}
       */
      readAny() {
        return readAny(this.restDecoder);
      }
      /**
       * @return {Uint8Array}
       */
      readBuf() {
        return copyUint8Array(readVarUint8Array(this.restDecoder));
      }
      /**
       * Legacy implementation uses JSON parse. We use any-decoding in v2.
       *
       * @return {any}
       */
      readJSON() {
        return JSON.parse(readVarString(this.restDecoder));
      }
      /**
       * @return {string}
       */
      readKey() {
        return readVarString(this.restDecoder);
      }
    };
    DSDecoderV2 = class {
      /**
       * @param {decoding.Decoder} decoder
       */
      constructor(decoder) {
        this.dsCurrVal = 0;
        this.restDecoder = decoder;
      }
      resetDsCurVal() {
        this.dsCurrVal = 0;
      }
      /**
       * @return {number}
       */
      readDsClock() {
        this.dsCurrVal += readVarUint(this.restDecoder);
        return this.dsCurrVal;
      }
      /**
       * @return {number}
       */
      readDsLen() {
        const diff = readVarUint(this.restDecoder) + 1;
        this.dsCurrVal += diff;
        return diff;
      }
    };
    UpdateDecoderV2 = class extends DSDecoderV2 {
      /**
       * @param {decoding.Decoder} decoder
       */
      constructor(decoder) {
        super(decoder);
        this.keys = [];
        readVarUint(decoder);
        this.keyClockDecoder = new IntDiffOptRleDecoder(readVarUint8Array(decoder));
        this.clientDecoder = new UintOptRleDecoder(readVarUint8Array(decoder));
        this.leftClockDecoder = new IntDiffOptRleDecoder(readVarUint8Array(decoder));
        this.rightClockDecoder = new IntDiffOptRleDecoder(readVarUint8Array(decoder));
        this.infoDecoder = new RleDecoder(readVarUint8Array(decoder), readUint8);
        this.stringDecoder = new StringDecoder(readVarUint8Array(decoder));
        this.parentInfoDecoder = new RleDecoder(readVarUint8Array(decoder), readUint8);
        this.typeRefDecoder = new UintOptRleDecoder(readVarUint8Array(decoder));
        this.lenDecoder = new UintOptRleDecoder(readVarUint8Array(decoder));
      }
      /**
       * @return {ID}
       */
      readLeftID() {
        return new ID(this.clientDecoder.read(), this.leftClockDecoder.read());
      }
      /**
       * @return {ID}
       */
      readRightID() {
        return new ID(this.clientDecoder.read(), this.rightClockDecoder.read());
      }
      /**
       * Read the next client id.
       * Use this in favor of readID whenever possible to reduce the number of objects created.
       */
      readClient() {
        return this.clientDecoder.read();
      }
      /**
       * @return {number} info An unsigned 8-bit integer
       */
      readInfo() {
        return (
          /** @type {number} */
          this.infoDecoder.read()
        );
      }
      /**
       * @return {string}
       */
      readString() {
        return this.stringDecoder.read();
      }
      /**
       * @return {boolean}
       */
      readParentInfo() {
        return this.parentInfoDecoder.read() === 1;
      }
      /**
       * @return {number} An unsigned 8-bit integer
       */
      readTypeRef() {
        return this.typeRefDecoder.read();
      }
      /**
       * Write len of a struct - well suited for Opt RLE encoder.
       *
       * @return {number}
       */
      readLen() {
        return this.lenDecoder.read();
      }
      /**
       * @return {any}
       */
      readAny() {
        return readAny(this.restDecoder);
      }
      /**
       * @return {Uint8Array}
       */
      readBuf() {
        return readVarUint8Array(this.restDecoder);
      }
      /**
       * This is mainly here for legacy purposes.
       *
       * Initial we incoded objects using JSON. Now we use the much faster lib0/any-encoder. This method mainly exists for legacy purposes for the v1 encoder.
       *
       * @return {any}
       */
      readJSON() {
        return readAny(this.restDecoder);
      }
      /**
       * @return {string}
       */
      readKey() {
        const keyClock = this.keyClockDecoder.read();
        if (keyClock < this.keys.length) {
          return this.keys[keyClock];
        } else {
          const key = this.stringDecoder.read();
          this.keys.push(key);
          return key;
        }
      }
    };
    DSEncoderV1 = class {
      constructor() {
        this.restEncoder = createEncoder();
      }
      toUint8Array() {
        return toUint8Array(this.restEncoder);
      }
      resetDsCurVal() {
      }
      /**
       * @param {number} clock
       */
      writeDsClock(clock) {
        writeVarUint(this.restEncoder, clock);
      }
      /**
       * @param {number} len
       */
      writeDsLen(len) {
        writeVarUint(this.restEncoder, len);
      }
    };
    UpdateEncoderV1 = class extends DSEncoderV1 {
      /**
       * @param {ID} id
       */
      writeLeftID(id2) {
        writeVarUint(this.restEncoder, id2.client);
        writeVarUint(this.restEncoder, id2.clock);
      }
      /**
       * @param {ID} id
       */
      writeRightID(id2) {
        writeVarUint(this.restEncoder, id2.client);
        writeVarUint(this.restEncoder, id2.clock);
      }
      /**
       * Use writeClient and writeClock instead of writeID if possible.
       * @param {number} client
       */
      writeClient(client) {
        writeVarUint(this.restEncoder, client);
      }
      /**
       * @param {number} info An unsigned 8-bit integer
       */
      writeInfo(info) {
        writeUint8(this.restEncoder, info);
      }
      /**
       * @param {string} s
       */
      writeString(s) {
        writeVarString(this.restEncoder, s);
      }
      /**
       * @param {boolean} isYKey
       */
      writeParentInfo(isYKey) {
        writeVarUint(this.restEncoder, isYKey ? 1 : 0);
      }
      /**
       * @param {number} info An unsigned 8-bit integer
       */
      writeTypeRef(info) {
        writeVarUint(this.restEncoder, info);
      }
      /**
       * Write len of a struct - well suited for Opt RLE encoder.
       *
       * @param {number} len
       */
      writeLen(len) {
        writeVarUint(this.restEncoder, len);
      }
      /**
       * @param {any} any
       */
      writeAny(any2) {
        writeAny(this.restEncoder, any2);
      }
      /**
       * @param {Uint8Array} buf
       */
      writeBuf(buf) {
        writeVarUint8Array(this.restEncoder, buf);
      }
      /**
       * @param {any} embed
       */
      writeJSON(embed) {
        writeVarString(this.restEncoder, JSON.stringify(embed));
      }
      /**
       * @param {string} key
       */
      writeKey(key) {
        writeVarString(this.restEncoder, key);
      }
    };
    DSEncoderV2 = class {
      constructor() {
        this.restEncoder = createEncoder();
        this.dsCurrVal = 0;
      }
      toUint8Array() {
        return toUint8Array(this.restEncoder);
      }
      resetDsCurVal() {
        this.dsCurrVal = 0;
      }
      /**
       * @param {number} clock
       */
      writeDsClock(clock) {
        const diff = clock - this.dsCurrVal;
        this.dsCurrVal = clock;
        writeVarUint(this.restEncoder, diff);
      }
      /**
       * @param {number} len
       */
      writeDsLen(len) {
        if (len === 0) {
          unexpectedCase();
        }
        writeVarUint(this.restEncoder, len - 1);
        this.dsCurrVal += len;
      }
    };
    UpdateEncoderV2 = class extends DSEncoderV2 {
      constructor() {
        super();
        this.keyMap = /* @__PURE__ */ new Map();
        this.keyClock = 0;
        this.keyClockEncoder = new IntDiffOptRleEncoder();
        this.clientEncoder = new UintOptRleEncoder();
        this.leftClockEncoder = new IntDiffOptRleEncoder();
        this.rightClockEncoder = new IntDiffOptRleEncoder();
        this.infoEncoder = new RleEncoder(writeUint8);
        this.stringEncoder = new StringEncoder();
        this.parentInfoEncoder = new RleEncoder(writeUint8);
        this.typeRefEncoder = new UintOptRleEncoder();
        this.lenEncoder = new UintOptRleEncoder();
      }
      toUint8Array() {
        const encoder3 = createEncoder();
        writeVarUint(encoder3, 0);
        writeVarUint8Array(encoder3, this.keyClockEncoder.toUint8Array());
        writeVarUint8Array(encoder3, this.clientEncoder.toUint8Array());
        writeVarUint8Array(encoder3, this.leftClockEncoder.toUint8Array());
        writeVarUint8Array(encoder3, this.rightClockEncoder.toUint8Array());
        writeVarUint8Array(encoder3, toUint8Array(this.infoEncoder));
        writeVarUint8Array(encoder3, this.stringEncoder.toUint8Array());
        writeVarUint8Array(encoder3, toUint8Array(this.parentInfoEncoder));
        writeVarUint8Array(encoder3, this.typeRefEncoder.toUint8Array());
        writeVarUint8Array(encoder3, this.lenEncoder.toUint8Array());
        writeUint8Array(encoder3, toUint8Array(this.restEncoder));
        return toUint8Array(encoder3);
      }
      /**
       * @param {ID} id
       */
      writeLeftID(id2) {
        this.clientEncoder.write(id2.client);
        this.leftClockEncoder.write(id2.clock);
      }
      /**
       * @param {ID} id
       */
      writeRightID(id2) {
        this.clientEncoder.write(id2.client);
        this.rightClockEncoder.write(id2.clock);
      }
      /**
       * @param {number} client
       */
      writeClient(client) {
        this.clientEncoder.write(client);
      }
      /**
       * @param {number} info An unsigned 8-bit integer
       */
      writeInfo(info) {
        this.infoEncoder.write(info);
      }
      /**
       * @param {string} s
       */
      writeString(s) {
        this.stringEncoder.write(s);
      }
      /**
       * @param {boolean} isYKey
       */
      writeParentInfo(isYKey) {
        this.parentInfoEncoder.write(isYKey ? 1 : 0);
      }
      /**
       * @param {number} info An unsigned 8-bit integer
       */
      writeTypeRef(info) {
        this.typeRefEncoder.write(info);
      }
      /**
       * Write len of a struct - well suited for Opt RLE encoder.
       *
       * @param {number} len
       */
      writeLen(len) {
        this.lenEncoder.write(len);
      }
      /**
       * @param {any} any
       */
      writeAny(any2) {
        writeAny(this.restEncoder, any2);
      }
      /**
       * @param {Uint8Array} buf
       */
      writeBuf(buf) {
        writeVarUint8Array(this.restEncoder, buf);
      }
      /**
       * This is mainly here for legacy purposes.
       *
       * Initial we incoded objects using JSON. Now we use the much faster lib0/any-encoder. This method mainly exists for legacy purposes for the v1 encoder.
       *
       * @param {any} embed
       */
      writeJSON(embed) {
        writeAny(this.restEncoder, embed);
      }
      /**
       * Property keys are often reused. For example, in y-prosemirror the key `bold` might
       * occur very often. For a 3d application, the key `position` might occur very often.
       *
       * We cache these keys in a Map and refer to them via a unique number.
       *
       * @param {string} key
       */
      writeKey(key) {
        const clock = this.keyMap.get(key);
        if (clock === void 0) {
          this.keyClockEncoder.write(this.keyClock++);
          this.stringEncoder.write(key);
        } else {
          this.keyClockEncoder.write(clock);
        }
      }
    };
    writeStructs = (encoder3, structs, client, clock) => {
      clock = max(clock, structs[0].id.clock);
      const startNewStructs = findIndexSS(structs, clock);
      writeVarUint(encoder3.restEncoder, structs.length - startNewStructs);
      encoder3.writeClient(client);
      writeVarUint(encoder3.restEncoder, clock);
      const firstStruct = structs[startNewStructs];
      firstStruct.write(encoder3, clock - firstStruct.id.clock);
      for (let i = startNewStructs + 1; i < structs.length; i++) {
        structs[i].write(encoder3, 0);
      }
    };
    writeClientsStructs = (encoder3, store, _sm) => {
      const sm = /* @__PURE__ */ new Map();
      _sm.forEach((clock, client) => {
        if (getState(store, client) > clock) {
          sm.set(client, clock);
        }
      });
      getStateVector(store).forEach((_clock, client) => {
        if (!_sm.has(client)) {
          sm.set(client, 0);
        }
      });
      writeVarUint(encoder3.restEncoder, sm.size);
      from(sm.entries()).sort((a, b) => b[0] - a[0]).forEach(([client, clock]) => {
        writeStructs(
          encoder3,
          /** @type {Array<GC|Item>} */
          store.clients.get(client),
          client,
          clock
        );
      });
    };
    readClientsStructRefs = (decoder, doc) => {
      const clientRefs = create();
      const numOfStateUpdates = readVarUint(decoder.restDecoder);
      for (let i = 0; i < numOfStateUpdates; i++) {
        const numberOfStructs = readVarUint(decoder.restDecoder);
        const refs = new Array(numberOfStructs);
        const client = decoder.readClient();
        let clock = readVarUint(decoder.restDecoder);
        clientRefs.set(client, { i: 0, refs });
        for (let i2 = 0; i2 < numberOfStructs; i2++) {
          const info = decoder.readInfo();
          switch (BITS5 & info) {
            case 0: {
              const len = decoder.readLen();
              refs[i2] = new GC(createID(client, clock), len);
              clock += len;
              break;
            }
            case 10: {
              const len = readVarUint(decoder.restDecoder);
              refs[i2] = new Skip(createID(client, clock), len);
              clock += len;
              break;
            }
            default: {
              const cantCopyParentInfo = (info & (BIT7 | BIT8)) === 0;
              const struct = new Item(
                createID(client, clock),
                null,
                // left
                (info & BIT8) === BIT8 ? decoder.readLeftID() : null,
                // origin
                null,
                // right
                (info & BIT7) === BIT7 ? decoder.readRightID() : null,
                // right origin
                cantCopyParentInfo ? decoder.readParentInfo() ? doc.get(decoder.readString()) : decoder.readLeftID() : null,
                // parent
                cantCopyParentInfo && (info & BIT6) === BIT6 ? decoder.readString() : null,
                // parentSub
                readItemContent(decoder, info)
                // item content
              );
              refs[i2] = struct;
              clock += struct.length;
            }
          }
        }
      }
      return clientRefs;
    };
    integrateStructs = (transaction, store, clientsStructRefs) => {
      const stack = [];
      let clientsStructRefsIds = from(clientsStructRefs.keys()).sort((a, b) => a - b);
      if (clientsStructRefsIds.length === 0) {
        return null;
      }
      const getNextStructTarget = () => {
        if (clientsStructRefsIds.length === 0) {
          return null;
        }
        let nextStructsTarget = (
          /** @type {{i:number,refs:Array<GC|Item>}} */
          clientsStructRefs.get(clientsStructRefsIds[clientsStructRefsIds.length - 1])
        );
        while (nextStructsTarget.refs.length === nextStructsTarget.i) {
          clientsStructRefsIds.pop();
          if (clientsStructRefsIds.length > 0) {
            nextStructsTarget = /** @type {{i:number,refs:Array<GC|Item>}} */
            clientsStructRefs.get(clientsStructRefsIds[clientsStructRefsIds.length - 1]);
          } else {
            return null;
          }
        }
        return nextStructsTarget;
      };
      let curStructsTarget = getNextStructTarget();
      if (curStructsTarget === null) {
        return null;
      }
      const restStructs = new StructStore();
      const missingSV = /* @__PURE__ */ new Map();
      const updateMissingSv = (client, clock) => {
        const mclock = missingSV.get(client);
        if (mclock == null || mclock > clock) {
          missingSV.set(client, clock);
        }
      };
      let stackHead = (
        /** @type {any} */
        curStructsTarget.refs[
          /** @type {any} */
          curStructsTarget.i++
        ]
      );
      const state = /* @__PURE__ */ new Map();
      const addStackToRestSS = () => {
        for (const item of stack) {
          const client = item.id.client;
          const inapplicableItems = clientsStructRefs.get(client);
          if (inapplicableItems) {
            inapplicableItems.i--;
            restStructs.clients.set(client, inapplicableItems.refs.slice(inapplicableItems.i));
            clientsStructRefs.delete(client);
            inapplicableItems.i = 0;
            inapplicableItems.refs = [];
          } else {
            restStructs.clients.set(client, [item]);
          }
          clientsStructRefsIds = clientsStructRefsIds.filter((c) => c !== client);
        }
        stack.length = 0;
      };
      while (true) {
        if (stackHead.constructor !== Skip) {
          const localClock = setIfUndefined(state, stackHead.id.client, () => getState(store, stackHead.id.client));
          const offset = localClock - stackHead.id.clock;
          if (offset < 0) {
            stack.push(stackHead);
            updateMissingSv(stackHead.id.client, stackHead.id.clock - 1);
            addStackToRestSS();
          } else {
            const missing = stackHead.getMissing(transaction, store);
            if (missing !== null) {
              stack.push(stackHead);
              const structRefs = clientsStructRefs.get(
                /** @type {number} */
                missing
              ) || { refs: [], i: 0 };
              if (structRefs.refs.length === structRefs.i) {
                updateMissingSv(
                  /** @type {number} */
                  missing,
                  getState(store, missing)
                );
                addStackToRestSS();
              } else {
                stackHead = structRefs.refs[structRefs.i++];
                continue;
              }
            } else if (offset === 0 || offset < stackHead.length) {
              stackHead.integrate(transaction, offset);
              state.set(stackHead.id.client, stackHead.id.clock + stackHead.length);
            }
          }
        }
        if (stack.length > 0) {
          stackHead = /** @type {GC|Item} */
          stack.pop();
        } else if (curStructsTarget !== null && curStructsTarget.i < curStructsTarget.refs.length) {
          stackHead = /** @type {GC|Item} */
          curStructsTarget.refs[curStructsTarget.i++];
        } else {
          curStructsTarget = getNextStructTarget();
          if (curStructsTarget === null) {
            break;
          } else {
            stackHead = /** @type {GC|Item} */
            curStructsTarget.refs[curStructsTarget.i++];
          }
        }
      }
      if (restStructs.clients.size > 0) {
        const encoder3 = new UpdateEncoderV2();
        writeClientsStructs(encoder3, restStructs, /* @__PURE__ */ new Map());
        writeVarUint(encoder3.restEncoder, 0);
        return { missing: missingSV, update: encoder3.toUint8Array() };
      }
      return null;
    };
    writeStructsFromTransaction = (encoder3, transaction) => writeClientsStructs(encoder3, transaction.doc.store, transaction.beforeState);
    readUpdateV2 = (decoder, ydoc, transactionOrigin, structDecoder = new UpdateDecoderV2(decoder)) => transact(ydoc, (transaction) => {
      transaction.local = false;
      let retry = false;
      const doc = transaction.doc;
      const store = doc.store;
      const ss = readClientsStructRefs(structDecoder, doc);
      const restStructs = integrateStructs(transaction, store, ss);
      const pending2 = store.pendingStructs;
      if (pending2) {
        for (const [client, clock] of pending2.missing) {
          if (clock < getState(store, client)) {
            retry = true;
            break;
          }
        }
        if (restStructs) {
          for (const [client, clock] of restStructs.missing) {
            const mclock = pending2.missing.get(client);
            if (mclock == null || mclock > clock) {
              pending2.missing.set(client, clock);
            }
          }
          pending2.update = mergeUpdatesV2([pending2.update, restStructs.update]);
        }
      } else {
        store.pendingStructs = restStructs;
      }
      const dsRest = readAndApplyDeleteSet(structDecoder, transaction, store);
      if (store.pendingDs) {
        const pendingDSUpdate = new UpdateDecoderV2(createDecoder(store.pendingDs));
        readVarUint(pendingDSUpdate.restDecoder);
        const dsRest2 = readAndApplyDeleteSet(pendingDSUpdate, transaction, store);
        if (dsRest && dsRest2) {
          store.pendingDs = mergeUpdatesV2([dsRest, dsRest2]);
        } else {
          store.pendingDs = dsRest || dsRest2;
        }
      } else {
        store.pendingDs = dsRest;
      }
      if (retry) {
        const update = (
          /** @type {{update: Uint8Array}} */
          store.pendingStructs.update
        );
        store.pendingStructs = null;
        applyUpdateV2(transaction.doc, update);
      }
    }, transactionOrigin, false);
    applyUpdateV2 = (ydoc, update, transactionOrigin, YDecoder = UpdateDecoderV2) => {
      const decoder = createDecoder(update);
      readUpdateV2(decoder, ydoc, transactionOrigin, new YDecoder(decoder));
    };
    applyUpdate = (ydoc, update, transactionOrigin) => applyUpdateV2(ydoc, update, transactionOrigin, UpdateDecoderV1);
    EventHandler = class {
      constructor() {
        this.l = [];
      }
    };
    createEventHandler = () => new EventHandler();
    addEventHandlerListener = (eventHandler, f) => eventHandler.l.push(f);
    removeEventHandlerListener = (eventHandler, f) => {
      const l = eventHandler.l;
      const len = l.length;
      eventHandler.l = l.filter((g) => f !== g);
      if (len === eventHandler.l.length) {
        console.error("[yjs] Tried to remove event handler that doesn't exist.");
      }
    };
    callEventHandlerListeners = (eventHandler, arg0, arg1) => callAll(eventHandler.l, [arg0, arg1]);
    ID = class {
      /**
       * @param {number} client client id
       * @param {number} clock unique per client id, continuous number
       */
      constructor(client, clock) {
        this.client = client;
        this.clock = clock;
      }
    };
    compareIDs = (a, b) => a === b || a !== null && b !== null && a.client === b.client && a.clock === b.clock;
    createID = (client, clock) => new ID(client, clock);
    findRootTypeKey = (type) => {
      for (const [key, value] of type.doc.share.entries()) {
        if (value === type) {
          return key;
        }
      }
      throw unexpectedCase();
    };
    RelativePosition = class {
      /**
       * @param {ID|null} type
       * @param {string|null} tname
       * @param {ID|null} item
       * @param {number} assoc
       */
      constructor(type, tname, item, assoc = 0) {
        this.type = type;
        this.tname = tname;
        this.item = item;
        this.assoc = assoc;
      }
    };
    relativePositionToJSON = (rpos) => {
      const json = {};
      if (rpos.type) {
        json.type = rpos.type;
      }
      if (rpos.tname) {
        json.tname = rpos.tname;
      }
      if (rpos.item) {
        json.item = rpos.item;
      }
      if (rpos.assoc != null) {
        json.assoc = rpos.assoc;
      }
      return json;
    };
    createRelativePositionFromJSON = (json) => new RelativePosition(json.type == null ? null : createID(json.type.client, json.type.clock), json.tname ?? null, json.item == null ? null : createID(json.item.client, json.item.clock), json.assoc == null ? 0 : json.assoc);
    AbsolutePosition = class {
      /**
       * @param {AbstractType<any>} type
       * @param {number} index
       * @param {number} [assoc]
       */
      constructor(type, index, assoc = 0) {
        this.type = type;
        this.index = index;
        this.assoc = assoc;
      }
    };
    createAbsolutePosition = (type, index, assoc = 0) => new AbsolutePosition(type, index, assoc);
    createRelativePosition = (type, item, assoc) => {
      let typeid = null;
      let tname = null;
      if (type._item === null) {
        tname = findRootTypeKey(type);
      } else {
        typeid = createID(type._item.id.client, type._item.id.clock);
      }
      return new RelativePosition(typeid, tname, item, assoc);
    };
    createRelativePositionFromTypeIndex = (type, index, assoc = 0) => {
      let t = type._start;
      if (assoc < 0) {
        if (index === 0) {
          return createRelativePosition(type, null, assoc);
        }
        index--;
      }
      while (t !== null) {
        if (!t.deleted && t.countable) {
          if (t.length > index) {
            return createRelativePosition(type, createID(t.id.client, t.id.clock + index), assoc);
          }
          index -= t.length;
        }
        if (t.right === null && assoc < 0) {
          return createRelativePosition(type, t.lastId, assoc);
        }
        t = t.right;
      }
      return createRelativePosition(type, null, assoc);
    };
    getItemWithOffset = (store, id2) => {
      const item = getItem(store, id2);
      const diff = id2.clock - item.id.clock;
      return {
        item,
        diff
      };
    };
    createAbsolutePositionFromRelativePosition = (rpos, doc, followUndoneDeletions = true) => {
      const store = doc.store;
      const rightID = rpos.item;
      const typeID = rpos.type;
      const tname = rpos.tname;
      const assoc = rpos.assoc;
      let type = null;
      let index = 0;
      if (rightID !== null) {
        if (getState(store, rightID.client) <= rightID.clock) {
          return null;
        }
        const res = followUndoneDeletions ? followRedone(store, rightID) : getItemWithOffset(store, rightID);
        const right = res.item;
        if (!(right instanceof Item)) {
          return null;
        }
        type = /** @type {AbstractType<any>} */
        right.parent;
        if (type._item === null || !type._item.deleted) {
          index = right.deleted || !right.countable ? 0 : res.diff + (assoc >= 0 ? 0 : 1);
          let n = right.left;
          while (n !== null) {
            if (!n.deleted && n.countable) {
              index += n.length;
            }
            n = n.left;
          }
        }
      } else {
        if (tname !== null) {
          type = doc.get(tname);
        } else if (typeID !== null) {
          if (getState(store, typeID.client) <= typeID.clock) {
            return null;
          }
          const { item } = followUndoneDeletions ? followRedone(store, typeID) : { item: getItem(store, typeID) };
          if (item instanceof Item && item.content instanceof ContentType) {
            type = item.content.type;
          } else {
            return null;
          }
        } else {
          throw unexpectedCase();
        }
        if (assoc >= 0) {
          index = type._length;
        } else {
          index = 0;
        }
      }
      return createAbsolutePosition(type, index, rpos.assoc);
    };
    Snapshot = class {
      /**
       * @param {DeleteSet} ds
       * @param {Map<number,number>} sv state map
       */
      constructor(ds, sv) {
        this.ds = ds;
        this.sv = sv;
      }
    };
    createSnapshot = (ds, sm) => new Snapshot(ds, sm);
    emptySnapshot = createSnapshot(createDeleteSet(), /* @__PURE__ */ new Map());
    isVisible = (item, snapshot) => snapshot === void 0 ? !item.deleted : snapshot.sv.has(item.id.client) && (snapshot.sv.get(item.id.client) || 0) > item.id.clock && !isDeleted(snapshot.ds, item.id);
    splitSnapshotAffectedStructs = (transaction, snapshot) => {
      const meta = setIfUndefined(transaction.meta, splitSnapshotAffectedStructs, create2);
      const store = transaction.doc.store;
      if (!meta.has(snapshot)) {
        snapshot.sv.forEach((clock, client) => {
          if (clock < getState(store, client)) {
            getItemCleanStart(transaction, createID(client, clock));
          }
        });
        iterateDeletedStructs(transaction, snapshot.ds, (_item) => {
        });
        meta.add(snapshot);
      }
    };
    StructStore = class {
      constructor() {
        this.clients = /* @__PURE__ */ new Map();
        this.pendingStructs = null;
        this.pendingDs = null;
      }
    };
    getStateVector = (store) => {
      const sm = /* @__PURE__ */ new Map();
      store.clients.forEach((structs, client) => {
        const struct = structs[structs.length - 1];
        sm.set(client, struct.id.clock + struct.length);
      });
      return sm;
    };
    getState = (store, client) => {
      const structs = store.clients.get(client);
      if (structs === void 0) {
        return 0;
      }
      const lastStruct = structs[structs.length - 1];
      return lastStruct.id.clock + lastStruct.length;
    };
    addStruct = (store, struct) => {
      let structs = store.clients.get(struct.id.client);
      if (structs === void 0) {
        structs = [];
        store.clients.set(struct.id.client, structs);
      } else {
        const lastStruct = structs[structs.length - 1];
        if (lastStruct.id.clock + lastStruct.length !== struct.id.clock) {
          throw unexpectedCase();
        }
      }
      structs.push(struct);
    };
    findIndexSS = (structs, clock) => {
      let left = 0;
      let right = structs.length - 1;
      let mid = structs[right];
      let midclock = mid.id.clock;
      if (midclock === clock) {
        return right;
      }
      let midindex = floor(clock / (midclock + mid.length - 1) * right);
      while (left <= right) {
        mid = structs[midindex];
        midclock = mid.id.clock;
        if (midclock <= clock) {
          if (clock < midclock + mid.length) {
            return midindex;
          }
          left = midindex + 1;
        } else {
          right = midindex - 1;
        }
        midindex = floor((left + right) / 2);
      }
      throw unexpectedCase();
    };
    find = (store, id2) => {
      const structs = store.clients.get(id2.client);
      return structs[findIndexSS(structs, id2.clock)];
    };
    getItem = /** @type {function(StructStore,ID):Item} */
    find;
    findIndexCleanStart = (transaction, structs, clock) => {
      const index = findIndexSS(structs, clock);
      const struct = structs[index];
      if (struct.id.clock < clock && struct instanceof Item) {
        structs.splice(index + 1, 0, splitItem(transaction, struct, clock - struct.id.clock));
        return index + 1;
      }
      return index;
    };
    getItemCleanStart = (transaction, id2) => {
      const structs = (
        /** @type {Array<Item>} */
        transaction.doc.store.clients.get(id2.client)
      );
      return structs[findIndexCleanStart(transaction, structs, id2.clock)];
    };
    getItemCleanEnd = (transaction, store, id2) => {
      const structs = store.clients.get(id2.client);
      const index = findIndexSS(structs, id2.clock);
      const struct = structs[index];
      if (id2.clock !== struct.id.clock + struct.length - 1 && struct.constructor !== GC) {
        structs.splice(index + 1, 0, splitItem(transaction, struct, id2.clock - struct.id.clock + 1));
      }
      return struct;
    };
    replaceStruct = (store, struct, newStruct) => {
      const structs = (
        /** @type {Array<GC|Item>} */
        store.clients.get(struct.id.client)
      );
      structs[findIndexSS(structs, struct.id.clock)] = newStruct;
    };
    iterateStructs = (transaction, structs, clockStart, len, f) => {
      if (len === 0) {
        return;
      }
      const clockEnd = clockStart + len;
      let index = findIndexCleanStart(transaction, structs, clockStart);
      let struct;
      do {
        struct = structs[index++];
        if (clockEnd < struct.id.clock + struct.length) {
          findIndexCleanStart(transaction, structs, clockEnd);
        }
        f(struct);
      } while (index < structs.length && structs[index].id.clock < clockEnd);
    };
    Transaction = class {
      /**
       * @param {Doc} doc
       * @param {any} origin
       * @param {boolean} local
       */
      constructor(doc, origin, local) {
        this.doc = doc;
        this.deleteSet = new DeleteSet();
        this.beforeState = getStateVector(doc.store);
        this.afterState = /* @__PURE__ */ new Map();
        this.changed = /* @__PURE__ */ new Map();
        this.changedParentTypes = /* @__PURE__ */ new Map();
        this._mergeStructs = [];
        this.origin = origin;
        this.meta = /* @__PURE__ */ new Map();
        this.local = local;
        this.subdocsAdded = /* @__PURE__ */ new Set();
        this.subdocsRemoved = /* @__PURE__ */ new Set();
        this.subdocsLoaded = /* @__PURE__ */ new Set();
        this._needFormattingCleanup = false;
      }
    };
    writeUpdateMessageFromTransaction = (encoder3, transaction) => {
      if (transaction.deleteSet.clients.size === 0 && !any(transaction.afterState, (clock, client) => transaction.beforeState.get(client) !== clock)) {
        return false;
      }
      sortAndMergeDeleteSet(transaction.deleteSet);
      writeStructsFromTransaction(encoder3, transaction);
      writeDeleteSet(encoder3, transaction.deleteSet);
      return true;
    };
    addChangedTypeToTransaction = (transaction, type, parentSub) => {
      const item = type._item;
      if (item === null || item.id.clock < (transaction.beforeState.get(item.id.client) || 0) && !item.deleted) {
        setIfUndefined(transaction.changed, type, create2).add(parentSub);
      }
    };
    tryToMergeWithLefts = (structs, pos) => {
      let right = structs[pos];
      let left = structs[pos - 1];
      let i = pos;
      for (; i > 0; right = left, left = structs[--i - 1]) {
        if (left.deleted === right.deleted && left.constructor === right.constructor) {
          if (left.mergeWith(right)) {
            if (right instanceof Item && right.parentSub !== null && /** @type {AbstractType<any>} */
            right.parent._map.get(right.parentSub) === right) {
              right.parent._map.set(
                right.parentSub,
                /** @type {Item} */
                left
              );
            }
            continue;
          }
        }
        break;
      }
      const merged = pos - i;
      if (merged) {
        structs.splice(pos + 1 - merged, merged);
      }
      return merged;
    };
    tryGcDeleteSet = (ds, store, gcFilter) => {
      for (const [client, deleteItems] of ds.clients.entries()) {
        const structs = (
          /** @type {Array<GC|Item>} */
          store.clients.get(client)
        );
        for (let di = deleteItems.length - 1; di >= 0; di--) {
          const deleteItem = deleteItems[di];
          const endDeleteItemClock = deleteItem.clock + deleteItem.len;
          for (let si = findIndexSS(structs, deleteItem.clock), struct = structs[si]; si < structs.length && struct.id.clock < endDeleteItemClock; struct = structs[++si]) {
            const struct2 = structs[si];
            if (deleteItem.clock + deleteItem.len <= struct2.id.clock) {
              break;
            }
            if (struct2 instanceof Item && struct2.deleted && !struct2.keep && gcFilter(struct2)) {
              struct2.gc(store, false);
            }
          }
        }
      }
    };
    tryMergeDeleteSet = (ds, store) => {
      ds.clients.forEach((deleteItems, client) => {
        const structs = (
          /** @type {Array<GC|Item>} */
          store.clients.get(client)
        );
        for (let di = deleteItems.length - 1; di >= 0; di--) {
          const deleteItem = deleteItems[di];
          const mostRightIndexToCheck = min(structs.length - 1, 1 + findIndexSS(structs, deleteItem.clock + deleteItem.len - 1));
          for (let si = mostRightIndexToCheck, struct = structs[si]; si > 0 && struct.id.clock >= deleteItem.clock; struct = structs[si]) {
            si -= 1 + tryToMergeWithLefts(structs, si);
          }
        }
      });
    };
    cleanupTransactions = (transactionCleanups, i) => {
      if (i < transactionCleanups.length) {
        const transaction = transactionCleanups[i];
        const doc = transaction.doc;
        const store = doc.store;
        const ds = transaction.deleteSet;
        const mergeStructs = transaction._mergeStructs;
        try {
          sortAndMergeDeleteSet(ds);
          transaction.afterState = getStateVector(transaction.doc.store);
          doc.emit("beforeObserverCalls", [transaction, doc]);
          const fs9 = [];
          transaction.changed.forEach(
            (subs, itemtype) => fs9.push(() => {
              if (itemtype._item === null || !itemtype._item.deleted) {
                itemtype._callObserver(transaction, subs);
              }
            })
          );
          fs9.push(() => {
            transaction.changedParentTypes.forEach((events, type) => {
              if (type._dEH.l.length > 0 && (type._item === null || !type._item.deleted)) {
                events = events.filter(
                  (event) => event.target._item === null || !event.target._item.deleted
                );
                events.forEach((event) => {
                  event.currentTarget = type;
                  event._path = null;
                });
                events.sort((event1, event2) => event1.path.length - event2.path.length);
                fs9.push(() => {
                  callEventHandlerListeners(type._dEH, events, transaction);
                });
              }
            });
            fs9.push(() => doc.emit("afterTransaction", [transaction, doc]));
            fs9.push(() => {
              if (transaction._needFormattingCleanup) {
                cleanupYTextAfterTransaction(transaction);
              }
            });
          });
          callAll(fs9, []);
        } finally {
          if (doc.gc) {
            tryGcDeleteSet(ds, store, doc.gcFilter);
          }
          tryMergeDeleteSet(ds, store);
          transaction.afterState.forEach((clock, client) => {
            const beforeClock = transaction.beforeState.get(client) || 0;
            if (beforeClock !== clock) {
              const structs = (
                /** @type {Array<GC|Item>} */
                store.clients.get(client)
              );
              const firstChangePos = max(findIndexSS(structs, beforeClock), 1);
              for (let i2 = structs.length - 1; i2 >= firstChangePos; ) {
                i2 -= 1 + tryToMergeWithLefts(structs, i2);
              }
            }
          });
          for (let i2 = mergeStructs.length - 1; i2 >= 0; i2--) {
            const { client, clock } = mergeStructs[i2].id;
            const structs = (
              /** @type {Array<GC|Item>} */
              store.clients.get(client)
            );
            const replacedStructPos = findIndexSS(structs, clock);
            if (replacedStructPos + 1 < structs.length) {
              if (tryToMergeWithLefts(structs, replacedStructPos + 1) > 1) {
                continue;
              }
            }
            if (replacedStructPos > 0) {
              tryToMergeWithLefts(structs, replacedStructPos);
            }
          }
          if (!transaction.local && transaction.afterState.get(doc.clientID) !== transaction.beforeState.get(doc.clientID)) {
            print(ORANGE, BOLD, "[yjs] ", UNBOLD, RED, "Changed the client-id because another client seems to be using it.");
            doc.clientID = generateNewClientId();
          }
          doc.emit("afterTransactionCleanup", [transaction, doc]);
          if (doc._observers.has("update")) {
            const encoder3 = new UpdateEncoderV1();
            const hasContent2 = writeUpdateMessageFromTransaction(encoder3, transaction);
            if (hasContent2) {
              doc.emit("update", [encoder3.toUint8Array(), transaction.origin, doc, transaction]);
            }
          }
          if (doc._observers.has("updateV2")) {
            const encoder3 = new UpdateEncoderV2();
            const hasContent2 = writeUpdateMessageFromTransaction(encoder3, transaction);
            if (hasContent2) {
              doc.emit("updateV2", [encoder3.toUint8Array(), transaction.origin, doc, transaction]);
            }
          }
          const { subdocsAdded, subdocsLoaded, subdocsRemoved } = transaction;
          if (subdocsAdded.size > 0 || subdocsRemoved.size > 0 || subdocsLoaded.size > 0) {
            subdocsAdded.forEach((subdoc) => {
              subdoc.clientID = doc.clientID;
              if (subdoc.collectionid == null) {
                subdoc.collectionid = doc.collectionid;
              }
              doc.subdocs.add(subdoc);
            });
            subdocsRemoved.forEach((subdoc) => doc.subdocs.delete(subdoc));
            doc.emit("subdocs", [{ loaded: subdocsLoaded, added: subdocsAdded, removed: subdocsRemoved }, doc, transaction]);
            subdocsRemoved.forEach((subdoc) => subdoc.destroy());
          }
          if (transactionCleanups.length <= i + 1) {
            doc._transactionCleanups = [];
            doc.emit("afterAllTransactions", [doc, transactionCleanups]);
          } else {
            cleanupTransactions(transactionCleanups, i + 1);
          }
        }
      }
    };
    transact = (doc, f, origin = null, local = true) => {
      const transactionCleanups = doc._transactionCleanups;
      let initialCall = false;
      let result = null;
      if (doc._transaction === null) {
        initialCall = true;
        doc._transaction = new Transaction(doc, origin, local);
        transactionCleanups.push(doc._transaction);
        if (transactionCleanups.length === 1) {
          doc.emit("beforeAllTransactions", [doc]);
        }
        doc.emit("beforeTransaction", [doc._transaction, doc]);
      }
      try {
        result = f(doc._transaction);
      } finally {
        if (initialCall) {
          const finishCleanup = doc._transaction === transactionCleanups[0];
          doc._transaction = null;
          if (finishCleanup) {
            cleanupTransactions(transactionCleanups, 0);
          }
        }
      }
      return result;
    };
    LazyStructReader = class {
      /**
       * @param {UpdateDecoderV1 | UpdateDecoderV2} decoder
       * @param {boolean} filterSkips
       */
      constructor(decoder, filterSkips) {
        this.gen = lazyStructReaderGenerator(decoder);
        this.curr = null;
        this.done = false;
        this.filterSkips = filterSkips;
        this.next();
      }
      /**
       * @return {Item | GC | Skip |null}
       */
      next() {
        do {
          this.curr = this.gen.next().value || null;
        } while (this.filterSkips && this.curr !== null && this.curr.constructor === Skip);
        return this.curr;
      }
    };
    LazyStructWriter = class {
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      constructor(encoder3) {
        this.currClient = 0;
        this.startClock = 0;
        this.written = 0;
        this.encoder = encoder3;
        this.clientStructs = [];
      }
    };
    sliceStruct = (left, diff) => {
      if (left.constructor === GC) {
        const { client, clock } = left.id;
        return new GC(createID(client, clock + diff), left.length - diff);
      } else if (left.constructor === Skip) {
        const { client, clock } = left.id;
        return new Skip(createID(client, clock + diff), left.length - diff);
      } else {
        const leftItem = (
          /** @type {Item} */
          left
        );
        const { client, clock } = leftItem.id;
        return new Item(
          createID(client, clock + diff),
          null,
          createID(client, clock + diff - 1),
          null,
          leftItem.rightOrigin,
          leftItem.parent,
          leftItem.parentSub,
          leftItem.content.splice(diff)
        );
      }
    };
    mergeUpdatesV2 = (updates, YDecoder = UpdateDecoderV2, YEncoder = UpdateEncoderV2) => {
      if (updates.length === 1) {
        return updates[0];
      }
      const updateDecoders = updates.map((update) => new YDecoder(createDecoder(update)));
      let lazyStructDecoders = updateDecoders.map((decoder) => new LazyStructReader(decoder, true));
      let currWrite = null;
      const updateEncoder = new YEncoder();
      const lazyStructEncoder = new LazyStructWriter(updateEncoder);
      while (true) {
        lazyStructDecoders = lazyStructDecoders.filter((dec) => dec.curr !== null);
        lazyStructDecoders.sort(
          /** @type {function(any,any):number} */
          (dec1, dec2) => {
            if (dec1.curr.id.client === dec2.curr.id.client) {
              const clockDiff = dec1.curr.id.clock - dec2.curr.id.clock;
              if (clockDiff === 0) {
                return dec1.curr.constructor === dec2.curr.constructor ? 0 : dec1.curr.constructor === Skip ? 1 : -1;
              } else {
                return clockDiff;
              }
            } else {
              return dec2.curr.id.client - dec1.curr.id.client;
            }
          }
        );
        if (lazyStructDecoders.length === 0) {
          break;
        }
        const currDecoder = lazyStructDecoders[0];
        const firstClient = (
          /** @type {Item | GC} */
          currDecoder.curr.id.client
        );
        if (currWrite !== null) {
          let curr = (
            /** @type {Item | GC | null} */
            currDecoder.curr
          );
          let iterated = false;
          while (curr !== null && curr.id.clock + curr.length <= currWrite.struct.id.clock + currWrite.struct.length && curr.id.client >= currWrite.struct.id.client) {
            curr = currDecoder.next();
            iterated = true;
          }
          if (curr === null || // current decoder is empty
          curr.id.client !== firstClient || // check whether there is another decoder that has has updates from `firstClient`
          iterated && curr.id.clock > currWrite.struct.id.clock + currWrite.struct.length) {
            continue;
          }
          if (firstClient !== currWrite.struct.id.client) {
            writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
            currWrite = { struct: curr, offset: 0 };
            currDecoder.next();
          } else {
            if (currWrite.struct.id.clock + currWrite.struct.length < curr.id.clock) {
              if (currWrite.struct.constructor === Skip) {
                currWrite.struct.length = curr.id.clock + curr.length - currWrite.struct.id.clock;
              } else {
                writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
                const diff = curr.id.clock - currWrite.struct.id.clock - currWrite.struct.length;
                const struct = new Skip(createID(firstClient, currWrite.struct.id.clock + currWrite.struct.length), diff);
                currWrite = { struct, offset: 0 };
              }
            } else {
              const diff = currWrite.struct.id.clock + currWrite.struct.length - curr.id.clock;
              if (diff > 0) {
                if (currWrite.struct.constructor === Skip) {
                  currWrite.struct.length -= diff;
                } else {
                  curr = sliceStruct(curr, diff);
                }
              }
              if (!currWrite.struct.mergeWith(
                /** @type {any} */
                curr
              )) {
                writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
                currWrite = { struct: curr, offset: 0 };
                currDecoder.next();
              }
            }
          }
        } else {
          currWrite = { struct: (
            /** @type {Item | GC} */
            currDecoder.curr
          ), offset: 0 };
          currDecoder.next();
        }
        for (let next = currDecoder.curr; next !== null && next.id.client === firstClient && next.id.clock === currWrite.struct.id.clock + currWrite.struct.length && next.constructor !== Skip; next = currDecoder.next()) {
          writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
          currWrite = { struct: next, offset: 0 };
        }
      }
      if (currWrite !== null) {
        writeStructToLazyStructWriter(lazyStructEncoder, currWrite.struct, currWrite.offset);
        currWrite = null;
      }
      finishLazyStructWriting(lazyStructEncoder);
      const dss = updateDecoders.map((decoder) => readDeleteSet(decoder));
      const ds = mergeDeleteSets(dss);
      writeDeleteSet(updateEncoder, ds);
      return updateEncoder.toUint8Array();
    };
    flushLazyStructWriter = (lazyWriter) => {
      if (lazyWriter.written > 0) {
        lazyWriter.clientStructs.push({ written: lazyWriter.written, restEncoder: toUint8Array(lazyWriter.encoder.restEncoder) });
        lazyWriter.encoder.restEncoder = createEncoder();
        lazyWriter.written = 0;
      }
    };
    writeStructToLazyStructWriter = (lazyWriter, struct, offset) => {
      if (lazyWriter.written > 0 && lazyWriter.currClient !== struct.id.client) {
        flushLazyStructWriter(lazyWriter);
      }
      if (lazyWriter.written === 0) {
        lazyWriter.currClient = struct.id.client;
        lazyWriter.encoder.writeClient(struct.id.client);
        writeVarUint(lazyWriter.encoder.restEncoder, struct.id.clock + offset);
      }
      struct.write(lazyWriter.encoder, offset);
      lazyWriter.written++;
    };
    finishLazyStructWriting = (lazyWriter) => {
      flushLazyStructWriter(lazyWriter);
      const restEncoder = lazyWriter.encoder.restEncoder;
      writeVarUint(restEncoder, lazyWriter.clientStructs.length);
      for (let i = 0; i < lazyWriter.clientStructs.length; i++) {
        const partStructs = lazyWriter.clientStructs[i];
        writeVarUint(restEncoder, partStructs.written);
        writeUint8Array(restEncoder, partStructs.restEncoder);
      }
    };
    errorComputeChanges = "You must not compute changes after the event-handler fired.";
    YEvent = class {
      /**
       * @param {T} target The changed type.
       * @param {Transaction} transaction
       */
      constructor(target, transaction) {
        this.target = target;
        this.currentTarget = target;
        this.transaction = transaction;
        this._changes = null;
        this._keys = null;
        this._delta = null;
        this._path = null;
      }
      /**
       * Computes the path from `y` to the changed type.
       *
       * @todo v14 should standardize on path: Array<{parent, index}> because that is easier to work with.
       *
       * The following property holds:
       * @example
       *   let type = y
       *   event.path.forEach(dir => {
       *     type = type.get(dir)
       *   })
       *   type === event.target // => true
       */
      get path() {
        return this._path || (this._path = getPathTo(this.currentTarget, this.target));
      }
      /**
       * Check if a struct is deleted by this event.
       *
       * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
       *
       * @param {AbstractStruct} struct
       * @return {boolean}
       */
      deletes(struct) {
        return isDeleted(this.transaction.deleteSet, struct.id);
      }
      /**
       * @type {Map<string, { action: 'add' | 'update' | 'delete', oldValue: any }>}
       */
      get keys() {
        if (this._keys === null) {
          if (this.transaction.doc._transactionCleanups.length === 0) {
            throw create3(errorComputeChanges);
          }
          const keys2 = /* @__PURE__ */ new Map();
          const target = this.target;
          const changed = (
            /** @type Set<string|null> */
            this.transaction.changed.get(target)
          );
          changed.forEach((key) => {
            if (key !== null) {
              const item = (
                /** @type {Item} */
                target._map.get(key)
              );
              let action;
              let oldValue;
              if (this.adds(item)) {
                let prev = item.left;
                while (prev !== null && this.adds(prev)) {
                  prev = prev.left;
                }
                if (this.deletes(item)) {
                  if (prev !== null && this.deletes(prev)) {
                    action = "delete";
                    oldValue = last(prev.content.getContent());
                  } else {
                    return;
                  }
                } else {
                  if (prev !== null && this.deletes(prev)) {
                    action = "update";
                    oldValue = last(prev.content.getContent());
                  } else {
                    action = "add";
                    oldValue = void 0;
                  }
                }
              } else {
                if (this.deletes(item)) {
                  action = "delete";
                  oldValue = last(
                    /** @type {Item} */
                    item.content.getContent()
                  );
                } else {
                  return;
                }
              }
              keys2.set(key, { action, oldValue });
            }
          });
          this._keys = keys2;
        }
        return this._keys;
      }
      /**
       * This is a computed property. Note that this can only be safely computed during the
       * event call. Computing this property after other changes happened might result in
       * unexpected behavior (incorrect computation of deltas). A safe way to collect changes
       * is to store the `changes` or the `delta` object. Avoid storing the `transaction` object.
       *
       * @type {Array<{insert?: string | Array<any> | object | AbstractType<any>, retain?: number, delete?: number, attributes?: Object<string, any>}>}
       */
      get delta() {
        return this.changes.delta;
      }
      /**
       * Check if a struct is added by this event.
       *
       * In contrast to change.deleted, this method also returns true if the struct was added and then deleted.
       *
       * @param {AbstractStruct} struct
       * @return {boolean}
       */
      adds(struct) {
        return struct.id.clock >= (this.transaction.beforeState.get(struct.id.client) || 0);
      }
      /**
       * This is a computed property. Note that this can only be safely computed during the
       * event call. Computing this property after other changes happened might result in
       * unexpected behavior (incorrect computation of deltas). A safe way to collect changes
       * is to store the `changes` or the `delta` object. Avoid storing the `transaction` object.
       *
       * @type {{added:Set<Item>,deleted:Set<Item>,keys:Map<string,{action:'add'|'update'|'delete',oldValue:any}>,delta:Array<{insert?:Array<any>|string, delete?:number, retain?:number}>}}
       */
      get changes() {
        let changes = this._changes;
        if (changes === null) {
          if (this.transaction.doc._transactionCleanups.length === 0) {
            throw create3(errorComputeChanges);
          }
          const target = this.target;
          const added = create2();
          const deleted = create2();
          const delta = [];
          changes = {
            added,
            deleted,
            delta,
            keys: this.keys
          };
          const changed = (
            /** @type Set<string|null> */
            this.transaction.changed.get(target)
          );
          if (changed.has(null)) {
            let lastOp = null;
            const packOp = () => {
              if (lastOp) {
                delta.push(lastOp);
              }
            };
            for (let item = target._start; item !== null; item = item.right) {
              if (item.deleted) {
                if (this.deletes(item) && !this.adds(item)) {
                  if (lastOp === null || lastOp.delete === void 0) {
                    packOp();
                    lastOp = { delete: 0 };
                  }
                  lastOp.delete += item.length;
                  deleted.add(item);
                }
              } else {
                if (this.adds(item)) {
                  if (lastOp === null || lastOp.insert === void 0) {
                    packOp();
                    lastOp = { insert: [] };
                  }
                  lastOp.insert = lastOp.insert.concat(item.content.getContent());
                  added.add(item);
                } else {
                  if (lastOp === null || lastOp.retain === void 0) {
                    packOp();
                    lastOp = { retain: 0 };
                  }
                  lastOp.retain += item.length;
                }
              }
            }
            if (lastOp !== null && lastOp.retain === void 0) {
              packOp();
            }
          }
          this._changes = changes;
        }
        return (
          /** @type {any} */
          changes
        );
      }
    };
    getPathTo = (parent, child) => {
      const path12 = [];
      while (child._item !== null && child !== parent) {
        if (child._item.parentSub !== null) {
          path12.unshift(child._item.parentSub);
        } else {
          let i = 0;
          let c = (
            /** @type {AbstractType<any>} */
            child._item.parent._start
          );
          while (c !== child._item && c !== null) {
            if (!c.deleted && c.countable) {
              i += c.length;
            }
            c = c.right;
          }
          path12.unshift(i);
        }
        child = /** @type {AbstractType<any>} */
        child._item.parent;
      }
      return path12;
    };
    warnPrematureAccess = () => {
      warn("Invalid access: Add Yjs type to a document before reading data.");
    };
    maxSearchMarker = 80;
    globalSearchMarkerTimestamp = 0;
    ArraySearchMarker = class {
      /**
       * @param {Item} p
       * @param {number} index
       */
      constructor(p, index) {
        p.marker = true;
        this.p = p;
        this.index = index;
        this.timestamp = globalSearchMarkerTimestamp++;
      }
    };
    refreshMarkerTimestamp = (marker) => {
      marker.timestamp = globalSearchMarkerTimestamp++;
    };
    overwriteMarker = (marker, p, index) => {
      marker.p.marker = false;
      marker.p = p;
      p.marker = true;
      marker.index = index;
      marker.timestamp = globalSearchMarkerTimestamp++;
    };
    markPosition = (searchMarker, p, index) => {
      if (searchMarker.length >= maxSearchMarker) {
        const marker = searchMarker.reduce((a, b) => a.timestamp < b.timestamp ? a : b);
        overwriteMarker(marker, p, index);
        return marker;
      } else {
        const pm = new ArraySearchMarker(p, index);
        searchMarker.push(pm);
        return pm;
      }
    };
    findMarker = (yarray, index) => {
      if (yarray._start === null || index === 0 || yarray._searchMarker === null) {
        return null;
      }
      const marker = yarray._searchMarker.length === 0 ? null : yarray._searchMarker.reduce((a, b) => abs(index - a.index) < abs(index - b.index) ? a : b);
      let p = yarray._start;
      let pindex = 0;
      if (marker !== null) {
        p = marker.p;
        pindex = marker.index;
        refreshMarkerTimestamp(marker);
      }
      while (p.right !== null && pindex < index) {
        if (!p.deleted && p.countable) {
          if (index < pindex + p.length) {
            break;
          }
          pindex += p.length;
        }
        p = p.right;
      }
      while (p.left !== null && pindex > index) {
        p = p.left;
        if (!p.deleted && p.countable) {
          pindex -= p.length;
        }
      }
      while (p.left !== null && p.left.id.client === p.id.client && p.left.id.clock + p.left.length === p.id.clock) {
        p = p.left;
        if (!p.deleted && p.countable) {
          pindex -= p.length;
        }
      }
      if (marker !== null && abs(marker.index - pindex) < /** @type {YText|YArray<any>} */
      p.parent.length / maxSearchMarker) {
        overwriteMarker(marker, p, pindex);
        return marker;
      } else {
        return markPosition(yarray._searchMarker, p, pindex);
      }
    };
    updateMarkerChanges = (searchMarker, index, len) => {
      for (let i = searchMarker.length - 1; i >= 0; i--) {
        const m = searchMarker[i];
        if (len > 0) {
          let p = m.p;
          p.marker = false;
          while (p && (p.deleted || !p.countable)) {
            p = p.left;
            if (p && !p.deleted && p.countable) {
              m.index -= p.length;
            }
          }
          if (p === null || p.marker === true) {
            searchMarker.splice(i, 1);
            continue;
          }
          m.p = p;
          p.marker = true;
        }
        if (index < m.index || len > 0 && index === m.index) {
          m.index = max(index, m.index + len);
        }
      }
    };
    callTypeObservers = (type, transaction, event) => {
      const changedType = type;
      const changedParentTypes = transaction.changedParentTypes;
      while (true) {
        setIfUndefined(changedParentTypes, type, () => []).push(event);
        if (type._item === null) {
          break;
        }
        type = /** @type {AbstractType<any>} */
        type._item.parent;
      }
      callEventHandlerListeners(changedType._eH, event, transaction);
    };
    AbstractType = class {
      constructor() {
        this._item = null;
        this._map = /* @__PURE__ */ new Map();
        this._start = null;
        this.doc = null;
        this._length = 0;
        this._eH = createEventHandler();
        this._dEH = createEventHandler();
        this._searchMarker = null;
      }
      /**
       * @return {AbstractType<any>|null}
       */
      get parent() {
        return this._item ? (
          /** @type {AbstractType<any>} */
          this._item.parent
        ) : null;
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item|null} item
       */
      _integrate(y, item) {
        this.doc = y;
        this._item = item;
      }
      /**
       * @return {AbstractType<EventType>}
       */
      _copy() {
        throw methodUnimplemented();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {AbstractType<EventType>}
       */
      clone() {
        throw methodUnimplemented();
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} _encoder
       */
      _write(_encoder) {
      }
      /**
       * The first non-deleted item
       */
      get _first() {
        let n = this._start;
        while (n !== null && n.deleted) {
          n = n.right;
        }
        return n;
      }
      /**
       * Creates YEvent and calls all type observers.
       * Must be implemented by each type.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} _parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, _parentSubs) {
        if (!transaction.local && this._searchMarker) {
          this._searchMarker.length = 0;
        }
      }
      /**
       * Observe all events that are created on this type.
       *
       * @param {function(EventType, Transaction):void} f Observer function
       */
      observe(f) {
        addEventHandlerListener(this._eH, f);
      }
      /**
       * Observe all events that are created by this type and its children.
       *
       * @param {function(Array<YEvent<any>>,Transaction):void} f Observer function
       */
      observeDeep(f) {
        addEventHandlerListener(this._dEH, f);
      }
      /**
       * Unregister an observer function.
       *
       * @param {function(EventType,Transaction):void} f Observer function
       */
      unobserve(f) {
        removeEventHandlerListener(this._eH, f);
      }
      /**
       * Unregister an observer function.
       *
       * @param {function(Array<YEvent<any>>,Transaction):void} f Observer function
       */
      unobserveDeep(f) {
        removeEventHandlerListener(this._dEH, f);
      }
      /**
       * @abstract
       * @return {any}
       */
      toJSON() {
      }
    };
    typeListSlice = (type, start, end) => {
      type.doc ?? warnPrematureAccess();
      if (start < 0) {
        start = type._length + start;
      }
      if (end < 0) {
        end = type._length + end;
      }
      let len = end - start;
      const cs = [];
      let n = type._start;
      while (n !== null && len > 0) {
        if (n.countable && !n.deleted) {
          const c = n.content.getContent();
          if (c.length <= start) {
            start -= c.length;
          } else {
            for (let i = start; i < c.length && len > 0; i++) {
              cs.push(c[i]);
              len--;
            }
            start = 0;
          }
        }
        n = n.right;
      }
      return cs;
    };
    typeListToArray = (type) => {
      type.doc ?? warnPrematureAccess();
      const cs = [];
      let n = type._start;
      while (n !== null) {
        if (n.countable && !n.deleted) {
          const c = n.content.getContent();
          for (let i = 0; i < c.length; i++) {
            cs.push(c[i]);
          }
        }
        n = n.right;
      }
      return cs;
    };
    typeListForEach = (type, f) => {
      let index = 0;
      let n = type._start;
      type.doc ?? warnPrematureAccess();
      while (n !== null) {
        if (n.countable && !n.deleted) {
          const c = n.content.getContent();
          for (let i = 0; i < c.length; i++) {
            f(c[i], index++, type);
          }
        }
        n = n.right;
      }
    };
    typeListMap = (type, f) => {
      const result = [];
      typeListForEach(type, (c, i) => {
        result.push(f(c, i, type));
      });
      return result;
    };
    typeListCreateIterator = (type) => {
      let n = type._start;
      let currentContent = null;
      let currentContentIndex = 0;
      return {
        [Symbol.iterator]() {
          return this;
        },
        next: () => {
          if (currentContent === null) {
            while (n !== null && n.deleted) {
              n = n.right;
            }
            if (n === null) {
              return {
                done: true,
                value: void 0
              };
            }
            currentContent = n.content.getContent();
            currentContentIndex = 0;
            n = n.right;
          }
          const value = currentContent[currentContentIndex++];
          if (currentContent.length <= currentContentIndex) {
            currentContent = null;
          }
          return {
            done: false,
            value
          };
        }
      };
    };
    typeListGet = (type, index) => {
      type.doc ?? warnPrematureAccess();
      const marker = findMarker(type, index);
      let n = type._start;
      if (marker !== null) {
        n = marker.p;
        index -= marker.index;
      }
      for (; n !== null; n = n.right) {
        if (!n.deleted && n.countable) {
          if (index < n.length) {
            return n.content.getContent()[index];
          }
          index -= n.length;
        }
      }
    };
    typeListInsertGenericsAfter = (transaction, parent, referenceItem, content) => {
      let left = referenceItem;
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      const store = doc.store;
      const right = referenceItem === null ? parent._start : referenceItem.right;
      let jsonContent = [];
      const packJsonContent = () => {
        if (jsonContent.length > 0) {
          left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentAny(jsonContent));
          left.integrate(transaction, 0);
          jsonContent = [];
        }
      };
      content.forEach((c) => {
        if (c === null) {
          jsonContent.push(c);
        } else {
          switch (c.constructor) {
            case Number:
            case Object:
            case Boolean:
            case Array:
            case String:
              jsonContent.push(c);
              break;
            default:
              packJsonContent();
              switch (c.constructor) {
                case Uint8Array:
                case ArrayBuffer:
                  left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentBinary(new Uint8Array(
                    /** @type {Uint8Array} */
                    c
                  )));
                  left.integrate(transaction, 0);
                  break;
                case Doc:
                  left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentDoc(
                    /** @type {Doc} */
                    c
                  ));
                  left.integrate(transaction, 0);
                  break;
                default:
                  if (c instanceof AbstractType) {
                    left = new Item(createID(ownClientId, getState(store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentType(c));
                    left.integrate(transaction, 0);
                  } else {
                    throw new Error("Unexpected content type in insert operation");
                  }
              }
          }
        }
      });
      packJsonContent();
    };
    lengthExceeded = () => create3("Length exceeded!");
    typeListInsertGenerics = (transaction, parent, index, content) => {
      if (index > parent._length) {
        throw lengthExceeded();
      }
      if (index === 0) {
        if (parent._searchMarker) {
          updateMarkerChanges(parent._searchMarker, index, content.length);
        }
        return typeListInsertGenericsAfter(transaction, parent, null, content);
      }
      const startIndex = index;
      const marker = findMarker(parent, index);
      let n = parent._start;
      if (marker !== null) {
        n = marker.p;
        index -= marker.index;
        if (index === 0) {
          n = n.prev;
          index += n && n.countable && !n.deleted ? n.length : 0;
        }
      }
      for (; n !== null; n = n.right) {
        if (!n.deleted && n.countable) {
          if (index <= n.length) {
            if (index < n.length) {
              getItemCleanStart(transaction, createID(n.id.client, n.id.clock + index));
            }
            break;
          }
          index -= n.length;
        }
      }
      if (parent._searchMarker) {
        updateMarkerChanges(parent._searchMarker, startIndex, content.length);
      }
      return typeListInsertGenericsAfter(transaction, parent, n, content);
    };
    typeListPushGenerics = (transaction, parent, content) => {
      const marker = (parent._searchMarker || []).reduce((maxMarker, currMarker) => currMarker.index > maxMarker.index ? currMarker : maxMarker, { index: 0, p: parent._start });
      let n = marker.p;
      if (n) {
        while (n.right) {
          n = n.right;
        }
      }
      return typeListInsertGenericsAfter(transaction, parent, n, content);
    };
    typeListDelete = (transaction, parent, index, length2) => {
      if (length2 === 0) {
        return;
      }
      const startIndex = index;
      const startLength = length2;
      const marker = findMarker(parent, index);
      let n = parent._start;
      if (marker !== null) {
        n = marker.p;
        index -= marker.index;
      }
      for (; n !== null && index > 0; n = n.right) {
        if (!n.deleted && n.countable) {
          if (index < n.length) {
            getItemCleanStart(transaction, createID(n.id.client, n.id.clock + index));
          }
          index -= n.length;
        }
      }
      while (length2 > 0 && n !== null) {
        if (!n.deleted) {
          if (length2 < n.length) {
            getItemCleanStart(transaction, createID(n.id.client, n.id.clock + length2));
          }
          n.delete(transaction);
          length2 -= n.length;
        }
        n = n.right;
      }
      if (length2 > 0) {
        throw lengthExceeded();
      }
      if (parent._searchMarker) {
        updateMarkerChanges(
          parent._searchMarker,
          startIndex,
          -startLength + length2
          /* in case we remove the above exception */
        );
      }
    };
    typeMapDelete = (transaction, parent, key) => {
      const c = parent._map.get(key);
      if (c !== void 0) {
        c.delete(transaction);
      }
    };
    typeMapSet = (transaction, parent, key, value) => {
      const left = parent._map.get(key) || null;
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      let content;
      if (value == null) {
        content = new ContentAny([value]);
      } else {
        switch (value.constructor) {
          case Number:
          case Object:
          case Boolean:
          case Array:
          case String:
          case Date:
          case BigInt:
            content = new ContentAny([value]);
            break;
          case Uint8Array:
            content = new ContentBinary(
              /** @type {Uint8Array} */
              value
            );
            break;
          case Doc:
            content = new ContentDoc(
              /** @type {Doc} */
              value
            );
            break;
          default:
            if (value instanceof AbstractType) {
              content = new ContentType(value);
            } else {
              throw new Error("Unexpected content type");
            }
        }
      }
      new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, null, null, parent, key, content).integrate(transaction, 0);
    };
    typeMapGet = (parent, key) => {
      parent.doc ?? warnPrematureAccess();
      const val = parent._map.get(key);
      return val !== void 0 && !val.deleted ? val.content.getContent()[val.length - 1] : void 0;
    };
    typeMapGetAll = (parent) => {
      const res = {};
      parent.doc ?? warnPrematureAccess();
      parent._map.forEach((value, key) => {
        if (!value.deleted) {
          res[key] = value.content.getContent()[value.length - 1];
        }
      });
      return res;
    };
    typeMapHas = (parent, key) => {
      parent.doc ?? warnPrematureAccess();
      const val = parent._map.get(key);
      return val !== void 0 && !val.deleted;
    };
    typeMapGetAllSnapshot = (parent, snapshot) => {
      const res = {};
      parent._map.forEach((value, key) => {
        let v = value;
        while (v !== null && (!snapshot.sv.has(v.id.client) || v.id.clock >= (snapshot.sv.get(v.id.client) || 0))) {
          v = v.left;
        }
        if (v !== null && isVisible(v, snapshot)) {
          res[key] = v.content.getContent()[v.length - 1];
        }
      });
      return res;
    };
    createMapIterator = (type) => {
      type.doc ?? warnPrematureAccess();
      return iteratorFilter(
        type._map.entries(),
        /** @param {any} entry */
        (entry) => !entry[1].deleted
      );
    };
    YArrayEvent = class extends YEvent {
    };
    YArray = class _YArray extends AbstractType {
      constructor() {
        super();
        this._prelimContent = [];
        this._searchMarker = [];
      }
      /**
       * Construct a new YArray containing the specified items.
       * @template {Object<string,any>|Array<any>|number|null|string|Uint8Array} T
       * @param {Array<T>} items
       * @return {YArray<T>}
       */
      static from(items) {
        const a = new _YArray();
        a.push(items);
        return a;
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        this.insert(
          0,
          /** @type {Array<any>} */
          this._prelimContent
        );
        this._prelimContent = null;
      }
      /**
       * @return {YArray<T>}
       */
      _copy() {
        return new _YArray();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YArray<T>}
       */
      clone() {
        const arr = new _YArray();
        arr.insert(0, this.toArray().map(
          (el) => el instanceof AbstractType ? (
            /** @type {typeof el} */
            el.clone()
          ) : el
        ));
        return arr;
      }
      get length() {
        this.doc ?? warnPrematureAccess();
        return this._length;
      }
      /**
       * Creates YArrayEvent and calls observers.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, parentSubs) {
        super._callObserver(transaction, parentSubs);
        callTypeObservers(this, transaction, new YArrayEvent(this, transaction));
      }
      /**
       * Inserts new content at an index.
       *
       * Important: This function expects an array of content. Not just a content
       * object. The reason for this "weirdness" is that inserting several elements
       * is very efficient when it is done as a single operation.
       *
       * @example
       *  // Insert character 'a' at position 0
       *  yarray.insert(0, ['a'])
       *  // Insert numbers 1, 2 at position 1
       *  yarray.insert(1, [1, 2])
       *
       * @param {number} index The index to insert content at.
       * @param {Array<T>} content The array of content
       */
      insert(index, content) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListInsertGenerics(
              transaction,
              this,
              index,
              /** @type {any} */
              content
            );
          });
        } else {
          this._prelimContent.splice(index, 0, ...content);
        }
      }
      /**
       * Appends content to this YArray.
       *
       * @param {Array<T>} content Array of content to append.
       *
       * @todo Use the following implementation in all types.
       */
      push(content) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListPushGenerics(
              transaction,
              this,
              /** @type {any} */
              content
            );
          });
        } else {
          this._prelimContent.push(...content);
        }
      }
      /**
       * Prepends content to this YArray.
       *
       * @param {Array<T>} content Array of content to prepend.
       */
      unshift(content) {
        this.insert(0, content);
      }
      /**
       * Deletes elements starting from an index.
       *
       * @param {number} index Index at which to start deleting elements
       * @param {number} length The number of elements to remove. Defaults to 1.
       */
      delete(index, length2 = 1) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListDelete(transaction, this, index, length2);
          });
        } else {
          this._prelimContent.splice(index, length2);
        }
      }
      /**
       * Returns the i-th element from a YArray.
       *
       * @param {number} index The index of the element to return from the YArray
       * @return {T}
       */
      get(index) {
        return typeListGet(this, index);
      }
      /**
       * Transforms this YArray to a JavaScript Array.
       *
       * @return {Array<T>}
       */
      toArray() {
        return typeListToArray(this);
      }
      /**
       * Returns a portion of this YArray into a JavaScript Array selected
       * from start to end (end not included).
       *
       * @param {number} [start]
       * @param {number} [end]
       * @return {Array<T>}
       */
      slice(start = 0, end = this.length) {
        return typeListSlice(this, start, end);
      }
      /**
       * Transforms this Shared Type to a JSON object.
       *
       * @return {Array<any>}
       */
      toJSON() {
        return this.map((c) => c instanceof AbstractType ? c.toJSON() : c);
      }
      /**
       * Returns an Array with the result of calling a provided function on every
       * element of this YArray.
       *
       * @template M
       * @param {function(T,number,YArray<T>):M} f Function that produces an element of the new Array
       * @return {Array<M>} A new array with each element being the result of the
       *                 callback function
       */
      map(f) {
        return typeListMap(
          this,
          /** @type {any} */
          f
        );
      }
      /**
       * Executes a provided function once on every element of this YArray.
       *
       * @param {function(T,number,YArray<T>):void} f A function to execute on every element of this YArray.
       */
      forEach(f) {
        typeListForEach(this, f);
      }
      /**
       * @return {IterableIterator<T>}
       */
      [Symbol.iterator]() {
        return typeListCreateIterator(this);
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YArrayRefID);
      }
    };
    readYArray = (_decoder) => new YArray();
    YMapEvent = class extends YEvent {
      /**
       * @param {YMap<T>} ymap The YArray that changed.
       * @param {Transaction} transaction
       * @param {Set<any>} subs The keys that changed.
       */
      constructor(ymap, transaction, subs) {
        super(ymap, transaction);
        this.keysChanged = subs;
      }
    };
    YMap = class _YMap extends AbstractType {
      /**
       *
       * @param {Iterable<readonly [string, any]>=} entries - an optional iterable to initialize the YMap
       */
      constructor(entries) {
        super();
        this._prelimContent = null;
        if (entries === void 0) {
          this._prelimContent = /* @__PURE__ */ new Map();
        } else {
          this._prelimContent = new Map(entries);
        }
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        this._prelimContent.forEach((value, key) => {
          this.set(key, value);
        });
        this._prelimContent = null;
      }
      /**
       * @return {YMap<MapType>}
       */
      _copy() {
        return new _YMap();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YMap<MapType>}
       */
      clone() {
        const map = new _YMap();
        this.forEach((value, key) => {
          map.set(key, value instanceof AbstractType ? (
            /** @type {typeof value} */
            value.clone()
          ) : value);
        });
        return map;
      }
      /**
       * Creates YMapEvent and calls observers.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, parentSubs) {
        callTypeObservers(this, transaction, new YMapEvent(this, transaction, parentSubs));
      }
      /**
       * Transforms this Shared Type to a JSON object.
       *
       * @return {Object<string,any>}
       */
      toJSON() {
        this.doc ?? warnPrematureAccess();
        const map = {};
        this._map.forEach((item, key) => {
          if (!item.deleted) {
            const v = item.content.getContent()[item.length - 1];
            map[key] = v instanceof AbstractType ? v.toJSON() : v;
          }
        });
        return map;
      }
      /**
       * Returns the size of the YMap (count of key/value pairs)
       *
       * @return {number}
       */
      get size() {
        return [...createMapIterator(this)].length;
      }
      /**
       * Returns the keys for each element in the YMap Type.
       *
       * @return {IterableIterator<string>}
       */
      keys() {
        return iteratorMap(
          createMapIterator(this),
          /** @param {any} v */
          (v) => v[0]
        );
      }
      /**
       * Returns the values for each element in the YMap Type.
       *
       * @return {IterableIterator<MapType>}
       */
      values() {
        return iteratorMap(
          createMapIterator(this),
          /** @param {any} v */
          (v) => v[1].content.getContent()[v[1].length - 1]
        );
      }
      /**
       * Returns an Iterator of [key, value] pairs
       *
       * @return {IterableIterator<[string, MapType]>}
       */
      entries() {
        return iteratorMap(
          createMapIterator(this),
          /** @param {any} v */
          (v) => (
            /** @type {any} */
            [v[0], v[1].content.getContent()[v[1].length - 1]]
          )
        );
      }
      /**
       * Executes a provided function on once on every key-value pair.
       *
       * @param {function(MapType,string,YMap<MapType>):void} f A function to execute on every element of this YArray.
       */
      forEach(f) {
        this.doc ?? warnPrematureAccess();
        this._map.forEach((item, key) => {
          if (!item.deleted) {
            f(item.content.getContent()[item.length - 1], key, this);
          }
        });
      }
      /**
       * Returns an Iterator of [key, value] pairs
       *
       * @return {IterableIterator<[string, MapType]>}
       */
      [Symbol.iterator]() {
        return this.entries();
      }
      /**
       * Remove a specified element from this YMap.
       *
       * @param {string} key The key of the element to remove.
       */
      delete(key) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapDelete(transaction, this, key);
          });
        } else {
          this._prelimContent.delete(key);
        }
      }
      /**
       * Adds or updates an element with a specified key and value.
       * @template {MapType} VAL
       *
       * @param {string} key The key of the element to add to this YMap
       * @param {VAL} value The value of the element to add
       * @return {VAL}
       */
      set(key, value) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapSet(
              transaction,
              this,
              key,
              /** @type {any} */
              value
            );
          });
        } else {
          this._prelimContent.set(key, value);
        }
        return value;
      }
      /**
       * Returns a specified element from this YMap.
       *
       * @param {string} key
       * @return {MapType|undefined}
       */
      get(key) {
        return (
          /** @type {any} */
          typeMapGet(this, key)
        );
      }
      /**
       * Returns a boolean indicating whether the specified key exists or not.
       *
       * @param {string} key The key to test.
       * @return {boolean}
       */
      has(key) {
        return typeMapHas(this, key);
      }
      /**
       * Removes all elements from this YMap.
       */
      clear() {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            this.forEach(function(_value, key, map) {
              typeMapDelete(transaction, map, key);
            });
          });
        } else {
          this._prelimContent.clear();
        }
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YMapRefID);
      }
    };
    readYMap = (_decoder) => new YMap();
    equalAttrs = (a, b) => a === b || typeof a === "object" && typeof b === "object" && a && b && equalFlat(a, b);
    ItemTextListPosition = class {
      /**
       * @param {Item|null} left
       * @param {Item|null} right
       * @param {number} index
       * @param {Map<string,any>} currentAttributes
       */
      constructor(left, right, index, currentAttributes) {
        this.left = left;
        this.right = right;
        this.index = index;
        this.currentAttributes = currentAttributes;
      }
      /**
       * Only call this if you know that this.right is defined
       */
      forward() {
        if (this.right === null) {
          unexpectedCase();
        }
        switch (this.right.content.constructor) {
          case ContentFormat:
            if (!this.right.deleted) {
              updateCurrentAttributes(
                this.currentAttributes,
                /** @type {ContentFormat} */
                this.right.content
              );
            }
            break;
          default:
            if (!this.right.deleted) {
              this.index += this.right.length;
            }
            break;
        }
        this.left = this.right;
        this.right = this.right.right;
      }
    };
    findNextPosition = (transaction, pos, count) => {
      while (pos.right !== null && count > 0) {
        switch (pos.right.content.constructor) {
          case ContentFormat:
            if (!pos.right.deleted) {
              updateCurrentAttributes(
                pos.currentAttributes,
                /** @type {ContentFormat} */
                pos.right.content
              );
            }
            break;
          default:
            if (!pos.right.deleted) {
              if (count < pos.right.length) {
                getItemCleanStart(transaction, createID(pos.right.id.client, pos.right.id.clock + count));
              }
              pos.index += pos.right.length;
              count -= pos.right.length;
            }
            break;
        }
        pos.left = pos.right;
        pos.right = pos.right.right;
      }
      return pos;
    };
    findPosition = (transaction, parent, index, useSearchMarker) => {
      const currentAttributes = /* @__PURE__ */ new Map();
      const marker = useSearchMarker ? findMarker(parent, index) : null;
      if (marker) {
        const pos = new ItemTextListPosition(marker.p.left, marker.p, marker.index, currentAttributes);
        return findNextPosition(transaction, pos, index - marker.index);
      } else {
        const pos = new ItemTextListPosition(null, parent._start, 0, currentAttributes);
        return findNextPosition(transaction, pos, index);
      }
    };
    insertNegatedAttributes = (transaction, parent, currPos, negatedAttributes) => {
      while (currPos.right !== null && (currPos.right.deleted === true || currPos.right.content.constructor === ContentFormat && equalAttrs(
        negatedAttributes.get(
          /** @type {ContentFormat} */
          currPos.right.content.key
        ),
        /** @type {ContentFormat} */
        currPos.right.content.value
      ))) {
        if (!currPos.right.deleted) {
          negatedAttributes.delete(
            /** @type {ContentFormat} */
            currPos.right.content.key
          );
        }
        currPos.forward();
      }
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      negatedAttributes.forEach((val, key) => {
        const left = currPos.left;
        const right = currPos.right;
        const nextFormat = new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentFormat(key, val));
        nextFormat.integrate(transaction, 0);
        currPos.right = nextFormat;
        currPos.forward();
      });
    };
    updateCurrentAttributes = (currentAttributes, format) => {
      const { key, value } = format;
      if (value === null) {
        currentAttributes.delete(key);
      } else {
        currentAttributes.set(key, value);
      }
    };
    minimizeAttributeChanges = (currPos, attributes) => {
      while (true) {
        if (currPos.right === null) {
          break;
        } else if (currPos.right.deleted || currPos.right.content.constructor === ContentFormat && equalAttrs(
          attributes[
            /** @type {ContentFormat} */
            currPos.right.content.key
          ] ?? null,
          /** @type {ContentFormat} */
          currPos.right.content.value
        )) ;
        else {
          break;
        }
        currPos.forward();
      }
    };
    insertAttributes = (transaction, parent, currPos, attributes) => {
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      const negatedAttributes = /* @__PURE__ */ new Map();
      for (const key in attributes) {
        const val = attributes[key];
        const currentVal = currPos.currentAttributes.get(key) ?? null;
        if (!equalAttrs(currentVal, val)) {
          negatedAttributes.set(key, currentVal);
          const { left, right } = currPos;
          currPos.right = new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, new ContentFormat(key, val));
          currPos.right.integrate(transaction, 0);
          currPos.forward();
        }
      }
      return negatedAttributes;
    };
    insertText = (transaction, parent, currPos, text, attributes) => {
      currPos.currentAttributes.forEach((_val, key) => {
        if (attributes[key] === void 0) {
          attributes[key] = null;
        }
      });
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      minimizeAttributeChanges(currPos, attributes);
      const negatedAttributes = insertAttributes(transaction, parent, currPos, attributes);
      const content = text.constructor === String ? new ContentString(
        /** @type {string} */
        text
      ) : text instanceof AbstractType ? new ContentType(text) : new ContentEmbed(text);
      let { left, right, index } = currPos;
      if (parent._searchMarker) {
        updateMarkerChanges(parent._searchMarker, currPos.index, content.getLength());
      }
      right = new Item(createID(ownClientId, getState(doc.store, ownClientId)), left, left && left.lastId, right, right && right.id, parent, null, content);
      right.integrate(transaction, 0);
      currPos.right = right;
      currPos.index = index;
      currPos.forward();
      insertNegatedAttributes(transaction, parent, currPos, negatedAttributes);
    };
    formatText = (transaction, parent, currPos, length2, attributes) => {
      const doc = transaction.doc;
      const ownClientId = doc.clientID;
      minimizeAttributeChanges(currPos, attributes);
      const negatedAttributes = insertAttributes(transaction, parent, currPos, attributes);
      iterationLoop: while (currPos.right !== null && (length2 > 0 || negatedAttributes.size > 0 && (currPos.right.deleted || currPos.right.content.constructor === ContentFormat))) {
        if (!currPos.right.deleted) {
          switch (currPos.right.content.constructor) {
            case ContentFormat: {
              const { key, value } = (
                /** @type {ContentFormat} */
                currPos.right.content
              );
              const attr = attributes[key];
              if (attr !== void 0) {
                if (equalAttrs(attr, value)) {
                  negatedAttributes.delete(key);
                } else {
                  if (length2 === 0) {
                    break iterationLoop;
                  }
                  negatedAttributes.set(key, value);
                }
                currPos.right.delete(transaction);
              } else {
                currPos.currentAttributes.set(key, value);
              }
              break;
            }
            default:
              if (length2 < currPos.right.length) {
                getItemCleanStart(transaction, createID(currPos.right.id.client, currPos.right.id.clock + length2));
              }
              length2 -= currPos.right.length;
              break;
          }
        }
        currPos.forward();
      }
      if (length2 > 0) {
        let newlines = "";
        for (; length2 > 0; length2--) {
          newlines += "\n";
        }
        currPos.right = new Item(createID(ownClientId, getState(doc.store, ownClientId)), currPos.left, currPos.left && currPos.left.lastId, currPos.right, currPos.right && currPos.right.id, parent, null, new ContentString(newlines));
        currPos.right.integrate(transaction, 0);
        currPos.forward();
      }
      insertNegatedAttributes(transaction, parent, currPos, negatedAttributes);
    };
    cleanupFormattingGap = (transaction, start, curr, startAttributes, currAttributes) => {
      let end = start;
      const endFormats = create();
      while (end && (!end.countable || end.deleted)) {
        if (!end.deleted && end.content.constructor === ContentFormat) {
          const cf = (
            /** @type {ContentFormat} */
            end.content
          );
          endFormats.set(cf.key, cf);
        }
        end = end.right;
      }
      let cleanups = 0;
      let reachedCurr = false;
      while (start !== end) {
        if (curr === start) {
          reachedCurr = true;
        }
        if (!start.deleted) {
          const content = start.content;
          switch (content.constructor) {
            case ContentFormat: {
              const { key, value } = (
                /** @type {ContentFormat} */
                content
              );
              const startAttrValue = startAttributes.get(key) ?? null;
              if (endFormats.get(key) !== content || startAttrValue === value) {
                start.delete(transaction);
                cleanups++;
                if (!reachedCurr && (currAttributes.get(key) ?? null) === value && startAttrValue !== value) {
                  if (startAttrValue === null) {
                    currAttributes.delete(key);
                  } else {
                    currAttributes.set(key, startAttrValue);
                  }
                }
              }
              if (!reachedCurr && !start.deleted) {
                updateCurrentAttributes(
                  currAttributes,
                  /** @type {ContentFormat} */
                  content
                );
              }
              break;
            }
          }
        }
        start = /** @type {Item} */
        start.right;
      }
      return cleanups;
    };
    cleanupContextlessFormattingGap = (transaction, item) => {
      while (item && item.right && (item.right.deleted || !item.right.countable)) {
        item = item.right;
      }
      const attrs = /* @__PURE__ */ new Set();
      while (item && (item.deleted || !item.countable)) {
        if (!item.deleted && item.content.constructor === ContentFormat) {
          const key = (
            /** @type {ContentFormat} */
            item.content.key
          );
          if (attrs.has(key)) {
            item.delete(transaction);
          } else {
            attrs.add(key);
          }
        }
        item = item.left;
      }
    };
    cleanupYTextFormatting = (type) => {
      let res = 0;
      transact(
        /** @type {Doc} */
        type.doc,
        (transaction) => {
          let start = (
            /** @type {Item} */
            type._start
          );
          let end = type._start;
          let startAttributes = create();
          const currentAttributes = copy(startAttributes);
          while (end) {
            if (end.deleted === false) {
              switch (end.content.constructor) {
                case ContentFormat:
                  updateCurrentAttributes(
                    currentAttributes,
                    /** @type {ContentFormat} */
                    end.content
                  );
                  break;
                default:
                  res += cleanupFormattingGap(transaction, start, end, startAttributes, currentAttributes);
                  startAttributes = copy(currentAttributes);
                  start = end;
                  break;
              }
            }
            end = end.right;
          }
        }
      );
      return res;
    };
    cleanupYTextAfterTransaction = (transaction) => {
      const needFullCleanup = /* @__PURE__ */ new Set();
      const doc = transaction.doc;
      for (const [client, afterClock] of transaction.afterState.entries()) {
        const clock = transaction.beforeState.get(client) || 0;
        if (afterClock === clock) {
          continue;
        }
        iterateStructs(
          transaction,
          /** @type {Array<Item|GC>} */
          doc.store.clients.get(client),
          clock,
          afterClock,
          (item) => {
            if (!item.deleted && /** @type {Item} */
            item.content.constructor === ContentFormat && item.constructor !== GC) {
              needFullCleanup.add(
                /** @type {any} */
                item.parent
              );
            }
          }
        );
      }
      transact(doc, (t) => {
        iterateDeletedStructs(transaction, transaction.deleteSet, (item) => {
          if (item instanceof GC || !/** @type {YText} */
          item.parent._hasFormatting || needFullCleanup.has(
            /** @type {YText} */
            item.parent
          )) {
            return;
          }
          const parent = (
            /** @type {YText} */
            item.parent
          );
          if (item.content.constructor === ContentFormat) {
            needFullCleanup.add(parent);
          } else {
            cleanupContextlessFormattingGap(t, item);
          }
        });
        for (const yText of needFullCleanup) {
          cleanupYTextFormatting(yText);
        }
      });
    };
    deleteText = (transaction, currPos, length2) => {
      const startLength = length2;
      const startAttrs = copy(currPos.currentAttributes);
      const start = currPos.right;
      while (length2 > 0 && currPos.right !== null) {
        if (currPos.right.deleted === false) {
          switch (currPos.right.content.constructor) {
            case ContentType:
            case ContentEmbed:
            case ContentString:
              if (length2 < currPos.right.length) {
                getItemCleanStart(transaction, createID(currPos.right.id.client, currPos.right.id.clock + length2));
              }
              length2 -= currPos.right.length;
              currPos.right.delete(transaction);
              break;
          }
        }
        currPos.forward();
      }
      if (start) {
        cleanupFormattingGap(transaction, start, currPos.right, startAttrs, currPos.currentAttributes);
      }
      const parent = (
        /** @type {AbstractType<any>} */
        /** @type {Item} */
        (currPos.left || currPos.right).parent
      );
      if (parent._searchMarker) {
        updateMarkerChanges(parent._searchMarker, currPos.index, -startLength + length2);
      }
      return currPos;
    };
    YTextEvent = class extends YEvent {
      /**
       * @param {YText} ytext
       * @param {Transaction} transaction
       * @param {Set<any>} subs The keys that changed
       */
      constructor(ytext, transaction, subs) {
        super(ytext, transaction);
        this.childListChanged = false;
        this.keysChanged = /* @__PURE__ */ new Set();
        subs.forEach((sub) => {
          if (sub === null) {
            this.childListChanged = true;
          } else {
            this.keysChanged.add(sub);
          }
        });
      }
      /**
       * @type {{added:Set<Item>,deleted:Set<Item>,keys:Map<string,{action:'add'|'update'|'delete',oldValue:any}>,delta:Array<{insert?:Array<any>|string, delete?:number, retain?:number}>}}
       */
      get changes() {
        if (this._changes === null) {
          const changes = {
            keys: this.keys,
            delta: this.delta,
            added: /* @__PURE__ */ new Set(),
            deleted: /* @__PURE__ */ new Set()
          };
          this._changes = changes;
        }
        return (
          /** @type {any} */
          this._changes
        );
      }
      /**
       * Compute the changes in the delta format.
       * A {@link https://quilljs.com/docs/delta/|Quill Delta}) that represents the changes on the document.
       *
       * @type {Array<{insert?:string|object|AbstractType<any>, delete?:number, retain?:number, attributes?: Object<string,any>}>}
       *
       * @public
       */
      get delta() {
        if (this._delta === null) {
          const y = (
            /** @type {Doc} */
            this.target.doc
          );
          const delta = [];
          transact(y, (transaction) => {
            const currentAttributes = /* @__PURE__ */ new Map();
            const oldAttributes = /* @__PURE__ */ new Map();
            let item = this.target._start;
            let action = null;
            const attributes = {};
            let insert = "";
            let retain = 0;
            let deleteLen = 0;
            const addOp = () => {
              if (action !== null) {
                let op = null;
                switch (action) {
                  case "delete":
                    if (deleteLen > 0) {
                      op = { delete: deleteLen };
                    }
                    deleteLen = 0;
                    break;
                  case "insert":
                    if (typeof insert === "object" || insert.length > 0) {
                      op = { insert };
                      if (currentAttributes.size > 0) {
                        op.attributes = {};
                        currentAttributes.forEach((value, key) => {
                          if (value !== null) {
                            op.attributes[key] = value;
                          }
                        });
                      }
                    }
                    insert = "";
                    break;
                  case "retain":
                    if (retain > 0) {
                      op = { retain };
                      if (!isEmpty(attributes)) {
                        op.attributes = assign({}, attributes);
                      }
                    }
                    retain = 0;
                    break;
                }
                if (op) delta.push(op);
                action = null;
              }
            };
            while (item !== null) {
              switch (item.content.constructor) {
                case ContentType:
                case ContentEmbed:
                  if (this.adds(item)) {
                    if (!this.deletes(item)) {
                      addOp();
                      action = "insert";
                      insert = item.content.getContent()[0];
                      addOp();
                    }
                  } else if (this.deletes(item)) {
                    if (action !== "delete") {
                      addOp();
                      action = "delete";
                    }
                    deleteLen += 1;
                  } else if (!item.deleted) {
                    if (action !== "retain") {
                      addOp();
                      action = "retain";
                    }
                    retain += 1;
                  }
                  break;
                case ContentString:
                  if (this.adds(item)) {
                    if (!this.deletes(item)) {
                      if (action !== "insert") {
                        addOp();
                        action = "insert";
                      }
                      insert += /** @type {ContentString} */
                      item.content.str;
                    }
                  } else if (this.deletes(item)) {
                    if (action !== "delete") {
                      addOp();
                      action = "delete";
                    }
                    deleteLen += item.length;
                  } else if (!item.deleted) {
                    if (action !== "retain") {
                      addOp();
                      action = "retain";
                    }
                    retain += item.length;
                  }
                  break;
                case ContentFormat: {
                  const { key, value } = (
                    /** @type {ContentFormat} */
                    item.content
                  );
                  if (this.adds(item)) {
                    if (!this.deletes(item)) {
                      const curVal = currentAttributes.get(key) ?? null;
                      if (!equalAttrs(curVal, value)) {
                        if (action === "retain") {
                          addOp();
                        }
                        if (equalAttrs(value, oldAttributes.get(key) ?? null)) {
                          delete attributes[key];
                        } else {
                          attributes[key] = value;
                        }
                      } else if (value !== null) {
                        item.delete(transaction);
                      }
                    }
                  } else if (this.deletes(item)) {
                    oldAttributes.set(key, value);
                    const curVal = currentAttributes.get(key) ?? null;
                    if (!equalAttrs(curVal, value)) {
                      if (action === "retain") {
                        addOp();
                      }
                      attributes[key] = curVal;
                    }
                  } else if (!item.deleted) {
                    oldAttributes.set(key, value);
                    const attr = attributes[key];
                    if (attr !== void 0) {
                      if (!equalAttrs(attr, value)) {
                        if (action === "retain") {
                          addOp();
                        }
                        if (value === null) {
                          delete attributes[key];
                        } else {
                          attributes[key] = value;
                        }
                      } else if (attr !== null) {
                        item.delete(transaction);
                      }
                    }
                  }
                  if (!item.deleted) {
                    if (action === "insert") {
                      addOp();
                    }
                    updateCurrentAttributes(
                      currentAttributes,
                      /** @type {ContentFormat} */
                      item.content
                    );
                  }
                  break;
                }
              }
              item = item.right;
            }
            addOp();
            while (delta.length > 0) {
              const lastOp = delta[delta.length - 1];
              if (lastOp.retain !== void 0 && lastOp.attributes === void 0) {
                delta.pop();
              } else {
                break;
              }
            }
          });
          this._delta = delta;
        }
        return (
          /** @type {any} */
          this._delta
        );
      }
    };
    YText = class _YText extends AbstractType {
      /**
       * @param {String} [string] The initial value of the YText.
       */
      constructor(string) {
        super();
        this._pending = string !== void 0 ? [() => this.insert(0, string)] : [];
        this._searchMarker = [];
        this._hasFormatting = false;
      }
      /**
       * Number of characters of this text type.
       *
       * @type {number}
       */
      get length() {
        this.doc ?? warnPrematureAccess();
        return this._length;
      }
      /**
       * @param {Doc} y
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        try {
          this._pending.forEach((f) => f());
        } catch (e) {
          console.error(e);
        }
        this._pending = null;
      }
      _copy() {
        return new _YText();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YText}
       */
      clone() {
        const text = new _YText();
        text.applyDelta(this.toDelta());
        return text;
      }
      /**
       * Creates YTextEvent and calls observers.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, parentSubs) {
        super._callObserver(transaction, parentSubs);
        const event = new YTextEvent(this, transaction, parentSubs);
        callTypeObservers(this, transaction, event);
        if (!transaction.local && this._hasFormatting) {
          transaction._needFormattingCleanup = true;
        }
      }
      /**
       * Returns the unformatted string representation of this YText type.
       *
       * @public
       */
      toString() {
        this.doc ?? warnPrematureAccess();
        let str2 = "";
        let n = this._start;
        while (n !== null) {
          if (!n.deleted && n.countable && n.content.constructor === ContentString) {
            str2 += /** @type {ContentString} */
            n.content.str;
          }
          n = n.right;
        }
        return str2;
      }
      /**
       * Returns the unformatted string representation of this YText type.
       *
       * @return {string}
       * @public
       */
      toJSON() {
        return this.toString();
      }
      /**
       * Apply a {@link Delta} on this shared YText type.
       *
       * @param {Array<any>} delta The changes to apply on this element.
       * @param {object}  opts
       * @param {boolean} [opts.sanitize] Sanitize input delta. Removes ending newlines if set to true.
       *
       *
       * @public
       */
      applyDelta(delta, { sanitize = true } = {}) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            const currPos = new ItemTextListPosition(null, this._start, 0, /* @__PURE__ */ new Map());
            for (let i = 0; i < delta.length; i++) {
              const op = delta[i];
              if (op.insert !== void 0) {
                const ins = !sanitize && typeof op.insert === "string" && i === delta.length - 1 && currPos.right === null && op.insert.slice(-1) === "\n" ? op.insert.slice(0, -1) : op.insert;
                if (typeof ins !== "string" || ins.length > 0) {
                  insertText(transaction, this, currPos, ins, op.attributes || {});
                }
              } else if (op.retain !== void 0) {
                formatText(transaction, this, currPos, op.retain, op.attributes || {});
              } else if (op.delete !== void 0) {
                deleteText(transaction, currPos, op.delete);
              }
            }
          });
        } else {
          this._pending.push(() => this.applyDelta(delta));
        }
      }
      /**
       * Returns the Delta representation of this YText type.
       *
       * @param {Snapshot} [snapshot]
       * @param {Snapshot} [prevSnapshot]
       * @param {function('removed' | 'added', ID):any} [computeYChange]
       * @return {any} The Delta representation of this type.
       *
       * @public
       */
      toDelta(snapshot, prevSnapshot, computeYChange) {
        this.doc ?? warnPrematureAccess();
        const ops = [];
        const currentAttributes = /* @__PURE__ */ new Map();
        const doc = (
          /** @type {Doc} */
          this.doc
        );
        let str2 = "";
        let n = this._start;
        function packStr() {
          if (str2.length > 0) {
            const attributes = {};
            let addAttributes = false;
            currentAttributes.forEach((value, key) => {
              addAttributes = true;
              attributes[key] = value;
            });
            const op = { insert: str2 };
            if (addAttributes) {
              op.attributes = attributes;
            }
            ops.push(op);
            str2 = "";
          }
        }
        const computeDelta = () => {
          while (n !== null) {
            if (isVisible(n, snapshot) || prevSnapshot !== void 0 && isVisible(n, prevSnapshot)) {
              switch (n.content.constructor) {
                case ContentString: {
                  const cur = currentAttributes.get("ychange");
                  if (snapshot !== void 0 && !isVisible(n, snapshot)) {
                    if (cur === void 0 || cur.user !== n.id.client || cur.type !== "removed") {
                      packStr();
                      currentAttributes.set("ychange", computeYChange ? computeYChange("removed", n.id) : { type: "removed" });
                    }
                  } else if (prevSnapshot !== void 0 && !isVisible(n, prevSnapshot)) {
                    if (cur === void 0 || cur.user !== n.id.client || cur.type !== "added") {
                      packStr();
                      currentAttributes.set("ychange", computeYChange ? computeYChange("added", n.id) : { type: "added" });
                    }
                  } else if (cur !== void 0) {
                    packStr();
                    currentAttributes.delete("ychange");
                  }
                  str2 += /** @type {ContentString} */
                  n.content.str;
                  break;
                }
                case ContentType:
                case ContentEmbed: {
                  packStr();
                  const op = {
                    insert: n.content.getContent()[0]
                  };
                  if (currentAttributes.size > 0) {
                    const attrs = (
                      /** @type {Object<string,any>} */
                      {}
                    );
                    op.attributes = attrs;
                    currentAttributes.forEach((value, key) => {
                      attrs[key] = value;
                    });
                  }
                  ops.push(op);
                  break;
                }
                case ContentFormat:
                  if (isVisible(n, snapshot)) {
                    packStr();
                    updateCurrentAttributes(
                      currentAttributes,
                      /** @type {ContentFormat} */
                      n.content
                    );
                  }
                  break;
              }
            }
            n = n.right;
          }
          packStr();
        };
        if (snapshot || prevSnapshot) {
          transact(doc, (transaction) => {
            if (snapshot) {
              splitSnapshotAffectedStructs(transaction, snapshot);
            }
            if (prevSnapshot) {
              splitSnapshotAffectedStructs(transaction, prevSnapshot);
            }
            computeDelta();
          }, "cleanup");
        } else {
          computeDelta();
        }
        return ops;
      }
      /**
       * Insert text at a given index.
       *
       * @param {number} index The index at which to start inserting.
       * @param {String} text The text to insert at the specified position.
       * @param {TextAttributes} [attributes] Optionally define some formatting
       *                                    information to apply on the inserted
       *                                    Text.
       * @public
       */
      insert(index, text, attributes) {
        if (text.length <= 0) {
          return;
        }
        const y = this.doc;
        if (y !== null) {
          transact(y, (transaction) => {
            const pos = findPosition(transaction, this, index, !attributes);
            if (!attributes) {
              attributes = {};
              pos.currentAttributes.forEach((v, k) => {
                attributes[k] = v;
              });
            }
            insertText(transaction, this, pos, text, attributes);
          });
        } else {
          this._pending.push(() => this.insert(index, text, attributes));
        }
      }
      /**
       * Inserts an embed at a index.
       *
       * @param {number} index The index to insert the embed at.
       * @param {Object | AbstractType<any>} embed The Object that represents the embed.
       * @param {TextAttributes} [attributes] Attribute information to apply on the
       *                                    embed
       *
       * @public
       */
      insertEmbed(index, embed, attributes) {
        const y = this.doc;
        if (y !== null) {
          transact(y, (transaction) => {
            const pos = findPosition(transaction, this, index, !attributes);
            insertText(transaction, this, pos, embed, attributes || {});
          });
        } else {
          this._pending.push(() => this.insertEmbed(index, embed, attributes || {}));
        }
      }
      /**
       * Deletes text starting from an index.
       *
       * @param {number} index Index at which to start deleting.
       * @param {number} length The number of characters to remove. Defaults to 1.
       *
       * @public
       */
      delete(index, length2) {
        if (length2 === 0) {
          return;
        }
        const y = this.doc;
        if (y !== null) {
          transact(y, (transaction) => {
            deleteText(transaction, findPosition(transaction, this, index, true), length2);
          });
        } else {
          this._pending.push(() => this.delete(index, length2));
        }
      }
      /**
       * Assigns properties to a range of text.
       *
       * @param {number} index The position where to start formatting.
       * @param {number} length The amount of characters to assign properties to.
       * @param {TextAttributes} attributes Attribute information to apply on the
       *                                    text.
       *
       * @public
       */
      format(index, length2, attributes) {
        if (length2 === 0) {
          return;
        }
        const y = this.doc;
        if (y !== null) {
          transact(y, (transaction) => {
            const pos = findPosition(transaction, this, index, false);
            if (pos.right === null) {
              return;
            }
            formatText(transaction, this, pos, length2, attributes);
          });
        } else {
          this._pending.push(() => this.format(index, length2, attributes));
        }
      }
      /**
       * Removes an attribute.
       *
       * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
       *
       * @param {String} attributeName The attribute name that is to be removed.
       *
       * @public
       */
      removeAttribute(attributeName) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapDelete(transaction, this, attributeName);
          });
        } else {
          this._pending.push(() => this.removeAttribute(attributeName));
        }
      }
      /**
       * Sets or updates an attribute.
       *
       * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
       *
       * @param {String} attributeName The attribute name that is to be set.
       * @param {any} attributeValue The attribute value that is to be set.
       *
       * @public
       */
      setAttribute(attributeName, attributeValue) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapSet(transaction, this, attributeName, attributeValue);
          });
        } else {
          this._pending.push(() => this.setAttribute(attributeName, attributeValue));
        }
      }
      /**
       * Returns an attribute value that belongs to the attribute name.
       *
       * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
       *
       * @param {String} attributeName The attribute name that identifies the
       *                               queried value.
       * @return {any} The queried attribute value.
       *
       * @public
       */
      getAttribute(attributeName) {
        return (
          /** @type {any} */
          typeMapGet(this, attributeName)
        );
      }
      /**
       * Returns all attribute name/value pairs in a JSON Object.
       *
       * @note Xml-Text nodes don't have attributes. You can use this feature to assign properties to complete text-blocks.
       *
       * @return {Object<string, any>} A JSON Object that describes the attributes.
       *
       * @public
       */
      getAttributes() {
        return typeMapGetAll(this);
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YTextRefID);
      }
    };
    readYText = (_decoder) => new YText();
    YXmlTreeWalker = class {
      /**
       * @param {YXmlFragment | YXmlElement} root
       * @param {function(AbstractType<any>):boolean} [f]
       */
      constructor(root, f = () => true) {
        this._filter = f;
        this._root = root;
        this._currentNode = /** @type {Item} */
        root._start;
        this._firstCall = true;
        root.doc ?? warnPrematureAccess();
      }
      [Symbol.iterator]() {
        return this;
      }
      /**
       * Get the next node.
       *
       * @return {IteratorResult<YXmlElement|YXmlText|YXmlHook>} The next node.
       *
       * @public
       */
      next() {
        let n = this._currentNode;
        let type = n && n.content && /** @type {any} */
        n.content.type;
        if (n !== null && (!this._firstCall || n.deleted || !this._filter(type))) {
          do {
            type = /** @type {any} */
            n.content.type;
            if (!n.deleted && (type.constructor === YXmlElement || type.constructor === YXmlFragment) && type._start !== null) {
              n = type._start;
            } else {
              while (n !== null) {
                const nxt = n.next;
                if (nxt !== null) {
                  n = nxt;
                  break;
                } else if (n.parent === this._root) {
                  n = null;
                } else {
                  n = /** @type {AbstractType<any>} */
                  n.parent._item;
                }
              }
            }
          } while (n !== null && (n.deleted || !this._filter(
            /** @type {ContentType} */
            n.content.type
          )));
        }
        this._firstCall = false;
        if (n === null) {
          return { value: void 0, done: true };
        }
        this._currentNode = n;
        return { value: (
          /** @type {any} */
          n.content.type
        ), done: false };
      }
    };
    YXmlFragment = class _YXmlFragment extends AbstractType {
      constructor() {
        super();
        this._prelimContent = [];
      }
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get firstChild() {
        const first = this._first;
        return first ? first.content.getContent()[0] : null;
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        this.insert(
          0,
          /** @type {Array<any>} */
          this._prelimContent
        );
        this._prelimContent = null;
      }
      _copy() {
        return new _YXmlFragment();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YXmlFragment}
       */
      clone() {
        const el = new _YXmlFragment();
        el.insert(0, this.toArray().map((item) => item instanceof AbstractType ? item.clone() : item));
        return el;
      }
      get length() {
        this.doc ?? warnPrematureAccess();
        return this._prelimContent === null ? this._length : this._prelimContent.length;
      }
      /**
       * Create a subtree of childNodes.
       *
       * @example
       * const walker = elem.createTreeWalker(dom => dom.nodeName === 'div')
       * for (let node in walker) {
       *   // `node` is a div node
       *   nop(node)
       * }
       *
       * @param {function(AbstractType<any>):boolean} filter Function that is called on each child element and
       *                          returns a Boolean indicating whether the child
       *                          is to be included in the subtree.
       * @return {YXmlTreeWalker} A subtree and a position within it.
       *
       * @public
       */
      createTreeWalker(filter) {
        return new YXmlTreeWalker(this, filter);
      }
      /**
       * Returns the first YXmlElement that matches the query.
       * Similar to DOM's {@link querySelector}.
       *
       * Query support:
       *   - tagname
       * TODO:
       *   - id
       *   - attribute
       *
       * @param {CSS_Selector} query The query on the children.
       * @return {YXmlElement|YXmlText|YXmlHook|null} The first element that matches the query or null.
       *
       * @public
       */
      querySelector(query) {
        query = query.toUpperCase();
        const iterator = new YXmlTreeWalker(this, (element) => element.nodeName && element.nodeName.toUpperCase() === query);
        const next = iterator.next();
        if (next.done) {
          return null;
        } else {
          return next.value;
        }
      }
      /**
       * Returns all YXmlElements that match the query.
       * Similar to Dom's {@link querySelectorAll}.
       *
       * @todo Does not yet support all queries. Currently only query by tagName.
       *
       * @param {CSS_Selector} query The query on the children
       * @return {Array<YXmlElement|YXmlText|YXmlHook|null>} The elements that match this query.
       *
       * @public
       */
      querySelectorAll(query) {
        query = query.toUpperCase();
        return from(new YXmlTreeWalker(this, (element) => element.nodeName && element.nodeName.toUpperCase() === query));
      }
      /**
       * Creates YXmlEvent and calls observers.
       *
       * @param {Transaction} transaction
       * @param {Set<null|string>} parentSubs Keys changed on this type. `null` if list was modified.
       */
      _callObserver(transaction, parentSubs) {
        callTypeObservers(this, transaction, new YXmlEvent(this, parentSubs, transaction));
      }
      /**
       * Get the string representation of all the children of this YXmlFragment.
       *
       * @return {string} The string representation of all children.
       */
      toString() {
        return typeListMap(this, (xml) => xml.toString()).join("");
      }
      /**
       * @return {string}
       */
      toJSON() {
        return this.toString();
      }
      /**
       * Creates a Dom Element that mirrors this YXmlElement.
       *
       * @param {Document} [_document=document] The document object (you must define
       *                                        this when calling this method in
       *                                        nodejs)
       * @param {Object<string, any>} [hooks={}] Optional property to customize how hooks
       *                                             are presented in the DOM
       * @param {any} [binding] You should not set this property. This is
       *                               used if DomBinding wants to create a
       *                               association to the created DOM type.
       * @return {Node} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
       *
       * @public
       */
      toDOM(_document = document, hooks = {}, binding) {
        const fragment = _document.createDocumentFragment();
        if (binding !== void 0) {
          binding._createAssociation(fragment, this);
        }
        typeListForEach(this, (xmlType) => {
          fragment.insertBefore(xmlType.toDOM(_document, hooks, binding), null);
        });
        return fragment;
      }
      /**
       * Inserts new content at an index.
       *
       * @example
       *  // Insert character 'a' at position 0
       *  xml.insert(0, [new Y.XmlText('text')])
       *
       * @param {number} index The index to insert content at
       * @param {Array<YXmlElement|YXmlText>} content The array of content
       */
      insert(index, content) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListInsertGenerics(transaction, this, index, content);
          });
        } else {
          this._prelimContent.splice(index, 0, ...content);
        }
      }
      /**
       * Inserts new content at an index.
       *
       * @example
       *  // Insert character 'a' at position 0
       *  xml.insert(0, [new Y.XmlText('text')])
       *
       * @param {null|Item|YXmlElement|YXmlText} ref The index to insert content at
       * @param {Array<YXmlElement|YXmlText>} content The array of content
       */
      insertAfter(ref, content) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            const refItem = ref && ref instanceof AbstractType ? ref._item : ref;
            typeListInsertGenericsAfter(transaction, this, refItem, content);
          });
        } else {
          const pc = (
            /** @type {Array<any>} */
            this._prelimContent
          );
          const index = ref === null ? 0 : pc.findIndex((el) => el === ref) + 1;
          if (index === 0 && ref !== null) {
            throw create3("Reference item not found");
          }
          pc.splice(index, 0, ...content);
        }
      }
      /**
       * Deletes elements starting from an index.
       *
       * @param {number} index Index at which to start deleting elements
       * @param {number} [length=1] The number of elements to remove. Defaults to 1.
       */
      delete(index, length2 = 1) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeListDelete(transaction, this, index, length2);
          });
        } else {
          this._prelimContent.splice(index, length2);
        }
      }
      /**
       * Transforms this YArray to a JavaScript Array.
       *
       * @return {Array<YXmlElement|YXmlText|YXmlHook>}
       */
      toArray() {
        return typeListToArray(this);
      }
      /**
       * Appends content to this YArray.
       *
       * @param {Array<YXmlElement|YXmlText>} content Array of content to append.
       */
      push(content) {
        this.insert(this.length, content);
      }
      /**
       * Prepends content to this YArray.
       *
       * @param {Array<YXmlElement|YXmlText>} content Array of content to prepend.
       */
      unshift(content) {
        this.insert(0, content);
      }
      /**
       * Returns the i-th element from a YArray.
       *
       * @param {number} index The index of the element to return from the YArray
       * @return {YXmlElement|YXmlText}
       */
      get(index) {
        return typeListGet(this, index);
      }
      /**
       * Returns a portion of this YXmlFragment into a JavaScript Array selected
       * from start to end (end not included).
       *
       * @param {number} [start]
       * @param {number} [end]
       * @return {Array<YXmlElement|YXmlText>}
       */
      slice(start = 0, end = this.length) {
        return typeListSlice(this, start, end);
      }
      /**
       * Executes a provided function on once on every child element.
       *
       * @param {function(YXmlElement|YXmlText,number, typeof self):void} f A function to execute on every element of this YArray.
       */
      forEach(f) {
        typeListForEach(this, f);
      }
      /**
       * Transform the properties of this type to binary and write it to an
       * BinaryEncoder.
       *
       * This is called when this Item is sent to a remote peer.
       *
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YXmlFragmentRefID);
      }
    };
    readYXmlFragment = (_decoder) => new YXmlFragment();
    YXmlElement = class _YXmlElement extends YXmlFragment {
      constructor(nodeName = "UNDEFINED") {
        super();
        this.nodeName = nodeName;
        this._prelimAttrs = /* @__PURE__ */ new Map();
      }
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get nextSibling() {
        const n = this._item ? this._item.next : null;
        return n ? (
          /** @type {YXmlElement|YXmlText} */
          /** @type {ContentType} */
          n.content.type
        ) : null;
      }
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get prevSibling() {
        const n = this._item ? this._item.prev : null;
        return n ? (
          /** @type {YXmlElement|YXmlText} */
          /** @type {ContentType} */
          n.content.type
        ) : null;
      }
      /**
       * Integrate this type into the Yjs instance.
       *
       * * Save this struct in the os
       * * This type is sent to other client
       * * Observer functions are fired
       *
       * @param {Doc} y The Yjs instance
       * @param {Item} item
       */
      _integrate(y, item) {
        super._integrate(y, item);
        /** @type {Map<string, any>} */
        this._prelimAttrs.forEach((value, key) => {
          this.setAttribute(key, value);
        });
        this._prelimAttrs = null;
      }
      /**
       * Creates an Item with the same effect as this Item (without position effect)
       *
       * @return {YXmlElement}
       */
      _copy() {
        return new _YXmlElement(this.nodeName);
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YXmlElement<KV>}
       */
      clone() {
        const el = new _YXmlElement(this.nodeName);
        const attrs = this.getAttributes();
        forEach(attrs, (value, key) => {
          el.setAttribute(
            key,
            /** @type {any} */
            value
          );
        });
        el.insert(0, this.toArray().map((v) => v instanceof AbstractType ? v.clone() : v));
        return el;
      }
      /**
       * Returns the XML serialization of this YXmlElement.
       * The attributes are ordered by attribute-name, so you can easily use this
       * method to compare YXmlElements
       *
       * @return {string} The string representation of this type.
       *
       * @public
       */
      toString() {
        const attrs = this.getAttributes();
        const stringBuilder = [];
        const keys2 = [];
        for (const key in attrs) {
          keys2.push(key);
        }
        keys2.sort();
        const keysLen = keys2.length;
        for (let i = 0; i < keysLen; i++) {
          const key = keys2[i];
          stringBuilder.push(key + '="' + attrs[key] + '"');
        }
        const nodeName = this.nodeName.toLocaleLowerCase();
        const attrsString = stringBuilder.length > 0 ? " " + stringBuilder.join(" ") : "";
        return `<${nodeName}${attrsString}>${super.toString()}</${nodeName}>`;
      }
      /**
       * Removes an attribute from this YXmlElement.
       *
       * @param {string} attributeName The attribute name that is to be removed.
       *
       * @public
       */
      removeAttribute(attributeName) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapDelete(transaction, this, attributeName);
          });
        } else {
          this._prelimAttrs.delete(attributeName);
        }
      }
      /**
       * Sets or updates an attribute.
       *
       * @template {keyof KV & string} KEY
       *
       * @param {KEY} attributeName The attribute name that is to be set.
       * @param {KV[KEY]} attributeValue The attribute value that is to be set.
       *
       * @public
       */
      setAttribute(attributeName, attributeValue) {
        if (this.doc !== null) {
          transact(this.doc, (transaction) => {
            typeMapSet(transaction, this, attributeName, attributeValue);
          });
        } else {
          this._prelimAttrs.set(attributeName, attributeValue);
        }
      }
      /**
       * Returns an attribute value that belongs to the attribute name.
       *
       * @template {keyof KV & string} KEY
       *
       * @param {KEY} attributeName The attribute name that identifies the
       *                               queried value.
       * @return {KV[KEY]|undefined} The queried attribute value.
       *
       * @public
       */
      getAttribute(attributeName) {
        return (
          /** @type {any} */
          typeMapGet(this, attributeName)
        );
      }
      /**
       * Returns whether an attribute exists
       *
       * @param {string} attributeName The attribute name to check for existence.
       * @return {boolean} whether the attribute exists.
       *
       * @public
       */
      hasAttribute(attributeName) {
        return (
          /** @type {any} */
          typeMapHas(this, attributeName)
        );
      }
      /**
       * Returns all attribute name/value pairs in a JSON Object.
       *
       * @param {Snapshot} [snapshot]
       * @return {{ [Key in Extract<keyof KV,string>]?: KV[Key]}} A JSON Object that describes the attributes.
       *
       * @public
       */
      getAttributes(snapshot) {
        return (
          /** @type {any} */
          snapshot ? typeMapGetAllSnapshot(this, snapshot) : typeMapGetAll(this)
        );
      }
      /**
       * Creates a Dom Element that mirrors this YXmlElement.
       *
       * @param {Document} [_document=document] The document object (you must define
       *                                        this when calling this method in
       *                                        nodejs)
       * @param {Object<string, any>} [hooks={}] Optional property to customize how hooks
       *                                             are presented in the DOM
       * @param {any} [binding] You should not set this property. This is
       *                               used if DomBinding wants to create a
       *                               association to the created DOM type.
       * @return {Node} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
       *
       * @public
       */
      toDOM(_document = document, hooks = {}, binding) {
        const dom = _document.createElement(this.nodeName);
        const attrs = this.getAttributes();
        for (const key in attrs) {
          const value = attrs[key];
          if (typeof value === "string") {
            dom.setAttribute(key, value);
          }
        }
        typeListForEach(this, (yxml) => {
          dom.appendChild(yxml.toDOM(_document, hooks, binding));
        });
        if (binding !== void 0) {
          binding._createAssociation(dom, this);
        }
        return dom;
      }
      /**
       * Transform the properties of this type to binary and write it to an
       * BinaryEncoder.
       *
       * This is called when this Item is sent to a remote peer.
       *
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YXmlElementRefID);
        encoder3.writeKey(this.nodeName);
      }
    };
    readYXmlElement = (decoder) => new YXmlElement(decoder.readKey());
    YXmlEvent = class extends YEvent {
      /**
       * @param {YXmlElement|YXmlText|YXmlFragment} target The target on which the event is created.
       * @param {Set<string|null>} subs The set of changed attributes. `null` is included if the
       *                   child list changed.
       * @param {Transaction} transaction The transaction instance with which the
       *                                  change was created.
       */
      constructor(target, subs, transaction) {
        super(target, transaction);
        this.childListChanged = false;
        this.attributesChanged = /* @__PURE__ */ new Set();
        subs.forEach((sub) => {
          if (sub === null) {
            this.childListChanged = true;
          } else {
            this.attributesChanged.add(sub);
          }
        });
      }
    };
    YXmlHook = class _YXmlHook extends YMap {
      /**
       * @param {string} hookName nodeName of the Dom Node.
       */
      constructor(hookName) {
        super();
        this.hookName = hookName;
      }
      /**
       * Creates an Item with the same effect as this Item (without position effect)
       */
      _copy() {
        return new _YXmlHook(this.hookName);
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YXmlHook}
       */
      clone() {
        const el = new _YXmlHook(this.hookName);
        this.forEach((value, key) => {
          el.set(key, value);
        });
        return el;
      }
      /**
       * Creates a Dom Element that mirrors this YXmlElement.
       *
       * @param {Document} [_document=document] The document object (you must define
       *                                        this when calling this method in
       *                                        nodejs)
       * @param {Object.<string, any>} [hooks] Optional property to customize how hooks
       *                                             are presented in the DOM
       * @param {any} [binding] You should not set this property. This is
       *                               used if DomBinding wants to create a
       *                               association to the created DOM type
       * @return {Element} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
       *
       * @public
       */
      toDOM(_document = document, hooks = {}, binding) {
        const hook = hooks[this.hookName];
        let dom;
        if (hook !== void 0) {
          dom = hook.createDom(this);
        } else {
          dom = document.createElement(this.hookName);
        }
        dom.setAttribute("data-yjs-hook", this.hookName);
        if (binding !== void 0) {
          binding._createAssociation(dom, this);
        }
        return dom;
      }
      /**
       * Transform the properties of this type to binary and write it to an
       * BinaryEncoder.
       *
       * This is called when this Item is sent to a remote peer.
       *
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YXmlHookRefID);
        encoder3.writeKey(this.hookName);
      }
    };
    readYXmlHook = (decoder) => new YXmlHook(decoder.readKey());
    YXmlText = class _YXmlText extends YText {
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get nextSibling() {
        const n = this._item ? this._item.next : null;
        return n ? (
          /** @type {YXmlElement|YXmlText} */
          /** @type {ContentType} */
          n.content.type
        ) : null;
      }
      /**
       * @type {YXmlElement|YXmlText|null}
       */
      get prevSibling() {
        const n = this._item ? this._item.prev : null;
        return n ? (
          /** @type {YXmlElement|YXmlText} */
          /** @type {ContentType} */
          n.content.type
        ) : null;
      }
      _copy() {
        return new _YXmlText();
      }
      /**
       * Makes a copy of this data type that can be included somewhere else.
       *
       * Note that the content is only readable _after_ it has been included somewhere in the Ydoc.
       *
       * @return {YXmlText}
       */
      clone() {
        const text = new _YXmlText();
        text.applyDelta(this.toDelta());
        return text;
      }
      /**
       * Creates a Dom Element that mirrors this YXmlText.
       *
       * @param {Document} [_document=document] The document object (you must define
       *                                        this when calling this method in
       *                                        nodejs)
       * @param {Object<string, any>} [hooks] Optional property to customize how hooks
       *                                             are presented in the DOM
       * @param {any} [binding] You should not set this property. This is
       *                               used if DomBinding wants to create a
       *                               association to the created DOM type.
       * @return {Text} The {@link https://developer.mozilla.org/en-US/docs/Web/API/Element|Dom Element}
       *
       * @public
       */
      toDOM(_document = document, hooks, binding) {
        const dom = _document.createTextNode(this.toString());
        if (binding !== void 0) {
          binding._createAssociation(dom, this);
        }
        return dom;
      }
      toString() {
        return this.toDelta().map((delta) => {
          const nestedNodes = [];
          for (const nodeName in delta.attributes) {
            const attrs = [];
            for (const key in delta.attributes[nodeName]) {
              attrs.push({ key, value: delta.attributes[nodeName][key] });
            }
            attrs.sort((a, b) => a.key < b.key ? -1 : 1);
            nestedNodes.push({ nodeName, attrs });
          }
          nestedNodes.sort((a, b) => a.nodeName < b.nodeName ? -1 : 1);
          let str2 = "";
          for (let i = 0; i < nestedNodes.length; i++) {
            const node = nestedNodes[i];
            str2 += `<${node.nodeName}`;
            for (let j = 0; j < node.attrs.length; j++) {
              const attr = node.attrs[j];
              str2 += ` ${attr.key}="${attr.value}"`;
            }
            str2 += ">";
          }
          str2 += delta.insert;
          for (let i = nestedNodes.length - 1; i >= 0; i--) {
            str2 += `</${nestedNodes[i].nodeName}>`;
          }
          return str2;
        }).join("");
      }
      /**
       * @return {string}
       */
      toJSON() {
        return this.toString();
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       */
      _write(encoder3) {
        encoder3.writeTypeRef(YXmlTextRefID);
      }
    };
    readYXmlText = (decoder) => new YXmlText();
    AbstractStruct = class {
      /**
       * @param {ID} id
       * @param {number} length
       */
      constructor(id2, length2) {
        this.id = id2;
        this.length = length2;
      }
      /**
       * @type {boolean}
       */
      get deleted() {
        throw methodUnimplemented();
      }
      /**
       * Merge this struct with the item to the right.
       * This method is already assuming that `this.id.clock + this.length === this.id.clock`.
       * Also this method does *not* remove right from StructStore!
       * @param {AbstractStruct} right
       * @return {boolean} whether this merged with right
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       * @param {number} offset
       * @param {number} encodingRef
       */
      write(encoder3, offset, encodingRef) {
        throw methodUnimplemented();
      }
      /**
       * @param {Transaction} transaction
       * @param {number} offset
       */
      integrate(transaction, offset) {
        throw methodUnimplemented();
      }
    };
    structGCRefNumber = 0;
    GC = class extends AbstractStruct {
      get deleted() {
        return true;
      }
      delete() {
      }
      /**
       * @param {GC} right
       * @return {boolean}
       */
      mergeWith(right) {
        if (this.constructor !== right.constructor) {
          return false;
        }
        this.length += right.length;
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {number} offset
       */
      integrate(transaction, offset) {
        if (offset > 0) {
          this.id.clock += offset;
          this.length -= offset;
        }
        addStruct(transaction.doc.store, this);
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeInfo(structGCRefNumber);
        encoder3.writeLen(this.length - offset);
      }
      /**
       * @param {Transaction} transaction
       * @param {StructStore} store
       * @return {null | number}
       */
      getMissing(transaction, store) {
        return null;
      }
    };
    ContentBinary = class _ContentBinary {
      /**
       * @param {Uint8Array} content
       */
      constructor(content) {
        this.content = content;
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [this.content];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentBinary}
       */
      copy() {
        return new _ContentBinary(this.content);
      }
      /**
       * @param {number} offset
       * @return {ContentBinary}
       */
      splice(offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentBinary} right
       * @return {boolean}
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeBuf(this.content);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 3;
      }
    };
    readContentBinary = (decoder) => new ContentBinary(decoder.readBuf());
    ContentDeleted = class _ContentDeleted {
      /**
       * @param {number} len
       */
      constructor(len) {
        this.len = len;
      }
      /**
       * @return {number}
       */
      getLength() {
        return this.len;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return false;
      }
      /**
       * @return {ContentDeleted}
       */
      copy() {
        return new _ContentDeleted(this.len);
      }
      /**
       * @param {number} offset
       * @return {ContentDeleted}
       */
      splice(offset) {
        const right = new _ContentDeleted(this.len - offset);
        this.len = offset;
        return right;
      }
      /**
       * @param {ContentDeleted} right
       * @return {boolean}
       */
      mergeWith(right) {
        this.len += right.len;
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
        addToDeleteSet(transaction.deleteSet, item.id.client, item.id.clock, this.len);
        item.markDeleted();
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeLen(this.len - offset);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 1;
      }
    };
    readContentDeleted = (decoder) => new ContentDeleted(decoder.readLen());
    createDocFromOpts = (guid, opts) => new Doc({ guid, ...opts, shouldLoad: opts.shouldLoad || opts.autoLoad || false });
    ContentDoc = class _ContentDoc {
      /**
       * @param {Doc} doc
       */
      constructor(doc) {
        if (doc._item) {
          console.error("This document was already integrated as a sub-document. You should create a second instance instead with the same guid.");
        }
        this.doc = doc;
        const opts = {};
        this.opts = opts;
        if (!doc.gc) {
          opts.gc = false;
        }
        if (doc.autoLoad) {
          opts.autoLoad = true;
        }
        if (doc.meta !== null) {
          opts.meta = doc.meta;
        }
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [this.doc];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentDoc}
       */
      copy() {
        return new _ContentDoc(createDocFromOpts(this.doc.guid, this.opts));
      }
      /**
       * @param {number} offset
       * @return {ContentDoc}
       */
      splice(offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentDoc} right
       * @return {boolean}
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
        this.doc._item = item;
        transaction.subdocsAdded.add(this.doc);
        if (this.doc.shouldLoad) {
          transaction.subdocsLoaded.add(this.doc);
        }
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
        if (transaction.subdocsAdded.has(this.doc)) {
          transaction.subdocsAdded.delete(this.doc);
        } else {
          transaction.subdocsRemoved.add(this.doc);
        }
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeString(this.doc.guid);
        encoder3.writeAny(this.opts);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 9;
      }
    };
    readContentDoc = (decoder) => new ContentDoc(createDocFromOpts(decoder.readString(), decoder.readAny()));
    ContentEmbed = class _ContentEmbed {
      /**
       * @param {Object} embed
       */
      constructor(embed) {
        this.embed = embed;
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [this.embed];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentEmbed}
       */
      copy() {
        return new _ContentEmbed(this.embed);
      }
      /**
       * @param {number} offset
       * @return {ContentEmbed}
       */
      splice(offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentEmbed} right
       * @return {boolean}
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeJSON(this.embed);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 5;
      }
    };
    readContentEmbed = (decoder) => new ContentEmbed(decoder.readJSON());
    ContentFormat = class _ContentFormat {
      /**
       * @param {string} key
       * @param {Object} value
       */
      constructor(key, value) {
        this.key = key;
        this.value = value;
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return false;
      }
      /**
       * @return {ContentFormat}
       */
      copy() {
        return new _ContentFormat(this.key, this.value);
      }
      /**
       * @param {number} _offset
       * @return {ContentFormat}
       */
      splice(_offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentFormat} _right
       * @return {boolean}
       */
      mergeWith(_right) {
        return false;
      }
      /**
       * @param {Transaction} _transaction
       * @param {Item} item
       */
      integrate(_transaction, item) {
        const p = (
          /** @type {YText} */
          item.parent
        );
        p._searchMarker = null;
        p._hasFormatting = true;
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeKey(this.key);
        encoder3.writeJSON(this.value);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 6;
      }
    };
    readContentFormat = (decoder) => new ContentFormat(decoder.readKey(), decoder.readJSON());
    ContentJSON = class _ContentJSON {
      /**
       * @param {Array<any>} arr
       */
      constructor(arr) {
        this.arr = arr;
      }
      /**
       * @return {number}
       */
      getLength() {
        return this.arr.length;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return this.arr;
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentJSON}
       */
      copy() {
        return new _ContentJSON(this.arr);
      }
      /**
       * @param {number} offset
       * @return {ContentJSON}
       */
      splice(offset) {
        const right = new _ContentJSON(this.arr.slice(offset));
        this.arr = this.arr.slice(0, offset);
        return right;
      }
      /**
       * @param {ContentJSON} right
       * @return {boolean}
       */
      mergeWith(right) {
        this.arr = this.arr.concat(right.arr);
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        const len = this.arr.length;
        encoder3.writeLen(len - offset);
        for (let i = offset; i < len; i++) {
          const c = this.arr[i];
          encoder3.writeString(c === void 0 ? "undefined" : JSON.stringify(c));
        }
      }
      /**
       * @return {number}
       */
      getRef() {
        return 2;
      }
    };
    readContentJSON = (decoder) => {
      const len = decoder.readLen();
      const cs = [];
      for (let i = 0; i < len; i++) {
        const c = decoder.readString();
        if (c === "undefined") {
          cs.push(void 0);
        } else {
          cs.push(JSON.parse(c));
        }
      }
      return new ContentJSON(cs);
    };
    isDevMode = getVariable("node_env") === "development";
    ContentAny = class _ContentAny {
      /**
       * @param {Array<any>} arr
       */
      constructor(arr) {
        this.arr = arr;
        isDevMode && deepFreeze(arr);
      }
      /**
       * @return {number}
       */
      getLength() {
        return this.arr.length;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return this.arr;
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentAny}
       */
      copy() {
        return new _ContentAny(this.arr);
      }
      /**
       * @param {number} offset
       * @return {ContentAny}
       */
      splice(offset) {
        const right = new _ContentAny(this.arr.slice(offset));
        this.arr = this.arr.slice(0, offset);
        return right;
      }
      /**
       * @param {ContentAny} right
       * @return {boolean}
       */
      mergeWith(right) {
        this.arr = this.arr.concat(right.arr);
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        const len = this.arr.length;
        encoder3.writeLen(len - offset);
        for (let i = offset; i < len; i++) {
          const c = this.arr[i];
          encoder3.writeAny(c);
        }
      }
      /**
       * @return {number}
       */
      getRef() {
        return 8;
      }
    };
    readContentAny = (decoder) => {
      const len = decoder.readLen();
      const cs = [];
      for (let i = 0; i < len; i++) {
        cs.push(decoder.readAny());
      }
      return new ContentAny(cs);
    };
    ContentString = class _ContentString {
      /**
       * @param {string} str
       */
      constructor(str2) {
        this.str = str2;
      }
      /**
       * @return {number}
       */
      getLength() {
        return this.str.length;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return this.str.split("");
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentString}
       */
      copy() {
        return new _ContentString(this.str);
      }
      /**
       * @param {number} offset
       * @return {ContentString}
       */
      splice(offset) {
        const right = new _ContentString(this.str.slice(offset));
        this.str = this.str.slice(0, offset);
        const firstCharCode = this.str.charCodeAt(offset - 1);
        if (firstCharCode >= 55296 && firstCharCode <= 56319) {
          this.str = this.str.slice(0, offset - 1) + "\uFFFD";
          right.str = "\uFFFD" + right.str.slice(1);
        }
        return right;
      }
      /**
       * @param {ContentString} right
       * @return {boolean}
       */
      mergeWith(right) {
        this.str += right.str;
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeString(offset === 0 ? this.str : this.str.slice(offset));
      }
      /**
       * @return {number}
       */
      getRef() {
        return 4;
      }
    };
    readContentString = (decoder) => new ContentString(decoder.readString());
    typeRefs = [
      readYArray,
      readYMap,
      readYText,
      readYXmlElement,
      readYXmlFragment,
      readYXmlHook,
      readYXmlText
    ];
    YArrayRefID = 0;
    YMapRefID = 1;
    YTextRefID = 2;
    YXmlElementRefID = 3;
    YXmlFragmentRefID = 4;
    YXmlHookRefID = 5;
    YXmlTextRefID = 6;
    ContentType = class _ContentType {
      /**
       * @param {AbstractType<any>} type
       */
      constructor(type) {
        this.type = type;
      }
      /**
       * @return {number}
       */
      getLength() {
        return 1;
      }
      /**
       * @return {Array<any>}
       */
      getContent() {
        return [this.type];
      }
      /**
       * @return {boolean}
       */
      isCountable() {
        return true;
      }
      /**
       * @return {ContentType}
       */
      copy() {
        return new _ContentType(this.type._copy());
      }
      /**
       * @param {number} offset
       * @return {ContentType}
       */
      splice(offset) {
        throw methodUnimplemented();
      }
      /**
       * @param {ContentType} right
       * @return {boolean}
       */
      mergeWith(right) {
        return false;
      }
      /**
       * @param {Transaction} transaction
       * @param {Item} item
       */
      integrate(transaction, item) {
        this.type._integrate(transaction.doc, item);
      }
      /**
       * @param {Transaction} transaction
       */
      delete(transaction) {
        let item = this.type._start;
        while (item !== null) {
          if (!item.deleted) {
            item.delete(transaction);
          } else if (item.id.clock < (transaction.beforeState.get(item.id.client) || 0)) {
            transaction._mergeStructs.push(item);
          }
          item = item.right;
        }
        this.type._map.forEach((item2) => {
          if (!item2.deleted) {
            item2.delete(transaction);
          } else if (item2.id.clock < (transaction.beforeState.get(item2.id.client) || 0)) {
            transaction._mergeStructs.push(item2);
          }
        });
        transaction.changed.delete(this.type);
      }
      /**
       * @param {StructStore} store
       */
      gc(store) {
        let item = this.type._start;
        while (item !== null) {
          item.gc(store, true);
          item = item.right;
        }
        this.type._start = null;
        this.type._map.forEach(
          /** @param {Item | null} item */
          (item2) => {
            while (item2 !== null) {
              item2.gc(store, true);
              item2 = item2.left;
            }
          }
        );
        this.type._map = /* @__PURE__ */ new Map();
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        this.type._write(encoder3);
      }
      /**
       * @return {number}
       */
      getRef() {
        return 7;
      }
    };
    readContentType = (decoder) => new ContentType(typeRefs[decoder.readTypeRef()](decoder));
    followRedone = (store, id2) => {
      let nextID = id2;
      let diff = 0;
      let item;
      do {
        if (diff > 0) {
          nextID = createID(nextID.client, nextID.clock + diff);
        }
        item = getItem(store, nextID);
        diff = nextID.clock - item.id.clock;
        nextID = item.redone;
      } while (nextID !== null && item instanceof Item);
      return {
        item,
        diff
      };
    };
    splitItem = (transaction, leftItem, diff) => {
      const { client, clock } = leftItem.id;
      const rightItem = new Item(
        createID(client, clock + diff),
        leftItem,
        createID(client, clock + diff - 1),
        leftItem.right,
        leftItem.rightOrigin,
        leftItem.parent,
        leftItem.parentSub,
        leftItem.content.splice(diff)
      );
      if (leftItem.deleted) {
        rightItem.markDeleted();
      }
      if (leftItem.keep) {
        rightItem.keep = true;
      }
      if (leftItem.redone !== null) {
        rightItem.redone = createID(leftItem.redone.client, leftItem.redone.clock + diff);
      }
      leftItem.right = rightItem;
      if (rightItem.right !== null) {
        rightItem.right.left = rightItem;
      }
      transaction._mergeStructs.push(rightItem);
      if (rightItem.parentSub !== null && rightItem.right === null) {
        rightItem.parent._map.set(rightItem.parentSub, rightItem);
      }
      leftItem.length = diff;
      return rightItem;
    };
    Item = class _Item extends AbstractStruct {
      /**
       * @param {ID} id
       * @param {Item | null} left
       * @param {ID | null} origin
       * @param {Item | null} right
       * @param {ID | null} rightOrigin
       * @param {AbstractType<any>|ID|null} parent Is a type if integrated, is null if it is possible to copy parent from left or right, is ID before integration to search for it.
       * @param {string | null} parentSub
       * @param {AbstractContent} content
       */
      constructor(id2, left, origin, right, rightOrigin, parent, parentSub, content) {
        super(id2, content.getLength());
        this.origin = origin;
        this.left = left;
        this.right = right;
        this.rightOrigin = rightOrigin;
        this.parent = parent;
        this.parentSub = parentSub;
        this.redone = null;
        this.content = content;
        this.info = this.content.isCountable() ? BIT2 : 0;
      }
      /**
       * This is used to mark the item as an indexed fast-search marker
       *
       * @type {boolean}
       */
      set marker(isMarked) {
        if ((this.info & BIT4) > 0 !== isMarked) {
          this.info ^= BIT4;
        }
      }
      get marker() {
        return (this.info & BIT4) > 0;
      }
      /**
       * If true, do not garbage collect this Item.
       */
      get keep() {
        return (this.info & BIT1) > 0;
      }
      set keep(doKeep) {
        if (this.keep !== doKeep) {
          this.info ^= BIT1;
        }
      }
      get countable() {
        return (this.info & BIT2) > 0;
      }
      /**
       * Whether this item was deleted or not.
       * @type {Boolean}
       */
      get deleted() {
        return (this.info & BIT3) > 0;
      }
      set deleted(doDelete) {
        if (this.deleted !== doDelete) {
          this.info ^= BIT3;
        }
      }
      markDeleted() {
        this.info |= BIT3;
      }
      /**
       * Return the creator clientID of the missing op or define missing items and return null.
       *
       * @param {Transaction} transaction
       * @param {StructStore} store
       * @return {null | number}
       */
      getMissing(transaction, store) {
        if (this.origin && this.origin.client !== this.id.client && this.origin.clock >= getState(store, this.origin.client)) {
          return this.origin.client;
        }
        if (this.rightOrigin && this.rightOrigin.client !== this.id.client && this.rightOrigin.clock >= getState(store, this.rightOrigin.client)) {
          return this.rightOrigin.client;
        }
        if (this.parent && this.parent.constructor === ID && this.id.client !== this.parent.client && this.parent.clock >= getState(store, this.parent.client)) {
          return this.parent.client;
        }
        if (this.origin) {
          this.left = getItemCleanEnd(transaction, store, this.origin);
          this.origin = this.left.lastId;
        }
        if (this.rightOrigin) {
          this.right = getItemCleanStart(transaction, this.rightOrigin);
          this.rightOrigin = this.right.id;
        }
        if (this.left && this.left.constructor === GC || this.right && this.right.constructor === GC) {
          this.parent = null;
        } else if (!this.parent) {
          if (this.left && this.left.constructor === _Item) {
            this.parent = this.left.parent;
            this.parentSub = this.left.parentSub;
          } else if (this.right && this.right.constructor === _Item) {
            this.parent = this.right.parent;
            this.parentSub = this.right.parentSub;
          }
        } else if (this.parent.constructor === ID) {
          const parentItem = getItem(store, this.parent);
          if (parentItem.constructor === GC) {
            this.parent = null;
          } else {
            this.parent = /** @type {ContentType} */
            parentItem.content.type;
          }
        }
        return null;
      }
      /**
       * @param {Transaction} transaction
       * @param {number} offset
       */
      integrate(transaction, offset) {
        if (offset > 0) {
          this.id.clock += offset;
          this.left = getItemCleanEnd(transaction, transaction.doc.store, createID(this.id.client, this.id.clock - 1));
          this.origin = this.left.lastId;
          this.content = this.content.splice(offset);
          this.length -= offset;
        }
        if (this.parent) {
          if (!this.left && (!this.right || this.right.left !== null) || this.left && this.left.right !== this.right) {
            let left = this.left;
            let o;
            if (left !== null) {
              o = left.right;
            } else if (this.parentSub !== null) {
              o = /** @type {AbstractType<any>} */
              this.parent._map.get(this.parentSub) || null;
              while (o !== null && o.left !== null) {
                o = o.left;
              }
            } else {
              o = /** @type {AbstractType<any>} */
              this.parent._start;
            }
            const conflictingItems = /* @__PURE__ */ new Set();
            const itemsBeforeOrigin = /* @__PURE__ */ new Set();
            while (o !== null && o !== this.right) {
              itemsBeforeOrigin.add(o);
              conflictingItems.add(o);
              if (compareIDs(this.origin, o.origin)) {
                if (o.id.client < this.id.client) {
                  left = o;
                  conflictingItems.clear();
                } else if (compareIDs(this.rightOrigin, o.rightOrigin)) {
                  break;
                }
              } else if (o.origin !== null && itemsBeforeOrigin.has(getItem(transaction.doc.store, o.origin))) {
                if (!conflictingItems.has(getItem(transaction.doc.store, o.origin))) {
                  left = o;
                  conflictingItems.clear();
                }
              } else {
                break;
              }
              o = o.right;
            }
            this.left = left;
          }
          if (this.left !== null) {
            const right = this.left.right;
            this.right = right;
            this.left.right = this;
          } else {
            let r;
            if (this.parentSub !== null) {
              r = /** @type {AbstractType<any>} */
              this.parent._map.get(this.parentSub) || null;
              while (r !== null && r.left !== null) {
                r = r.left;
              }
            } else {
              r = /** @type {AbstractType<any>} */
              this.parent._start;
              this.parent._start = this;
            }
            this.right = r;
          }
          if (this.right !== null) {
            this.right.left = this;
          } else if (this.parentSub !== null) {
            this.parent._map.set(this.parentSub, this);
            if (this.left !== null) {
              this.left.delete(transaction);
            }
          }
          if (this.parentSub === null && this.countable && !this.deleted) {
            this.parent._length += this.length;
          }
          addStruct(transaction.doc.store, this);
          this.content.integrate(transaction, this);
          addChangedTypeToTransaction(
            transaction,
            /** @type {AbstractType<any>} */
            this.parent,
            this.parentSub
          );
          if (
            /** @type {AbstractType<any>} */
            this.parent._item !== null && /** @type {AbstractType<any>} */
            this.parent._item.deleted || this.parentSub !== null && this.right !== null
          ) {
            this.delete(transaction);
          }
        } else {
          new GC(this.id, this.length).integrate(transaction, 0);
        }
      }
      /**
       * Returns the next non-deleted item
       */
      get next() {
        let n = this.right;
        while (n !== null && n.deleted) {
          n = n.right;
        }
        return n;
      }
      /**
       * Returns the previous non-deleted item
       */
      get prev() {
        let n = this.left;
        while (n !== null && n.deleted) {
          n = n.left;
        }
        return n;
      }
      /**
       * Computes the last content address of this Item.
       */
      get lastId() {
        return this.length === 1 ? this.id : createID(this.id.client, this.id.clock + this.length - 1);
      }
      /**
       * Try to merge two items
       *
       * @param {Item} right
       * @return {boolean}
       */
      mergeWith(right) {
        if (this.constructor === right.constructor && compareIDs(right.origin, this.lastId) && this.right === right && compareIDs(this.rightOrigin, right.rightOrigin) && this.id.client === right.id.client && this.id.clock + this.length === right.id.clock && this.deleted === right.deleted && this.redone === null && right.redone === null && this.content.constructor === right.content.constructor && this.content.mergeWith(right.content)) {
          const searchMarker = (
            /** @type {AbstractType<any>} */
            this.parent._searchMarker
          );
          if (searchMarker) {
            searchMarker.forEach((marker) => {
              if (marker.p === right) {
                marker.p = this;
                if (!this.deleted && this.countable) {
                  marker.index -= this.length;
                }
              }
            });
          }
          if (right.keep) {
            this.keep = true;
          }
          this.right = right.right;
          if (this.right !== null) {
            this.right.left = this;
          }
          this.length += right.length;
          return true;
        }
        return false;
      }
      /**
       * Mark this Item as deleted.
       *
       * @param {Transaction} transaction
       */
      delete(transaction) {
        if (!this.deleted) {
          const parent = (
            /** @type {AbstractType<any>} */
            this.parent
          );
          if (this.countable && this.parentSub === null) {
            parent._length -= this.length;
          }
          this.markDeleted();
          addToDeleteSet(transaction.deleteSet, this.id.client, this.id.clock, this.length);
          addChangedTypeToTransaction(transaction, parent, this.parentSub);
          this.content.delete(transaction);
        }
      }
      /**
       * @param {StructStore} store
       * @param {boolean} parentGCd
       */
      gc(store, parentGCd) {
        if (!this.deleted) {
          throw unexpectedCase();
        }
        this.content.gc(store);
        if (parentGCd) {
          replaceStruct(store, this, new GC(this.id, this.length));
        } else {
          this.content = new ContentDeleted(this.length);
        }
      }
      /**
       * Transform the properties of this type to binary and write it to an
       * BinaryEncoder.
       *
       * This is called when this Item is sent to a remote peer.
       *
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder The encoder to write data to.
       * @param {number} offset
       */
      write(encoder3, offset) {
        const origin = offset > 0 ? createID(this.id.client, this.id.clock + offset - 1) : this.origin;
        const rightOrigin = this.rightOrigin;
        const parentSub = this.parentSub;
        const info = this.content.getRef() & BITS5 | (origin === null ? 0 : BIT8) | // origin is defined
        (rightOrigin === null ? 0 : BIT7) | // right origin is defined
        (parentSub === null ? 0 : BIT6);
        encoder3.writeInfo(info);
        if (origin !== null) {
          encoder3.writeLeftID(origin);
        }
        if (rightOrigin !== null) {
          encoder3.writeRightID(rightOrigin);
        }
        if (origin === null && rightOrigin === null) {
          const parent = (
            /** @type {AbstractType<any>} */
            this.parent
          );
          if (parent._item !== void 0) {
            const parentItem = parent._item;
            if (parentItem === null) {
              const ykey = findRootTypeKey(parent);
              encoder3.writeParentInfo(true);
              encoder3.writeString(ykey);
            } else {
              encoder3.writeParentInfo(false);
              encoder3.writeLeftID(parentItem.id);
            }
          } else if (parent.constructor === String) {
            encoder3.writeParentInfo(true);
            encoder3.writeString(parent);
          } else if (parent.constructor === ID) {
            encoder3.writeParentInfo(false);
            encoder3.writeLeftID(parent);
          } else {
            unexpectedCase();
          }
          if (parentSub !== null) {
            encoder3.writeString(parentSub);
          }
        }
        this.content.write(encoder3, offset);
      }
    };
    readItemContent = (decoder, info) => contentRefs[info & BITS5](decoder);
    contentRefs = [
      () => {
        unexpectedCase();
      },
      // GC is not ItemContent
      readContentDeleted,
      // 1
      readContentJSON,
      // 2
      readContentBinary,
      // 3
      readContentString,
      // 4
      readContentEmbed,
      // 5
      readContentFormat,
      // 6
      readContentType,
      // 7
      readContentAny,
      // 8
      readContentDoc,
      // 9
      () => {
        unexpectedCase();
      }
      // 10 - Skip is not ItemContent
    ];
    structSkipRefNumber = 10;
    Skip = class extends AbstractStruct {
      get deleted() {
        return true;
      }
      delete() {
      }
      /**
       * @param {Skip} right
       * @return {boolean}
       */
      mergeWith(right) {
        if (this.constructor !== right.constructor) {
          return false;
        }
        this.length += right.length;
        return true;
      }
      /**
       * @param {Transaction} transaction
       * @param {number} offset
       */
      integrate(transaction, offset) {
        unexpectedCase();
      }
      /**
       * @param {UpdateEncoderV1 | UpdateEncoderV2} encoder
       * @param {number} offset
       */
      write(encoder3, offset) {
        encoder3.writeInfo(structSkipRefNumber);
        writeVarUint(encoder3.restEncoder, this.length - offset);
      }
      /**
       * @param {Transaction} transaction
       * @param {StructStore} store
       * @return {null | number}
       */
      getMissing(transaction, store) {
        return null;
      }
    };
    glo = /** @type {any} */
    typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {};
    importIdentifier = "__ $YJS$ __";
    if (glo[importIdentifier] === true) {
      console.error("Yjs was already imported. This breaks constructor checks and will lead to issues! - https://github.com/yjs/yjs/issues/438");
    }
    glo[importIdentifier] = true;
  }
});

// packages/shared/src/types.ts
var init_types = __esm({
  "packages/shared/src/types.ts"() {
    "use strict";
  }
});

// packages/shared/src/identity.ts
function isAgentic(kind) {
  return kind !== void 0 && kind !== "human";
}
function displayName(id2) {
  const owner = "owner" in id2 ? id2.owner : void 0;
  const label = "label" in id2 ? id2.label : void 0;
  switch (id2.kind) {
    case "agent":
      return id2.name.includes("+") ? id2.name : `${owner ?? id2.name}'s agent`;
    case "bot":
      return `${label ?? id2.name} [bot]`;
    case "ci":
      return `${label ?? id2.name} [ci]`;
    default:
      return id2.name;
  }
}
function newId(prefix = "") {
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${r}`;
}
var PALETTE;
var init_identity = __esm({
  "packages/shared/src/identity.ts"() {
    "use strict";
    PALETTE = ["#2e86de", "#c9761a", "#6d4fc2", "#27ae60", "#c0392b", "#b5179e", "#0f8b8d", "#8d6e63"];
  }
});

// packages/shared/src/bus-index.ts
var empty, BusIndex;
var init_bus_index = __esm({
  "packages/shared/src/bus-index.ts"() {
    "use strict";
    init_yjs();
    init_messages();
    empty = () => ({ entries: /* @__PURE__ */ new Map(), ids: /* @__PURE__ */ new Map(), changed: /* @__PURE__ */ new Set(), sizes: /* @__PURE__ */ new Map(), bad: /* @__PURE__ */ new Set(), bytes: 0, invalid: 0, addressedCount: 0, addressedBytes: 0 });
    BusIndex = class {
      constructor(bus, onChange = () => {
      }) {
        this.bus = bus;
        this.onChange = onChange;
        this.rebuild();
        bus.observe(this.observe);
        bus.doc?.on("destroy", () => bus.unobserve(this.observe));
      }
      bus;
      onChange;
      state = empty();
      get entries() {
        return this.state.entries;
      }
      get ids() {
        return this.state.ids;
      }
      get changed() {
        return this.state.changed;
      }
      get bytes() {
        return this.state.bytes;
      }
      get invalid() {
        return this.state.invalid;
      }
      // Upper bound on bus values trim might move to mail; broadcasts can never move.
      get addressedCount() {
        return this.state.addressedCount;
      }
      get addressedBytes() {
        return this.state.addressedBytes;
      }
      stale = true;
      touched = /* @__PURE__ */ new Set();
      /** Changed values inspected; instrumentation for deterministic scaling tests. */
      visits = 0;
      encoder = new TextEncoder();
      observe = (_event, tx) => {
        this.touched = /* @__PURE__ */ new Set();
        if (this.stale) {
          this.rebuild();
          this.onChange(this.touched, true);
          return;
        }
        try {
          iterateDeletedStructs(tx, tx.deleteSet, (struct) => {
            if (!(struct instanceof Item) || struct.parent !== this.bus || struct.parentSub !== null) return;
            for (let i = 0; i < struct.length; i++) this.remove(`${struct.id.client}:${struct.id.clock + i}`);
          });
          for (const [client, end] of tx.afterState) {
            const start = tx.beforeState.get(client) ?? 0;
            if (start === end) continue;
            const structs = tx.doc.store.clients.get(client);
            if (!structs) throw new Error("missing client range");
            for (let i = findIndexSS(structs, start); i < structs.length; i++) {
              const struct = structs[i];
              if (struct.id.clock >= end) break;
              if (!(struct instanceof Item) || struct.parent !== this.bus || struct.parentSub !== null || struct.deleted) continue;
              const values = struct.content.getContent();
              for (let offset = Math.max(0, start - struct.id.clock); offset < values.length; offset++)
                this.add(`${client}:${struct.id.clock + offset}`, values[offset]);
            }
          }
          this.onChange(this.touched);
        } catch {
          this.rebuild();
          this.onChange(this.touched, true);
        }
      };
      add(key, m, state = this.state) {
        this.visits++;
        if (state.entries.has(key)) return;
        let size2, bad = !validMessageShape(m);
        try {
          size2 = this.encoder.encode(JSON.stringify(m) ?? "null").length;
        } catch {
          size2 = 2 ** 32;
          bad = true;
        }
        state.entries.set(key, m);
        if (bad) {
          state.bad.add(key);
          state.invalid++;
        }
        state.sizes.set(key, size2);
        state.bytes += size2;
        if (validMessageShape(m) && m.to) {
          state.addressedCount++;
          state.addressedBytes += size2;
        }
        const id2 = m?.id;
        if (typeof id2 !== "string") return;
        let values = state.ids.get(id2);
        if (!values) state.ids.set(id2, values = /* @__PURE__ */ new Map());
        values.set(key, m);
        state.changed.add(id2);
        this.touched.add(id2);
      }
      remove(key) {
        this.visits++;
        if (!this.entries.has(key)) return;
        const m = this.entries.get(key);
        this.entries.delete(key);
        if (this.state.bad.delete(key)) this.state.invalid--;
        const size2 = this.state.sizes.get(key) ?? 0;
        this.state.bytes -= size2;
        this.state.sizes.delete(key);
        if (validMessageShape(m) && m.to) {
          this.state.addressedCount--;
          this.state.addressedBytes -= size2;
        }
        const id2 = m?.id;
        if (typeof id2 !== "string") return;
        const values = this.ids.get(id2);
        values?.delete(key);
        if (!values?.size) {
          this.ids.delete(id2);
          this.changed.delete(id2);
        } else this.changed.add(id2);
        this.touched.add(id2);
      }
      recompute() {
        const next = empty();
        for (const structs of this.bus.doc.store.clients.values()) for (const struct of structs) {
          if (!(struct instanceof Item) || struct.parent !== this.bus || struct.parentSub !== null || struct.deleted) continue;
          const values = struct.content.getContent();
          values.forEach((m, i) => this.add(`${struct.id.client}:${struct.id.clock + i}`, m, next));
        }
        return next;
      }
      rebuild() {
        this.stale = true;
        try {
          this.state = this.recompute();
          this.stale = false;
        } catch {
        }
      }
      /** Independent full recompute, only for minute maintenance/debug. */
      drift() {
        if (this.stale) return "bus.stale";
        const next = this.recompute();
        if (next.bytes !== this.bytes) return "bus.bytes";
        if (next.invalid !== this.invalid || next.bad.size !== this.state.bad.size || [...next.bad].some((key) => !this.state.bad.has(key))) return "bus.invalid";
        if (next.addressedCount !== this.addressedCount || next.addressedBytes !== this.addressedBytes) return "bus.addressed";
        if (next.entries.size !== this.entries.size || [...next.entries].some(([key, m]) => this.entries.get(key) !== m)) return "bus.entries";
        if (next.ids.size !== this.ids.size || [...next.ids].some(([id2, values]) => {
          const old = this.ids.get(id2);
          return old?.size !== values.size || [...values].some(([key, m]) => old.get(key) !== m);
        })) return "bus.ids";
        if (next.sizes.size !== this.state.sizes.size || [...next.sizes].some(([key, size2]) => this.state.sizes.get(key) !== size2)) return "bus.sizes";
        return void 0;
      }
      count(id2) {
        return this.ids.get(id2)?.size ?? 0;
      }
      first(id2) {
        if (this.stale) return this.bus.toArray().find((m) => m?.id === id2);
        const values = this.ids.get(id2);
        return values?.size === 1 ? values.values().next().value : values?.size ? this.bus.toArray().find((m) => m?.id === id2) : void 0;
      }
    };
  }
});

// packages/shared/src/ledger.ts
function compactRetiredWorker(record) {
  const files2 = [...new Set(record.files)];
  return {
    ...record,
    task: record.task.slice(0, 200),
    summary: record.summary.slice(0, 400),
    files: files2.slice(0, 50),
    fileCount: Math.max(record.fileCount, files2.length)
  };
}
function msgPaths(m) {
  if ("paths" in m) return Array.isArray(m.paths) ? m.paths.filter((p) => typeof p === "string") : [];
  if ("path" in m) return typeof m.path === "string" ? [m.path] : [];
  return [];
}
function scopeCovers(scope, path12) {
  return Array.isArray(scope?.paths) && scope.paths.some((p) => typeof p === "string" && containsPath(p, path12));
}
function ledger(messages, scopes, q = {}) {
  const areaScopes = q.area ? scopes.filter((s) => s.area === q.area) : [];
  const out = [];
  for (const m of messages) {
    if (!validMessageShape(m)) continue;
    if (!LEDGER_TYPES.has(m.type)) continue;
    if (q.since && m.at < q.since) continue;
    const paths = msgPaths(m);
    if (q.path && !paths.includes(q.path)) continue;
    if (q.area) {
      const inArea = m.type === "scope" && m.area === q.area || paths.some((p) => areaScopes.some((s) => scopeCovers(s, p)));
      if (!inArea) continue;
    }
    out.push(m);
  }
  return q.limit ? out.slice(-q.limit) : out;
}
function areaSummary(messages, scopes, windowMs = 10 * 60 * 1e3, now = Date.now()) {
  const areas = Array.from(new Set(scopes.map((s) => s.area))).sort();
  return areas.map((area) => {
    const recent = ledger(messages, scopes, { area, since: now - windowMs }).filter((m) => m.type === "changed");
    const who2 = Array.from(new Set(recent.map((m) => m.from)));
    const owners = scopes.filter((s) => s.area === area).map((s) => s.by);
    return `${area} (${owners.join(", ")}): ${recent.length} change${recent.length === 1 ? "" : "s"} in the last ${Math.round(windowMs / 6e4)} min${who2.length ? ` by ${who2.join(", ")}` : ""}`;
  });
}
var MAX_RETIRED_WORKERS, LEDGER_TYPES;
var init_ledger = __esm({
  "packages/shared/src/ledger.ts"() {
    "use strict";
    init_near();
    init_messages();
    MAX_RETIRED_WORKERS = 200;
    LEDGER_TYPES = /* @__PURE__ */ new Set(["scope", "claim", "changed", "release", "conflict", "base", "plan"]);
  }
});

// packages/shared/src/delivery.ts
function isOwed(doc, m) {
  return !!m.to && !selfSent(m) && !doc.outcomes.has(m.id) && !receipted(doc, m.to, m.id);
}
function deliveryIndex(doc) {
  let index = indexes.get(doc.doc);
  if (!index) {
    index = new DeliveryIndex(doc);
    indexes.set(doc.doc, index);
  }
  return index;
}
var KiB, MiB, DAY_MS, BUS_KEEP, BUS_BYTES, MAIL_MAX, MAIL_BYTES, OWED_PER_RECIPIENT, OWED_BYTES_PER_RECIPIENT, ARCHIVE_BYTES, OUTCOMES_MAX, OUTCOMES_BYTES, OUTCOMES_TTL_MS, RECEIPTS_BYTES, LEDGER_BUDGET, REPLY_WINDOW_MS, OWED_TTL_MS, MAX_MESSAGE_BYTES, encoder, sizeOf, validOutcome, selfSent, receipted, DeliveryIndex, indexes;
var init_delivery = __esm({
  "packages/shared/src/delivery.ts"() {
    "use strict";
    init_yjs();
    init_bus_index();
    init_ledger();
    init_messages();
    KiB = 1024;
    MiB = 1024 * KiB;
    DAY_MS = 24 * 60 * 60 * 1e3;
    BUS_KEEP = 2e3;
    BUS_BYTES = 1.5 * MiB;
    MAIL_MAX = 2e3;
    MAIL_BYTES = 1.5 * MiB;
    OWED_PER_RECIPIENT = 200;
    OWED_BYTES_PER_RECIPIENT = 256 * KiB;
    ARCHIVE_BYTES = 512 * KiB;
    OUTCOMES_MAX = 2e3;
    OUTCOMES_BYTES = 256 * KiB;
    OUTCOMES_TTL_MS = 30 * DAY_MS;
    RECEIPTS_BYTES = 256 * KiB;
    LEDGER_BUDGET = BUS_BYTES + MAIL_BYTES + ARCHIVE_BYTES + OUTCOMES_BYTES + RECEIPTS_BYTES;
    REPLY_WINDOW_MS = 14 * DAY_MS;
    OWED_TTL_MS = 14 * DAY_MS;
    MAX_MESSAGE_BYTES = 64 * KiB;
    encoder = new TextEncoder();
    sizeOf = (value) => {
      try {
        return encoder.encode(JSON.stringify(value)).length;
      } catch {
        return 2 ** 32;
      }
    };
    validOutcome = (o) => !!o && Number.isFinite(o.at) && typeof o.to === "string" && typeof o.from === "string" && ["expired", "over-cap", "recipient-retired"].includes(o.outcome);
    selfSent = (m) => m.from === m.to && m.fromKind !== "human";
    receipted = (doc, name, id2) => doc.seen(name).has(id2);
    DeliveryIndex = class {
      constructor(doc) {
        this.doc = doc;
        this.bus = new BusIndex(doc.bus, (ids, rebuilt) => {
          this.clean = false;
          if (rebuilt) this.rebuildPending = true;
          else for (const id2 of ids) this.changed.add(id2);
        });
        doc.mail.observe((e) => {
          for (const key of e.keysChanged) {
            const oldId = this.mailIds.get(key);
            this.checkMail(key);
            if (oldId !== void 0) this.changed.add(oldId);
            const id2 = this.mailIds.get(key);
            if (id2 !== void 0) this.changed.add(id2);
          }
        });
        doc.outcomes.observe((e) => {
          for (const id2 of e.keysChanged) {
            this.checkOutcome(id2);
            this.changed.add(id2);
          }
        });
        doc.archive.observe((e) => {
          for (const id2 of e.keysChanged) if (this.bus.count(id2)) this.bus.changed.add(id2);
        });
        this.rebuildAggregates();
        this.cacheRoots();
        doc.doc.on("afterTransaction", this.afterTransaction);
        doc.doc.on("destroy", () => doc.doc.off("afterTransaction", this.afterTransaction));
      }
      doc;
      bus;
      recipients = /* @__PURE__ */ new Map();
      pending = /* @__PURE__ */ new Map();
      owedBytes = 0;
      sizes = /* @__PURE__ */ new Map();
      badMail = /* @__PURE__ */ new Set();
      badOutcomes = /* @__PURE__ */ new Set();
      outcomeSizes = /* @__PURE__ */ new Map();
      outcomeBytes = 0;
      mailSizes = /* @__PURE__ */ new Map();
      mailBytes = 0;
      aliases = /* @__PURE__ */ new Set();
      duplicateBus = /* @__PURE__ */ new Set();
      overCapRecipients = /* @__PURE__ */ new Set();
      mailCopies = /* @__PURE__ */ new Map();
      mailIds = /* @__PURE__ */ new Map();
      clean = false;
      cleanKeep = BUS_KEEP;
      cleanBytes = BUS_BYTES;
      oldest = Infinity;
      oldestOutcome = Infinity;
      changed = /* @__PURE__ */ new Set();
      rebuildPending = false;
      rootNames = /* @__PURE__ */ new Map();
      afterTransaction = (tx) => {
        let unknown = false;
        for (const type of tx.changed.keys()) if (type.parent === null && !this.rootNames.has(type)) {
          unknown = true;
          break;
        }
        if (unknown) this.cacheRoots();
        for (const [type, keys2] of tx.changed) {
          if (!(type instanceof YMap) || !this.rootNames.get(type)?.startsWith("seen:")) continue;
          for (const key of keys2) if (key !== null) this.changed.add(key);
        }
        const changed = this.changed;
        this.changed = /* @__PURE__ */ new Set();
        if (this.rebuildPending) {
          this.rebuildPending = false;
          this.rebuildAggregates();
        } else this.refreshMany(changed);
      };
      cacheRoots() {
        for (const [name, type] of this.doc.doc.share) this.rootNames.set(type, name);
      }
      checkMail(key) {
        const old = this.mailIds.get(key);
        if (old !== void 0) {
          const copies = this.mailCopies.get(old);
          copies?.delete(key);
          if (!copies?.size) this.mailCopies.delete(old);
        }
        this.mailIds.delete(key);
        this.aliases.delete(key);
        this.mailBytes -= this.mailSizes.get(key) ?? 0;
        this.mailSizes.delete(key);
        const m = this.doc.mail.get(key);
        if (this.doc.mail.has(key) && !validMessageShape(m)) this.badMail.add(key);
        else this.badMail.delete(key);
        if (validMessageShape(m)) {
          let copies = this.mailCopies.get(m.id);
          if (!copies) this.mailCopies.set(m.id, copies = /* @__PURE__ */ new Map());
          copies.set(key, m);
          this.mailIds.set(key, m.id);
          if (key !== m.id) this.aliases.add(key);
          const size2 = sizeOf(m);
          this.mailSizes.set(key, size2);
          this.mailBytes += size2;
        }
      }
      checkOutcome(id2) {
        this.outcomeBytes -= this.outcomeSizes.get(id2) ?? 0;
        this.outcomeSizes.delete(id2);
        const o = this.doc.outcomes.get(id2);
        if (this.doc.outcomes.has(id2) && !validOutcome(o)) this.badOutcomes.add(id2);
        else this.badOutcomes.delete(id2);
        if (o && !this.badOutcomes.has(id2)) {
          const size2 = id2.length + sizeOf(o);
          this.outcomeSizes.set(id2, size2);
          this.outcomeBytes += size2;
          this.oldestOutcome = Math.min(this.oldestOutcome, o.at);
        }
        if (this.bus.count(id2)) this.bus.changed.add(id2);
      }
      refreshMany(ids) {
        const ordered = /* @__PURE__ */ new Map();
        for (const id2 of ids) if (this.bus.count(id2) + (this.mailCopies.get(id2)?.size ?? 0) > 1) ordered.set(id2, []);
        if (ordered.size) {
          for (const m of this.doc.mail.values()) if (validMessageShape(m)) ordered.get(m.id)?.push(m);
          for (const m of this.doc.bus.toArray()) if (validMessageShape(m)) ordered.get(m.id)?.push(m);
        }
        for (const id2 of ids) this.refresh(id2, ordered.get(id2));
      }
      refresh(id2, ordered) {
        const prior = this.pending.get(id2);
        if (prior) {
          const size2 = this.sizes.get(id2);
          const count = this.recipients.get(prior.to);
          count.count--;
          count.bytes -= size2;
          this.owedBytes -= size2;
          if (!count.count) this.recipients.delete(prior.to);
          this.checkRecipient(prior.to);
          this.pending.delete(id2);
          this.sizes.delete(id2);
        }
        const mail = this.mailCopies.get(id2);
        const bus = this.bus.ids.get(id2);
        const candidates = ordered ?? [...mail?.values() ?? [], ...bus?.values() ?? []];
        if ((bus?.size ?? 0) > 1) this.duplicateBus.add(id2);
        else this.duplicateBus.delete(id2);
        const m = candidates.find((m2) => validMessageShape(m2) && isOwed(this.doc, m2));
        if (m) {
          const size2 = sizeOf(m);
          const count = this.recipients.get(m.to) ?? { count: 0, bytes: 0 };
          count.count++;
          count.bytes += size2;
          this.owedBytes += size2;
          this.recipients.set(m.to, count);
          this.pending.set(id2, m);
          this.sizes.set(id2, size2);
          this.checkRecipient(m.to);
          if (Number.isFinite(m.at)) this.oldest = Math.min(this.oldest, m.at);
        }
        if (prior || m || candidates.some((m2) => validMessageShape(m2) && (m2.to || "inReplyTo" in m2 && m2.inReplyTo))) this.clean = false;
      }
      checkRecipient(name) {
        const r = this.recipients.get(name);
        if (r && (r.count > OWED_PER_RECIPIENT || r.bytes > OWED_BYTES_PER_RECIPIENT)) this.overCapRecipients.add(name);
        else this.overCapRecipients.delete(name);
      }
      /** Debug/recovery check: callers can snapshot aggregates, rebuild, then compare to full recompute. */
      rebuild() {
        this.bus.rebuild();
        this.rebuildAggregates();
      }
      /** Minute-only full recompute; correct any drift before the next post can use it. */
      verify() {
        let field = this.bus.drift();
        const pending2 = /* @__PURE__ */ new Map(), sizes = /* @__PURE__ */ new Map(), recipients = /* @__PURE__ */ new Map();
        const mailIds = /* @__PURE__ */ new Map(), mailSizes = /* @__PURE__ */ new Map(), outcomeSizes = /* @__PURE__ */ new Map();
        const badMail = /* @__PURE__ */ new Set(), badOutcomes = /* @__PURE__ */ new Set(), aliases = /* @__PURE__ */ new Set(), duplicateBus = /* @__PURE__ */ new Set();
        const busCounts = /* @__PURE__ */ new Map();
        for (const m of this.doc.messages()) if (typeof m?.id === "string") busCounts.set(m.id, (busCounts.get(m.id) ?? 0) + 1);
        for (const [id2, count] of busCounts) if (count > 1) duplicateBus.add(id2);
        let owedBytes = 0, mailBytes = 0, outcomeBytes = 0, oldest = Infinity, oldestOutcome = Infinity;
        for (const [key, m] of this.doc.mail) {
          if (!validMessageShape(m)) {
            badMail.add(key);
            continue;
          }
          mailIds.set(key, m.id);
          const size2 = sizeOf(m);
          mailSizes.set(key, size2);
          mailBytes += size2;
          if (key !== m.id) aliases.add(key);
        }
        for (const m of [...this.doc.mail.values(), ...this.doc.messages()]) {
          if (!validMessageShape(m)) continue;
          if (!pending2.has(m.id) && isOwed(this.doc, m)) {
            pending2.set(m.id, m);
            const size2 = sizeOf(m), r = recipients.get(m.to) ?? { count: 0, bytes: 0 };
            r.count++;
            r.bytes += size2;
            recipients.set(m.to, r);
            owedBytes += size2;
            sizes.set(m.id, size2);
            if (Number.isFinite(m.at)) oldest = Math.min(oldest, m.at);
          }
        }
        for (const [id2, o] of this.doc.outcomes) {
          if (!validOutcome(o)) {
            badOutcomes.add(id2);
            continue;
          }
          const size2 = id2.length + sizeOf(o);
          outcomeSizes.set(id2, size2);
          outcomeBytes += size2;
          oldestOutcome = Math.min(oldestOutcome, o.at);
        }
        const sameMap = (a, b) => a.size === b.size && [...a].every(([id2, value]) => b.get(id2) === value);
        const sameSet = (a, b) => a.size === b.size && [...a].every((id2) => b.has(id2));
        const overCap = new Set([...recipients].filter(([, r]) => r.count > OWED_PER_RECIPIENT || r.bytes > OWED_BYTES_PER_RECIPIENT).map(([name]) => name));
        if (!field && owedBytes !== this.owedBytes) field = "owedBytes";
        if (!field && (!sameMap(pending2, this.pending) || !sameMap(sizes, this.sizes))) field = "pending";
        if (!field && (recipients.size !== this.recipients.size || [...recipients].some(([name, r]) => {
          const old = this.recipients.get(name);
          return r.count !== old?.count || r.bytes !== old.bytes;
        }))) field = "recipients";
        if (!field && (!sameMap(mailIds, this.mailIds) || !sameMap(mailSizes, this.mailSizes) || mailBytes !== this.mailBytes || this.mailCopies.size !== new Set(mailIds.values()).size || [...mailIds].some(([key, id2]) => this.mailCopies.get(id2)?.get(key) !== this.doc.mail.get(key)) || [...this.mailCopies.values()].reduce((n, copies) => n + copies.size, 0) !== mailIds.size)) field = "mail";
        if (!field && (!sameMap(outcomeSizes, this.outcomeSizes) || outcomeBytes !== this.outcomeBytes)) field = "outcomes";
        if (!field && (!sameSet(badMail, this.badMail) || !sameSet(badOutcomes, this.badOutcomes))) field = "invalid";
        if (!field && (!sameSet(aliases, this.aliases) || !sameSet(duplicateBus, this.duplicateBus) || !sameSet(overCap, this.overCapRecipients))) field = "certainty";
        if (!field && (oldest !== this.oldest || oldestOutcome !== this.oldestOutcome)) field = "oldest";
        if (field) this.rebuild();
        return field;
      }
      rebuildAggregates() {
        this.pending.clear();
        this.recipients.clear();
        this.sizes.clear();
        this.badMail.clear();
        this.badOutcomes.clear();
        this.mailCopies.clear();
        this.mailIds.clear();
        this.owedBytes = 0;
        this.outcomeSizes.clear();
        this.outcomeBytes = 0;
        this.mailSizes.clear();
        this.mailBytes = 0;
        this.aliases.clear();
        this.duplicateBus.clear();
        this.overCapRecipients.clear();
        this.oldest = this.oldestOutcome = Infinity;
        this.clean = false;
        for (const id2 of this.doc.mail.keys()) this.checkMail(id2);
        for (const id2 of this.doc.outcomes.keys()) this.checkOutcome(id2);
        this.refreshMany(/* @__PURE__ */ new Set([...this.bus.ids.keys(), ...this.mailCopies.keys()]));
      }
      markTrimmed(now, opts) {
        this.cleanKeep = opts.busKeep ?? BUS_KEEP;
        this.cleanBytes = opts.busBytes ?? BUS_BYTES;
        this.oldest = Math.min(Infinity, ...[...this.pending.values()].filter((m) => Number.isFinite(m.at)).map((m) => m.at));
        this.oldestOutcome = Math.min(Infinity, ...[...this.doc.outcomes.values()].filter((o) => o && Number.isFinite(o.at)).map((o) => o.at));
        this.clean = !this.bus.stale && this.bus.invalid === 0 && !this.badMail.size && !this.badOutcomes.size && now - this.oldest <= OWED_TTL_MS;
      }
      certain(now, opts = {}) {
        const retention = this.bus.entries.size > (opts.busKeep ?? BUS_KEEP) || this.bus.bytes > (opts.busBytes ?? BUS_BYTES);
        const mailRisk = this.mailSizes.size > MAIL_MAX || this.mailBytes > MAIL_BYTES || retention && (this.mailSizes.size + this.bus.addressedCount > MAIL_MAX || this.mailBytes + this.bus.addressedBytes > MAIL_BYTES);
        return !this.bus.stale && !this.bus.invalid && !this.badMail.size && !this.badOutcomes.size && this.outcomeSizes.size <= OUTCOMES_MAX && this.outcomeBytes <= OUTCOMES_BYTES && now - this.oldestOutcome <= OUTCOMES_TTL_MS && !this.aliases.size && !(this.duplicateBus.size && (retention || mailRisk)) && !(this.outcomeSizes.size && (this.overCapRecipients.size || mailRisk || now - this.oldest > OWED_TTL_MS));
      }
      trimmed(now, opts) {
        return this.clean && this.certain(now, opts) && now - this.oldest <= OWED_TTL_MS && this.cleanKeep === (opts.busKeep ?? BUS_KEEP) && this.cleanBytes === (opts.busBytes ?? BUS_BYTES);
      }
    };
    indexes = /* @__PURE__ */ new WeakMap();
  }
});

// packages/shared/src/worker-memory.ts
function revisions(doc) {
  const latest = /* @__PURE__ */ new Map();
  const see = (r) => {
    const old = latest.get(r.name);
    if (!old || compareRevision(r, old) > 0) latest.set(r.name, r);
  };
  for (const r of doc.getMap(REVISIONS).values()) see(r);
  for (const p of doc.getMap("completedPublications").values()) see(publicationRevision(p));
  const names = /* @__PURE__ */ new Set([...latest.keys(), ...[...doc.getMap("workerViews").values()].map((worker2) => worker2.name)]);
  const participants = doc.getMap("participants");
  const heads = doc.getMap("manifestHead");
  for (const name of names) {
    const holder = participants.get(`${name}\0holder`);
    if (holder && Number.isSafeInteger(holder.epoch)) see({ name, epoch: holder.epoch, semRev: -1, rev: -1 });
    const head = heads.get(name);
    const epoch = head && Number(head.fence);
    if (head && epoch !== void 0 && Number.isSafeInteger(epoch)) see({ name, epoch, semRev: head.semRev, rev: head.rev });
  }
  return latest;
}
function publicationRevisionCurrent(doc, name, head) {
  const known = revisions(doc).get(name);
  return !known || compareRevision({ name, epoch: Number(head.fence), semRev: head.semRev, rev: head.rev }, known) >= 0;
}
function contradicted(doc, p) {
  const view = doc.getMap("workerViews").get(p.worker.id);
  const holder = doc.getMap("participants").get(`${p.worker.name}\0holder`);
  return !!view && (view.name !== p.worker.name || view.run !== p.worker.run || view.status !== "done") || !!holder && (holder.workerId !== p.worker.id || holder.epoch !== p.holder.epoch) || doc.getArray("retiredWorkers").toArray().some((value) => value.id === p.worker.id);
}
function retainedPublication(room, name) {
  if (room.manifestHead.has(name)) return void 0;
  const view = room.acceptedWorkerViewOf(name);
  if (!view || view.status !== "done") return void 0;
  const latest = revisions(room.doc);
  return [...room.doc.getMap("completedPublications").values()].find((p) => p.worker.id === view.id && p.worker.run === view.run && p.worker.name === name && matchesRevision(p, latest) && !contradicted(room.doc, p));
}
var REVISIONS, compareRevision, publicationRevision, matchesRevision;
var init_worker_memory = __esm({
  "packages/shared/src/worker-memory.ts"() {
    "use strict";
    REVISIONS = "completedPublicationRevisions";
    compareRevision = (a, b) => a.epoch - b.epoch || a.semRev - b.semRev || a.rev - b.rev;
    publicationRevision = (p) => ({ name: p.worker.name, epoch: p.holder.epoch, semRev: p.head.semRev, rev: p.head.rev });
    matchesRevision = (p, latest) => {
      const known = latest.get(p.worker.name);
      return !!known && compareRevision(publicationRevision(p), known) === 0;
    };
  }
});

// node_modules/diff/libesm/diff/base.js
var Diff;
var init_base = __esm({
  "node_modules/diff/libesm/diff/base.js"() {
    "use strict";
    Diff = class {
      diff(oldStr, newStr, options = {}) {
        let callback;
        if (typeof options === "function") {
          callback = options;
          options = {};
        } else if ("callback" in options) {
          callback = options.callback;
        }
        const oldString = this.castInput(oldStr, options);
        const newString = this.castInput(newStr, options);
        const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
        const newTokens = this.removeEmpty(this.tokenize(newString, options));
        return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
      }
      diffWithOptionsObj(oldTokens, newTokens, options, callback) {
        var _a;
        const done = (value) => {
          value = this.postProcess(value, options);
          if (callback) {
            setTimeout(function() {
              callback(value);
            }, 0);
            return void 0;
          } else {
            return value;
          }
        };
        const newLen = newTokens.length, oldLen = oldTokens.length;
        let editLength = 1;
        let maxEditLength = newLen + oldLen;
        if (options.maxEditLength != null) {
          maxEditLength = Math.min(maxEditLength, options.maxEditLength);
        }
        const maxExecutionTime = (_a = options.timeout) !== null && _a !== void 0 ? _a : Infinity;
        const abortAfterTimestamp = Date.now() + maxExecutionTime;
        const bestPath = [{ oldPos: -1, lastComponent: void 0 }];
        let newPos = this.extractCommon(bestPath[0], newTokens, oldTokens, 0, options);
        if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
          return done(this.buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
        }
        let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
        const execEditLength = () => {
          for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
            let basePath;
            const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
            if (removePath) {
              bestPath[diagonalPath - 1] = void 0;
            }
            let canAdd = false;
            if (addPath) {
              const addPathNewPos = addPath.oldPos - diagonalPath;
              canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
            }
            const canRemove = removePath && removePath.oldPos + 1 < oldLen;
            if (!canAdd && !canRemove) {
              bestPath[diagonalPath] = void 0;
              continue;
            }
            if (!canRemove || canAdd && removePath.oldPos < addPath.oldPos) {
              basePath = this.addToPath(addPath, true, false, 0, options);
            } else {
              basePath = this.addToPath(removePath, false, true, 1, options);
            }
            newPos = this.extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
            if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
              return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
            } else {
              bestPath[diagonalPath] = basePath;
              if (basePath.oldPos + 1 >= oldLen) {
                maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
              }
              if (newPos + 1 >= newLen) {
                minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
              }
            }
          }
          editLength++;
        };
        if (callback) {
          (function exec2() {
            setTimeout(function() {
              if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
                return callback(void 0);
              }
              if (!execEditLength()) {
                exec2();
              }
            }, 0);
          })();
        } else {
          while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
            const ret = execEditLength();
            if (ret) {
              return ret;
            }
          }
        }
      }
      addToPath(path12, added, removed, oldPosInc, options) {
        const last2 = path12.lastComponent;
        if (last2 && !options.oneChangePerToken && last2.added === added && last2.removed === removed) {
          return {
            oldPos: path12.oldPos + oldPosInc,
            lastComponent: { count: last2.count + 1, added, removed, previousComponent: last2.previousComponent }
          };
        } else {
          return {
            oldPos: path12.oldPos + oldPosInc,
            lastComponent: { count: 1, added, removed, previousComponent: last2 }
          };
        }
      }
      extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
        const newLen = newTokens.length, oldLen = oldTokens.length;
        let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
        while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
          newPos++;
          oldPos++;
          commonCount++;
          if (options.oneChangePerToken) {
            basePath.lastComponent = { count: 1, previousComponent: basePath.lastComponent, added: false, removed: false };
          }
        }
        if (commonCount && !options.oneChangePerToken) {
          basePath.lastComponent = { count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false };
        }
        basePath.oldPos = oldPos;
        return newPos;
      }
      equals(left, right, options) {
        if (options.comparator) {
          return options.comparator(left, right);
        } else {
          return left === right || !!options.ignoreCase && left.toLowerCase() === right.toLowerCase();
        }
      }
      removeEmpty(array) {
        const ret = [];
        for (let i = 0; i < array.length; i++) {
          if (array[i]) {
            ret.push(array[i]);
          }
        }
        return ret;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      castInput(value, options) {
        return value;
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      tokenize(value, options) {
        return Array.from(value);
      }
      join(chars) {
        return chars.join("");
      }
      postProcess(changeObjects, options) {
        return changeObjects;
      }
      get useLongestToken() {
        return false;
      }
      buildValues(lastComponent, newTokens, oldTokens) {
        const components = [];
        let nextComponent;
        while (lastComponent) {
          components.push(lastComponent);
          nextComponent = lastComponent.previousComponent;
          delete lastComponent.previousComponent;
          lastComponent = nextComponent;
        }
        components.reverse();
        const componentLen = components.length;
        let componentPos = 0, newPos = 0, oldPos = 0;
        for (; componentPos < componentLen; componentPos++) {
          const component = components[componentPos];
          if (!component.removed) {
            if (!component.added && this.useLongestToken) {
              let value = newTokens.slice(newPos, newPos + component.count);
              value = value.map(function(value2, i) {
                const oldValue = oldTokens[oldPos + i];
                return oldValue.length > value2.length ? oldValue : value2;
              });
              component.value = this.join(value);
            } else {
              component.value = this.join(newTokens.slice(newPos, newPos + component.count));
            }
            newPos += component.count;
            if (!component.added) {
              oldPos += component.count;
            }
          } else {
            component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
            oldPos += component.count;
          }
        }
        return components;
      }
    };
  }
});

// node_modules/diff/libesm/diff/character.js
function diffChars(oldStr, newStr, options) {
  return characterDiff.diff(oldStr, newStr, options);
}
var CharacterDiff, characterDiff;
var init_character = __esm({
  "node_modules/diff/libesm/diff/character.js"() {
    "use strict";
    init_base();
    CharacterDiff = class extends Diff {
    };
    characterDiff = new CharacterDiff();
  }
});

// node_modules/diff/libesm/diff/line.js
function diffLines(oldStr, newStr, options) {
  return lineDiff.diff(oldStr, newStr, options);
}
function tokenize(value, options) {
  if (options.stripTrailingCr) {
    value = value.replace(/\r\n/g, "\n");
  }
  const retLines = [], linesAndNewlines = value.split(/(\n|\r\n)/);
  if (!linesAndNewlines[linesAndNewlines.length - 1]) {
    linesAndNewlines.pop();
  }
  for (let i = 0; i < linesAndNewlines.length; i++) {
    const line = linesAndNewlines[i];
    if (i % 2 && !options.newlineIsToken) {
      retLines[retLines.length - 1] += line;
    } else {
      retLines.push(line);
    }
  }
  return retLines;
}
var LineDiff, lineDiff;
var init_line = __esm({
  "node_modules/diff/libesm/diff/line.js"() {
    "use strict";
    init_base();
    LineDiff = class extends Diff {
      constructor() {
        super(...arguments);
        this.tokenize = tokenize;
      }
      equals(left, right, options) {
        if (options.ignoreWhitespace) {
          if (!options.newlineIsToken || !left.includes("\n")) {
            left = left.trim();
          }
          if (!options.newlineIsToken || !right.includes("\n")) {
            right = right.trim();
          }
        } else if (options.ignoreNewlineAtEof && !options.newlineIsToken) {
          if (left.endsWith("\n")) {
            left = left.slice(0, -1);
          }
          if (right.endsWith("\n")) {
            right = right.slice(0, -1);
          }
        }
        return super.equals(left, right, options);
      }
    };
    lineDiff = new LineDiff();
  }
});

// node_modules/diff/libesm/index.js
var init_libesm = __esm({
  "node_modules/diff/libesm/index.js"() {
    "use strict";
    init_character();
    init_line();
  }
});

// packages/shared/src/text-diff.ts
function commonEdges(a, b) {
  const shortest = Math.min(a.length, b.length);
  let head = 0;
  while (head < shortest && a.charCodeAt(head) === b.charCodeAt(head)) head++;
  if (head > 0 && isHigh(a.charCodeAt(head - 1))) head--;
  let tail = 0;
  while (tail < shortest - head && a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)) tail++;
  if (tail > 0 && isLow(a.charCodeAt(a.length - tail))) tail--;
  return [head, tail];
}
function fromChanges(changes) {
  return changes.map((c) => [c.added ? 1 : c.removed ? -1 : 0, c.value]);
}
function disjoint(a, b) {
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < a.length; i++) seen.add(a.charCodeAt(i));
  for (let i = 0; i < b.length; i++) if (seen.has(b.charCodeAt(i))) return false;
  return true;
}
function hunk(before, after, budget, stats) {
  if (!before || !after) return [replace(before, after), 0];
  const [head, tail] = commonEdges(before, after);
  const a = before.slice(head, before.length - tail), b = after.slice(head, after.length - tail);
  const edges = (middle) => [
    ...head ? [[0, before.slice(0, head)]] : [],
    ...middle,
    ...tail ? [[0, before.slice(before.length - tail)]] : []
  ];
  if (!a || !b) return [edges(replace(a, b)), 0];
  if (a.length >= 128 && b.length >= 128 && disjoint(a, b)) return [edges(replace(a, b)), 0];
  const tokens = a.length + b.length;
  const maxEditLength = editBudget(tokens, budget);
  if (maxEditLength > 0 && stats) stats.charCalls++;
  const changes = maxEditLength > 0 ? diffChars(a, b, { maxEditLength }) : void 0;
  if (!changes) {
    const spent2 = tokens * maxEditLength;
    if (stats) stats.work += spent2;
    return [edges(replace(a, b)), spent2];
  }
  const ops = fromChanges(changes);
  const spent = tokens * ops.filter(([kind]) => kind !== 0).reduce((n, [, v]) => n + v.length, 0);
  if (stats) stats.work += spent;
  return [edges(ops), spent];
}
function boundedTextDiff(before, after, stats) {
  if (before === after) return before ? [[0, before]] : [];
  const [head, tail] = commonEdges(before, after);
  const a = before.slice(head, before.length - tail), b = after.slice(head, after.length - tail);
  const out = head ? [[0, before.slice(0, head)]] : [];
  if (a.length <= SMALL_MIDDLE && b.length <= SMALL_MIDDLE) {
    out.push(...hunk(a, b, SMALL_WORK, stats)[0]);
    if (tail) out.push([0, before.slice(before.length - tail)]);
    return out.filter(([, value]) => value.length);
  }
  let budget = WORK;
  const lineCount = (s) => s.split("\n").length;
  const lineTokens = lineCount(a) + lineCount(b);
  const lineEdits = editBudget(lineTokens, budget / 2);
  if (a && b && lineEdits > 0 && stats) {
    stats.lineCalls++;
    stats.work += lineTokens * lineEdits;
  }
  const lines = a && b && lineEdits > 0 ? diffLines(a, b, { maxEditLength: lineEdits }) : void 0;
  budget /= 2;
  if (!lines) out.push(...hunk(a, b, budget, stats)[0]);
  else {
    let removed = "", added = "";
    const flush = () => {
      if (!removed && !added) return;
      const [ops, spent] = hunk(removed, added, budget, stats);
      out.push(...ops);
      budget = Math.max(0, budget - spent);
      removed = added = "";
    };
    for (const change of lines) {
      if (change.removed) removed += change.value;
      else if (change.added) added += change.value;
      else {
        flush();
        out.push([0, change.value]);
      }
    }
    flush();
  }
  if (tail) out.push([0, before.slice(before.length - tail)]);
  return out.filter(([, value]) => value.length);
}
var WORK, SMALL_MIDDLE, SMALL_WORK, isHigh, isLow, editBudget, replace;
var init_text_diff = __esm({
  "packages/shared/src/text-diff.ts"() {
    "use strict";
    init_libesm();
    WORK = 2e6;
    SMALL_MIDDLE = 4096;
    SMALL_WORK = 35e4;
    isHigh = (code) => code >= 55296 && code <= 56319;
    isLow = (code) => code >= 56320 && code <= 57343;
    editBudget = (tokens, budget) => Math.floor(budget / Math.max(1, tokens));
    replace = (before, after) => [
      ...before ? [[-1, before]] : [],
      ...after ? [[1, after]] : []
    ];
  }
});

// packages/shared/src/doc.ts
import { randomBytes as randomBytes2 } from "node:crypto";
function holderFence(holder) {
  return holder && Number.isSafeInteger(holder.epoch) ? String(holder.epoch) : void 0;
}
function participantRecord(room, name) {
  const key = (field) => `${name}\0${field}`;
  const id2 = room.participants.get(key("id"));
  const holder = room.participants.get(key("holder"));
  const git3 = room.participants.get(key("git"));
  const proj = room.participants.get(key("proj"));
  if (!id2 && !holder && !git3 && !proj) return void 0;
  return { ...id2 ? { id: id2 } : {}, ...holder ? { holder } : {}, ...git3 ? { git: git3 } : {}, ...proj ? { proj } : {} };
}
function lineStart(text, oneBasedLine) {
  let index = 0;
  for (let line = 1; line < Math.max(1, oneBasedLine); line++) {
    const newline = text.indexOf("\n", index);
    if (newline < 0) return text.length;
    index = newline + 1;
  }
  return index;
}
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < Math.min(index, text.length); i++) if (text[i] === "\n") line++;
  return line;
}
function makeAnchor(text, from2, to2) {
  return {
    from: relativePositionToJSON(createRelativePositionFromTypeIndex(text, lineStart(text.toString(), from2))),
    to: relativePositionToJSON(createRelativePositionFromTypeIndex(text, lineStart(text.toString(), to2)))
  };
}
var validColorIndex, RoomDoc;
var init_doc = __esm({
  "packages/shared/src/doc.ts"() {
    "use strict";
    init_delivery();
    init_worker_memory();
    init_claims();
    init_messages();
    init_text_diff();
    init_yjs();
    init_manifest();
    init_identity();
    init_ledger();
    validColorIndex = (value) => Number.isInteger(value) && value >= 0 && value < PALETTE.length;
    RoomDoc = class {
      doc;
      colorName;
      colorOrigin;
      get graphs() {
        return this.doc.getMap("graphs");
      }
      /** Flat `${name}\0${field}` keys avoid concurrent child-map insertion races. */
      get participants() {
        return this.doc.getMap("participants");
      }
      /** Monotonic absence accumulated by the current trim leader. */
      get expiry() {
        return this.doc.getMap("expiry");
      }
      /** Persistent participant -> palette slot assignments. */
      get colors() {
        return this.doc.getMap("colors");
      }
      /** One writer per incarnation key; the head remains a plain value. */
      get manifest() {
        return this.doc.getMap("manifest");
      }
      get manifestHead() {
        return this.doc.getMap("manifestHead");
      }
      get coordination() {
        return this.doc.getMap("coordination");
      }
      get roomSalt() {
        return this.metaMap.get("roomSalt");
      }
      /** Local/test fallback until room creation owns salt in the schema-2 cutover. */
      ensureRoomSalt() {
        if (!this.roomSalt) this.doc.transact(() => {
          if (!this.roomSalt) this.metaMap.set("roomSalt", randomBytes2(32).toString("hex"));
        });
        return this.roomSalt;
      }
      constructor(doc = new Doc()) {
        this.doc = doc;
        this.colors.observe(() => {
          if (this.colorName) this.reconcileColors(this.colorName, this.colorOrigin);
        });
      }
      /** Claim the lowest unused slot, retaining existing slots across reconnects. */
      assignColor(name, origin) {
        this.colorName = name;
        this.colorOrigin = origin;
        if (!this.colors.has(name)) {
          const used = new Set(Array.from(this.colors.values()).filter(validColorIndex));
          const free = Array.from({ length: PALETTE.length }, (_, i) => i).find((i) => !used.has(i));
          this.doc.transact(() => {
            this.colors.set(name, free ?? this.colors.size % PALETTE.length);
          }, origin);
        }
        this.reconcileColors(name, origin);
        return this.colors.get(name);
      }
      /** Lexically first keeps a concurrently claimed slot; a later caller moves only its own slot. */
      reconcileColors(name, origin) {
        const current = this.colors.get(name);
        if (current === void 0) return;
        const entries = [...this.colors.entries()];
        const losesTie = validColorIndex(current) && entries.some(([other, slot]) => other.localeCompare(name) < 0 && slot === current);
        if (validColorIndex(current) && !losesTie) return;
        const used = new Set(entries.flatMap(([other, slot]) => other !== name && validColorIndex(slot) ? [slot] : []));
        const free = Array.from({ length: PALETTE.length }, (_, i) => i).find((i) => !used.has(i));
        if (free !== void 0 && free !== current) this.doc.transact(() => {
          this.colors.set(name, free);
        }, origin);
      }
      get overlays() {
        return this.doc.getMap("overlays");
      }
      /** Evict a stopped participant's overlays and base texts together. The absent owner cannot reconcile them. */
      clearOverlays(person, origin) {
        const incarnations = [...this.overlays.keys()].filter((key) => key === person || key.startsWith(`${person}\0`));
        const paths = new Set(incarnations.flatMap((key) => [...this.overlays.get(key)?.keys() ?? []]));
        this.doc.transact(() => {
          for (const key of incarnations) this.overlays.delete(key);
          this.clearPersonBaseTexts(person);
        }, origin);
        return paths.size;
      }
      /** Decoding only: 0.16 branch-room snapshots can still contain deletion markers. */
      get legacyDeleted() {
        return this.doc.getMap("deleted");
      }
      get scopes() {
        return this.doc.getMap("scopes");
      }
      get claims() {
        return this.doc.getMap("claims");
      }
      get bus() {
        return this.doc.getArray("bus");
      }
      /** Leads' workers as the room shows them, keyed by worker ID (registry §14). Display only; written by each lead's projector. */
      get workerViews() {
        return this.doc.getMap("workerViews");
      }
      /** The newest view under a participant name, for display and remote classification. */
      workerViewOf(name) {
        let found;
        for (const view of this.workerViews.values()) if (view.name === name && (!found || view.startedAt > found.startedAt)) found = view;
        return found;
      }
      /** A view is display evidence only while its lead still holds the writer fence. */
      workerViewCurrent(view) {
        const holder = participantRecord(this, view.lead)?.holder;
        return !!holder && !holder.ended && view.fence === (holderFence(holder) ?? holder.sessionId);
      }
      acceptedWorkerViewOf(name) {
        let found;
        for (const view of this.workerViews.values()) if (view.name === name && this.workerViewCurrent(view) && (!found || view.startedAt > found.startedAt)) found = view;
        return found;
      }
      acceptedWorkerViews() {
        return [...this.workerViews.values()].filter((view) => this.workerViewCurrent(view));
      }
      retiredWorkers() {
        return this.doc.getArray("retiredWorkers").toArray();
      }
      /** Remove coordination from a participant that can no longer act; `post` sends the release notices. */
      clearWorkerCoordination(name, reason, post) {
        this.doc.transact(() => {
          for (const claim of this.claims.values()) if (claim.by === name) {
            this.claims.delete(claim.id);
            post({ name, kind: claim.byKind }, { type: "release", claimId: claim.id, path: claim.path, summary: reason });
          }
          this.clearOverlays(name);
          this.scopes.delete(name);
          this.graphs.delete(name);
        });
      }
      /**
       * Whether the live state under `name` is worker `id`'s: its holder names `id`, a team projection's
       * `projectedFrom` does, or, with neither, no other worker's view holds the name. A newer worker or a
       * standalone participant under the same name never is.
       */
      workerOwnsName(id2, name) {
        const record = participantRecord(this, name);
        return record?.holder ? record.holder.workerId === id2 : record?.proj ? record.proj.projectedFrom === id2 : ![...this.workerViews.values()].some((view) => view.name === name && view.id !== id2);
      }
      /**
       * Retirement keyed by worker ID (registry §12), one compare-and-delete transaction run by the projector of
       * this room. The live state under the worker's name (claims, scope, manifest and text, graph, colour,
       * receipts, participant keys) goes only while `workerOwnsName`. The view goes and the archive gains one entry per ID.
       */
      retireWorker(id2, archived, post) {
        if (archived.id !== id2) throw new Error("retirement id does not match record");
        const name = archived.name;
        this.doc.transact(() => {
          const cached = this.doc.getMap("completedPublications");
          for (const [key, value] of cached) if (value.worker.id === id2) cached.delete(key);
          if (this.workerOwnsName(id2, name)) {
            this.clearWorkerCoordination(name, "retired", post);
            const conflicts = this.doc.getMap("conflicts");
            for (const [key, slot] of conflicts) if (slot.owner === name) conflicts.delete(key);
            this.manifestHead.delete(name);
            for (const key of [...this.manifest.keys()]) if (key.startsWith(`${name}\0`)) this.manifest.delete(key);
            for (const key of [...this.overlays.keys()]) if (key.startsWith(`${name}\0`)) this.overlays.delete(key);
            for (const key of [...this.participants.keys()]) if (key.startsWith(`${name}\0`)) this.participants.delete(key);
            this.colors.delete(name);
            this.seen(name).clear();
          }
          this.workerViews.delete(id2);
          const archive = this.doc.getArray("retiredWorkers");
          if (!archive.toArray().some((r) => r.id === id2)) {
            archive.push([compactRetiredWorker(archived)]);
            if (archive.length > MAX_RETIRED_WORKERS) archive.delete(0, archive.length - MAX_RETIRED_WORKERS);
          }
        });
      }
      get metaMap() {
        return this.doc.getMap("meta");
      }
      /** Flat keys merge even when two sessions first publish under the same participant tag. */
      get ownedBaseTexts() {
        return this.doc.getMap("basetextFlat");
      }
      baseTextKey(person, sha, relpath) {
        return `${person}\0${sha}:${relpath}`;
      }
      baseTextPrefix(person) {
        return `${person}\0`;
      }
      isPersonBaseTextKey(key, person) {
        return key.startsWith(this.baseTextPrefix(person)) && !key.slice(person.length + 1).includes("\0");
      }
      baseText(person, sha, relpath) {
        const head = this.manifestHead.get(person);
        if (head && !publicationRevisionCurrent(this.doc, person, head)) return void 0;
        const live = this.ownedBaseTexts.get(this.baseTextKey(person, sha, relpath));
        if (live !== void 0) return live;
        const retained = retainedPublication(this, person);
        return retained?.head.base === sha ? retained.baseTexts.find(([path12]) => path12 === relpath)?.[1] : void 0;
      }
      /** Remove only this participant's entries that no longer back their live work. */
      reconcileBaseTexts(person, origin, baseSha) {
        const head = this.manifestHead.get(person);
        const base = baseSha ?? head?.base;
        const current = head ? this.manifest.get(manifestKey(person, head.fence)) : void 0;
        const wanted = new Set([...current?.entries() ?? []].filter(([, entry]) => entry.fence === head?.fence && entry.held !== "scope").map(([path12]) => `${base}:${path12}`));
        this.doc.transact(() => {
          const prefix = this.baseTextPrefix(person);
          for (const key of this.ownedBaseTexts.keys()) {
            if (this.isPersonBaseTextKey(key, person) && !wanted.has(key.slice(prefix.length))) this.ownedBaseTexts.delete(key);
          }
        }, origin);
      }
      /** Only eviction/retirement may remove another participant's entries: that owner has stopped. */
      clearPersonBaseTexts(person) {
        for (const key of this.ownedBaseTexts.keys()) if (this.isPersonBaseTextKey(key, person)) this.ownedBaseTexts.delete(key);
      }
      setBaseText(person, sha, relpath, text, origin) {
        const key = this.baseTextKey(person, sha, relpath);
        if (this.ownedBaseTexts.get(key) === text) return;
        this.doc.transact(() => {
          this.ownedBaseTexts.set(key, text);
        }, origin);
      }
      // ---- overlays ----------------------------------------------------------
      overlay(person) {
        let map = this.overlays.get(person);
        if (!map) {
          map = new YMap();
          this.overlays.set(person, map);
        }
        return map;
      }
      overlayText(person, relpath) {
        return this.overlays.get(person)?.get(relpath);
      }
      /** Compute bounded edits ahead of a larger atomic publication transaction. */
      prepareOverlayDiff(person, relpath, content, stats) {
        const before = this.overlayText(person, relpath)?.toString() ?? "";
        return { before, ops: boundedTextDiff(before, content, stats) };
      }
      /** Apply bounded character-level diff operations, preserving Yjs relative positions. */
      setOverlay(person, relpath, content, origin, prepared) {
        const existing = this.overlayText(person, relpath);
        const previous = existing?.toString() ?? "";
        if (existing && previous === content) return;
        this.doc.transact(() => {
          let text = this.overlayText(person, relpath);
          if (!text) {
            text = new YText();
            this.overlay(person).set(relpath, text);
          }
          let index = 0;
          const before = text === existing ? previous : text.toString();
          for (const [kind, value] of prepared?.before === before ? prepared.ops : boundedTextDiff(before, content)) {
            if (kind === 0) index += value.length;
            else if (kind === -1) text.delete(index, value.length);
            else {
              text.insert(index, value);
              index += value.length;
            }
          }
        }, origin);
      }
      /** Publisher-only apply of an overlay diff prepared against its fenced incarnation. */
      applyPreparedOverlayDiff(person, relpath, prepared, origin) {
        this.doc.transact(() => {
          let text = this.overlayText(person, relpath);
          if (!text) {
            text = new YText();
            this.overlay(person).set(relpath, text);
          }
          let index = 0;
          for (const [kind, value] of prepared.ops) {
            if (kind === 0) index += value.length;
            else if (kind === -1) text.delete(index, value.length);
            else {
              text.insert(index, value);
              index += value.length;
            }
          }
        }, origin);
      }
      clearOverlay(person, relpath, origin) {
        const map = this.overlays.get(person);
        if (!map?.has(relpath)) return;
        this.doc.transact(() => {
          map.delete(relpath);
        }, origin);
      }
      scope(person) {
        return this.scopes.get(person);
      }
      allScopes() {
        return Array.from(this.scopes.values()).sort((a, b) => a.at - b.at);
      }
      ledger(q = {}) {
        return ledger(this.messages(), this.allScopes(), q);
      }
      areaSummary(windowMs) {
        return areaSummary(this.messages(), this.allScopes(), windowMs);
      }
      setScope(personOrScope, scopeOrOrigin, origin) {
        const value = typeof personOrScope === "string" ? { ...scopeOrOrigin, by: personOrScope, at: scopeOrOrigin.at ?? Date.now() } : { ...personOrScope, at: personOrScope.at ?? Date.now() };
        const transactionOrigin = typeof personOrScope === "string" ? origin : scopeOrOrigin;
        this.doc.transact(() => {
          this.scopes.set(value.by, value);
        }, transactionOrigin);
        return value;
      }
      clearScope(person, origin) {
        const scope = this.scopes.get(person);
        if (scope) this.doc.transact(() => {
          this.scopes.delete(person);
        }, origin);
        return scope;
      }
      text(relpath, person) {
        return person ? this.overlayText(person, relpath)?.toString() : void 0;
      }
      lineCount(relpath, person) {
        const text = this.text(relpath, person);
        if (text === void 0) return 0;
        const count = text.split("\n").length;
        return text.endsWith("\n") ? count - 1 : count;
      }
      // ---- meta --------------------------------------------------------------
      get meta() {
        const map = this.metaMap;
        return {
          repo: map.get("repo"),
          createdAt: map.get("createdAt"),
          seededBy: map.get("seededBy"),
          schemaVersion: map.get("schemaVersion"),
          roomSalt: map.get("roomSalt")
        };
      }
      setMeta(patch, origin) {
        this.doc.transact(() => {
          for (const [key, value] of Object.entries(patch)) {
            if (value !== void 0) this.metaMap.set(key, value);
          }
        }, origin);
      }
      // ---- claims ------------------------------------------------------------
      openClaims() {
        return Array.from(this.claims.values()).map((claim) => ({ ...claim, ...this.claimRange(claim) })).sort((a, b) => a.at - b.at);
      }
      claimsFor(relpath) {
        return this.openClaims().filter((claim) => claimsOverlap(claim, { path: relpath, from: 1, to: Number.MAX_SAFE_INTEGER }));
      }
      /** Everyone who was shown a message: recipients of routed copies plus agents with a read receipt for it or its copies. */
      dependentsOf(msgId) {
        const out = new Set(this.seenBy(msgId));
        for (const m of this.messages()) if (m.copyOf === msgId) {
          if (m.to) out.add(m.to);
          for (const p of this.seenBy(m.id)) out.add(p);
        }
        return Array.from(out).sort();
      }
      setClaimMsg(claimId, msgId, origin) {
        const c = this.claims.get(claimId);
        if (c) this.doc.transact(() => {
          this.claims.set(claimId, { ...c, msgId });
        }, origin);
      }
      addClaim(input, origin) {
        const text = this.overlayText(input.by, input.path);
        const anchor = text && !input.mirrorOf ? makeAnchor(text, input.from, input.to) : void 0;
        const claim = { ...input, id: newId("c_"), at: Date.now(), ...anchor ? { anchor } : {} };
        this.doc.transact(() => {
          this.claims.set(claim.id, claim);
        }, origin);
        return claim;
      }
      claimRange(claim) {
        if (claim.mirrorOf) return { from: claim.from, to: claim.to };
        const text = this.overlayText(claim.by, claim.path);
        if (!text || !claim.anchor) return { from: claim.from, to: claim.to };
        try {
          const from2 = createAbsolutePositionFromRelativePosition(
            createRelativePositionFromJSON(claim.anchor.from),
            this.doc
          );
          const to2 = createAbsolutePositionFromRelativePosition(
            createRelativePositionFromJSON(claim.anchor.to),
            this.doc
          );
          if (!from2 || !to2 || from2.type !== text || to2.type !== text) return { from: claim.from, to: claim.to };
          const fromLine = lineAt(text.toString(), from2.index);
          const toLine = lineAt(text.toString(), to2.index);
          return { from: fromLine, to: Math.max(fromLine, toLine) };
        } catch {
          return { from: claim.from, to: claim.to };
        }
      }
      removeClaim(id2, origin) {
        const claim = this.claims.get(id2);
        if (claim) this.doc.transact(() => {
          this.claims.delete(id2);
        }, origin);
        return claim;
      }
      /** Replace a claim's line range and any obsolete overlay anchor after HEAD changes. */
      moveClaim(id2, from2, to2, origin, claimedHash) {
        const claim = this.claims.get(id2);
        if (!claim) return void 0;
        const text = this.overlayText(claim.by, claim.path);
        const { anchor: _oldAnchor, claimedHash: _oldHash, ...rest } = claim;
        const next = { ...rest, from: from2, to: to2, ...claimedHash !== void 0 ? { claimedHash } : {}, ...text && !claim.mirrorOf ? { anchor: makeAnchor(text, from2, to2) } : {} };
        this.doc.transact(() => {
          this.claims.set(id2, next);
        }, origin);
        return next;
      }
      // ---- bus ---------------------------------------------------------------
      messages() {
        return this.bus.toArray();
      }
      /** Addressed messages that left the bus while owed or answerable; written by the trim (delivery.ts). */
      get mail() {
        return this.doc.getMap("mail");
      }
      /** Terminal outcomes of addressed messages that were never receipted. */
      get outcomes() {
        return this.doc.getMap("outcomes");
      }
      /** Compact records of every message the trim removed from the bus. */
      get archive() {
        return this.doc.getMap("archive");
      }
      /** A message on the bus, else in mail. */
      message(id2) {
        return deliveryIndex(this).bus.first(id2) ?? this.mail.get(id2);
      }
      lastMessages(n) {
        const messages = this.messages();
        return messages.slice(Math.max(0, messages.length - n));
      }
      // ---- read receipts ------------------------------------------------------
      /** `seen:<P>`: message ids P's agent was handed, after a confirmed handoff (ledger R2). Legacy receipts are a number. */
      seen(name) {
        return this.doc.getMap(`seen:${encodeURIComponent(name)}`);
      }
      /** Receipts for a confirmed handoff to session `s` by `via`. */
      markSeen(name, ids, receipt, origin) {
        if (!ids.length) return;
        const value = { ...receipt, at: Date.now() };
        this.doc.transact(() => {
          const m = this.seen(name);
          for (const id2 of ids) if (!m.has(id2)) m.set(id2, value);
        }, origin);
      }
      /** Remove orphaned receipts only while this writer still holds its authority fence. */
      pruneSeen(name, current) {
        if (!current()) return;
        this.doc.transact(() => {
          if (!current()) return;
          const refs = /* @__PURE__ */ new Set([...this.messages().map((m) => m.id), ...this.mail.keys(), ...this.outcomes.keys()]);
          const seen = this.seen(name);
          for (const id2 of seen.keys()) if (!refs.has(id2)) seen.delete(id2);
        });
      }
      seenBy(msgId) {
        const out = [];
        for (const key of this.doc.share.keys()) if (key.startsWith("seen:") && this.doc.getMap(key).has(msgId)) out.push(decodeURIComponent(key.slice(5)));
        return out.sort();
      }
      // ---- chats (human <-> own agent) --------------------------------------
      chat(name) {
        return this.doc.getArray(`chat:${encodeURIComponent(name)}`);
      }
      say(name, item, origin) {
        const value = { ...item, id: newId("h_"), at: Date.now() };
        this.doc.transact(() => {
          this.chat(name).push([value]);
        }, origin);
        return value;
      }
    };
  }
});

// packages/shared/src/views.ts
var ROOM_STALE_MS, STALE_WORKER_MS;
var init_views = __esm({
  "packages/shared/src/views.ts"() {
    "use strict";
    init_claims();
    init_worker_memory();
    init_identity();
    init_doc();
    init_types();
    ROOM_STALE_MS = 7 * 24 * 60 * 60 * 1e3;
    STALE_WORKER_MS = 60 * 60 * 1e3;
  }
});

// packages/shared/src/manifest.ts
function manifestKey(name, fence) {
  return `${name}\0${fence}`;
}
var init_manifest = __esm({
  "packages/shared/src/manifest.ts"() {
    "use strict";
    init_doc();
    init_views();
    init_worker_memory();
  }
});

// packages/shared/src/near.ts
function normalizeCoordinationPath(p) {
  const parts = [];
  for (const part of p.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/") || ".";
}
function containsPath(parent, child) {
  const valid = (p) => p.trim().length > 0 && !/^(?:[\\/]|[a-z]:)/i.test(p) && (normalizeCoordinationPath(p) !== "." || p === "." || p === "./");
  if (!valid(parent) || !valid(child)) return false;
  const a = normalizeCoordinationPath(parent), b = normalizeCoordinationPath(child);
  return a === "." || a === b || b.startsWith(a + "/");
}
var init_near = __esm({
  "packages/shared/src/near.ts"() {
    "use strict";
    init_identity();
    init_manifest();
  }
});

// packages/shared/src/messages.ts
function validMessageShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value;
  const str2 = (key, required = true) => m[key] === void 0 ? !required : typeof m[key] === "string" && m[key].length <= 64 * 1024;
  const arr = (key, required = true) => m[key] === void 0 ? !required : Array.isArray(m[key]) && m[key].every((x) => typeof x === "string" && x.length <= 4096);
  const num = (key) => Number.isSafeInteger(m[key]) && m[key] >= 0;
  const plan2 = (p) => !!p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).every((k) => ["kind", "symbol", "detail"].includes(k)) && ["rename", "signature", "delete", "add"].includes(p.kind) && typeof p.symbol === "string" && p.symbol.length <= 512 && (p.detail === void 0 || typeof p.detail === "string" && p.detail.length <= 4096);
  const plans = (key) => m[key] === void 0 || Array.isArray(m[key]) && m[key].every(plan2);
  if (!str2("id") || !str2("from") || !str2("to", false) || !str2("copyOf", false) || typeof m.type !== "string" || !Object.hasOwn(MessageKinds, m.type)) return false;
  if (m.priority !== void 0 && !["fyi", "notify", "interrupt"].includes(m.priority)) return false;
  if (m.fromKind !== void 0 && !["human", "agent", "bot", "ci"].includes(m.fromKind)) return false;
  if (m.at !== void 0 && !num("at")) return false;
  if (m.seq !== void 0 && !num("seq")) return false;
  const common = ["id", "type", "from", "fromKind", "to", "priority", "at", "seq", "copyOf"];
  const fields = {
    claim: ["claimId", "path", "from_line", "to_line", "intent", "plans"],
    release: ["claimId", "path", "summary", "unfulfilled"],
    changed: ["paths", "summary", "symbols"],
    question: ["text"],
    note: ["text", "inReplyTo"],
    answer: ["inReplyTo", "text"],
    conflict: ["claimId", "otherClaimId", "path", "text", "clearedFrom", "merges"],
    "merge-conflict": ["path", "text", "clearedFrom"],
    contract: ["path", "symbol", "text"],
    scope: ["area", "summary", "paths"],
    base: ["base", "prev", "commits", "paths", "summary"],
    pushed: ["branch", "upstream", "fromSha", "toSha", "commits", "paths", "summary", "rewrite"],
    plan: ["status", "claimId", "path", "plan", "replacedBy", "text"],
    done: ["tag", "summary", "changed"]
  };
  if (!fields[m.type] || Object.keys(m).some((k) => !common.includes(k) && !fields[m.type].includes(k))) return false;
  switch (m.type) {
    case "claim":
      return str2("claimId") && str2("path") && num("from_line") && num("to_line") && str2("intent") && plans("plans");
    case "release":
      return str2("claimId") && str2("path") && str2("summary", false) && plans("unfulfilled");
    case "changed":
      return arr("paths") && str2("summary") && arr("symbols", false);
    case "question":
    case "note":
      return str2("text") && str2("inReplyTo", false);
    case "answer":
      return str2("inReplyTo") && str2("text");
    case "conflict":
      return str2("claimId") && str2("otherClaimId") && str2("path") && str2("text") && (m.clearedFrom === void 0 || ["conflict", "possible"].includes(m.clearedFrom)) && (m.merges === void 0 || m.merges === "clean");
    case "merge-conflict":
      return str2("path") && str2("text") && (m.clearedFrom === void 0 || ["conflict", "possible"].includes(m.clearedFrom));
    case "contract":
      return str2("path") && str2("symbol") && str2("text");
    case "scope":
      return str2("area") && str2("summary") && arr("paths");
    case "base":
      return str2("base") && str2("prev") && num("commits") && arr("paths") && str2("summary");
    case "pushed":
      return str2("branch") && str2("upstream") && str2("fromSha") && str2("toSha") && num("commits") && arr("paths") && str2("summary") && (m.rewrite === void 0 || ["yes", "unknown"].includes(m.rewrite));
    case "plan":
      return ["cancelled", "superseded"].includes(m.status) && str2("claimId") && str2("path") && plan2(m.plan) && (m.replacedBy === void 0 || plan2(m.replacedBy)) && str2("text");
    case "done":
      return str2("tag") && str2("summary") && arr("changed");
    default:
      return false;
  }
}
function messageKind(m) {
  const kind = MessageKinds[m.type];
  if (!kind) throw new Error(`unregistered message kind: ${m.type}`);
  return kind;
}
function holdsClaim(me, m, claims) {
  const ids = "claimId" in m ? [m.claimId, ..."otherClaimId" in m ? [m.otherClaimId] : []] : [];
  if (claims.some((c) => c.by === me && ids.includes(c.id))) return true;
  return "path" in m && claims.some((c) => c.by === me && isAgentic(c.byKind) && claimsOverlap(c, { path: m.path, from: 1, to: Number.MAX_SAFE_INTEGER }));
}
function messageForMe(me, m, context = {}) {
  if (m.type === "note" && !m.to && (m.from === me.name || m.priority === "fyi")) return false;
  if (m.from === me.name && m.fromKind !== "human") return false;
  if (m.type === "plan" && m.priority === "fyi") return false;
  if (m.to === me.name) return true;
  if (m.to) return false;
  const kind = messageKind(m);
  if (m.priority === "interrupt") return true;
  if (kind.inbox === false) return false;
  if (kind.audience === "everyone") return true;
  if (kind.audience === "addressed") return false;
  if (kind.audience === "claim-holders" && !holdsClaim(me.name, m, context.claims ?? [])) return false;
  if (m.priority === "notify") return context.inMyAreas?.(m) ?? false;
  return false;
}
function formatPlans(plans) {
  return plans.map((p) => `${p.kind} ${p.symbol}${p.detail ? ` \u2192 ${p.detail}` : ""}`).join("; ");
}
var who, to, priority, conflictLabel, PEER_NOTICE_TEXT, scopePaths, BASE_CATCH_UP, builtins, MessageKinds;
var init_messages = __esm({
  "packages/shared/src/messages.ts"() {
    "use strict";
    init_claims();
    init_identity();
    init_near();
    who = (m) => displayName({ name: m.from, kind: m.fromKind });
    to = (m) => m.to ? ` \u2192 ${displayName({ name: m.to, kind: "agent" })}` : "";
    priority = (m) => `[${m.priority}] `;
    conflictLabel = (m) => m.clearedFrom === "possible" ? "POSSIBLE conflict cleared" : m.clearedFrom === "conflict" ? m.merges === "clean" ? "overlap cleared" : "CONFLICT cleared" : m.merges === "clean" ? "overlap" : m.priority !== "fyi" ? "CONFLICT" : "POSSIBLE conflict";
    PEER_NOTICE_TEXT = /^\d+ files? (?:conflicts?|no longer conflict) with /;
    scopePaths = (paths) => [...new Set(paths.map(normalizeCoordinationPath))].sort().join("\0");
    BASE_CATCH_UP = "Run git pull --ff-only --autostash to catch up. If it refuses, or your push is rejected, stop and tell your human; never merge another branch into this one, and do not undo, rebase or recommit your commits to get past it without their yes.";
    builtins = {
      claim: { priority: "fyi", audience: "claim-holders", inbox: false, wakes: "never", format: (m, context) => context?.claims && !context.claims.some((c) => c.id === m.claimId) ? `${priority(m)}earlier: ${who(m)} claimed ${m.path}:${m.from_line}-${m.to_line} (${new Date(m.at).toISOString().slice(11, 19)}) \u2014 ${m.intent}` : `${priority(m)}${who(m)} claims ${m.path}:${m.from_line}-${m.to_line} \u2014 ${m.intent}${m.plans?.length ? ` (plans: ${formatPlans(m.plans)})` : ""}` },
      release: { priority: "fyi", audience: "everyone", inbox: false, wakes: "never", format: (m) => `${priority(m)}${who(m)} released ${m.path}${m.summary ? ` \u2014 ${m.summary}` : ""}${m.unfulfilled?.length ? ` (not done: ${formatPlans(m.unfulfilled)})` : ""}` },
      changed: { priority: (m) => m.symbols?.length ? "notify" : "fyi", audience: "everyone", inbox: false, wakes: "addressed", format: (m) => `${priority(m)}${who(m)} changed ${m.paths.join(", ")} \u2014 ${m.summary}${m.symbols?.length ? ` (${m.symbols.join(", ")})` : ""}` },
      question: { priority: "notify", audience: "addressed", wakes: "addressed", endsWait: (m, w) => !w.answersOnly && m.to === w.me && (w.workersRoom || !w.claimId && !w.questionId), format: (m) => `${priority(m)}${who(m)}${to(m)} asks: ${m.text}` },
      answer: { priority: "notify", audience: "addressed", wakes: "addressed", endsWait: (m, w) => !!w.questionId && m.inReplyTo === w.questionId && m.to === w.me, format: (m) => `${priority(m)}${who(m)}${to(m)} answers: ${m.text}` },
      conflict: { priority: "interrupt", audience: "claim-holders", wakes: "always", format: (m) => `${priority(m)}${conflictLabel(m)} on ${m.path}: ${m.text}` },
      "merge-conflict": { priority: "notify", audience: "addressed", inbox: true, wakes: "addressed", endsWait: (m, w) => !w.answersOnly && m.to === w.me, format: (m) => PEER_NOTICE_TEXT.test(m.text) ? `${priority(m)}${m.clearedFrom ? "CONFLICT cleared" : "CONFLICT"}: ${m.text}` : `${priority(m)}${conflictLabel(m)} on ${m.path}: ${m.text}` },
      contract: { priority: "notify", audience: "addressed", inbox: true, wakes: "always", format: (m) => `${priority(m)}CONTRACT on ${m.path}: ${m.text}` },
      note: { priority: (m) => m.to ? "notify" : "fyi", audience: "everyone", inbox: true, wakes: (m, ctx) => m.to === ctx.me.name, endsWait: (m, w) => !w.answersOnly && (m.to === w.me || !m.to && m.priority === "interrupt" && !!w.me && messageForMe({ name: w.me }, m)), format: (m) => `${priority(m)}${who(m)}${to(m)}: ${m.text}` },
      done: { priority: "fyi", audience: "addressed", wakes: "addressed", endsWait: (m, w) => !w.answersOnly && m.to === w.me, format: (m) => `${priority(m)}${who(m)} (worker ${m.tag}) finished: ${m.summary}${m.changed.length ? ` \u2014 changed ${m.changed.join(", ")}` : ""}` },
      base: { priority: "fyi", audience: "everyone", wakes: "never", format: (m) => `${priority(m)}${who(m)} moved the base to ${m.base.slice(0, 10)} (+${m.commits} commit${m.commits === 1 ? "" : "s"}: ${m.summary}) \u2014 ${BASE_CATCH_UP}` },
      pushed: { priority: "notify", audience: "everyone", wakes: (m, ctx) => m.from !== ctx.me.name && ctx.hasUncommitted, format: (m) => m.rewrite === "yes" ? `${priority(m)}${who(m)} rewrote ${m.branch} (force-push): ${m.fromSha.slice(0, 7)} was replaced by ${m.toSha.slice(0, 7)}; git pull --ff-only will refuse. If you have no local commits on it: git fetch && git reset --keep ${m.upstream}; if you do: git rebase --onto ${m.upstream} ${m.fromSha.slice(0, 7)} \u2014 ask your human first.` : m.rewrite === "unknown" ? `${priority(m)}${who(m)}: the branch moved from ${m.fromSha.slice(0, 7)} to ${m.toSha.slice(0, 7)} (history may have been rewritten)` : `${priority(m)}${m.from}'s local commits ${m.fromSha.slice(0, 7)}..${m.toSha.slice(0, 7)} are now on ${m.upstream} (${m.commits} commit${m.commits === 1 ? "" : "s"}: ${m.summary}) \u2014 if you work on ${m.upstream}: ${BASE_CATCH_UP}` },
      plan: { priority: "fyi", audience: "broadcast", wakes: "interrupt", format: (m) => `${priority(m)}${who(m)} ${m.status} plan ${formatPlans([m.plan])} in ${m.path}${m.replacedBy ? ` \u2192 now ${formatPlans([m.replacedBy])}` : ""}${m.text ? ` \u2014 ${m.text}` : ""}` },
      scope: { priority: "notify", audience: "everyone", inbox: false, wakes: "never", format: (m, context) => {
        const current = context?.scopes.some((s) => s.by === m.from && s.area === m.area && s.summary === m.summary && scopePaths(s.paths) === scopePaths(m.paths)) && context.messages.filter((x) => x.type === "scope" && x.from === m.from && x.area === m.area && x.summary === m.summary && scopePaths(x.paths) === scopePaths(m.paths)).at(-1)?.id === m.id;
        return current ? `${priority(m)}${who(m)} is on ${m.area}: ${m.summary} (${m.paths.join(", ")})` : `${priority(m)}earlier: ${who(m)} was on ${m.area} (${new Date(m.at).toISOString().slice(11, 19)}): ${m.summary} (${m.paths.join(", ")})`;
      } }
    };
    MessageKinds = builtins;
  }
});

// packages/shared/src/format.ts
var init_format = __esm({
  "packages/shared/src/format.ts"() {
    "use strict";
    init_messages();
  }
});

// packages/shared/src/claims.ts
function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  return aFrom <= bTo && bFrom <= aTo;
}
function claimsOverlap(a, b) {
  if (/[\\/]$/.test(a.path) && containsPath(a.path, b.path)) return true;
  if (/[\\/]$/.test(b.path) && containsPath(b.path, a.path)) return true;
  return normalizeCoordinationPath(a.path) === normalizeCoordinationPath(b.path) && rangesOverlap(a.from, a.to, b.from, b.to);
}
var init_claims = __esm({
  "packages/shared/src/claims.ts"() {
    "use strict";
    init_identity();
    init_format();
    init_near();
  }
});

// packages/shared/src/manifest-node.ts
var init_manifest_node = __esm({
  "packages/shared/src/manifest-node.ts"() {
    "use strict";
    init_near();
  }
});

// packages/shared/src/worker-messages.ts
var init_worker_messages = __esm({
  "packages/shared/src/worker-messages.ts"() {
    "use strict";
  }
});

// packages/shared/src/wake.ts
var init_wake = __esm({
  "packages/shared/src/wake.ts"() {
    "use strict";
    init_identity();
    init_claims();
    init_messages();
  }
});

// packages/shared/src/graph.ts
var KEYWORDS, CONTRACT_TEXT_MAX_CHARS;
var init_graph = __esm({
  "packages/shared/src/graph.ts"() {
    "use strict";
    KEYWORDS = new Set("def class return if else elif for while in not and or import from as with try except finally raise pass break continue lambda yield await async None True False self cls function const let var new this export default import from return if else for while do switch case break continue typeof instanceof void null undefined true false async await class extends super interface type enum implements".split(" "));
    CONTRACT_TEXT_MAX_CHARS = 256 * 1024;
  }
});

// packages/shared/src/areas.ts
var init_areas = __esm({
  "packages/shared/src/areas.ts"() {
    "use strict";
  }
});

// packages/shared/src/rooms.ts
var init_rooms = __esm({
  "packages/shared/src/rooms.ts"() {
    "use strict";
  }
});

// packages/shared/src/memory.ts
var MAX_MEMORY_BYTES, ROOM_DOC_MAX_BYTES;
var init_memory = __esm({
  "packages/shared/src/memory.ts"() {
    "use strict";
    init_delivery();
    init_worker_memory();
    MAX_MEMORY_BYTES = 5 * 1024 * 1024;
    ROOM_DOC_MAX_BYTES = 64 * 1024 * 1024;
  }
});

// packages/shared/src/expiry.ts
var ROOM_STALE_DAYS;
var init_expiry = __esm({
  "packages/shared/src/expiry.ts"() {
    "use strict";
    init_doc();
    init_views();
    ROOM_STALE_DAYS = ROOM_STALE_MS / (24 * 60 * 60 * 1e3);
  }
});

// packages/shared/src/parsed.ts
var init_parsed = __esm({
  "packages/shared/src/parsed.ts"() {
    "use strict";
  }
});

// packages/shared/src/build-output.ts
var REGENERABLE_BUILD_DIRS, buildDirs;
var init_build_output = __esm({
  "packages/shared/src/build-output.ts"() {
    "use strict";
    REGENERABLE_BUILD_DIRS = [
      "dist",
      "build",
      "out",
      ".astro",
      ".next",
      ".nuxt",
      ".svelte-kit",
      ".turbo",
      ".cache",
      "coverage",
      "test-results",
      "playwright-report",
      "node_modules",
      "vendor",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      ".tox",
      ".gradle",
      "target"
    ];
    buildDirs = new Set(REGENERABLE_BUILD_DIRS);
  }
});

// packages/shared/src/compact.ts
var init_compact = __esm({
  "packages/shared/src/compact.ts"() {
    "use strict";
  }
});

// packages/shared/src/schema.ts
var init_schema = __esm({
  "packages/shared/src/schema.ts"() {
    "use strict";
  }
});

// packages/shared/src/index.ts
var init_src = __esm({
  "packages/shared/src/index.ts"() {
    "use strict";
    init_types();
    init_identity();
    init_claims();
    init_doc();
    init_manifest();
    init_manifest_node();
    init_format();
    init_messages();
    init_worker_messages();
    init_wake();
    init_ledger();
    init_delivery();
    init_graph();
    init_areas();
    init_views();
    init_rooms();
    init_memory();
    init_near();
    init_expiry();
    init_parsed();
    init_build_output();
    init_compact();
    init_schema();
  }
});

// packages/roomd/src/git.ts
var GIT_OUTPUT_MAX_BYTES, GIT_STDERR_MAX_BYTES;
var init_git = __esm({
  "packages/roomd/src/git.ts"() {
    "use strict";
    GIT_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
    GIT_STDERR_MAX_BYTES = 64 * 1024;
  }
});

// packages/roomd/src/repo-path.ts
import path7 from "node:path";
function validRepoPath(rel, policy) {
  if ((policy.blank ?? "reject") === "reject" && !rel) return false;
  if (path7.isAbsolute(rel)) return false;
  if (policy.backslash === "reject" && rel.includes("\\")) return false;
  if ((policy.nul ?? "allow") === "reject" && rel.includes("\0")) return false;
  const parts = rel.split(policy.backslash === "separator" ? /[\\/]/ : "/");
  if (policy.empty === "reject" && parts.some((part) => !part)) return false;
  if (policy.dot === "reject" && parts.some((part) => part === "." || part === "..")) return false;
  if (policy.dot === "allow" && parts.includes("..")) return false;
  if (policy.git === "first" && parts[0] === ".git") return false;
  if (policy.git === "any" && parts.some((part) => part.toLowerCase() === ".git")) return false;
  if (policy.room === "first" && parts[0] === ".room") return false;
  return true;
}
var RECORDED_PATH;
var init_repo_path = __esm({
  "packages/roomd/src/repo-path.ts"() {
    "use strict";
    RECORDED_PATH = { backslash: "literal", empty: "reject", dot: "reject", git: "allow" };
  }
});

// packages/roomd/src/baseline.ts
var init_baseline = __esm({
  "packages/roomd/src/baseline.ts"() {
    "use strict";
    init_repo_path();
    init_git();
  }
});

// packages/roomd/src/git-dirs.ts
var init_git_dirs = __esm({
  "packages/roomd/src/git-dirs.ts"() {
    "use strict";
    init_baseline();
    init_git();
  }
});

// packages/roomd/src/bounded-read.ts
var init_bounded_read = __esm({
  "packages/roomd/src/bounded-read.ts"() {
    "use strict";
  }
});

// packages/roomd/src/room-file.ts
var ROOM_FILE_MAX_BYTES;
var init_room_file = __esm({
  "packages/roomd/src/room-file.ts"() {
    "use strict";
    init_git_dirs();
    init_bounded_read();
    ROOM_FILE_MAX_BYTES = 16 * 1024;
  }
});

// packages/roomd/src/disk-batch.ts
var init_disk_batch = __esm({
  "packages/roomd/src/disk-batch.ts"() {
    "use strict";
  }
});

// packages/roomd/src/poll.ts
var POLL_DIAGNOSTIC_MS;
var init_poll = __esm({
  "packages/roomd/src/poll.ts"() {
    "use strict";
    POLL_DIAGNOSTIC_MS = 5 * 6e4;
  }
});

// packages/roomd/src/share-level.ts
var init_share_level = __esm({
  "packages/roomd/src/share-level.ts"() {
    "use strict";
  }
});

// packages/roomd/src/roomignore.ts
var ROOMIGNORE_MAX_BYTES;
var init_roomignore = __esm({
  "packages/roomd/src/roomignore.ts"() {
    "use strict";
    ROOMIGNORE_MAX_BYTES = 64 * 1024;
  }
});

// packages/roomd/src/policy.ts
var init_policy = __esm({
  "packages/roomd/src/policy.ts"() {
    "use strict";
    init_src();
    init_share_level();
    init_roomignore();
  }
});

// packages/roomd/src/disk-scan.ts
var init_disk_scan = __esm({
  "packages/roomd/src/disk-scan.ts"() {
    "use strict";
    init_git();
    init_policy();
  }
});

// packages/roomd/src/manifest-publish.ts
var init_manifest_publish = __esm({
  "packages/roomd/src/manifest-publish.ts"() {
    "use strict";
    init_src();
  }
});

// packages/roomd/src/recent-keys.ts
var RecentKeys;
var init_recent_keys = __esm({
  "packages/roomd/src/recent-keys.ts"() {
    "use strict";
    RecentKeys = class {
      constructor(ttlMs, max2, now = Date.now) {
        this.ttlMs = ttlMs;
        this.max = max2;
        this.now = now;
      }
      ttlMs;
      max;
      now;
      // Insertion order is time order: a key is only (re)inserted after it expired or was evicted.
      at = /* @__PURE__ */ new Map();
      get size() {
        return this.at.size;
      }
      /** True when `key` was marked within the window; otherwise marks it now and returns false. */
      hit(key) {
        const now = this.now();
        for (const [old, at] of this.at) {
          if (now - at < this.ttlMs) break;
          this.at.delete(old);
        }
        if (this.at.has(key)) return true;
        this.at.set(key, now);
        if (this.at.size > this.max) this.at.delete(this.at.keys().next().value);
        return false;
      }
      clear() {
        this.at.clear();
      }
    };
  }
});

// packages/roomd/src/publisher.ts
var init_publisher = __esm({
  "packages/roomd/src/publisher.ts"() {
    "use strict";
    init_src();
    init_git();
    init_baseline();
    init_disk_scan();
    init_manifest_publish();
    init_policy();
    init_recent_keys();
  }
});

// packages/roomd/src/skip-summary.ts
var init_skip_summary = __esm({
  "packages/roomd/src/skip-summary.ts"() {
    "use strict";
  }
});

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length2) {
      for (let i = 0; i < length2; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = __require("bufferutil");
        module.exports.mask = function(source, mask, output, offset, length2) {
          if (length2 < 48) _mask(source, mask, output, offset, length2);
          else bufferUtil.mask(source, mask, output, offset, length2);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params2 = {};
        if (this._options.serverNoContextTakeover) {
          params2.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params2.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params2.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params2.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params2.client_max_window_bits = true;
        }
        return params2;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params2) => {
          if (opts.serverNoContextTakeover === false && params2.server_no_context_takeover || params2.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params2.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params2.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params2.client_max_window_bits : !params2.client_max_window_bits)) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params2 = response[0];
        if (this._options.clientNoContextTakeover === false && params2.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params2.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params2.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params2.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params2;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params2) => {
          Object.keys(params2).forEach((key) => {
            let value = params2[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params2[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = __require("utf-8-validate");
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._numFragments = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
          const error = this.createError(
            RangeError,
            "Too many message fragments",
            false,
            1008,
            "WS_ERR_TOO_MANY_BUFFERED_PARTS"
          );
          cb(error);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._numFragments = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var {
      types: { isUint8Array }
    } = __require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length2 = Buffer.byteLength(data);
          if (length2 > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length2);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params2 = this._queue.shift();
          this._bufferedBytes -= params2[3][kByteLength];
          Reflect.apply(params2[0], this, params2.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params2) {
        this._bufferedBytes += params2[3][kByteLength];
        this._queue.push(params2);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params2 = sender._queue[i];
        const callback = params2[params2.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params2 = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params2);
              params2 = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params2, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params2);
              params2 = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params2, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params2);
              params2 = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params2);
      } else {
        if (paramName === void 0) {
          push(params2, token, true);
        } else if (mustUnescape) {
          push(params2, paramName, token.replace(/\\/g, ""));
        } else {
          push(params2, paramName, token);
        }
        push(offers, extensionName, params2);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params2) => {
          return [extension2].concat(
            Object.keys(params2).map((k) => {
              let values = params2[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var https = __require("https");
    var http = __require("http");
    var net = __require("net");
    var tls = __require("tls");
    var { randomBytes: randomBytes6, createHash: createHash2 } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
    var { URL: URL2 } = __require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener: addEventListener2, removeEventListener: removeEventListener2 }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener2;
    WebSocket2.prototype.removeEventListener = removeEventListener2;
    module.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 256 * 1024,
        maxFragments: 16 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes6(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location2 = res.headers.location;
        const statusCode = res.statusCode;
        if (location2 && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location2, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location2}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length2 = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length2;
        else websocket._bufferedAmount += length2;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var http = __require("http");
    var { Duplex } = __require("stream");
    var { createHash: createHash2 } = __require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=262144] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=16384] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 256 * 1024,
          maxFragments: 16 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params2 = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params2]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// node_modules/ws/wrapper.mjs
var import_stream, import_extension, import_permessage_deflate, import_receiver, import_sender, import_subprotocol, import_websocket, import_websocket_server;
var init_wrapper = __esm({
  "node_modules/ws/wrapper.mjs"() {
    "use strict";
    import_stream = __toESM(require_stream(), 1);
    import_extension = __toESM(require_extension(), 1);
    import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
    import_receiver = __toESM(require_receiver(), 1);
    import_sender = __toESM(require_sender(), 1);
    import_subprotocol = __toESM(require_subprotocol(), 1);
    import_websocket = __toESM(require_websocket(), 1);
    import_websocket_server = __toESM(require_websocket_server(), 1);
  }
});

// packages/relay/src/memory.ts
var WARN_EVERY_MS, WARN_KEYS_MAX, WarningLimiter, sharedWarnings;
var init_memory2 = __esm({
  "packages/relay/src/memory.ts"() {
    "use strict";
    init_private_state();
    init_src();
    WARN_EVERY_MS = 6e4;
    WARN_KEYS_MAX = 64;
    WarningLimiter = class {
      constructor(now = Date.now) {
        this.now = now;
      }
      now;
      // Insertion order is time order: a key is re-inserted only after it expired.
      warnedAt = /* @__PURE__ */ new Map();
      get size() {
        return this.warnedAt.size;
      }
      warn(key, line, log) {
        const now = this.now();
        for (const [old, at] of this.warnedAt) {
          if (now - at < WARN_EVERY_MS) break;
          this.warnedAt.delete(old);
        }
        if (this.warnedAt.has(key)) return;
        this.warnedAt.set(key, now);
        if (this.warnedAt.size > WARN_KEYS_MAX) this.warnedAt.delete(this.warnedAt.keys().next().value);
        log(line());
      }
      clear() {
        this.warnedAt.clear();
      }
    };
    sharedWarnings = new WarningLimiter();
  }
});

// packages/relay/src/local-migrate.ts
var DEFAULT_LIMITS;
var init_local_migrate = __esm({
  "packages/relay/src/local-migrate.ts"() {
    "use strict";
    init_private_state();
    init_src();
    init_process();
    init_memory2();
    DEFAULT_LIMITS = { fileBytes: ROOM_DOC_MAX_BYTES, files: 64, totalBytes: 2 * ROOM_DOC_MAX_BYTES };
  }
});

// packages/hub-core/src/negotiation.ts
function freeze2(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze2(child);
    Object.freeze(value);
  }
  return value;
}
function baseline() {
  return { bootstrap: 1, hub: { min: 1, max: 1 }, schemas: { read: [2], write: [2] }, capabilities: { "room.generation": [1], "room.manifest": [1], "room.ledger": [1] }, legacy: { schema: 2, hub: 1 } };
}
var BOOTSTRAP_MAX_BUFFERED_BYTES, CAPABILITY_REGISTRY, LEGACY_COMPAT, CURRENT_COMPAT;
var init_negotiation = __esm({
  "packages/hub-core/src/negotiation.ts"() {
    "use strict";
    BOOTSTRAP_MAX_BUFFERED_BYTES = 1024 * 1024;
    CAPABILITY_REGISTRY = freeze2({
      "room.generation": { scope: "connection", wire: "schema/gen query and 4403/4409 fencing", documentEffects: "meta.generation identifies a replica epoch", versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: {} } } },
      "room.manifest": { scope: "room", wire: "schema-2 manifest records", documentEffects: "baseline per-participant manifests and sharing revisions", versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: {} } } },
      "room.ledger": { scope: "room", wire: "proto-1 ordered post and baseline event vocabulary", documentEffects: "schema-2 bus, mail, archive, outcomes and receipts; no stronger durability", versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: {} } } },
      "room.daemon": { scope: "connection", wire: "negotiated standalone local transport; no in-session takeover", documentEffects: "client retains its replica across involuntary transport rebinding; delayed snapshot durability unchanged", versions: { 1: { hub: { min: 1, max: 1 }, schemas: [2], dependencies: {} } } },
      "room.worker-handover": { scope: "participant", wire: "reserved; not implemented", documentEffects: "reserved; grants no worker lifecycle guarantee", versions: {} }
    });
    LEGACY_COMPAT = freeze2(baseline());
    CURRENT_COMPAT = freeze2(baseline());
  }
});

// packages/hub-core/src/protocol.ts
var COUNTER_BITS, COUNTER_LIMIT;
var init_protocol2 = __esm({
  "packages/hub-core/src/protocol.ts"() {
    "use strict";
    init_negotiation();
    COUNTER_BITS = 21;
    COUNTER_LIMIT = 2 ** COUNTER_BITS;
  }
});

// packages/hub-core/src/hub.ts
var MAX_HUB_FRAME_BYTES, MAX_HUB_REQUESTS_PER_SECOND, HubRequestBudget, encoder2;
var init_hub = __esm({
  "packages/hub-core/src/hub.ts"() {
    "use strict";
    init_src();
    init_protocol2();
    MAX_HUB_FRAME_BYTES = 96 * 1024;
    MAX_HUB_REQUESTS_PER_SECOND = 500;
    HubRequestBudget = class {
      connections = /* @__PURE__ */ new WeakMap();
      take(conn, now = Date.now()) {
        const current = this.connections.get(conn);
        if (!current || now - current.at >= 1e3) {
          this.connections.set(conn, { at: now, count: 1 });
          return void 0;
        }
        if (current.count >= MAX_HUB_REQUESTS_PER_SECOND) return Math.max(1, 1e3 - (now - current.at));
        current.count++;
        return void 0;
      }
    };
    encoder2 = new TextEncoder();
  }
});

// packages/hub-core/src/doc-cap.ts
var NON_GROWING_MAX_DECODE_BYTES;
var init_doc_cap = __esm({
  "packages/hub-core/src/doc-cap.ts"() {
    "use strict";
    NON_GROWING_MAX_DECODE_BYTES = 4 * 1048576;
  }
});

// packages/hub-core/src/http.ts
var init_http = __esm({
  "packages/hub-core/src/http.ts"() {
    "use strict";
  }
});

// packages/hub-core/src/incarnation-file.ts
var init_incarnation_file = __esm({
  "packages/hub-core/src/incarnation-file.ts"() {
    "use strict";
    init_hub();
  }
});

// packages/hub-core/src/index.ts
var init_src2 = __esm({
  "packages/hub-core/src/index.ts"() {
    "use strict";
    init_protocol2();
    init_hub();
    init_doc_cap();
    init_http();
    init_incarnation_file();
  }
});

// packages/relay/src/hub.ts
var init_hub2 = __esm({
  "packages/relay/src/hub.ts"() {
    "use strict";
    init_src2();
    init_leases();
    init_process();
  }
});

// packages/relay/src/proof.ts
var init_proof = __esm({
  "packages/relay/src/proof.ts"() {
    "use strict";
  }
});

// packages/relay/src/daemon.ts
var LOCAL_DAEMON_IDLE_MS;
var init_daemon = __esm({
  "packages/relay/src/daemon.ts"() {
    "use strict";
    init_preflight();
    init_src2();
    init_hub2();
    init_leases();
    init_process();
    init_proof();
    init_src3();
    init_private_state();
    LOCAL_DAEMON_IDLE_MS = 5 * 6e4;
  }
});

// node_modules/y-protocols/sync.js
var init_sync = __esm({
  "node_modules/y-protocols/sync.js"() {
    "use strict";
  }
});

// node_modules/y-protocols/awareness.js
var init_awareness = __esm({
  "node_modules/y-protocols/awareness.js"() {
    "use strict";
  }
});

// packages/relay/src/secure.ts
var MAGIC, LABEL, INFO_C2S, INFO_S2C;
var init_secure = __esm({
  "packages/relay/src/secure.ts"() {
    "use strict";
    MAGIC = Buffer.from("room-secure-v1");
    LABEL = Buffer.from("room-relay-v2\0relay\0");
    INFO_C2S = Buffer.from("room-relay-v2 c2s");
    INFO_S2C = Buffer.from("room-relay-v2 s2c");
  }
});

// packages/relay/src/limits.ts
var init_limits = __esm({
  "packages/relay/src/limits.ts"() {
    "use strict";
  }
});

// packages/relay/src/awareness.ts
var DEFAULTS;
var init_awareness2 = __esm({
  "packages/relay/src/awareness.ts"() {
    "use strict";
    init_limits();
    DEFAULTS = {
      maxMessageBytes: 64 * 1024,
      maxStateBytes: 16 * 1024,
      maxMessagesPerMinute: 6e3,
      maxIdsPerConnection: 16,
      maxIdsPerRoom: 4096
    };
  }
});

// packages/relay/src/index.ts
import path8 from "node:path";
var RELAY_STATE_QUEUE_BYTES, RELAY_SOCKET_QUEUE_BYTES, RELAY_TOTAL_QUEUE_BYTES, hubBudget, LOCAL_FILE;
var init_src3 = __esm({
  "packages/relay/src/index.ts"() {
    "use strict";
    init_memory2();
    init_local_migrate();
    init_local_migrate();
    init_daemon();
    init_hub2();
    init_memory2();
    init_hub2();
    init_wrapper();
    init_sync();
    init_awareness();
    init_src2();
    init_src();
    init_proof();
    init_secure();
    init_limits();
    init_awareness2();
    init_secure();
    init_proof();
    init_src2();
    init_src2();
    RELAY_STATE_QUEUE_BYTES = 1024 * 1024;
    RELAY_SOCKET_QUEUE_BYTES = 68 * 1024 * 1024;
    RELAY_TOTAL_QUEUE_BYTES = 256 * 1024 * 1024;
    hubBudget = new HubRequestBudget();
    LOCAL_FILE = path8.join("room", "relay.json");
  }
});

// packages/roomd/src/ws-auth.ts
var init_ws_auth = __esm({
  "packages/roomd/src/ws-auth.ts"() {
    "use strict";
    init_wrapper();
    init_src3();
    init_src2();
  }
});

// packages/roomd/src/reanchor.ts
var init_reanchor = __esm({
  "packages/roomd/src/reanchor.ts"() {
    "use strict";
  }
});

// packages/roomd/src/checkout-watch.ts
var init_checkout_watch = __esm({
  "packages/roomd/src/checkout-watch.ts"() {
    "use strict";
  }
});

// packages/roomd/src/base.ts
var FETCH_RETRY_MS, fetchAttempts;
var init_base2 = __esm({
  "packages/roomd/src/base.ts"() {
    "use strict";
    init_src();
    init_git();
    init_recent_keys();
    FETCH_RETRY_MS = 5 * 6e4;
    fetchAttempts = new RecentKeys(FETCH_RETRY_MS, 1024);
  }
});

// packages/roomd/src/index.ts
import os2 from "node:os";
var machineHostname, GIT_EXCLUDE_MAX_BYTES;
var init_src4 = __esm({
  "packages/roomd/src/index.ts"() {
    "use strict";
    init_room_file();
    init_repo_path();
    init_room_file();
    init_bounded_read();
    init_git_dirs();
    init_git_dirs();
    init_disk_batch();
    init_poll();
    init_publisher();
    init_skip_summary();
    init_disk_scan();
    init_manifest_publish();
    init_policy();
    init_share_level();
    init_policy();
    init_ws_auth();
    init_ws_auth();
    init_reanchor();
    init_checkout_watch();
    init_checkout_watch();
    init_src();
    init_roomignore();
    init_bounded_read();
    init_baseline();
    init_git();
    init_base2();
    init_base2();
    init_reanchor();
    machineHostname = os2.hostname();
    GIT_EXCLUDE_MAX_BYTES = 1024 * 1024;
  }
});

// packages/room-mcp/src/offline/room-state.ts
import path11 from "node:path";
import { randomBytes as randomBytes5 } from "node:crypto";

// packages/local-state/src/gate.ts
init_leases();
init_private_state();
import fs5 from "node:fs";
import path6 from "node:path";
import { randomBytes, randomUUID as randomUUID2 } from "node:crypto";

// packages/local-state/src/gate-thread.ts
init_protocol();
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
var worker;
var sequence = 0;
var closing;
var inFlight = /* @__PURE__ */ new Set();
var pending = /* @__PURE__ */ new Map();
function thread() {
  if (worker) return worker;
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(import.meta.url.endsWith(".mjs") ? "./gate-worker.mjs" : source ? "./gate-worker.ts" : "./gate-worker.js", import.meta.url);
  const current = source ? new Worker(`import { register } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)}; register(); await import(${JSON.stringify(entry.href)})`, { eval: true, execArgv: [] }) : new Worker(entry, { execArgv: [] });
  worker = current;
  const fail = (detail) => {
    if (worker !== current) return;
    worker = void 0;
    for (const request of pending.values()) request.reject(new StorageRefused(
      "unavailable",
      detail,
      "inspect storage gate status before retrying; an interrupted write may have completed"
    ));
    pending.clear();
    current.unref();
  };
  current.on("message", (message) => {
    if (worker !== current) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (!pending.size) current.unref();
    const error = message.error;
    if (!error) request.resolve(message.value);
    else request.reject(error.reason ? new StorageRefused(error.reason, error.detail, error.remedy) : Object.assign(new Error(error.detail), { code: error.code }));
  });
  current.on("error", (error) => fail(`storage gate worker failed: ${error.message.slice(0, 400)}`));
  current.on("exit", (code) => fail(`storage gate worker exited (${code})`));
  current.unref();
  return current;
}
function callGateThread(commonDir, options, method, args2) {
  if (closing) return Promise.reject(new StorageRefused("unavailable", "storage gates are closing"));
  const result = new Promise((resolve, reject) => {
    const current = thread(), id2 = ++sequence;
    pending.set(id2, { resolve, reject });
    current.ref();
    try {
      current.postMessage({ id: id2, commonDir, options: { limits: options.limits }, method, args: args2 });
    } catch (error) {
      pending.delete(id2);
      if (!pending.size) current.unref();
      reject(error);
    }
  });
  inFlight.add(result);
  void result.then(() => inFlight.delete(result), () => inFlight.delete(result));
  return result;
}
function closeStorageGates() {
  if (closing) return closing;
  closing = (async () => {
    await Promise.allSettled([...inFlight]);
    const current = worker;
    worker = void 0;
    if (current) await current.terminate();
  })().finally(() => {
    closing = void 0;
  });
  return closing;
}

// packages/local-state/src/gate.ts
init_protocol();
var PHASES = ["legacy", "draining", "staging", "db-complete", "active"];
var KINDS = ["mcp", "daemon", "maintenance"];
var MAX_GATE_BYTES = 64 * 1024;
var MAX_RECORD_BYTES = 8 * 1024;
var MAX_NOTE = 512;
var NONCE = /^[0-9a-f-]{8,64}$/;
var TICKET_ID = /^[0-9a-f]{32}$/;
var REGISTRATION_ID = /^registration:([0-9a-f-]{8,64})$/;
var TICKET_FILE = /^([0-9a-f-]{8,64})\.([0-9a-f]{32})\.json$/;
var EVIDENCE_NAMES = /* @__PURE__ */ new Set([
  path6.basename(STORAGE_PATHS.database),
  `${path6.basename(STORAGE_PATHS.database)}-wal`,
  `${path6.basename(STORAGE_PATHS.database)}-shm`,
  path6.basename(STORAGE_PATHS.activationMarker)
]);
var REMEDY = "run `node <plugin>/server/room-state.mjs status --common-dir <git common dir>` for details";
var bounded = (text, max2 = MAX_NOTE) => text.replace(/[\r\n\t]/g, " ").slice(0, max2);
var object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var positive = (value) => Number.isSafeInteger(value) && value >= 1;
var identityShape = (value) => object(value) && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.startTime === "string" && typeof value.executable === "string";
var tokenShape = (value) => identityShape(value) && object(value) && typeof value.sessionId === "string" && typeof value.nonce === "string" && NONCE.test(value.nonce);
function readRecord(file, max2) {
  let stat;
  try {
    stat = fs5.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
  if (!stat.isFile()) throw new Error(`not a regular file: ${path6.basename(file)}`);
  if (stat.size > max2) throw new Error(`record exceeds ${max2} bytes: ${path6.basename(file)}`);
  let text;
  try {
    text = fs5.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
  return JSON.parse(text);
}
function parseGate(value) {
  if (!object(value) || value.v !== 1 || typeof value.cloneId !== "string" || !/^[0-9a-f]{32}$/.test(value.cloneId) || typeof value.commonDir !== "string" || !positive(value.generation) || !PHASES.includes(value.phase) || !positive(value.minReader) || !positive(value.minWriter) || typeof value.updatedAt !== "number")
    throw new Error("invalid storage gate record");
  if (value.phase !== "legacy" && !(object(value.owner) && tokenShape(value.owner.instance) && typeof value.owner.token === "string"))
    throw new Error("storage gate in maintenance without an owner");
  if (value.phase === "draining" && !(positive(value.drainingFrom) && value.drainingFrom < value.generation))
    throw new Error("draining storage gate without a predecessor generation");
  return value;
}
function parseRegistration(value, nonce) {
  if (!object(value) || value.v !== 1 || !tokenShape(value.instance) || value.instance.nonce !== nonce || !KINDS.includes(value.kind) || !positive(value.build) || typeof value.release !== "string" || !positive(value.generation) || typeof value.registeredAt !== "number" || value.hasHeldTickets !== void 0 && value.hasHeldTickets !== true)
    throw new Error("invalid storage registration");
  return value;
}
function parseTicket(value, holder, id2) {
  if (!object(value) || value.v !== 1 || value.id !== id2 || value.holder !== holder || !identityShape(value.identity) || typeof value.kind !== "string" || !positive(value.generation) || typeof value.admittedAt !== "number" || value.parent !== void 0 && !(typeof value.parent === "string" && TICKET_ID.test(value.parent)))
    throw new Error("invalid storage ticket");
  return value;
}
var pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
var guardBusy = (error) => error instanceof Error && error.message.startsWith("lease guard busy");
function canonicalCommonDir(commonDir) {
  let canonical;
  try {
    canonical = fs5.realpathSync.native(commonDir);
  } catch (error) {
    throw new StorageRefused("unavailable", `common directory unreadable: ${error.code ?? error}`);
  }
  if (!path6.isAbsolute(canonical) || !fs5.existsSync(path6.join(canonical, "HEAD")))
    throw new StorageRefused("unavailable", "not a Git common directory (no HEAD)");
  return canonical;
}
function openStorageGate(commonDir, options = {}) {
  const gate = new FileStorageGate(canonicalCommonDir(commonDir), options);
  if (options.now || options.liveness) return gate;
  return {
    commonDir: gate.commonDir,
    register: (...args2) => callGateThread(gate.commonDir, options, "register", args2),
    admit: (...args2) => callGateThread(gate.commonDir, options, "admit", args2),
    finish: (...args2) => callGateThread(gate.commonDir, options, "finish", args2),
    unregister: (...args2) => callGateThread(gate.commonDir, options, "unregister", args2),
    drain: (...args2) => callGateThread(gate.commonDir, options, "drain", args2),
    resolveDead: (...args2) => callGateThread(gate.commonDir, options, "resolveDead", args2),
    takeOver: (...args2) => callGateThread(gate.commonDir, options, "takeOver", args2),
    reopen: (...args2) => callGateThread(gate.commonDir, options, "reopen", args2),
    status: (...args2) => callGateThread(gate.commonDir, options, "status", args2),
    listTickets: (...args2) => callGateThread(gate.commonDir, options, "listTickets", args2),
    // The read-only hot path remains one cached lstat; it never syncs or probes processes.
    observe: () => gate.observe()
  };
}
var FileStorageGate = class {
  constructor(commonDir, options) {
    this.commonDir = commonDir;
    this.now = options.now ?? Date.now;
    this.alive = options.liveness ?? ((identity) => liveness(identity));
    this.limits = { registrations: GATE_LIMITS.registrations, tickets: GATE_LIMITS.tickets, scanBatch: GATE_LIMITS.scanBatch, ...options.limits };
    this.gateFile = path6.join(commonDir, STORAGE_PATHS.gate);
    this.registrationDir = path6.join(commonDir, STORAGE_PATHS.registrations);
    this.ticketDir = path6.join(commonDir, STORAGE_PATHS.tickets);
    this.resolutionDir = path6.join(commonDir, STORAGE_PATHS.resolutions);
  }
  commonDir;
  now;
  alive;
  gateFile;
  registrationDir;
  ticketDir;
  resolutionDir;
  limits;
  /** Last observation, keyed by the gate file's identity. Every publication renames a new file into place. */
  observed;
  // ---- primitives ------------------------------------------------------------------------------------------
  /** Short synchronous critical section on the gate guard; waits only outside it, bounded by guardWaitMs. */
  async guarded(fn) {
    const deadline = performance.now() + GATE_LIMITS.guardWaitMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return withGuard(this.gateFile, fn, void 0, { durable: false });
      } catch (error) {
        if (error instanceof StorageRefused) throw error;
        if (!guardBusy(error)) throw new StorageRefused("unavailable", bounded(`storage gate I/O failed: ${error.message ?? error}`), REMEDY);
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new StorageRefused("unavailable", "storage gate guard busy", REMEDY);
        await pause(Math.min(remaining, Math.min(50, 2 + attempt * 3) + Math.random() * 5));
      }
    }
  }
  readGate() {
    let raw;
    try {
      raw = readRecord(this.gateFile, MAX_GATE_BYTES);
    } catch (error) {
      throw new StorageRefused("unavailable", bounded(`storage gate unreadable: ${error.message}`), "preserve room/storage-gate.json and repair it; Room never reinitializes it");
    }
    if (raw === void 0) return void 0;
    let gate;
    try {
      gate = parseGate(raw);
    } catch (error) {
      throw new StorageRefused("unavailable", bounded(`storage gate invalid: ${error.message}`), "preserve room/storage-gate.json and repair it; Room never reinitializes it");
    }
    if (gate.commonDir !== this.commonDir) throw new StorageRefused("incompatible", "storage gate belongs to another clone location", "this Git directory was copied or moved; repair before use");
    return gate;
  }
  requireGate() {
    const gate = this.readGate();
    if (!gate) throw new StorageRefused("unavailable", this.activationEvidence() ? "storage activation evidence exists without a storage gate" : "storage gate not initialized; register first", REMEDY);
    return gate;
  }
  /** One directory read: every evidence path lives directly in room/. Unreadable counts as evidence. */
  activationEvidence() {
    let names;
    try {
      names = fs5.readdirSync(path6.join(this.commonDir, "room"));
    } catch (error) {
      return error.code !== "ENOENT";
    }
    return names.some((name) => EVIDENCE_NAMES.has(name));
  }
  names(dir) {
    try {
      return fs5.readdirSync(dir);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  ticketNames() {
    return this.names(this.ticketDir).filter((name) => TICKET_FILE.test(name));
  }
  registrationNames() {
    return this.names(this.registrationDir).filter((name) => /^[0-9a-f-]{8,64}\.json$/.test(name));
  }
  ticketFile(holder, id2) {
    return path6.join(this.ticketDir, `${holder}.${id2}.json`);
  }
  registrationFile(nonce) {
    return path6.join(this.registrationDir, `${nonce}.json`);
  }
  readRegistration(nonce) {
    const raw = readRecord(this.registrationFile(nonce), MAX_RECORD_BYTES);
    return raw === void 0 ? void 0 : parseRegistration(raw, nonce);
  }
  publish(gate) {
    const next = { ...gate, updatedAt: this.now() };
    writeAtomic(this.gateFile, next);
    return next;
  }
  initialize(preRegistryImport) {
    if (this.activationEvidence()) throw new StorageRefused("unavailable", "storage activation evidence exists without a storage gate", "preserve room/state.sqlite and the activation marker; repair the gate with the offline command");
    privateStateDirectory(path6.join(this.commonDir, "room"));
    const gate = {
      v: 1,
      cloneId: randomBytes(16).toString("hex"),
      commonDir: this.commonDir,
      generation: 1,
      phase: "legacy",
      minReader: 1,
      minWriter: 1,
      preRegistryImport,
      updatedAt: this.now()
    };
    if (!createExclusive(this.gateFile, gate)) return this.requireGate();
    return gate;
  }
  compatibility(gate, build) {
    if (build < gate.minReader || build < gate.minWriter)
      throw new StorageRefused("incompatible", `storage build ${build} is below this clone's minimum ${Math.max(gate.minReader, gate.minWriter)}`, "update the Room plugin on every host, then restart them");
    if (gate.phase === "active" && build < 2)
      throw new StorageRefused("incompatible", "this clone uses SQLite storage; this Room build only supports legacy files", "update the Room plugin on every host, then restart them");
  }
  /** The maintenance owner must hold migration.lock and match the gate's recorded owner when there is one. */
  requireOwner(owner, gate) {
    let raw;
    try {
      raw = readRecord(path6.join(this.commonDir, STORAGE_PATHS.migrationLock), MAX_RECORD_BYTES);
    } catch (error) {
      throw new StorageRefused("unavailable", bounded(`migration lock unreadable: ${error.message}`));
    }
    const holder = object(raw) ? object(raw.holder) ? raw.holder : raw : void 0;
    if (!holder || holder.nonce !== owner.instance.nonce)
      throw new StorageRefused("maintenance", "this process does not hold migration.lock");
    if (gate.owner && (gate.owner.instance.nonce !== owner.instance.nonce || gate.owner.token !== owner.token))
      throw new StorageRefused("maintenance", "another maintenance owner holds this generation");
  }
  // ---- StorageGate -----------------------------------------------------------------------------------------
  async register(input) {
    if (!tokenShape(input.instance)) throw new StorageRefused("unavailable", "invalid instance identity");
    if (!KINDS.includes(input.kind)) throw new StorageRefused("unavailable", "invalid registration kind");
    const build = input.build ?? STORAGE_BUILD;
    const attempt = () => this.guarded(() => {
      const gate = this.readGate() ?? this.initialize(input.preRegistryImport ?? "required");
      this.compatibility(gate, build);
      const existing = this.readRegistration(input.instance.nonce);
      if (existing) return existing;
      if (this.registrationNames().length >= this.limits.registrations) return "full";
      const registration = {
        v: 1,
        instance: input.instance,
        kind: input.kind,
        build,
        release: bounded(input.release, 64),
        generation: gate.generation,
        registeredAt: this.now()
      };
      writeAtomic(this.registrationFile(input.instance.nonce), registration);
      return registration;
    });
    let result = await attempt();
    if (result === "full") {
      await this.pruneDeadRegistrations();
      result = await attempt();
    }
    if (result === "full") throw new StorageRefused("capacity", `${this.limits.registrations} processes are registered for this clone`, REMEDY);
    return result;
  }
  /**
   * Lock-free admission against the guarded drain transition. The ticket is published atomically, then the gate is
   * read again: a drain publishes its generation under the guard before scanning tickets, so either that scan sees
   * this ticket, or this re-read sees the drain and the ticket is withdrawn before anything can act on it.
   */
  async admit(registration, kind, options = {}) {
    const holder = registration.instance.nonce;
    const parent = options.parent;
    if (options.identity && !(parent && identityShape(options.identity)))
      throw new StorageRefused("unavailable", "a ticket for another process must be a child of the operation that started it");
    const current = this.readRegistrationOrRefuse(holder);
    const permitted = (gate) => {
      this.compatibility(gate, current.build);
      if (parent && !fs5.existsSync(this.ticketFile(parent.holder, parent.id)))
        throw new StorageRefused("maintenance", "parent operation already finished");
      if (gate.phase !== "legacy") {
        const predecessor = gate.phase === "draining" && parent && parent.generation <= (gate.drainingFrom ?? 0);
        if (!predecessor) throw new StorageRefused(
          gate.phase === "active" ? "incompatible" : "maintenance",
          `Room storage maintenance in progress (generation ${gate.generation}, ${gate.phase})`,
          REMEDY
        );
      }
      return parent ? parent.generation : gate.generation;
    };
    const capacity2 = () => {
      if (this.ticketNames().length > this.limits.tickets)
        throw new StorageRefused("capacity", `${this.limits.tickets} operations are in progress for this clone`, "retry after current operations finish");
    };
    const before = this.requireGate();
    const generation = permitted(before);
    if (this.ticketNames().length >= this.limits.tickets)
      throw new StorageRefused("capacity", `${this.limits.tickets} operations are in progress for this clone`, "retry after current operations finish");
    if (!current.hasHeldTickets) writeAtomic(this.registrationFile(holder), { ...current, hasHeldTickets: true });
    const effectOwner = options.identity ?? {
      pid: registration.instance.pid,
      startTime: registration.instance.startTime,
      executable: registration.instance.executable
    };
    const ticket = {
      v: 1,
      id: randomBytes(16).toString("hex"),
      holder,
      identity: effectOwner,
      kind,
      generation,
      ...parent ? { parent: parent.id } : {},
      admittedAt: this.now()
    };
    const file = this.ticketFile(holder, ticket.id);
    if (!createExclusive(file, ticket, { durable: false })) throw new StorageRefused("unavailable", "ticket id collision");
    try {
      const after = this.requireGate();
      if (after.generation !== before.generation || after.phase !== before.phase) {
        if (!parent) throw new StorageRefused("maintenance", `Room storage maintenance in progress (generation ${after.generation}, ${after.phase})`, REMEDY);
        permitted(after);
      }
      capacity2();
    } catch (error) {
      try {
        fs5.unlinkSync(file);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      }
      throw error;
    }
    return ticket;
  }
  readRegistrationOrRefuse(holder) {
    let current;
    try {
      current = this.readRegistration(holder);
    } catch (error) {
      throw new StorageRefused("unavailable", bounded(`storage registration unreadable: ${error.message}`));
    }
    if (!current) throw new StorageRefused("unavailable", "this process is not registered with the storage gate");
    return current;
  }
  async finish(ticket) {
    const file = this.ticketFile(ticket.holder, ticket.id);
    try {
      fs5.unlinkSync(file);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw new StorageRefused("unavailable", bounded(`ticket release failed: ${error.code ?? error}`));
    }
  }
  async unregister(registration) {
    const nonce = registration.instance.nonce;
    await this.guarded(() => {
      if (this.ticketNames().some((name) => name.startsWith(`${nonce}.`)))
        throw new StorageRefused("busy", "this process still holds storage tickets");
      try {
        fs5.unlinkSync(this.registrationFile(nonce));
        syncDirectoryQuietly(this.registrationDir);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    });
  }
  async drain(owner) {
    const gate = await this.guarded(() => {
      const gate2 = this.requireGate();
      if (!this.readRegistration(owner.instance.nonce)) throw new StorageRefused("maintenance", "maintenance owner is not registered");
      if (gate2.phase === "legacy") {
        this.requireOwner(owner, { ...gate2, owner: void 0 });
        return this.publish({ ...gate2, generation: gate2.generation + 1, phase: "draining", drainingFrom: gate2.generation, owner });
      }
      if (gate2.phase !== "draining") throw new StorageRefused("incompatible", `storage gate is ${gate2.phase}; this build only drains legacy storage`);
      this.requireOwner(owner, gate2);
      return gate2;
    });
    return this.progress(gate);
  }
  async takeOver(owner) {
    const observed = this.requireGate();
    if (observed.phase !== "draining" || !observed.owner) throw new StorageRefused("maintenance", "no draining generation to take over");
    if (this.alive(observed.owner.instance) !== "dead") throw new StorageRefused("maintenance", "the recorded maintenance owner is alive or unknown");
    const gate = await this.guarded(() => {
      const gate2 = this.requireGate();
      if (gate2.generation !== observed.generation || gate2.owner?.token !== observed.owner.token)
        throw new StorageRefused("maintenance", "storage gate changed during takeover");
      this.requireOwner(owner, { ...gate2, owner: void 0 });
      return this.publish({ ...gate2, generation: gate2.generation + 1, owner });
    });
    return this.progress(gate);
  }
  /**
   * Registration evidence is separate from volatile tickets. Never interpret lifecycle leases here. A ticket name
   * whose record was read and found gone (Windows lists a delete-pending name until its last handle closes) does not
   * cover its holder, so that holder's registration evidence is still reported.
   */
  async registrationEvidence(ticketNames, gone = /* @__PURE__ */ new Set()) {
    const holders = new Set(ticketNames.filter((name) => !gone.has(name)).map((name) => name.split(".")[0]));
    const names = this.registrationNames(), evidence = [];
    for (let start = 0; start < names.length; start += this.limits.scanBatch) {
      for (const name of names.slice(start, start + this.limits.scanBatch)) {
        const holder = name.slice(0, -5);
        if (holders.has(holder)) continue;
        let registration;
        try {
          registration = this.readRegistration(holder);
        } catch {
          evidence.push({
            id: `registration:${holder}`,
            holder,
            kind: "reconcile",
            generation: 0,
            pid: 0,
            admittedAt: 0,
            holderState: "unreadable"
          });
          continue;
        }
        if (!registration?.hasHeldTickets) continue;
        evidence.push({
          id: `registration:${holder}`,
          holder,
          kind: "reconcile",
          generation: registration.generation,
          pid: registration.instance.pid,
          admittedAt: registration.registeredAt,
          holderState: this.alive(registration.instance)
        });
      }
      await yieldTurn();
    }
    return evidence;
  }
  async progress(gate) {
    const live = [], unknown = [], dead = [];
    const names = this.ticketNames(), gone = /* @__PURE__ */ new Set();
    for (let start = 0; start < names.length; start += this.limits.scanBatch) {
      for (const name of names.slice(start, start + this.limits.scanBatch)) {
        const [, holder, id2] = TICKET_FILE.exec(name);
        let ticket;
        try {
          const raw = readRecord(path6.join(this.ticketDir, name), MAX_RECORD_BYTES);
          if (raw === void 0) {
            gone.add(name);
            continue;
          }
          ;
          ticket = parseTicket(raw, holder, id2);
        } catch {
          unknown.push({ id: id2, kind: "reconcile", generation: 0, holder, pid: 0, admittedAt: 0 });
          continue;
        }
        const view = {
          id: id2,
          kind: ticket.kind,
          generation: ticket.generation,
          holder,
          pid: ticket.identity.pid,
          ...ticket.parent ? { parent: ticket.parent } : {},
          admittedAt: ticket.admittedAt
        };
        const state = this.alive(ticket.identity);
        (state === "alive" ? live : state === "dead" ? dead : unknown).push(view);
      }
      await yieldTurn();
    }
    for (const { holderState, ...view } of await this.registrationEvidence(names, gone)) {
      ;
      (holderState === "alive" ? live : holderState === "dead" ? dead : unknown).push(view);
    }
    if (!names.length) await this.pruneDeadRegistrations();
    return {
      generation: gate.generation,
      phase: gate.phase,
      complete: names.length === 0 && !live.length && !dead.length && !unknown.length,
      live,
      unknown,
      dead,
      pending: 0
    };
  }
  async pruneDeadRegistrations() {
    const names = this.registrationNames();
    const holders = new Set(this.ticketNames().map((name) => name.split(".")[0]));
    for (let start = 0; start < names.length; start += this.limits.scanBatch) {
      for (const name of names.slice(start, start + this.limits.scanBatch)) {
        const nonce = name.slice(0, -5);
        if (holders.has(nonce)) continue;
        let registration;
        try {
          registration = this.readRegistration(nonce);
        } catch {
          continue;
        }
        if (!registration || registration.hasHeldTickets || this.alive(registration.instance) !== "dead") continue;
        try {
          fs5.unlinkSync(this.registrationFile(nonce));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      await yieldTurn();
    }
    syncDirectoryQuietly(this.registrationDir);
  }
  async resolveDead(owner, ticketId, note) {
    const registrationId = REGISTRATION_ID.exec(ticketId);
    if (registrationId) {
      const holder2 = registrationId[1], registration = this.readRegistration(holder2);
      if (!registration?.hasHeldTickets) throw new StorageRefused("unavailable", "no such registration evidence");
      if (this.alive(registration.instance) !== "dead")
        throw new StorageRefused("blocked", "the registration holder is alive or its identity cannot be verified");
      await this.guarded(() => {
        const gate = this.requireGate();
        if (gate.phase !== "draining") throw new StorageRefused("maintenance", "dead holders are resolved only while draining");
        this.requireOwner(owner, gate);
        if (!this.readRegistration(holder2)?.hasHeldTickets) return;
        if (this.ticketNames().some((name2) => name2.startsWith(`${holder2}.`)))
          throw new StorageRefused("busy", "resolve remaining holder tickets before registration evidence");
        writeAtomic(path6.join(this.resolutionDir, `registration-${holder2}.json`), {
          v: 1,
          registration,
          note: bounded(note),
          owner: owner.instance.nonce,
          generation: gate.generation,
          liveness: "dead",
          at: this.now(),
          id: randomUUID2()
        });
        fs5.unlinkSync(this.registrationFile(holder2));
        syncDirectoryQuietly(this.registrationDir);
      });
      return;
    }
    if (!TICKET_ID.test(ticketId)) throw new StorageRefused("unavailable", "invalid ticket id");
    const name = this.ticketNames().find((candidate) => candidate.endsWith(`.${ticketId}.json`));
    if (!name) throw new StorageRefused("unavailable", "no such ticket");
    const [, holder] = TICKET_FILE.exec(name);
    const ticket = parseTicket(readRecord(path6.join(this.ticketDir, name), MAX_RECORD_BYTES), holder, ticketId);
    if (this.alive(ticket.identity) !== "dead") throw new StorageRefused("blocked", "the ticket holder is alive or its identity cannot be verified");
    await this.guarded(() => {
      const gate = this.requireGate();
      if (gate.phase !== "draining") throw new StorageRefused("maintenance", "dead tickets are resolved only while draining");
      this.requireOwner(owner, gate);
      const file = path6.join(this.ticketDir, name);
      if (!fs5.existsSync(file)) return;
      privateStateDirectory(this.resolutionDir);
      writeAtomic(path6.join(this.resolutionDir, `${ticketId}.json`), {
        v: 1,
        ticket,
        note: bounded(note),
        owner: owner.instance.nonce,
        generation: gate.generation,
        liveness: "dead",
        at: this.now(),
        id: randomUUID2()
      });
      fs5.unlinkSync(file);
      syncDirectoryQuietly(this.ticketDir);
    });
  }
  async reopen(owner, options = {}) {
    return this.guarded(() => {
      const gate = this.requireGate();
      if (gate.phase !== "draining") throw new StorageRefused("maintenance", `storage gate is ${gate.phase}, not draining`);
      this.requireOwner(owner, gate);
      const { owner: _owner, drainingFrom: _from, ...rest } = gate;
      if (options.notAfter !== void 0 && (!Number.isFinite(options.notAfter) || this.now() >= options.notAfter))
        throw new StorageRefused("maintenance", "import attempt deadline passed; admission stays closed");
      return this.publish({ ...rest, phase: "legacy" });
    });
  }
  async status() {
    const counts = () => {
      try {
        return { registrations: this.registrationNames().length, tickets: this.ticketNames().length };
      } catch {
        return { registrations: 0, tickets: 0 };
      }
    };
    let legacyImport;
    try {
      const raw = readRecord(path6.join(this.commonDir, STORAGE_PATHS.migrationMap), 4 * 1024 * 1024);
      legacyImport = raw === void 0 ? "absent" : object(raw) && raw.done === true ? "done" : "pending";
    } catch {
      legacyImport = "unreadable";
    }
    let gate;
    try {
      gate = this.readGate();
    } catch (error) {
      const refused = error;
      return { state: "unreadable", ...counts(), legacyImport, maintenanceRequired: true, refusal: { reason: refused.reason, detail: refused.detail, remedy: refused.remedy } };
    }
    if (!gate) {
      const evidence = this.activationEvidence();
      return {
        state: evidence ? "evidence-without-gate" : "absent",
        ...counts(),
        legacyImport,
        maintenanceRequired: evidence,
        ...evidence ? { refusal: { reason: "unavailable", detail: "storage activation evidence exists without a storage gate", remedy: REMEDY } } : {}
      };
    }
    try {
      this.compatibility(gate, STORAGE_BUILD);
    } catch (error) {
      const refused = error;
      return { state: "present", gate, ...counts(), legacyImport, maintenanceRequired: true, refusal: { reason: refused.reason, detail: refused.detail, remedy: refused.remedy } };
    }
    const maintenance = gate.phase !== "legacy";
    return {
      state: "present",
      gate,
      ...counts(),
      legacyImport,
      maintenanceRequired: maintenance,
      ...maintenance ? { refusal: { reason: "maintenance", detail: `generation ${gate.generation} is ${gate.phase}`, remedy: REMEDY } } : {}
    };
  }
  async listTickets(limit = this.limits.scanBatch) {
    const names = this.ticketNames().sort();
    const bound = Math.max(0, Math.min(limit, this.limits.scanBatch));
    const tickets = [], gone = /* @__PURE__ */ new Set();
    for (const name of names.slice(0, bound)) {
      const [, holder, id2] = TICKET_FILE.exec(name);
      try {
        const raw = readRecord(path6.join(this.ticketDir, name), MAX_RECORD_BYTES);
        if (raw === void 0) {
          gone.add(name);
          continue;
        }
        const ticket = parseTicket(raw, holder, id2);
        tickets.push({
          id: id2,
          kind: ticket.kind,
          generation: ticket.generation,
          holder,
          pid: ticket.identity.pid,
          ...ticket.parent ? { parent: ticket.parent } : {},
          admittedAt: ticket.admittedAt,
          holderState: this.alive(ticket.identity)
        });
      } catch {
        tickets.push({ id: id2, kind: "reconcile", generation: 0, holder, pid: 0, admittedAt: 0, holderState: "unreadable" });
      }
    }
    const evidence = await this.registrationEvidence(names, gone);
    tickets.push(...evidence.slice(0, Math.max(0, bound - tickets.length)));
    const total = names.length + evidence.length;
    return { tickets, total, truncated: total > bound };
  }
  async observe() {
    let stat;
    try {
      stat = fs5.lstatSync(this.gateFile, { bigint: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw new StorageRefused("unavailable", bounded(`storage gate unreadable: ${error.code ?? error}`), REMEDY);
    }
    const key = stat && `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    if (key && this.observed?.key === key) {
      this.compatibility(this.observed.gate, STORAGE_BUILD);
      return this.observed.value;
    }
    this.observed = void 0;
    const gate = stat ? this.readGate() : void 0;
    if (gate) {
      this.compatibility(gate, STORAGE_BUILD);
      const value = { generation: gate.generation, phase: gate.phase };
      if (key) this.observed = { key, value, gate };
      return value;
    }
    if (this.activationEvidence()) throw new StorageRefused("unavailable", "storage activation evidence exists without a storage gate", REMEDY);
    return { generation: 0, phase: "legacy" };
  }
};
function syncDirectoryQuietly(dir) {
  let fd;
  try {
    fd = fs5.openSync(dir, "r");
    fs5.fsyncSync(fd);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "ENOENT"].includes(error.code ?? "")) throw error;
  } finally {
    if (fd !== void 0) fs5.closeSync(fd);
  }
}

// packages/room-mcp/src/offline/room-state.ts
init_leases();
init_protocol();

// packages/room-mcp/src/storage-admission.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes as randomBytes4 } from "node:crypto";
import fs8 from "node:fs";
init_process();
init_preflight();
init_protocol();

// packages/room-mcp/src/offline/legacy-import.ts
init_yjs();
init_src();
import fs7 from "node:fs";
import path10 from "node:path";
import { randomBytes as randomBytes3 } from "node:crypto";
import { execFileSync as execFileSync3 } from "node:child_process";

// packages/room-mcp/src/hosts/claude-shell.ts
var POWERSHELL_HOOK = String.raw`import fs from 'node:fs'
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
`;

// packages/room-mcp/src/run-log-facts.ts
var CHUNK = 64 * 1024;
var PENDING_CAP = 1024 * 1024;

// packages/room-mcp/src/hosts/lifecycle.ts
function legacyWorkerHost(value) {
  return value ?? "codex";
}

// packages/room-mcp/src/worker-state.ts
init_git();
init_baseline();
init_src4();
import path9 from "node:path";

// packages/room-mcp/src/worker-config.ts
init_src2();
init_src();

// packages/room-mcp/src/hosts/install-io.ts
import { execFile as execFile4 } from "node:child_process";
import { promisify } from "node:util";
var exec = promisify(execFile4);

// packages/room-mcp/src/hosts/codex-install.ts
init_src2();

// plugins/room/.claude-plugin/plugin.json
var plugin_default = {
  name: "room",
  version: "0.17.40",
  description: "Lets your coding agent see what teammates' agents are changing. Silent while you work alone; local by default.",
  author: {
    name: "Rohan",
    url: "https://github.com/rohanz/room"
  },
  repository: "https://github.com/rohanz/room",
  license: "PolyForm-Noncommercial-1.0.0",
  keywords: [
    "collaboration",
    "multiplayer",
    "crdt",
    "agents"
  ],
  hooks: "./hooks/claude.json",
  mcpServers: {
    room: {
      command: "node",
      args: [
        "${CLAUDE_PLUGIN_ROOT}/server/room-mcp.mjs"
      ],
      env: {
        ROOM_HOST: "claude"
      }
    }
  }
};

// packages/room-mcp/src/config.ts
init_src4();

// packages/roomd/src/local.ts
init_git_dirs();

// packages/room-mcp/src/config.ts
init_src4();

// packages/room-mcp/src/worker-process.ts
init_process();
init_process();

// packages/room-mcp/src/worker-state.ts
function roomWorkerPathMatchesBranch(leadDir, workerDir, branch, nested = false) {
  const relative = path9.relative(path9.resolve(leadDir), path9.resolve(workerDir)).split(path9.sep);
  if (relative.length < 3 || relative.length % 3 !== 0 || !nested && relative.length !== 3) return false;
  return relative.every((part, i) => i % 3 === 0 ? part === ".room" : i % 3 === 1 ? part === "workers" : validRepoPath(part, RECORDED_PATH)) && branch === `room/${relative.at(-1)}`;
}

// packages/room-mcp/src/hosts/types.ts
function isHostId(value) {
  return value === "claude" || value === "codex";
}

// packages/room-mcp/src/worker-codecs.ts
var safeTag = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) && value !== "..";
var object2 = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var tokenShape2 = (value) => object2(value) && Number.isSafeInteger(value.pid) && typeof value.startTime === "string" && typeof value.executable === "string" && typeof value.sessionId === "string" && typeof value.nonce === "string";
var processShape = (value) => object2(value) && Number.isSafeInteger(value.pid) && typeof value.startTime === "string" && typeof value.executable === "string";
var runShape = (value) => {
  if (!object2(value) || !Number.isSafeInteger(value.n) || value.n < 1 || !["fresh", "resume"].includes(value.mode) || typeof value.intentAt !== "number" || typeof value.nonce !== "string" || !Number.isSafeInteger(value.busFrontier) || !Array.isArray(value.promptMsgIds) || !tokenShape2(value.launcher) || typeof value.logStart !== "number") return false;
  if (value.launch === void 0) return true;
  if (!object2(value.launch)) return false;
  switch (value.launch.outcome) {
    case "launched":
      return Number.isSafeInteger(value.launch.pid) && (value.launch.process === void 0 || processShape(value.launch.process));
    case "never":
      return typeof value.launch.error === "string";
    case "ambiguous":
      return typeof value.launch.at === "number";
    case "imported":
      return true;
    default:
      return false;
  }
};
var keptPublicationShape = (value) => object2(value) && typeof value.pending === "boolean" && Array.isArray(value.paths) && value.paths.length <= 2e3 && value.paths.every((p) => typeof p === "string") && value.paths.reduce((bytes, p) => bytes + Buffer.byteLength(p), 0) <= 128 * 1024 && (value.overflow === void 0 || typeof value.overflow === "boolean") && (value.base === void 0 || typeof value.base === "string" && /^[0-9a-f]{40,64}$/.test(value.base)) && (value.ack === void 0 || object2(value.ack) && typeof value.ack.publisher === "string" && typeof value.ack.sessionId === "string" && typeof value.ack.fence === "string" && Number.isSafeInteger(value.ack.rev) && Number(value.ack.rev) >= 0 && (value.ack.roomSalt === void 0 || typeof value.ack.roomSalt === "string" && /^[a-f0-9]{64}$/i.test(value.ack.roomSalt)));
var recordShape = (value, id2) => object2(value) && value.v === 1 && value.id === id2 && typeof value.tag === "string" && safeTag(value.tag) && typeof value.name === "string" && ["local", "here"].includes(value.mode) && typeof value.room === "string" && object2(value.lead) && typeof value.lead.participant === "string" && typeof value.lead.room === "string" && tokenShape2(value.lead.instance) && isHostId(value.host) && object2(value.budget) && typeof value.task === "string" && typeof value.dir === "string" && typeof value.branch === "string" && typeof value.outside === "boolean" && (value.logFile === void 0 || typeof value.logFile === "string") && object2(value.prep) && typeof value.prep.step === "string" && (value.keptPublication === void 0 || keptPublicationShape(value.keptPublication)) && object2(value.capabilities) && typeof value.capabilities.resume === "boolean" && typeof value.capabilities.signal === "boolean" && ["delta", "copy", "none"].includes(value.capabilities.collect) && ["intent", "preparing", "prepared", "active", "collecting", "discarding", "retiring", "retired", "abandoned"].includes(value.phase) && Array.isArray(value.runs) && value.runs.length > 0 && value.runs.every(runShape) && typeof value.createdAt === "number" && Number.isSafeInteger(value.seq);

// packages/room-mcp/src/offline/legacy-import.ts
init_leases();
init_protocol();
var readJson = (file) => {
  try {
    return JSON.parse(fs7.readFileSync(file, "utf8"));
  } catch (e) {
    if (["ENOENT", "ENOTDIR"].includes(e.code ?? "")) return void 0;
    throw e;
  }
};
var files = (dir, suffix) => {
  try {
    return fs7.readdirSync(dir).filter((n) => n.endsWith(suffix)).map((n) => path10.join(dir, n));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
};
function commitExists(commonDir, oid, budget) {
  if (typeof oid !== "string" || !/^[0-9a-f]{40,64}$/.test(oid)) return false;
  try {
    execFileSync3("git", ["--git-dir", commonDir, "cat-file", "-e", `${oid}^{commit}`], { stdio: "ignore", timeout: budget.gitTimeout(), killSignal: "SIGKILL" });
    budget.check();
    return true;
  } catch (error) {
    budget.check();
    if (error.code === "ETIMEDOUT") throw new StorageRefused("unavailable", "legacy Git probe timed out");
    return false;
  }
}
function legacySession(dir, oldId, host, budget) {
  if (!oldId) return void 0;
  try {
    const gitDir = execFileSync3("git", ["-C", dir, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", timeout: budget.gitTimeout(), killSignal: "SIGKILL" }).trim();
    const local = readJson(path10.join(gitDir, "room-session.json"));
    return local?.worker_id === oldId && local.host === host && typeof local.session_id === "string" ? local.session_id : void 0;
  } catch (error) {
    budget.check();
    if (error.code === "ETIMEDOUT") throw new StorageRefused("unavailable", "legacy Git probe timed out");
    return void 0;
  }
}
var LegacySnapshotUnavailable = class extends Error {
};
function legacyDisplay(commonDir) {
  const found = /* @__PURE__ */ new Map();
  const canonical = (dir) => {
    try {
      return fs7.realpathSync(dir);
    } catch {
      return path10.resolve(dir);
    }
  };
  for (const file of files(path10.join(commonDir, "room-local"), ".ydoc")) {
    const doc = new Doc();
    try {
      if (fs7.statSync(file).size > ROOM_DOC_MAX_BYTES) throw new Error(`snapshot exceeds ${ROOM_DOC_MAX_BYTES / 1048576} MiB`);
      applyUpdate(doc, fs7.readFileSync(file));
      const room = new RoomDoc(doc);
      for (const worker2 of doc.getMap("workers").values()) {
        if (!worker2.dir || !worker2.id) continue;
        found.set(canonical(worker2.dir), {
          oldId: worker2.id,
          host: worker2.host,
          model: worker2.model,
          task: worker2.task,
          said: worker2.summary
        });
      }
      for (const retired of room.retiredWorkers()) {
        if (!retired.keptWorktree) continue;
        const prior = found.get(canonical(retired.keptWorktree));
        found.set(canonical(retired.keptWorktree), {
          ...prior,
          host: retired.host,
          model: retired.model,
          task: retired.task,
          said: retired.summary,
          keptWorktree: retired.keptWorktree
        });
      }
    } catch (error) {
      throw new LegacySnapshotUnavailable(`unreadable legacy snapshot: ${file}`);
    } finally {
      doc.destroy();
    }
  }
  return found;
}
function discoverLegacyWorktrees(commonDir, budget = importBudget()) {
  budget.check();
  let output;
  try {
    output = execFileSync3("git", ["--git-dir", commonDir, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: budget.gitTimeout(), killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
  } catch {
    throw new StorageRefused("unavailable", "legacy worktree inventory failed");
  }
  budget.check();
  const registered = new Set([...output.matchAll(/^worktree (.+)$/gm)].map((match) => {
    try {
      return fs7.realpathSync(match[1]);
    } catch {
      return path10.resolve(match[1]);
    }
  }));
  const display = legacyDisplay(commonDir);
  const out = [];
  for (const block of output.split(/\n\s*\n/)) {
    const listed = /^worktree (.+)$/m.exec(block)?.[1];
    const dir = listed === void 0 ? void 0 : path10.resolve(listed);
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (!dir || !branch?.startsWith("room/")) continue;
    const tag = branch.slice(5);
    if (path10.basename(dir) !== tag || !dir.includes(`${path10.sep}.room${path10.sep}workers${path10.sep}`)) continue;
    let canonical;
    try {
      canonical = fs7.realpathSync(dir);
    } catch {
      throw new StorageRefused("unavailable", "legacy worktree path is unreadable; inventory is incomplete");
    }
    const ownerCheckout = path10.dirname(path10.dirname(path10.dirname(canonical)));
    if (!registered.has(ownerCheckout) || !roomWorkerPathMatchesBranch(ownerCheckout, canonical, branch)) continue;
    const prior = display.get(canonical);
    out.push({
      key: `worktree:${canonical}`,
      tag,
      dir: canonical,
      branch,
      host: legacyWorkerHost(prior?.host),
      ...prior ?? {}
    });
  }
  return out;
}
async function importLegacy(commonDir, identity, now, source, workerId, budget, verify) {
  const file = path10.join(commonDir, "room/registry/workers", `${workerId}.json`);
  const carryFile = path10.join(commonDir, "room-carry", `${source.tag}.json`);
  const migratedCarryFile = `${carryFile}.migrated`;
  if (fs7.existsSync(file)) {
    if (fs7.existsSync(carryFile) && !fs7.existsSync(migratedCarryFile)) {
      await verify();
      fs7.renameSync(carryFile, migratedCarryFile);
    }
    return;
  }
  const token = identity;
  const carryRecord = readJson(carryFile);
  const base = commitExists(commonDir, carryRecord?.base, budget) ? carryRecord.base : void 0;
  const carriedBase = commitExists(commonDir, carryRecord?.carriedBase, budget) ? carryRecord.carriedBase : void 0;
  const carry = base && (!carryRecord?.carriedBase || carriedBase) ? "delta" : "copy";
  const hostSessionId = legacySession(source.dir, source.oldId, source.host, budget);
  const record = {
    v: 1,
    id: workerId,
    tag: source.tag,
    name: "",
    mode: "local",
    room: "",
    lead: { participant: "", room: "", instance: token },
    host: source.host,
    model: source.model,
    budget: { threads: 1, memGb: 1, nice: 10 },
    share: source.share ?? "intent",
    task: source.task ?? "legacy worker",
    dir: source.dir,
    outside: false,
    branch: source.branch,
    prep: { step: "prepared" },
    base,
    carriedBase,
    hostSessionId,
    capabilities: { resume: !!hostSessionId, signal: false, collect: carry },
    phase: source.keptWorktree ? "retired" : "active",
    keptWorktree: source.keptWorktree,
    cleanup: source.keptWorktree ? { legacy: "done" } : void 0,
    runs: [{ n: 1, mode: "fresh", intentAt: now(), nonce: `imported:${workerId}`, busFrontier: 0, promptMsgIds: [], launcher: token, launch: { outcome: "imported" }, logStart: 0 }],
    legacy: { id: source.key, source: source.dir, said: source.said, unowned: true },
    createdAt: now(),
    seq: 1
  };
  await verify();
  createExclusive(path10.join(commonDir, "room/registry/tags", `${source.tag}.json`), { id: workerId, holder: token, at: now() });
  await verify();
  createExclusive(file, record);
  if (fs7.existsSync(carryFile) && !fs7.existsSync(migratedCarryFile)) {
    await verify();
    fs7.renameSync(carryFile, migratedCarryFile);
  }
}
var legacyImportRemedy = (commonDir) => `node <plugin>/server/room-state.mjs import-legacy --common-dir ${JSON.stringify(commonDir)}`;
function legacyImportRequired(commonDir, status, gate) {
  if (status === "done") return false;
  if (status !== "absent") return true;
  if (gate) return gate.preRegistryImport !== "not-needed";
  return preRegistryImportRequired(commonDir);
}
function preRegistryImportRequired(commonDir) {
  try {
    if (files(path10.join(commonDir, "room-local"), ".ydoc").length || files(path10.join(commonDir, "room-carry"), ".json").length) return true;
    const output = execFileSync3("git", ["--git-dir", commonDir, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 3e3, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
    const candidates = output.split(/\n\s*\n/).flatMap((block) => {
      const dir = /^worktree (.+)$/m.exec(block)?.[1], branch = /^branch refs\/heads\/(room\/.+)$/m.exec(block)?.[1];
      return dir && branch && dir.includes(`${path10.sep}.room${path10.sep}workers${path10.sep}`) && path10.basename(dir) === branch.slice(5) ? [path10.resolve(dir)] : [];
    });
    if (!candidates.length) return false;
    const records = files(path10.join(commonDir, "room/registry/workers"), ".json").map((file) => {
      try {
        const value = readJson(file);
        return recordShape(value, path10.basename(file, ".json")) ? value : void 0;
      } catch {
        return void 0;
      }
    });
    return candidates.some((dir) => !records.some((record) => record && path10.resolve(record.dir) === dir));
  } catch {
    return true;
  }
}
function importBudget(mono = () => performance.now(), deadline = mono() + 10 * 6e4) {
  const notAfter = Date.now() + Math.max(0, deadline - mono());
  const check = () => {
    if (mono() >= deadline || Date.now() >= notAfter) throw new StorageRefused("maintenance", "legacy import attempt exceeded 10 minutes; gate remains draining");
  };
  return { check, notAfter, gitTimeout() {
    check();
    return Math.max(1, Math.min(3e3, Math.ceil(deadline - mono())));
  } };
}
async function importLegacyWorkers(commonDir, identity, options) {
  const budget = options.budget ?? importBudget();
  const verify = async () => {
    budget.check();
    await options.verify();
    budget.check();
  };
  await verify();
  const file = path10.join(commonDir, "room/registry/migration.json");
  const map = readJson(file) ?? { v: 1, sources: {}, done: false };
  if (map.v !== 1 || typeof map.done !== "boolean" || !map.sources || typeof map.sources !== "object" || Object.values(map.sources).some((value) => !value || typeof value.id !== "string" || !/^w_[A-Za-z0-9_-]+$/.test(value.id) || !["assigned", "imported"].includes(value.state)))
    throw new StorageRefused("unavailable", "legacy assignment map is unreadable", legacyImportRemedy(commonDir));
  if (map.done) return;
  const sources = options.sources ? options.sources(commonDir) : discoverLegacyWorktrees(commonDir, budget);
  budget.check();
  for (const source of sources) {
    if (!safeTag(source.tag)) throw new StorageRefused("unavailable", "invalid legacy worker tag");
    await verify();
    if (!map.sources[source.key]) {
      map.sources[source.key] = { id: `w_${randomBytes3(16).toString("hex")}`, state: "assigned" };
      writeAtomic(file, map);
    }
    const target = map.sources[source.key];
    if (target.state === "imported") continue;
    await importLegacy(commonDir, identity, options.now ?? Date.now, source, target.id, budget, verify);
    await verify();
    target.state = "imported";
    writeAtomic(file, map);
  }
  if (Object.values(map.sources).some((source) => source.state !== "imported"))
    throw new StorageRefused("unavailable", "legacy assignments remain unresolved; inventory is incomplete");
  await verify();
  map.done = true;
  writeAtomic(file, map);
}

// packages/room-mcp/src/storage-admission.ts
var registrations = /* @__PURE__ */ new Map();
var startups = /* @__PURE__ */ new Set();
var ambient = new AsyncLocalStorage();
var reads = new AsyncLocalStorage();
var gates = /* @__PURE__ */ new Map();
function storageInstance() {
  const own = probeOwnProcess();
  return {
    pid: process.pid,
    startTime: own?.startTime ?? "",
    executable: own?.executable ?? "",
    sessionId: `mcp:${process.pid}`,
    nonce: randomBytes4(16).toString("hex")
  };
}
var drainingSweep;
var drainRequested = false;
function unregisterDraining() {
  drainRequested = true;
  if (drainingSweep) return drainingSweep;
  drainingSweep = (async () => {
    do {
      drainRequested = false;
      for (const [common, pending2] of [...registrations]) {
        const state = await pending2.catch(() => void 0);
        if (!state || outstanding.has(common) || (await state.gate.observe()).phase !== "draining") continue;
        await retireRegistration(common, pending2, state);
      }
    } while (drainRequested);
  })().finally(() => {
    drainingSweep = void 0;
  });
  return drainingSweep;
}
var drainWatch = setInterval(() => {
  if (registrations.size) void unregisterDraining().catch(() => {
  });
}, 1e3);
drainWatch.unref();
var outstanding = /* @__PURE__ */ new Map();
async function retireRegistration(common, pending2, state) {
  if (outstanding.has(common) || registrations.get(common) !== pending2) return;
  registrations.delete(common);
  try {
    await state.gate.unregister(state.registration);
  } catch (error) {
    if (!registrations.has(common)) registrations.set(common, pending2);
    if (!(error instanceof StorageRefused && error.reason === "busy")) throw error;
  }
}
async function closeStorageAdmissions() {
  await Promise.allSettled([...startups]);
  await drainingSweep;
  for (const [common, pending2] of [...registrations]) {
    const state = await pending2.catch(() => void 0);
    if (!state) continue;
    if (!fs8.existsSync(common)) {
      registrations.delete(common);
      continue;
    }
    await retireRegistration(common, pending2, state);
  }
  if (!registrations.size) {
    await closeStorageGates();
    gates.clear();
  }
}
process.on("beforeExit", () => {
  void closeStorageAdmissions().catch(() => {
  });
});

// packages/room-mcp/src/offline/room-state.ts
var pause2 = () => new Promise((resolve) => setTimeout(resolve, 25));
async function legacyStatus(commonDir) {
  const gate = openStorageGate(commonDir), status = await gate.status();
  const required = legacyImportRequired(gate.commonDir, status.legacyImport, status.gate);
  return {
    ...status,
    maintenanceRequired: status.maintenanceRequired || required,
    ...required ? { remedy: legacyImportRemedy(gate.commonDir) } : status.refusal?.remedy ? { remedy: status.refusal.remedy } : {}
  };
}
async function withMaintenance(commonDir, fn) {
  const gate = openStorageGate(commonDir), instance = storageInstance();
  const lock = path11.join(gate.commonDir, STORAGE_PATHS.migrationLock);
  const deadline = performance.now() + GATE_LIMITS.migrationLockWaitMs;
  let acquired = false;
  while (performance.now() < deadline) {
    try {
      if (createExclusive(lock, instance)) {
        acquired = true;
        break;
      }
      if (recover(lock, () => true)) continue;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("lease guard busy: "))) throw error;
    }
    await pause2();
  }
  if (!acquired) throw new StorageRefused("maintenance", "migration ownership wait exceeded 30 s; existing owner retained");
  let registration;
  try {
    const before = await gate.status();
    const preRegistryImport = before.gate?.preRegistryImport ?? (preRegistryImportRequired(gate.commonDir) ? "required" : "not-needed");
    registration = await gate.register({ instance, kind: "maintenance", release: plugin_default.version, preRegistryImport });
    const owner = { instance, token: randomBytes5(16).toString("hex") };
    const status = await gate.status();
    if (status.gate?.phase === "draining") await gate.takeOver(owner);
    else await gate.drain(owner);
    try {
      return await fn(gate, owner);
    } catch (error) {
      const latest = await gate.status();
      if (latest.gate?.phase === "draining") throw new StorageRefused(
        "maintenance",
        `gate remains draining at generation ${latest.gate.generation}; ${error instanceof StorageRefused ? error.detail : "maintenance failed"}`.slice(0, 512),
        "after this process exits, run import-legacy (or reopen) from a new room-state.mjs process"
      );
      throw error;
    }
  } finally {
    if (registration) await gate.unregister(registration);
    const releaseDeadline = performance.now() + GATE_LIMITS.migrationLockWaitMs;
    for (; ; ) {
      try {
        compareAndRelease(lock, instance);
        break;
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith("lease guard busy: ")) || performance.now() >= releaseDeadline) throw error;
        await pause2();
      }
    }
  }
}
async function runLegacyImport(commonDir, options = {}) {
  const budget = importBudget(options.mono);
  await withMaintenance(commonDir, async (gate, owner) => {
    const deadline = performance.now() + GATE_LIMITS.drainMs;
    for (; ; ) {
      budget.check();
      const progress = await gate.drain(owner);
      if (progress.complete) break;
      if (performance.now() >= deadline) throw new StorageRefused("maintenance", "drain timed out; gate remains draining; reconcile outstanding tickets before retrying");
      await pause2();
    }
    await importLegacyWorkers(gate.commonDir, owner.instance, { ...options, budget, verify: async () => {
      if (!(await gate.drain(owner)).complete) throw new StorageRefused("maintenance", "legacy import requires a complete drain");
    } });
    budget.check();
    await gate.reopen(owner, { notAfter: budget.notAfter });
  });
}
async function main(argv) {
  try {
    const [command, ...args2] = argv;
    const allowed = /* @__PURE__ */ new Set(["--common-dir", ...command === "status" ? ["--json"] : [], ...command === "resolve-ticket" ? ["--ticket", "--note"] : []]);
    const flags = /* @__PURE__ */ new Map();
    for (let i = 0; i < args2.length; i++) {
      const key = args2[i];
      if (!allowed.has(key) || flags.has(key)) throw new Error("invalid or repeated option");
      if (key === "--json") flags.set(key, "true");
      else {
        const value = args2[++i];
        if (!value || value.startsWith("--")) throw new Error("missing option value");
        flags.set(key, value);
      }
    }
    const common = flags.get("--common-dir");
    if (!common || !["status", "import-legacy", "resolve-ticket", "reopen"].includes(command))
      throw new Error("usage: room-state.mjs status|import-legacy|resolve-ticket|reopen --common-dir <dir>");
    if (command === "status") {
      const status = { ...await legacyStatus(common), ticketListing: await openStorageGate(common).listTickets() };
      process.stdout.write(flags.has("--json") ? `${JSON.stringify(status)}
` : `storage: ${status.gate?.phase ?? status.state}; generation ${status.gate?.generation ?? 0}; registrations ${status.registrations}; tickets ${status.tickets}; legacy import ${status.legacyImport}; maintenance ${status.maintenanceRequired ? "required" : "not required"}${status.remedy ? `
remedy: ${status.remedy}` : ""}
${status.ticketListing.tickets.map((ticket) => `ticket ${ticket.id}: ${ticket.kind}; generation ${ticket.generation}; pid ${ticket.pid}; ${ticket.holderState}`).join("\n")}${status.ticketListing.truncated ? "\nticket listing truncated" : ""}
`);
      return status.maintenanceRequired ? 1 : 0;
    }
    if (command === "import-legacy") await runLegacyImport(common);
    else {
      const ticket = flags.get("--ticket"), note = flags.get("--note");
      if (command === "resolve-ticket" && (!ticket || !note)) throw new Error("resolve-ticket requires --ticket <id> --note <text>");
      await withMaintenance(common, async (gate, owner) => {
        if (command === "resolve-ticket") await gate.resolveDead(owner, ticket, note);
        else {
          const status = await gate.status();
          if (legacyImportRequired(gate.commonDir, status.legacyImport, status.gate))
            throw new StorageRefused("maintenance", "offline legacy import still required", legacyImportRemedy(gate.commonDir));
          await gate.reopen(owner);
        }
      });
    }
    process.stdout.write(command === "resolve-ticket" ? "ticket resolved; gate remains draining\n" : "storage reopened in legacy mode\n");
    return 0;
  } catch (error) {
    const message = error instanceof StorageRefused ? error.message : error instanceof Error && error.message.startsWith("usage:") ? error.message : "storage maintenance failed; inspect gate status and ownership";
    process.stderr.write(`${message.replace(/[\r\n]/g, " ").slice(0, 2048)}
`);
    return 1;
  }
}
export {
  legacyStatus,
  main,
  runLegacyImport,
  withMaintenance
};
