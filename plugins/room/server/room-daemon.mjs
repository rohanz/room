#!/usr/bin/env node
import { createRequire as __roomCreateRequire } from 'node:module'; import { fileURLToPath as __roomFileURLToPath } from 'node:url'; import { dirname as __roomDirname } from 'node:path'; const require = __roomCreateRequire(import.meta.url); const __filename = __roomFileURLToPath(import.meta.url); const __dirname = __roomDirname(__filename);

// packages/relay/src/daemon-bin.ts
import fs5 from "node:fs";

// packages/local-state/src/preflight.ts
import fs4 from "node:fs";
import path4 from "node:path";
import { randomBytes } from "node:crypto";

// packages/local-state/src/filesystem.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
var QUALIFIED = /* @__PURE__ */ new Set(["apfs", "ext4", "ntfs"]);
var COMMAND_TIMEOUT_MS = 3e3;
var run = (command, args2) => new Promise((resolve, reject) => {
  execFile(
    command,
    args2,
    { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout)
  );
});
var systemFilesystemReaders = {
  platform: process.platform,
  realpath: (file) => fs.promises.realpath(file),
  statfsType: (file) => fs.promises.statfs(file).then((stat) => stat.type, () => void 0),
  macMounts: () => run("/sbin/mount", []),
  linuxMountinfo: () => fs.promises.readFile("/proc/self/mountinfo", "utf8"),
  windowsDriveType: (drive) => run("fsutil", ["fsinfo", "drivetype", drive]),
  windowsVolumeInfo: (drive) => run("fsutil", ["fsinfo", "volumeinfo", `${drive}\\`]),
  home: () => os.homedir(),
  env: process.env
};
var result = (kind, detail, file) => ({ kind, detail: detail.slice(0, 256), path: file, journal: QUALIFIED.has(kind) ? "wal" : "refuse" });
function synchronizedRoot(file, readers) {
  const home = readers.home(), paths = readers.platform === "win32" ? path.win32 : path.posix;
  const roots = [
    paths.join(home, "Library", "Mobile Documents"),
    // iCloud Drive
    paths.join(home, "Library", "CloudStorage"),
    // File Provider clients (Dropbox, OneDrive, Google Drive, Box)
    paths.join(home, "Dropbox"),
    ...[readers.env.OneDrive, readers.env.OneDriveConsumer, readers.env.OneDriveCommercial].filter((value) => !!value)
  ];
  const normalize = (value) => readers.platform === "win32" ? value.toLowerCase() : value;
  const target = normalize(file);
  return roots.find((root) => {
    const prefix = normalize(root);
    return target === prefix || target.startsWith(prefix + paths.sep);
  });
}
function longestMount(mounts, file) {
  return mounts.filter((mount) => file === mount.point || file.startsWith(mount.point.endsWith("/") ? mount.point : `${mount.point}/`)).sort((a, b) => b.point.length - a.point.length)[0];
}
async function classifyMac(file, readers, statfs) {
  const mounts = (await readers.macMounts()).split("\n").flatMap((line) => {
    const match = / on (.+) \(([^,)]+)((?:, [^)]*)?)\)$/.exec(line);
    return match ? [{ point: match[1], type: match[2], flags: match[3].split(", ").filter(Boolean) }] : [];
  });
  const mount = longestMount(mounts, file);
  if (!mount) return result("unknown", `${statfs}; no mount covers the path`, file);
  const detail = `${statfs}; mount ${mount.type} at ${mount.point} (${mount.flags.join(",")})`;
  if (["nfs", "smbfs", "afpfs", "webdav", "cifs", "ftp", "osxfuse", "macfuse", "fuse"].includes(mount.type)) return result("network", detail, file);
  if (!mount.flags.includes("local")) return result("network", detail, file);
  return result(mount.type === "apfs" ? "apfs" : "other-local", detail, file);
}
var LINUX_NETWORK = /* @__PURE__ */ new Set(["nfs", "nfs4", "cifs", "smb3", "smbfs", "ceph", "glusterfs", "9p", "virtiofs", "afs", "lustre", "gpfs", "ocfs2", "gfs2", "beegfs"]);
var LINUX_LOCAL = /* @__PURE__ */ new Set(["ext2", "ext3", "btrfs", "xfs", "zfs", "f2fs", "tmpfs", "overlay", "bcachefs", "jfs", "reiserfs", "vfat", "exfat", "ntfs3"]);
async function classifyLinux(file, readers, statfs) {
  const mounts = (await readers.linuxMountinfo()).split("\n").flatMap((line) => {
    const [left, right] = line.split(" - ");
    if (!left || !right) return [];
    const fields = left.split(" "), point = fields[4]?.replace(/\\(\d{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const type = right.split(" ")[0];
    return point && type ? [{ point, type }] : [];
  });
  const mount = longestMount(mounts, file);
  if (!mount) return result("unknown", `${statfs}; no mount covers the path`, file);
  const detail = `${statfs}; mount ${mount.type} at ${mount.point}`;
  if (mount.type === "ext4") return result("ext4", detail, file);
  if (LINUX_NETWORK.has(mount.type) || mount.type.startsWith("fuse.sshfs") || mount.type === "fuse.rclone") return result("network", detail, file);
  if (mount.type.startsWith("fuse")) return result("unknown", detail, file);
  return result(LINUX_LOCAL.has(mount.type) ? "other-local" : "unknown", detail, file);
}
async function classifyWindows(file, readers) {
  if (/^\\\\(\?\\UNC\\|[^?.])/i.test(file)) return result("network", "UNC path", file);
  const drive = /^(?:\\\\\?\\)?([A-Za-z]:)/.exec(file)?.[1];
  if (!drive) return result("unknown", "no drive letter", file);
  let type, volume;
  try {
    type = await readers.windowsDriveType(drive);
  } catch (error) {
    return result("unknown", `drive type unavailable: ${error.message}`, file);
  }
  if (/remote|network/i.test(type)) return result("network", type.trim(), file);
  if (!/fixed/i.test(type)) return result("unknown", type.trim(), file);
  try {
    volume = await readers.windowsVolumeInfo(drive);
  } catch (error) {
    return result("unknown", `volume information unavailable: ${error.message}`, file);
  }
  const name = /File System Name\s*:\s*(\S+)/i.exec(volume)?.[1];
  if (!name) return result("unknown", "file system name missing", file);
  return result(name.toUpperCase() === "NTFS" ? "ntfs" : "other-local", `${type.trim()}; ${name}`, file);
}
async function detectFilesystem(target, readers = systemFilesystemReaders) {
  let file;
  try {
    file = await readers.realpath(target);
  } catch (error) {
    return result("unknown", `unresolvable path: ${error.code ?? error}`, target);
  }
  const synced = synchronizedRoot(file, readers);
  if (synced) return result("synchronized", `inside synchronized folder ${synced}`, file);
  const type = await readers.statfsType(file);
  const statfs = type === void 0 ? "statfs unavailable" : `statfs 0x${type.toString(16)}`;
  try {
    if (readers.platform === "darwin") return await classifyMac(file, readers, statfs);
    if (readers.platform === "linux") return await classifyLinux(file, readers, statfs);
    if (readers.platform === "win32") return await classifyWindows(file, readers);
  } catch (error) {
    return result("unknown", `${statfs}; mount information unavailable: ${error.message}`, file);
  }
  return result("unknown", `${statfs}; unsupported platform ${readers.platform}`, file);
}

// packages/local-state/src/private-state.ts
import fs3 from "node:fs";
import path3 from "node:path";
import { execFile as execFile2, execFileSync } from "node:child_process";

// packages/local-state/src/private-core.ts
import fs2 from "node:fs";
import path2 from "node:path";
function privateDirectoryPath(dir) {
  dir = path2.resolve(dir);
  const directories = [dir];
  let root = dir;
  while (path2.basename(root) !== "room" && path2.dirname(root) !== root) {
    root = path2.dirname(root);
    directories.unshift(root);
    if (directories.length > 64) throw new Error(`Room state directory path is too deep: ${dir}`);
  }
  return { directories, root, inState: path2.basename(root) === "room" };
}
function verifyPosixPath(file, stat = fs2.lstatSync(file)) {
  if (stat.isSymbolicLink() || !process.getuid || stat.uid !== process.getuid() || (stat.mode & 63) !== 0) {
    throw new Error(`Room state must be owned by the current user and private: ${file}`);
  }
}
function initializePrivateDirectory(dir, repair) {
  let created = false;
  try {
    fs2.mkdirSync(dir, { mode: 448 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs2.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Room state path must be a directory, not a symlink or junction: ${dir}`);
  if (process.platform === "win32") return;
  if (!process.getuid || stat.uid !== process.getuid()) throw new Error(`Room state must be owned by the current user and private: ${dir}`);
  if (created || repair && (stat.mode & 511) !== 448) {
    const fd = fs2.openSync(dir, fs2.constants.O_RDONLY | fs2.constants.O_NOFOLLOW | fs2.constants.O_DIRECTORY);
    try {
      const opened = fs2.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.uid !== process.getuid()) throw new Error(`Room state must be owned by the current user and private: ${dir}`);
      fs2.fchmodSync(fd, 448);
    } finally {
      fs2.closeSync(fd);
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
var windowsKey = (file) => path3.resolve(file).toLowerCase();
function windowsIdentity(file) {
  try {
    const stat = fs3.lstatSync(file, { bigint: true });
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
    ${repair ? `# Count and reject reparse points before the root ACL can propagate through an oversized subtree.
    $pending=[System.Collections.Generic.Stack[string]]::new(); $pending.Push($p);
    $children=[System.Collections.Generic.List[string]]::new();
    while ($pending.Count -gt 0) {
      foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($pending.Pop())) {
        if ($children.Count -ge 20000) { throw "Room state subtree exceeds the 20000 entry inspection limit: $p (at $child)" };
        $attributes=[IO.File]::GetAttributes($child);
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
var primingWindows = /* @__PURE__ */ new Map();
function primeWindowsDirectory(dir, repair) {
  if (process.platform !== "win32") return Promise.resolve();
  dir = path3.resolve(dir);
  const key = windowsKey(dir);
  const running = primingWindows.get(key);
  if (running) return running;
  if (windowsVerified(dir, repair)) return Promise.resolve();
  const work = (async () => {
    if (!fs3.statSync(path3.dirname(dir)).isDirectory()) throw new Error(`Room state parent must be a directory: ${dir}`);
    const output = await new Promise((resolve, reject) => {
      execFile2(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsAclScript(false, true, repair)],
        { env: windowsPowerShellEnv(dir), timeout: 2e4, maxBuffer: 64 * 1024, windowsHide: true, encoding: "utf8" },
        (error, stdout, stderr) => error ? reject(windowsAclError(dir, Object.assign(error, { stderr }))) : resolve(stdout)
      );
    });
    rememberWindowsAcl(dir, output, repair);
  })().finally(() => {
    if (primingWindows.get(key) === work) primingWindows.delete(key);
  });
  primingWindows.set(key, work);
  return work;
}
function primePrivateState(commonDir2) {
  return primeWindowsDirectory(path3.join(commonDir2, "room"), true);
}
function privateStateDirectory(dir) {
  dir = path3.resolve(dir);
  const { directories, root, inState } = privateDirectoryPath(dir);
  if (!fs3.statSync(path3.dirname(inState ? root : dir)).isDirectory()) throw new Error(`Room state parent must be a directory: ${dir}`);
  for (const directory of inState ? directories : [dir]) {
    if (process.platform === "win32" && (!inState || directory === root)) {
      if (fs3.existsSync(directory)) {
        const stat = fs3.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Room state path must be a directory, not a symlink or junction: ${directory}`);
      }
      windowsAcl(directory, false, true, inState);
    } else initializePrivateDirectory(directory, inState);
  }
}

// packages/local-state/src/protocol.ts
var NODE_FLOOR = "22.22.3";
var SQLITE_FLOOR = "3.51.3";
var NODE_MAJOR = 22;
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
  /** Gate record. All admission and phase transitions serialize on `${gate}.guard` (relay withGuard). */
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

// packages/local-state/src/preflight.ts
var REMEDY = "install the official Node.js 22 (22.22.3 or later) from nodejs.org, put its bin directory (Windows: the folder containing node.exe) first on the PATH the host is launched with, fully stop the host and any MCP-launching daemon, restart, then rerun `node <plugin>/server/room-state.mjs preflight`";
var MAX_DETAIL = 512;
function compareVersions(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
async function importSqliteQuietly() {
  const original = process.emitWarning;
  process.emitWarning = function(warning, ...rest) {
    const text = typeof warning === "string" ? warning : warning?.message;
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type ?? (warning instanceof Error ? warning.name : void 0);
    if (type === "ExperimentalWarning" && /\bSQLite\b/i.test(text ?? "")) return;
    return original.call(process, warning, ...rest);
  };
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}
function verifyPragmas(db) {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
  const value = (pragma) => Object.values(db.prepare(`PRAGMA ${pragma}`).get() ?? {})[0];
  if (Number(value("foreign_keys")) !== 1) return "foreign_keys could not be enabled";
  if (Number(value("trusted_schema")) !== 0) return "trusted_schema could not be disabled";
  try {
    db.loadExtension(path4.join(path4.sep, "room-preflight-no-such-extension"));
    return "extension loading is enabled";
  } catch (error) {
    if (!/not allowed|disabled|ERR_LOAD_SQLITE_EXTENSION|ERR_INVALID_STATE/i.test(`${error.code ?? ""} ${error.message}`)) return `extension loading check failed: ${error.message}`;
  }
  return void 0;
}
async function walProbe(sqlite, commonDir2) {
  await primePrivateState(commonDir2);
  const scratchRoot = path4.join(commonDir2, STORAGE_PATHS.preflightScratch);
  privateStateDirectory(scratchRoot);
  const dir = path4.join(scratchRoot, randomBytes(8).toString("hex"));
  privateStateDirectory(dir);
  const file = path4.join(dir, "probe.sqlite");
  const open = [];
  const connect = () => {
    const db = new sqlite.DatabaseSync(file, { enableForeignKeyConstraints: true, allowExtension: false, timeout: 0 });
    open.push(db);
    return db;
  };
  try {
    const a = connect();
    const mode = Object.values(a.prepare("PRAGMA journal_mode = WAL").get() ?? {})[0];
    if (String(mode).toLowerCase() !== "wal") return `journal_mode is ${String(mode)}, not wal`;
    a.exec("PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE probe (n INTEGER PRIMARY KEY) STRICT;");
    a.exec("BEGIN IMMEDIATE; INSERT INTO probe (n) VALUES (1); COMMIT;");
    const b = connect();
    if (Number(Object.values(b.prepare("SELECT count(*) AS c FROM probe").get() ?? {})[0]) !== 1) return "second connection did not see the committed row";
    b.close();
    a.close();
    open.length = 0;
    const c = connect();
    const reopened = Object.values(c.prepare("PRAGMA journal_mode").get() ?? {})[0];
    if (String(reopened).toLowerCase() !== "wal") return `journal_mode after reopen is ${String(reopened)}`;
    if (Number(Object.values(c.prepare("SELECT count(*) AS c FROM probe").get() ?? {})[0]) !== 1) return "row missing after reopen";
    return void 0;
  } finally {
    for (const db of open) {
      try {
        db.close();
      } catch {
      }
    }
    for (const name of ["probe.sqlite", "probe.sqlite-wal", "probe.sqlite-shm"]) fs4.rmSync(path4.join(dir, name), { force: true });
    try {
      fs4.rmdirSync(dir);
    } catch {
    }
  }
}
async function preflight(surface, options = {}) {
  const started = performance.now();
  const runtime = options.runtime ?? {};
  const release = runtime.release ?? process.release;
  let executable = runtime.execPath ?? process.execPath;
  try {
    executable = fs4.realpathSync.native(executable);
  } catch {
  }
  let source;
  try {
    source = release.sourceUrl ? new URL(release.sourceUrl).host : void 0;
  } catch {
    source = "unparseable";
  }
  const evidence = {
    surface,
    executable,
    node: runtime.version ?? process.versions.node,
    vendor: {
      name: release.name,
      ...source ? { source } : {},
      platform: runtime.platform ?? process.platform,
      arch: runtime.arch ?? process.arch
    },
    elapsedMs: 0
  };
  const fail = (failure, detail) => ({ ok: false, failure, evidence: { ...evidence, elapsedMs: Math.round(performance.now() - started) }, detail: detail.replace(/[\r\n]/g, " ").slice(0, MAX_DETAIL), remedy: REMEDY });
  const work = async () => {
    const version = evidence.node;
    if (Number(version.split(".")[0]) !== NODE_MAJOR) return fail("node-version", `Node ${version} is not the qualified ${NODE_MAJOR}.x line`);
    if (compareVersions(version, NODE_FLOOR) < 0) return fail("node-version", `Node ${version} is below the minimum ${NODE_FLOOR}`);
    const shared = runtime.sharedSqlite ?? process.config.variables.node_shared_sqlite === true;
    if (release.name !== "node" || shared) return fail("node-vendor", release.name !== "node" ? `runtime ${release.name} is not Node.js` : "this Node.js build uses a system SQLite library, not the bundled one; it is not an official nodejs.org binary");
    let sqlite;
    try {
      sqlite = await (options.importSqlite ?? importSqliteQuietly)();
    } catch (error) {
      return fail("sqlite-import", `import('node:sqlite') failed: ${error.message}`);
    }
    if (typeof sqlite?.DatabaseSync !== "function") return fail("sqlite-api", "node:sqlite has no DatabaseSync");
    let db;
    try {
      db = new sqlite.DatabaseSync(":memory:", { enableForeignKeyConstraints: true, allowExtension: false });
    } catch (error) {
      return fail("sqlite-api", `DatabaseSync failed: ${error.message}`);
    }
    try {
      for (const method of ["exec", "prepare", "close", "loadExtension"]) if (typeof db[method] !== "function") return fail("sqlite-api", `DatabaseSync.${method} missing`);
      const sqliteVersion = String(Object.values(db.prepare("SELECT sqlite_version() AS v").get() ?? {})[0]);
      evidence.sqlite = sqliteVersion;
      if (compareVersions(sqliteVersion, SQLITE_FLOOR) < 0) return fail("sqlite-version", `SQLite ${sqliteVersion} is below the minimum ${SQLITE_FLOOR}`);
      const pragma = verifyPragmas(db);
      if (pragma) return fail("pragma", pragma);
    } catch (error) {
      return fail("sqlite-api", `SQLite probe failed: ${error.message}`);
    } finally {
      try {
        db.close();
      } catch {
      }
    }
    let storage = "unqualified";
    if (options.commonDir) {
      const filesystem = await detectFilesystem(options.commonDir, options.filesystem ?? systemFilesystemReaders);
      evidence.filesystem = filesystem;
      if (filesystem.journal === "wal") {
        let journal;
        try {
          journal = await walProbe(sqlite, options.commonDir);
        } catch (error) {
          const code = error.code;
          if (code === "EACCES" || code === "EPERM" || /private|permission|ownership|symlink/i.test(error.message)) return fail("permission", `private preflight scratch unavailable: ${error.message}`);
          return fail("journal", `WAL probe failed: ${error.message}`);
        }
        if (journal) return fail("journal", journal);
        storage = "qualified";
      }
    }
    return { ok: true, storage, evidence: { ...evidence, elapsedMs: Math.round(performance.now() - started) } };
  };
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fail("timeout", `preflight exceeded ${options.timeoutMs ?? GATE_LIMITS.preflightMs} ms`)), options.timeoutMs ?? GATE_LIMITS.preflightMs);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
function preflightDiagnostic(result2) {
  const { evidence } = result2;
  return `Room cannot start (${evidence.surface}): ${result2.failure}: ${result2.detail}. Runtime: ${evidence.executable}, Node ${evidence.node}, SQLite ${evidence.sqlite ?? "unavailable"}. Remedy: ${result2.remedy}.`.replace(/[\r\n\u2028\u2029]+/g, " ").slice(0, 2048);
}

// packages/local-state/src/bootstrap.ts
async function bootstrap(surface, load, options = {}) {
  const result2 = await preflight(surface, options);
  if (!result2.ok) {
    process.stderr.write(`${preflightDiagnostic(result2)}
`);
    process.exitCode = 1;
    return result2;
  }
  await load(result2);
  return result2;
}

// packages/relay/src/daemon-bin.ts
var args = process.argv.slice(2);
var index = args.indexOf("--common-dir");
var commonDir = index < 0 ? void 0 : args[index + 1];
if (!commonDir || commonDir.startsWith("--")) {
  process.stderr.write("Room daemon: missing --common-dir\n");
  process.exitCode = 1;
} else {
  const result2 = await bootstrap("daemon", async (result3) => {
    const { main } = await import("./room-daemon-app.mjs");
    await main(args, result3);
  }, { commonDir });
  if (!result2.ok) {
    const report = args.indexOf("--startup-report");
    if (report >= 0 && args[report + 1]) {
      try {
        fs5.writeFileSync(args[report + 1], preflightDiagnostic(result2), { flag: "wx", mode: 384 });
      } catch {
      }
    }
  }
}
