/** Private checkout boundary. Windows ACL inspection is required; chmod is not an ACL check. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

interface AclReport { owner: string; user: string; protected: boolean; grants: string[]; repaired?: boolean }
export function checkWindowsAcl(report: AclReport, file: string): void {
  const allowed = new Set([report.user, 'S-1-5-18', 'S-1-5-32-544'])
  // An elevated administrator's new files are owned by BUILTIN\Administrators on Windows Server; ownership alone
  // grants no access, and the grants below are what keep the state private.
  if ((report.owner !== report.user && report.owner !== 'S-1-5-32-544') || !report.protected || report.grants.some(sid => !allowed.has(sid))) {
    throw new Error(`Room state is not private: ${file}; owner ${report.owner}; offending grants ${report.grants.filter(sid => !allowed.has(sid)).join(', ') || 'none'}; DACL must be protected and access restricted to the current user, SYSTEM and Administrators. Use a private local clone, remove broad inherited grants and protect its Room state DACL, then retry`)
  }
}
/** Paths this process has already verified on Windows, keyed to their file identity: one PowerShell run per path
 * per process, not per write. A replaced path has a new identity and is inspected again. */
const verifiedWindows = new Map<string, string>()
const windowsKey = (file: string) => path.resolve(file).toLowerCase()
function windowsIdentity(file: string): string | undefined {
  try { const stat = fs.lstatSync(file, { bigint: true }); return `${stat.dev}:${stat.ino}` } catch { return undefined }
}
/** Windows PowerShell 5.1 cannot load Microsoft.PowerShell.Security when it inherits PowerShell 7's PSModulePath
 * (for example when the host was started from pwsh); without the variable it uses its own default module path. */
function windowsPowerShellEnv(file: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (key.toLowerCase() !== 'psmodulepath') env[key] = value
  env.ROOM_PRIVATE_PATH = file
  return env
}
function windowsAcl(file: string, protectNew = false, createDirectory = false, repair = false): void {
  const key = windowsKey(file), known = verifiedWindows.get(key)
  if (known && !protectNew && known === windowsIdentity(file)) return
  // The path travels through the environment, never interpolated into PowerShell source.
  const script = `$ErrorActionPreference='Stop'; $p=$env:ROOM_PRIVATE_PATH; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    function PrivateAcl($directory) {
      if ($directory) { $acl=New-Object Security.AccessControl.DirectorySecurity; $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
      else { $acl=New-Object Security.AccessControl.FileSecurity; $inherit=[Security.AccessControl.InheritanceFlags]::None };
      $acl.SetOwner($u); $acl.SetAccessRuleProtection($true,$false);
      foreach ($sid in @($u.Value,'S-1-5-18','S-1-5-32-544')) {
        $identity=New-Object Security.Principal.SecurityIdentifier($sid);
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl',$inherit,'None','Allow')))
      }; return $acl
    };
    $created=$false; $repaired=$false;
    ${createDirectory ? "if (!(Test-Path -LiteralPath $p)) { [IO.Directory]::CreateDirectory($p,(PrivateAcl $true)) | Out-Null; $created=$true };" : ''}
    $item=Get-Item -Force -LiteralPath $p; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Room state must not be a reparse point' };
    $a=Get-Acl -LiteralPath $p;
    $g=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Value});
    $owned=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $u.Value;
    $broad=@($g | Where-Object {$_ -notin @($u.Value,'S-1-5-18','S-1-5-32-544')});
    ${protectNew || repair ? `if ($owned -and (${protectNew ? '$true' : '!$a.AreAccessRulesProtected -or $broad.Count -gt 0'})) {
      Set-Acl -LiteralPath $p -AclObject (PrivateAcl $item.PSIsContainer); $repaired=!$created;
      $a=Get-Acl -LiteralPath $p;
      $g=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Value})
    };` : ''}
    @{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;user=$u.Value;protected=$a.AreAccessRulesProtected;grants=$g;repaired=$repaired} | ConvertTo-Json -Compress`
  let report: AclReport
  try {
    report = JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: windowsPowerShellEnv(file), timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as AclReport
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string; signal?: string }
    const cause = e.code === 'ETIMEDOUT' || e.signal ? 'PowerShell timed out' : (String(e.stderr ?? '').trim().split(/\r?\n/).find(Boolean) ?? e.message).slice(0, 300)
    throw new Error(`Cannot verify the Windows owner/DACL for ${file} (${cause}); use a private local state directory and permit bounded ACL inspection, then retry`)
  }
  if (!report || !Array.isArray(report.grants) || typeof report.user !== 'string') throw new Error(`Invalid Windows ACL inspection for ${file}`)
  checkWindowsAcl(report, file)
  if (repair && report.repaired) console.error(`Room repaired private state directory: ${file}`)
  const identity = windowsIdentity(file)
  if (identity) verifiedWindows.set(key, identity)
}
/** Protect only newly created Room files; never rewrite checkout ACLs. */
export function verifyPrivatePath(file: string, created = false): void {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink()) throw new Error(`Room state path must not be a symlink: ${file}`)
  if (process.platform === 'win32') {
    // A file created inside a directory this process verified inherits its protected owner-only ACL.
    if (created && stat.isFile() && verifiedWindows.get(windowsKey(path.dirname(file))) === windowsIdentity(path.dirname(file))) return
    windowsAcl(file, created); return
  }
  if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw new Error(`Room state must be owned by the current user and private: ${file}`)
}
/** Repair only the requested path from room/ down; never scan children or alter checkout ancestors. */
export function privateStateDirectory(dir: string): void {
  dir = path.resolve(dir)
  const directories = [dir]
  let root = dir
  while (path.basename(root) !== 'room' && path.dirname(root) !== root) {
    root = path.dirname(root)
    directories.unshift(root)
    if (directories.length > 64) throw new Error(`Room state directory path is too deep: ${dir}`)
  }
  const inState = path.basename(root) === 'room'
  // Top-down repairs make every parent below room/ private before its child is handled. No check on the git common directory above room/: anyone who can write it can already install git hooks that run as this user, so a Room check there adds no protection, and default umask 002 makes it group-writable on Debian and Ubuntu.
  // Directory.CreateDirectory on Windows is recursive; never let it create checkout ancestors.
  if (!fs.statSync(path.dirname(inState ? root : dir)).isDirectory()) throw new Error(`Room state parent must be a directory: ${dir}`)
  // Other private output directories retain strict verification and must have an existing parent.
  for (const directory of inState ? directories : [dir]) {
    initializeDirectory(directory, inState)
    if (inState && directory === root) privateMarker(root)
  }
}

/** Hooks on Windows may write only after the native initializer has verified the root's owner/DACL. */
function privateMarker(root: string): void {
  const marker = path.join(root, '.private')
  let created = false
  // A raw descriptor write: exclusive create, and it stays out of the way of code that observes whole-file writes.
  try {
    const fd = fs.openSync(marker, 'wx', 0o600)
    try { fs.writeSync(fd, 'v1\n') } finally { fs.closeSync(fd) }
    created = true
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const stat = fs.lstatSync(marker)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Room private marker must be a regular file, not a symlink: ${marker}`)
  verifyPrivatePath(marker, created)
}

function initializeDirectory(dir: string, repair: boolean): void {
  let created = false
  if (process.platform !== 'win32') {
    try { fs.mkdirSync(dir, { mode: 0o700 }); created = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  let stat: fs.Stats | undefined
  try { stat = fs.lstatSync(dir) }
  catch (error) { if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Room state path must be a directory, not a symlink: ${dir}`)
  if (process.platform === 'win32') { windowsAcl(dir, false, true, repair); return }
  if (!process.getuid || stat!.uid !== process.getuid()) throw new Error(`Room state must be owned by the current user and private: ${dir}`)
  // Use a no-follow directory descriptor so chmod cannot follow a replaced final component.
  if (created || repair && (stat!.mode & 0o777) !== 0o700) {
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY)
    try {
      const opened = fs.fstatSync(fd)
      if (opened.dev !== stat!.dev || opened.ino !== stat!.ino || opened.uid !== process.getuid()) throw new Error(`Room state must be owned by the current user and private: ${dir}`)
      fs.fchmodSync(fd, 0o700)
    } finally { fs.closeSync(fd) }
    if (!created) console.error(`Room repaired private state directory: ${dir}`)
  }
  verifyPrivatePath(dir)
}
