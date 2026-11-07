import { createRequire as __roomCreateRequire } from 'node:module'; import { fileURLToPath as __roomFileURLToPath } from 'node:url'; import { dirname as __roomDirname } from 'node:path'; const require = __roomCreateRequire(import.meta.url); const __filename = __roomFileURLToPath(import.meta.url); const __dirname = __roomDirname(__filename);

// packages/local-state/src/gate-worker.ts
import { parentPort } from "node:worker_threads";

// packages/local-state/src/gate.ts
import fs5 from "node:fs";
import { fileURLToPath } from "node:url";
import path6 from "node:path";
import { randomBytes, randomUUID as randomUUID2, createHash as createHash2 } from "node:crypto";

// packages/local-state/src/leases.ts
import fs4 from "node:fs";
import path5 from "node:path";
import { createHash, randomUUID } from "node:crypto";

// packages/local-state/src/private-state.ts
import fs2 from "node:fs";
import path2 from "node:path";
import { execFile, execFileSync } from "node:child_process";

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

// packages/local-state/src/private-state.ts
function checkWindowsAcl(report, file) {
  const allowed = /* @__PURE__ */ new Set([report.user, "S-1-5-18", "S-1-5-32-544"]);
  if (report.owner !== report.user && report.owner !== "S-1-5-32-544" || report.directory !== false && !report.protected || report.grants.some((sid) => !allowed.has(sid))) {
    throw new Error(`Room state is not private: ${file}; owner ${report.owner}; offending grants ${report.grants.filter((sid) => !allowed.has(sid)).join(", ") || "none"}; DACL must be protected and access restricted to the current user, SYSTEM and Administrators. Use a private local clone, remove broad inherited grants and protect its Room state DACL, then retry`);
  }
}
var verifiedWindows = /* @__PURE__ */ new Map();
var windowsKey = (file) => path2.resolve(file).toLowerCase();
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
    function ReadAcl($path) { if (IsDir $path) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) } };
    # Room's own writers remove files concurrently (atomic-write temps, consumed start tickets). A descendant that
    # vanished during the walk has no access to protect; any other failure still fails the walk. Absence must be
    # reported as not-found by a throwing probe: Exists() also answers false when access is denied.
    function NotFound($e) { while ($e) { if ($e -is [IO.FileNotFoundException] -or $e -is [IO.DirectoryNotFoundException]) { return $true }; $e=$e.InnerException }; $false };
    function Vanished($path, $err) { if (NotFound $err.Exception) { return $true }; try { [IO.File]::GetAttributes($path) | Out-Null; $false } catch { NotFound $_.Exception } };
    function Entries($dir) { try { @([IO.Directory]::EnumerateFileSystemEntries($dir)) } catch { if (Vanished $dir $_) { @() } else { throw } } };
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
    # processes create and remove entries meanwhile: an entry (or directory) reported not found needs no verification;
    # any other failure, access denied included, still refuses.
    $pending=[System.Collections.Generic.Stack[string]]::new(); $pending.Push($p);
    $children=[System.Collections.Generic.List[string]]::new();
    while ($pending.Count -gt 0) {
      foreach ($child in (Entries $pending.Pop())) {
        if ($children.Count -ge 20000) { throw "Room state subtree exceeds the 20000 entry inspection limit: $p (at $child)" };
        try { $attributes=[IO.File]::GetAttributes($child) } catch { if (Vanished $child $_) { continue } else { throw } };
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Room state must not be a symlink or junction: $child" };
        $children.Add($child);
        if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($child) }
      }
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
          # 2/3: file/path not found (removed meanwhile); any other failure, access denied (5) included, refuses.
          if ($LASTEXITCODE -eq 2 -or $LASTEXITCODE -eq 3) { continue };
          if ($LASTEXITCODE -ne 0) { throw "Cannot reset Room state ACL ($LASTEXITCODE): $child" };
          $childAcl=ReadAcl $child; $rules=Rules $childAcl
        };
        if ($childAcl.AreAccessRulesProtected -or @($rules | Where-Object {$_.IsInherited}).Count -eq 0 -or
            @($rules | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $trusted}).Count -gt 0) { throw "Room state descendant is not private: $child" };
      } catch { if (Vanished $child $_) { continue } else { throw } }
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

// packages/local-state/src/process.ts
import { execFile as execFile2, execFileSync as execFileSync2 } from "node:child_process";
import fs3 from "node:fs";
import path4 from "node:path";
function validPid(pid) {
  return Number.isInteger(pid) && pid > 0 && pid <= 2147483647;
}
function pidAlive(pid) {
  if (!validPid(pid)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== "ESRCH";
  }
}
var systemProcessReaders = {
  platform: process.platform,
  readFile: (file) => fs3.readFileSync(file, "utf8"),
  readLink: (file) => fs3.readlinkSync(file),
  exec: (file, args, options) => execFileSync2(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3e3,
    ...options,
    ...file === "ps" ? { env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" } } : {}
  }),
  execAsync: (file, args, options, done) => {
    execFile2(file, args, { encoding: "utf8", windowsHide: true, ...options }, (error, stdout) => done(error, stdout));
  }
};
function readWindowsProcessTable(readers, pid, timeout = 3e3) {
  const args = windowsProcessCommand(pid);
  return args ? parseWindowsProcessTable(readers.exec("powershell.exe", args, { timeout, maxBuffer: WINDOWS_MAX_BUFFER })) : /* @__PURE__ */ new Map();
}
var WINDOWS_SYNC_READ_MS = 1e4;
var WINDOWS_ASYNC_READ_MS = 15e3;
var WINDOWS_MAX_BUFFER = 8 * 1024 * 1024;
var WINDOWS_MAX_IN_FLIGHT = 4;
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
function linuxProcessName(files) {
  const read2 = (file) => {
    try {
      return file();
    } catch {
      return void 0;
    }
  };
  let name = read2(files.comm)?.replace(/\n$/, "") || void 0;
  if (!name || name.length >= 15) {
    const argv0 = read2(files.cmdline)?.split("\0")[0];
    const invoked = argv0 ? path4.basename(argv0) : void 0;
    if (invoked && (!name || invoked.startsWith(name))) name = invoked;
  }
  if (name && !/^\d+(?:\.\d+)+/.test(name)) return name;
  const exe = read2(files.exe)?.replace(/ \(deleted\)$/, "");
  if (exe && /[\\/]claude[\\/]versions[\\/][^\\/]+$/.test(exe)) return "claude";
  return name ?? (exe ? path4.basename(exe) : void 0);
}
function probeProcess(pid, readers) {
  return readers ? probeUncached(pid, readers) : systemProbe(pid);
}
function probeUncached(pid, readers, boottime = () => readers.exec("sysctl", ["-n", "kern.boottime"])) {
  if (!validPid(pid)) return {};
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
var PROBE_TTL_MS = 2e3;
var YOUNG_TTL_MS = 250;
var SETTLED_AFTER_S = 5;
var BOOTTIME_TTL_MS = 6e4;
var CONFIRMED_TTL_MS = 6e4;
var startSeconds = (startTime) => startTime?.startsWith("windows:") ? Date.parse(startTime.slice("windows:".length)) / 1e3 : Number(/^darwin:\d+:(\d+)$/.exec(startTime ?? "")?.[1]);
var agrees = (info, recorded) => (!info.startTime || !recorded.startTime || sameStartTime(info.startTime, recorded.startTime)) && (!info.executable || !recorded.executable || info.executable === recorded.executable);
function createProcessProbe(readers, options = {}) {
  if (readers.platform !== "darwin" && readers.platform !== "win32") {
    const read3 = (pid) => probeUncached(pid, readers);
    return Object.assign(read3, { confirm: read3, fresh: read3, read: async (pid) => read3(pid) });
  }
  const now = options.now ?? (() => performance.now()), wall = options.wall ?? Date.now, alive = readers.alive ?? pidAlive;
  const cache = /* @__PURE__ */ new Map();
  let reads = 0;
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
    const read3 = ++reads;
    return store(pid, probeUncached(pid, readers, boottime), read3);
  };
  const inFlight = /* @__PURE__ */ new Map();
  const readInBackground = (pid) => {
    const pending = inFlight.get(pid);
    if (pending) return pending;
    const args = windowsProcessCommand(pid);
    if (!args || !readers.execAsync || inFlight.size >= WINDOWS_MAX_IN_FLIGHT) return Promise.resolve({});
    const started = ++reads, execAsync = readers.execAsync;
    let settled = false;
    const read3 = new Promise((resolve) => {
      const done = (error, stdout) => {
        if (settled) return;
        settled = true;
        inFlight.delete(pid);
        const row = error ? void 0 : parseWindowsProcessTable(stdout).get(pid);
        const info = row ? { startTime: row.startTime, executable: row.executable } : alive(pid) ? {} : void 0;
        const current = cache.get(pid);
        resolve(current && current.read > started ? current.info : store(pid, info, started));
      };
      try {
        execAsync("powershell.exe", args, { timeout: WINDOWS_ASYNC_READ_MS, maxBuffer: WINDOWS_MAX_BUFFER }, done);
      } catch (error) {
        done(error, "");
      }
    });
    if (!settled) inFlight.set(pid, read3);
    return read3;
  };
  const probe = (pid) => {
    const hit = cache.get(pid);
    if (!validPid(pid)) return {};
    if (!alive(pid)) {
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
    if (!validPid(pid)) return {};
    if (!alive(pid)) return void 0;
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
var systemProbe = createProcessProbe(systemProcessReaders);
var ownIdentity;
var ownRead = false;
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

// packages/local-state/src/leases.ts
function liveness(identity, probe = probeProcess) {
  const verdict = livenessBy(identity, probe);
  return verdict === "dead" && probe === probeProcess && pidAlive(identity.pid) ? livenessBy(identity, (pid) => probeProcessConfirm(pid, identity)) : verdict;
}
function livenessBy(identity, probe) {
  if (!validPid(identity.pid)) return "unknown";
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
var startMarker = (startTime) => createHash("sha256").update(startTime).digest("hex").slice(0, 24);
var tempPattern = /\.roomtmp-p(\d+)-s([a-f0-9]{24}|u)-n[0-9a-f-]{36}\.tmp$/;
function cleanupOrphanTemps(dir, probe = probeProcess, durable = true) {
  let removed = 0;
  for (const name of fs4.readdirSync(dir)) {
    const match = tempPattern.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!validPid(pid) || String(pid) !== match[1]) continue;
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

// packages/local-state/src/protocol.ts
var STORAGE_BUILD = 1;
var GATE_LIMITS = {
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
var STORAGE_PATHS = {
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
  /** Private preflight scratch; each probe uses and removes only its own `p<pid>-n<nonce>` subdirectory. */
  preflightScratch: "room/preflight"
};
var StorageRefused = class extends Error {
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

// packages/local-state/src/gate.ts
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
var bounded = (text, max = MAX_NOTE) => text.replace(/[\r\n\t]/g, " ").slice(0, max);
var object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var positive = (value) => Number.isSafeInteger(value) && value >= 1;
var identityShape = (value) => object(value) && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.startTime === "string" && typeof value.executable === "string";
var tokenShape = (value) => identityShape(value) && object(value) && typeof value.sessionId === "string" && typeof value.nonce === "string" && NONCE.test(value.nonce);
function readRecord(file, max) {
  let stat;
  try {
    stat = fs5.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
  if (!stat.isFile()) throw new Error(`not a regular file: ${path6.basename(file)}`);
  if (stat.size > max) throw new Error(`record exceeds ${max} bytes: ${path6.basename(file)}`);
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
function parseTicket(value, holder, id) {
  if (!object(value) || value.v !== 1 || value.id !== id || value.holder !== holder || !identityShape(value.identity) || typeof value.kind !== "string" || !positive(value.generation) || typeof value.admittedAt !== "number" || value.parent !== void 0 && !(typeof value.parent === "string" && TICKET_ID.test(value.parent)))
    throw new Error("invalid storage ticket");
  return value;
}
var pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
var guardBusy = (error) => error instanceof Error && error.message.startsWith("lease guard busy");
function canonicalLocation(location, allowMissing = true) {
  try {
    return fs5.realpathSync.native(location);
  } catch (error) {
    if (!allowMissing || error.code !== "ENOENT" || path6.dirname(location) === location) throw error;
    return path6.join(canonicalLocation(path6.dirname(location)), path6.basename(location));
  }
}
function sameLocation(a, b) {
  if (!path6.isAbsolute(a) || !path6.isAbsolute(b)) return false;
  try {
    const left = fs5.statSync(a, { bigint: true }), right = fs5.statSync(b, { bigint: true });
    return left.isDirectory() && right.isDirectory() && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if (error.code !== "ENOENT") return false;
    try {
      return canonicalLocation(a) === canonicalLocation(b);
    } catch {
      return false;
    }
  }
}
function canonicalCommonDir(commonDir) {
  let canonical;
  try {
    canonical = canonicalLocation(commonDir, false);
  } catch (error) {
    throw new StorageRefused("unavailable", `common directory unreadable: ${error.code ?? error}`);
  }
  if (!path6.isAbsolute(canonical) || !fs5.existsSync(path6.join(canonical, "HEAD")))
    throw new StorageRefused("unavailable", "not a Git common directory (no HEAD)");
  return canonical;
}
var FileStorageGate = class {
  now;
  alive;
  gateFile;
  registrationDir;
  ticketDir;
  resolutionDir;
  limits;
  /** Last observation, keyed by the gate file's identity. Every publication renames a new file into place. */
  observed;
  commonDir;
  constructor(commonDir, options) {
    this.commonDir = commonDir = canonicalCommonDir(commonDir);
    this.now = options.now ?? Date.now;
    this.alive = options.liveness ?? ((identity) => liveness(identity));
    this.limits = { registrations: GATE_LIMITS.registrations, tickets: GATE_LIMITS.tickets, scanBatch: GATE_LIMITS.scanBatch, ...options.limits };
    this.gateFile = path6.join(commonDir, STORAGE_PATHS.gate);
    this.registrationDir = path6.join(commonDir, STORAGE_PATHS.registrations);
    this.ticketDir = path6.join(commonDir, STORAGE_PATHS.tickets);
    this.resolutionDir = path6.join(commonDir, STORAGE_PATHS.resolutions);
  }
  // ---- primitives ------------------------------------------------------------------------------------------
  /** Short synchronous critical section on the gate guard; waits only outside it, bounded by guardWaitMs. */
  async guarded(fn, repairing = false) {
    const deadline = performance.now() + GATE_LIMITS.guardWaitMs;
    for (let attempt = 0; ; attempt++) {
      try {
        return withGuard(path6.join(this.commonDir, "room-storage-location"), () => {
          if (!repairing) this.readGate();
          return fn();
        }, void 0, { durable: false });
      } catch (error) {
        if (error instanceof StorageRefused) throw error;
        if (!guardBusy(error)) throw new StorageRefused("unavailable", bounded(`storage gate I/O failed: ${error.message ?? error}`), REMEDY);
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new StorageRefused("unavailable", "storage gate guard busy", REMEDY);
        await pause(Math.min(remaining, Math.min(50, 2 + attempt * 3) + Math.random() * 5));
      }
    }
  }
  readGate(allowForeign = false) {
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
    if (!allowForeign && gate.commonDir !== this.commonDir && !this.sameDirectory(gate.commonDir)) throw this.locationMismatch(gate.commonDir);
    return gate;
  }
  relocationCommand() {
    const entry = fileURLToPath(new URL(import.meta.url.endsWith(".mjs") ? "./room-state.mjs" : "../../../plugins/room/server/room-state.mjs", import.meta.url));
    const quote = (value) => process.platform === "win32" ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\\''") + "'";
    return `node ${quote(entry)} repair-location --common-dir ${quote(this.commonDir)}`;
  }
  locationMessage(old) {
    const command = this.relocationCommand();
    return `This repository's Room state was recorded at \`${old}\`; it is now at \`${this.commonDir}\`. If you moved it, run: \`${command} --confirm-moved\`. If it is a copy, run: \`${command} --confirm-copied\`.`;
  }
  locationMismatch(old) {
    return new StorageRefused("incompatible", this.locationMessage(old));
  }
  relocationRefused(detail) {
    const old = this.readGate(true)?.commonDir ?? "the recorded location";
    return new StorageRefused("incompatible", detail, this.locationMessage(old));
  }
  sameDirectory(old) {
    try {
      const source = fs5.statSync(old, { bigint: true }), current = fs5.statSync(this.commonDir, { bigint: true });
      return source.isDirectory() && current.isDirectory() && source.ino !== 0n && source.dev === current.dev && source.ino === current.ino;
    } catch {
      return false;
    }
  }
  checkLocationChoice(old, cloneId, copied) {
    if (this.sameDirectory(old)) {
      if (copied) throw this.relocationRefused("--confirm-copied refused: recorded and current paths are the same directory");
      return;
    }
    if (!copied) {
      let source;
      try {
        source = parseGate(readRecord(path6.join(old, STORAGE_PATHS.gate), MAX_GATE_BYTES));
      } catch {
      }
      if (source?.cloneId === cloneId)
        throw this.relocationRefused("--confirm-moved refused: a different directory at the recorded path holds the same cloneId, evidence of a copy; use --confirm-copied");
    }
  }
  /** Explicit confirmation resolves location ambiguity, never process ownership or storage phase. */
  async repairLocation(mode) {
    await this.guarded(() => {
      if (this.completeRelocation(mode)) return;
      const gate = this.readGate(true);
      if (!gate) return;
      const old = gate.commonDir;
      const alias = this.sameDirectory(old);
      if (mode === "copied" && alias) this.checkLocationChoice(old, gate.cloneId, true);
      if (old === this.commonDir) return;
      if (!mode && !alias) throw this.locationMismatch(old);
      if (mode && gate.phase !== "legacy") throw this.relocationRefused(`relocation requires legacy phase; found ${gate.phase}`);
      if (alias && !mode) {
        writeAtomic(this.gateFile, { ...gate, commonDir: this.commonDir });
        process.stderr.write(`Room location alias: ${old} -> ${this.commonDir}
`);
        return;
      }
      const copied = mode === "copied";
      this.checkLocationChoice(old, gate.cloneId, copied);
      if (!copied) this.checkRelocationRoots(old);
      for (const name of this.registrationNames()) {
        const registration = this.readRegistration(name.slice(0, -5));
        if (registration && this.alive(registration.instance) !== "dead")
          throw this.relocationRefused("relocation blocked by a live or unknown registration");
      }
      for (const name of this.ticketNames()) {
        const [, holder, id] = TICKET_FILE.exec(name);
        const ticket = parseTicket(readRecord(path6.join(this.ticketDir, name), MAX_RECORD_BYTES), holder, id);
        if (this.alive(ticket.identity) !== "dead") throw this.relocationRefused("relocation blocked by a live or unknown ticket");
      }
      if (gate.owner && this.alive(gate.owner.instance) !== "dead") throw this.relocationRefused("relocation blocked by a live or unknown maintenance owner");
      const room = path6.join(this.commonDir, "room");
      this.checkRelocationHolders(room);
      if (alias) {
        writeAtomic(this.gateFile, { ...gate, commonDir: this.commonDir });
        process.stderr.write(`Room location alias: ${old} -> ${this.commonDir}
`);
        return;
      }
      if (!copied) this.planRebindRecords(old);
      const sourceDigest = copied ? void 0 : this.relocationDigest(room);
      const aside = copied ? `room.copied-${this.now()}-${randomBytes(6).toString("hex")}` : void 0;
      const fresh = copied ? { cloneId: randomBytes(16).toString("hex"), relocationNonce: randomBytes(16).toString("hex") } : void 0;
      writeAtomic(path6.join(this.commonDir, "room-location-pending.json"), { v: 1, gate, current: this.commonDir, copied, aside, fresh, sourceDigest });
      this.completeRelocation();
    }, true);
  }
  completeRelocation(mode, inspect = false) {
    const journal = path6.join(this.commonDir, "room-location-pending.json");
    const raw = readRecord(journal, MAX_GATE_BYTES);
    if (raw === void 0) return false;
    if (!object(raw) || raw.v !== 1 || typeof raw.current !== "string" || !sameLocation(raw.current, this.commonDir) || typeof raw.copied !== "boolean" || raw.copied && (typeof raw.aside !== "string" || !/^room\.copied-[0-9]+-[a-f0-9]{12}$/.test(raw.aside)))
      throw this.relocationRefused("invalid relocation journal; preserve it for inspection");
    let original;
    try {
      original = parseGate(raw.gate);
    } catch {
      throw this.relocationRefused("invalid relocation journal source");
    }
    const fresh = raw.fresh;
    if (raw.copied && (!object(fresh) || typeof fresh.cloneId !== "string" || !/^[a-f0-9]{32}$/.test(fresh.cloneId) || typeof fresh.relocationNonce !== "string" || !/^[a-f0-9]{32}$/.test(fresh.relocationNonce)))
      throw this.relocationRefused("invalid relocation journal destination identity");
    if (!path6.isAbsolute(original.commonDir)) throw this.relocationRefused("invalid relocation journal source location");
    const old = canonicalLocation(original.commonDir);
    if (sameLocation(original.commonDir, this.commonDir)) throw this.relocationRefused("invalid relocation journal source location");
    const room = path6.join(this.commonDir, "room");
    const aside = raw.copied ? path6.join(this.commonDir, raw.aside) : void 0;
    const matches = (gate, rebound = false) => gate && gate.cloneId === original.cloneId && gate.generation === original.generation && gate.phase === "legacy" && (sameLocation(gate.commonDir, old) || rebound && sameLocation(gate.commonDir, this.commonDir));
    if (original.phase !== "legacy") throw this.relocationRefused("relocation requires legacy phase");
    const current = this.readGate(true);
    const ownDestination = !!(raw.copied && object(fresh) && current && current.cloneId === fresh.cloneId && current.relocationNonce === fresh.relocationNonce && sameLocation(current.commonDir, this.commonDir));
    if (mode && mode === "copied" !== raw.copied) {
      const archived = !!aside && fs5.existsSync(aside);
      const untouched = matches(current) && !archived && (raw.copied || typeof raw.sourceDigest === "string" && raw.sourceDigest === this.relocationDigest(room));
      if (!untouched) {
        const state = archived ? ownDestination ? "copy archive and fresh gate published" : "copy archive renamed" : current && sameLocation(current.commonDir, this.commonDir) ? "move gate published" : raw.sourceDigest ? "move records changed" : "move progress cannot be verified (older journal)";
        throw this.relocationRefused(`cannot switch relocation mode: ${state}; resume with --confirm-${raw.copied ? "copied" : "moved"} before choosing another operation`);
      }
      fs5.unlinkSync(journal);
      syncDirectoryQuietly(this.commonDir);
      return false;
    }
    if (aside && fs5.existsSync(aside)) {
      if (!fs5.lstatSync(aside).isDirectory()) throw this.relocationRefused("relocation archive is not a directory");
      let archived;
      try {
        archived = parseGate(readRecord(path6.join(aside, "storage-gate.json"), MAX_GATE_BYTES));
      } catch {
        throw this.relocationRefused("relocation archive source cannot be verified");
      }
      if (!matches(archived)) throw this.relocationRefused("relocation archive source mismatch");
      this.checkRelocationHolders(aside);
      if (current && !ownDestination) throw this.relocationRefused("relocation archive already exists alongside a foreign gate; inspect journal");
    } else {
      if (!matches(current, !aside)) throw this.relocationRefused("stale or foreign relocation journal");
      this.checkRelocationHolders(room);
    }
    if (inspect) {
      const stage = aside ? fs5.existsSync(aside) ? ownDestination ? "copy archive and fresh gate published" : "copy archive renamed" : "copy archive not yet renamed" : current && sameLocation(current.commonDir, this.commonDir) ? "move gate published" : typeof raw.sourceDigest === "string" ? raw.sourceDigest === this.relocationDigest(room) ? "move source unchanged" : "move records changed" : "move progress cannot be verified (older journal)";
      throw new StorageRefused(
        "incompatible",
        `pending relocation requires recovery: ${raw.copied ? "copied" : "moved"}; old path: ${old}; new path: ${this.commonDir}${aside ? `; archive: ${aside}` : ""}; stage: ${stage}`,
        `${this.relocationCommand()} --confirm-${raw.copied ? "copied" : "moved"}`
      );
    }
    if (aside && fs5.existsSync(aside) && !ownDestination) this.cleanRelocationDestination(room);
    if (!ownDestination) this.checkLocationChoice(old, original.cloneId, raw.copied);
    if (aside) {
      if (!fs5.existsSync(aside)) fs5.renameSync(room, aside);
      privateStateDirectory(room);
      if (!ownDestination) this.initialize("not-needed", fresh);
    } else {
      this.checkRelocationRoots(old);
      if (!current || !sameLocation(current.commonDir, this.commonDir)) {
        this.planRebindRecords(original.commonDir)();
        this.publish({ ...original, commonDir: this.commonDir });
      }
    }
    const notice = `Room ${raw.copied ? "copied" : "moved"}: ${old} -> ${this.commonDir}${aside ? `; previous state preserved at ${aside}` : ""}${fs5.existsSync(path6.join(this.commonDir, "worktrees")) ? "; linked worktrees may require git worktree repair" : ""}`;
    const noticeFile = path6.join(room, "location-notice.json");
    const previous = readRecord(noticeFile, MAX_GATE_BYTES);
    if (!object(previous) || previous.notice !== notice) {
      writeAtomic(noticeFile, { v: 1, old, current: this.commonDir, copied: raw.copied, aside, notice });
      process.stderr.write(`${notice}
`);
    }
    fs5.unlinkSync(journal);
    syncDirectoryQuietly(this.commonDir);
    return true;
  }
  /** Only reclaim known scratch with a verified-gone writer; unknown evidence stays for inspection. */
  cleanRelocationDestination(room) {
    if (!fs5.existsSync(room)) return;
    const refuse = () => {
      throw this.relocationRefused("relocation destination is not empty");
    };
    if (!fs5.lstatSync(room).isDirectory()) refuse();
    const scratch = path6.join(room, "preflight");
    const children = [];
    for (const entry of fs5.readdirSync(room, { withFileTypes: true })) {
      if (entry.name === "preflight" && entry.isDirectory()) {
        for (const child of fs5.readdirSync(scratch, { withFileTypes: true })) {
          const match = /^p([1-9][0-9]*)-n[a-f0-9]{16}$/.exec(child.name);
          const pid = match ? Number(match[1]) : NaN;
          if (!child.isDirectory() || !Number.isSafeInteger(pid) || pidAlive(pid)) refuse();
          const dir = path6.join(scratch, child.name);
          for (const file of fs5.readdirSync(dir, { withFileTypes: true })) {
            if (!file.isFile() || !["probe.sqlite", "probe.sqlite-wal", "probe.sqlite-shm"].includes(file.name)) refuse();
          }
          children.push(dir);
        }
      } else if (!entry.isFile()) refuse();
    }
    cleanupOrphanTemps(room);
    for (const dir of children) {
      for (const name of fs5.readdirSync(dir)) fs5.unlinkSync(path6.join(dir, name));
      fs5.rmdirSync(dir);
    }
    if (fs5.readdirSync(room, { withFileTypes: true }).some((entry) => entry.name !== "preflight" || !entry.isDirectory())) refuse();
  }
  /** Disjoint prefixes make every location rewrite a fixed point, including crash replay. */
  checkRelocationRoots(old) {
    const from = path6.basename(old) === ".git" ? path6.dirname(old) : old;
    const to = path6.basename(old) === ".git" ? path6.dirname(this.commonDir) : this.commonDir;
    const normalize = (root) => {
      const resolved = canonicalLocation(root);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const a = normalize(from), b = normalize(to);
    if (a !== b && (a.startsWith(b + path6.sep) || b.startsWith(a + path6.sep)))
      throw this.relocationRefused("overlapping relocation roots; use --confirm-copied to preserve state aside");
  }
  checkRelocationHolders(dir) {
    const dead = (identity) => {
      if (!identityShape(identity) || this.alive(identity) !== "dead")
        throw this.relocationRefused("relocation blocked by a live or unknown recorded process");
    };
    const hasPid = (value) => Array.isArray(value) ? value.some(hasPid) : object(value) && Object.entries(value).some(([key, item]) => /pid$/i.test(key) || hasPid(item));
    const check = (value, name) => {
      if (name.endsWith(".report.json")) {
        if (!object(value) || !Array.isArray(value.chain)) dead(void 0);
        const report = value;
        const chain = report.chain;
        dead(chain[0]);
        dead(report.hostProcess !== void 0 ? report.hostProcess : chain[1]);
      } else if (name === "session.json") {
        if (!object(value)) dead(void 0);
        const session = value;
        const interpreter = /^(?:sh|bash|dash|zsh|fish|cmd|powershell|pwsh)(?:\.exe)?$/i;
        if ("chain" in session) {
          const chain = Array.isArray(session.chain) ? session.chain : [];
          const first = chain[0];
          const host = identityShape(first) && interpreter.test(first.executable) ? chain[1] : first;
          if (!identityShape(host) || !host.executable || interpreter.test(host.executable))
            throw this.relocationRefused("cannot verify session host identity");
          dead(host);
        } else dead({ pid: session.hostPid, startTime: "", executable: "" });
      } else if (object(value) && name === "storage-gate.json") {
        if (object(value.owner)) dead(value.owner.instance);
      } else if (object(value) && dir === this.registrationDir) {
        dead(value.instance);
      } else if (object(value) && /storage-gate[/\\](registrations|tickets)$/.test(dir)) {
        dead(value.instance ?? value.identity);
      } else if (object(value) && /[/\\]workers$/.test(dir) && name.endsWith(".json")) {
        if (!object(value.lead) || !Array.isArray(value.runs)) dead(void 0);
        dead(value.lead.instance);
        for (const run of value.runs) {
          dead(run.launcher);
          if (object(run.launch) && run.launch.outcome === "launched")
            dead(run.launch.process ?? { pid: run.launch.pid, startTime: "", executable: "" });
          else if (object(run.launch) && run.launch.outcome === "ambiguous") dead(void 0);
        }
      } else if (object(value) && (name.endsWith(".op") || name.endsWith(".writer") || name.endsWith(".lock") || name.endsWith(".guard") || /[/\\](publishers|collect|tags|adoptions)$/.test(dir))) {
        dead(value.holder ?? value);
        if (object(value.requested)) dead(value.requested.holder);
      } else if (object(value) && (name === "relay.json" || value.runtime === "daemon-client")) {
        dead(value);
        if (object(value.worker)) dead(value.worker.host);
      } else if (hasPid(value)) {
        throw this.relocationRefused(`relocation blocked by a live or unknown record kind: ${name}`);
      }
    };
    for (const entry of fs5.readdirSync(dir, { withFileTypes: true })) {
      const file = path6.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw this.relocationRefused(`cannot relocate symbolic link ${entry.name}`);
      if (entry.isDirectory()) this.checkRelocationHolders(file);
      else if (entry.name.endsWith(".json") || entry.name.endsWith(".lock") || entry.name.endsWith(".op") || entry.name.endsWith(".writer") || entry.name.endsWith(".guard")) {
        try {
          check(readRecord(file, 16 * 1024 * 1024), entry.name);
        } catch (error) {
          if (error instanceof StorageRefused) throw error;
          throw this.relocationRefused(`cannot verify relocation record ${entry.name}`);
        }
      }
    }
  }
  /** Fingerprint source bytes and names to prove an intent has not changed state. */
  relocationDigest(dir) {
    const hash = createHash2("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const walk = (root) => {
      for (const entry of fs5.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path6.join(root, entry.name);
        hash.update(JSON.stringify([path6.relative(dir, file), entry.isDirectory()]));
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) {
          const content = createHash2("sha256"), fd = fs5.openSync(file, "r");
          try {
            for (; ; ) {
              const size = fs5.readSync(fd, buffer, 0, buffer.length, null);
              if (!size) break;
              content.update(buffer.subarray(0, size));
            }
          } finally {
            fs5.closeSync(fd);
          }
          hash.update(content.digest());
        } else throw this.relocationRefused("cannot verify relocation source entry");
      }
    };
    walk(dir);
    return hash.digest("hex");
  }
  /** Validate the complete rewrite before returning any mutations. */
  planRebindRecords(old) {
    const room = path6.join(this.commonDir, "room");
    const oldRoot = canonicalLocation(path6.basename(old) === ".git" ? path6.dirname(old) : old);
    const newRoot = path6.basename(old) === ".git" ? path6.dirname(this.commonDir) : this.commonDir;
    const relocate = (value) => {
      const canonical = canonicalLocation(value);
      return canonical === oldRoot ? newRoot : canonical.startsWith(oldRoot + path6.sep) ? newRoot + canonical.slice(oldRoot.length) : canonical;
    };
    const hash = (value) => createHash2("sha256").update(value).digest("hex");
    const fields = /* @__PURE__ */ new Set(["dir", "commonDir", "worktree", "keptWorktree", "leadDir", "cwd", "gitDir", "sessionDir", "logDir", "logFile", "reportFile", "exitFile", "path"]);
    const visit = (value) => {
      if (Array.isArray(value)) return value.map(visit);
      if (!object(value)) return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key.startsWith("worktree:") ? `worktree:${relocate(key.slice(9))}` : key,
        typeof item === "string" && fields.has(key) && path6.isAbsolute(item) ? relocate(item) : key === "clone" && item === hash(old) ? hash(this.commonDir) : visit(item)
      ]));
    };
    const actions = [];
    const targets = /* @__PURE__ */ new Set();
    const reserve = (target, detail) => {
      if (fs5.existsSync(target) || targets.has(target)) throw this.relocationRefused(detail);
      targets.add(target);
    };
    const walk = (dir) => {
      for (const entry of fs5.readdirSync(dir, { withFileTypes: true })) {
        const file = path6.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw this.relocationRefused(`cannot relocate symbolic link ${path6.relative(room, file)}`);
        if (entry.isDirectory()) {
          walk(file);
          continue;
        }
        if (!entry.name.endsWith(".json") || file === this.gateFile || entry.name === "location-notice.json") continue;
        const raw = readRecord(file, 16 * 1024 * 1024);
        const next = visit(raw);
        if (JSON.stringify(raw) !== JSON.stringify(next)) actions.push(() => writeAtomic(file, next));
        if (["publishers", "collect"].includes(path6.basename(dir)) && object(next) && typeof next.worktree === "string") {
          const target = path6.join(dir, `${hash(next.worktree)}.json`);
          if (target !== file) {
            reserve(target, "lease relocation target already exists");
            actions.push(() => {
              fs5.renameSync(file, target);
              syncDirectoryQuietly(dir);
            });
          }
        }
      }
    };
    const destinations = /* @__PURE__ */ new Map([[hash(oldRoot), hash(newRoot)], [hash(newRoot), hash(newRoot)]]);
    const collectPaths = (value) => {
      if (Array.isArray(value)) value.forEach(collectPaths);
      else if (object(value)) for (const [key, item] of Object.entries(value)) {
        if (fields.has(key) && typeof item === "string" && path6.isAbsolute(item)) {
          destinations.set(hash(item), hash(relocate(item)));
          if (item === newRoot || item.startsWith(newRoot + path6.sep)) destinations.set(hash(oldRoot + item.slice(newRoot.length)), hash(item));
        }
        collectPaths(item);
      }
    };
    const scan = (dir) => {
      for (const entry of fs5.readdirSync(dir, { withFileTypes: true })) {
        const file = path6.join(dir, entry.name);
        if (entry.isDirectory()) scan(file);
        else if (entry.isFile() && entry.name.endsWith(".json")) collectPaths(readRecord(file, 16 * 1024 * 1024));
      }
    };
    scan(room);
    const holds = path6.join(room, "registry", "collection-reviews");
    const renames = [];
    for (const name of this.names(holds)) {
      if (!name.endsWith(".json")) continue;
      const source = path6.join(holds, name), key = name.slice(0, -5), mapped = destinations.get(key);
      const value = readRecord(source, MAX_GATE_BYTES);
      if (!mapped && !(Array.isArray(value) && value.length === 0))
        throw this.relocationRefused("collection review destination cannot be proven; use --confirm-copied to preserve state aside");
      if (mapped && mapped !== key) {
        const target = path6.join(holds, `${mapped}.json`);
        reserve(target, "collection review relocation target already exists");
        renames.push([source, target]);
      }
    }
    walk(room);
    return () => {
      for (const action of actions) action();
      for (const [source, target] of renames) fs5.renameSync(source, target);
      if (renames.length) syncDirectoryQuietly(holds);
    };
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
  ticketFile(holder, id) {
    return path6.join(this.ticketDir, `${holder}.${id}.json`);
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
  initialize(preRegistryImport, fresh) {
    if (this.activationEvidence()) throw new StorageRefused("unavailable", "storage activation evidence exists without a storage gate", "preserve room/state.sqlite and the activation marker; repair the gate with the offline command");
    privateStateDirectory(path6.join(this.commonDir, "room"));
    const gate = {
      v: 1,
      cloneId: randomBytes(16).toString("hex"),
      ...fresh,
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
    await this.repairLocation();
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
    const capacity = () => {
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
    writeAtomic(file, ticket, { durable: false });
    try {
      const after = this.requireGate();
      if (after.generation !== before.generation || after.phase !== before.phase) {
        if (!parent) throw new StorageRefused("maintenance", `Room storage maintenance in progress (generation ${after.generation}, ${after.phase})`, REMEDY);
        permitted(after);
      }
      capacity();
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
    this.readGate();
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
        const [, holder, id] = TICKET_FILE.exec(name);
        let ticket;
        try {
          const raw = readRecord(path6.join(this.ticketDir, name), MAX_RECORD_BYTES);
          if (raw === void 0) {
            gone.add(name);
            continue;
          }
          ;
          ticket = parseTicket(raw, holder, id);
        } catch {
          unknown.push({ id, kind: "reconcile", generation: 0, holder, pid: 0, admittedAt: 0 });
          continue;
        }
        const view = {
          id,
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
      if (fs5.existsSync(path6.join(this.commonDir, "room-location-pending.json"))) {
        try {
          this.completeRelocation(void 0, true);
        } catch (error) {
          if (error instanceof StorageRefused && error.detail.startsWith("pending relocation requires recovery:")) throw error;
          throw new StorageRefused(
            "incompatible",
            `pending relocation cannot be verified: ${error instanceof StorageRefused ? error.detail : error.message}`,
            "preserve the relocation journal and source state for inspection"
          );
        }
      }
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
      ...gate.commonDir !== this.commonDir ? { locationUpdate: { recorded: gate.commonDir, canonical: this.commonDir } } : {},
      ...maintenance ? { refusal: { reason: "maintenance", detail: `generation ${gate.generation} is ${gate.phase}`, remedy: REMEDY } } : {}
    };
  }
  async listTickets(limit = this.limits.scanBatch) {
    this.readGate();
    const names = this.ticketNames().sort();
    const bound = Math.max(0, Math.min(limit, this.limits.scanBatch));
    const tickets = [], gone = /* @__PURE__ */ new Set();
    for (const name of names.slice(0, bound)) {
      const [, holder, id] = TICKET_FILE.exec(name);
      try {
        const raw = readRecord(path6.join(this.ticketDir, name), MAX_RECORD_BYTES);
        if (raw === void 0) {
          gone.add(name);
          continue;
        }
        const ticket = parseTicket(raw, holder, id);
        tickets.push({
          id,
          kind: ticket.kind,
          generation: ticket.generation,
          holder,
          pid: ticket.identity.pid,
          ...ticket.parent ? { parent: ticket.parent } : {},
          admittedAt: ticket.admittedAt,
          holderState: this.alive(ticket.identity)
        });
      } catch {
        tickets.push({ id, kind: "reconcile", generation: 0, holder, pid: 0, admittedAt: 0, holderState: "unreadable" });
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

// packages/local-state/src/gate-worker.ts
if (!parentPort) throw new Error("storage gate worker requires a parent port");
parentPort.on("message", async ({ id, commonDir, options, method, args }) => {
  let response;
  try {
    const gate = new FileStorageGate(commonDir, options);
    const invoke = gate[method];
    response = { id, value: await invoke.apply(gate, args) };
  } catch (error) {
    response = { id, error: error instanceof StorageRefused ? { reason: error.reason, detail: error.detail, remedy: error.remedy } : { detail: String(error.message ?? error).slice(0, 512), code: error.code } };
  }
  parentPort.postMessage(response);
});
