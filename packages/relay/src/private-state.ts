/** Private checkout boundary. Windows ACL inspection is required; chmod is not an ACL check. */
import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { initializePrivateDirectory, privateDirectoryPath, verifyPosixPath } from './private-core.js'

interface AclReport { owner: string; user: string; protected: boolean; grants: string[]; directory?: boolean; repaired?: boolean }
export function checkWindowsAcl(report: AclReport, file: string): void {
  const allowed = new Set([report.user, 'S-1-5-18', 'S-1-5-32-544'])
  // An elevated administrator's new files are owned by BUILTIN\Administrators on Windows Server; ownership alone
  // grants no access, and the grants below are what keep the state private.
  // Directories must block inheritance so a broad parent cannot widen them later. A file may inherit from its
  // protected Room directory: the effective grants below are what decide whether it is private.
  if ((report.owner !== report.user && report.owner !== 'S-1-5-32-544') || (report.directory !== false && !report.protected) || report.grants.some(sid => !allowed.has(sid))) {
    throw new Error(`Room state is not private: ${file}; owner ${report.owner}; offending grants ${report.grants.filter(sid => !allowed.has(sid)).join(', ') || 'none'}; DACL must be protected and access restricted to the current user, SYSTEM and Administrators. Use a private local clone, remove broad inherited grants and protect its Room state DACL, then retry`)
  }
}
/** Paths this process has already verified on Windows, keyed to their file identity: one PowerShell run per path
 * per process, not per write. A replaced path has a new identity and is inspected again. */
const verifiedWindows = new Map<string, { identity: string; subtree: boolean }>()
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
function windowsAclScript(protectNew: boolean, createDirectory: boolean, repair: boolean): string {
  // The path travels through the environment, never interpolated into PowerShell source.
  return `$ErrorActionPreference='Stop'; $p=$env:ROOM_PRIVATE_PATH; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User;
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
    $o=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;
    # An elevated administrator's new directories are owned by BUILTIN\\Administrators (Windows Server default); that
    # user can already rewrite the ACL, so the repair may take ownership back for them.
    $elevated=(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);
    $owned=($o -eq $u.Value) -or ($o -eq 'S-1-5-32-544' -and $elevated);
    $broad=@($g | Where-Object {$_ -notin @($u.Value,'S-1-5-18','S-1-5-32-544')});
    ${repair ? `$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';
    $inheritable=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {
      $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -eq $u.Value -and
      ($_.InheritanceFlags -band $inherit) -eq $inherit -and $_.PropagationFlags -eq 'None' -and
      ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl
    }).Count -gt 0;` : ''}
    ${repair ? `# Count and reject reparse points before Set-Acl can propagate through an oversized subtree.
    $pending=New-Object 'System.Collections.Generic.Stack[string]'; $pending.Push($p);
    $children=New-Object 'System.Collections.Generic.List[string]';
    while ($pending.Count -gt 0) {
      foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($pending.Pop())) {
        if ($children.Count -ge 20000) { throw "Room state subtree exceeds the 20000 entry inspection limit: $p (at $child)" };
        $attributes=[IO.File]::GetAttributes($child);
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Room state must not be a symlink or junction: $child" };
        $children.Add($child);
        if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($child) }
      }
    };` : ''}
    ${protectNew || repair ? `if ($owned -and (${protectNew ? '$true' : '!$a.AreAccessRulesProtected -or $broad.Count -gt 0 -or !$inheritable'})) {
      Set-Acl -LiteralPath $p -AclObject (PrivateAcl $item.PSIsContainer); $repaired=!$created;
      ${repair ? '$inheritable=$true;' : ''}
      $a=Get-Acl -LiteralPath $p;
      $g=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Value})
    };` : ''}
    ${repair ? `# Establish inheritance for the whole existing subtree before caching this root. Never follow reparse points.
    if (!$inheritable -or !$a.AreAccessRulesProtected -or @($g | Where-Object {$_ -notin @($u.Value,'S-1-5-18','S-1-5-32-544')}).Count -gt 0 -or
        $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($u.Value,'S-1-5-32-544')) { throw "Room state is not private: $p" };
    foreach ($child in $children) {
        $childItem=Get-Item -Force -LiteralPath $child;
        if ($childItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Room state must not be a symlink or junction: $child" };
        $childAcl=Get-Acl -LiteralPath $child;
        $rules=@($childAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));
        $explicitBroad=@($rules | Where-Object {!$_.IsInherited -and $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin @($u.Value,'S-1-5-18','S-1-5-32-544')});
        if ($childAcl.AreAccessRulesProtected -or @($rules | Where-Object {$_.IsInherited}).Count -eq 0 -or $explicitBroad.Count -gt 0) {
          $childOwner=$childAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
          if ($childOwner -ne $u.Value -and !($childOwner -eq 'S-1-5-32-544' -and $elevated)) { throw "Cannot repair Room state owned by $childOwner : $child" };
          # icacls /reset re-enables inheritance and removes every explicit entry. A Get-Acl/Set-Acl round trip
          # cannot do this: Set-Acl persists the inherited entries it read back as explicit ones.
          & (Join-Path $env:SystemRoot 'System32\\icacls.exe') $child /reset /q | Out-Null;
          if ($LASTEXITCODE -ne 0) { throw "Cannot reset Room state ACL ($LASTEXITCODE): $child" };
          $childAcl=Get-Acl -LiteralPath $child;
          $rules=@($childAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));
        };
        if ($childAcl.AreAccessRulesProtected -or @($rules | Where-Object {$_.IsInherited}).Count -eq 0 -or
            @($rules | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin @($u.Value,'S-1-5-18','S-1-5-32-544')}).Count -gt 0) { throw "Room state descendant is not private: $child" };
    };` : ''}
    @{owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;user=$u.Value;protected=$a.AreAccessRulesProtected;directory=[bool]$item.PSIsContainer;grants=$g;repaired=$repaired} | ConvertTo-Json -Compress`
}
function windowsAclError(file: string, error: unknown): Error {
  const e = error as NodeJS.ErrnoException & { stderr?: string; signal?: string }
  const cause = e.code === 'ETIMEDOUT' || e.signal ? 'PowerShell timed out' : (String(e.stderr ?? '').trim().split(/\r?\n/).find(Boolean) ?? e.message).slice(0, 300)
  return new Error(`Cannot verify the Windows owner/DACL for ${file} (${cause}); use a private local state directory and permit bounded ACL inspection, then retry`)
}
function rememberWindowsAcl(file: string, output: string, repair: boolean): void {
  let report: AclReport
  try { report = JSON.parse(output) as AclReport } catch (error) { throw windowsAclError(file, error) }
  if (!report || !Array.isArray(report.grants) || typeof report.user !== 'string') throw new Error(`Invalid Windows ACL inspection for ${file}`)
  checkWindowsAcl(report, file)
  if (repair && report.repaired) console.error(`Room repaired private state directory: ${file}`)
  const identity = windowsIdentity(file)
  if (identity) verifiedWindows.set(windowsKey(file), { identity, subtree: repair })
}
function windowsVerified(file: string, subtree = false): boolean {
  const known = verifiedWindows.get(windowsKey(file))
  return !!known && (!subtree || known.subtree) && known.identity === windowsIdentity(file)
}
function windowsAcl(file: string, protectNew = false, createDirectory = false, repair = false): void {
  if (!protectNew && windowsVerified(file, repair)) return
  // A synchronous caller cannot await a prime already in flight. Its own idempotent check is the fallback;
  // repair only changes an owned, unprotected/broad DACL, so both checks converge on the same private ACL.
  let output: string
  try {
    output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsAclScript(protectNew, createDirectory, repair)], { env: windowsPowerShellEnv(file), timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw windowsAclError(file, error)
  }
  rememberWindowsAcl(file, output, repair)
}
const primingWindows = new Map<string, Promise<void>>()
/** Start one non-blocking inspection per path; synchronous writers share its identity cache. */
function primeWindowsDirectory(dir: string, repair: boolean): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  dir = path.resolve(dir)
  const key = windowsKey(dir)
  const running = primingWindows.get(key)
  if (running) return running
  if (windowsVerified(dir, repair)) return Promise.resolve()
  const work = (async () => {
    // Like privateStateDirectory, never let recursive native creation create checkout ancestors.
    if (!fs.statSync(path.dirname(dir)).isDirectory()) throw new Error(`Room state parent must be a directory: ${dir}`)
    const output = await new Promise<string>((resolve, reject) => {
      execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsAclScript(false, true, repair)],
        { env: windowsPowerShellEnv(dir), timeout: 20_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' },
        (error, stdout, stderr) => error ? reject(windowsAclError(dir, Object.assign(error, { stderr }))) : resolve(stdout))
    })
    rememberWindowsAcl(dir, output, repair)
  })().finally(() => { if (primingWindows.get(key) === work) primingWindows.delete(key) })
  primingWindows.set(key, work)
  return work
}
/** Config writers protect only a newly created leaf; existing ancestors keep their ACLs.
 * The later atomic write still fsyncs each parent, including those created plainly here. */
export function primePrivateDirectory(dir: string): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  dir = path.resolve(dir)
  const running = primingWindows.get(windowsKey(dir))
  if (running) return running
  if (fs.existsSync(dir)) return Promise.resolve()
  try { fs.mkdirSync(path.dirname(dir), { recursive: true }) }
  catch (error) { return Promise.reject(error) }
  return primeWindowsDirectory(dir, false)
}
/** Prime the single Windows privacy boundary as soon as startup knows the Git common directory. */
export function primePrivateState(commonDir: string): Promise<void> {
  return primeWindowsDirectory(path.join(commonDir, 'room'), true)
}
/** Protect only newly created Room files; never rewrite checkout ACLs. */
export function verifyPrivatePath(file: string, created = false): void {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink()) throw new Error(`Room state path must not be a symlink: ${file}`)
  if (process.platform === 'win32') {
    // The root inspection normalized existing descendants; new children inherit its private ACL.
    if (underVerifiedRoomRoot(file)) return
    windowsAcl(file, created); return
  }
  verifyPosixPath(file, stat)
}
/** Windows trusts one boundary per process: the room/ root, created or repaired with a protected, inheritable
 * owner-only ACL. That same inspection walks and normalizes all existing descendants before caching the root;
 * subsequent plain creations inherit it, so writers need no PowerShell inspection of their own. */
function underVerifiedRoomRoot(file: string): boolean {
  let dir = path.resolve(file)
  while (path.basename(dir).toLowerCase() !== 'room' && path.dirname(dir) !== dir) dir = path.dirname(dir)
  if (path.basename(dir).toLowerCase() !== 'room' || path.resolve(file) === dir) return false
  const known = verifiedWindows.get(windowsKey(dir))
  return !!known?.subtree && known.identity === windowsIdentity(dir)
}
/** POSIX repairs the requested path from room/ down; Windows verifies the root and its existing subtree once. */
export function privateStateDirectory(dir: string): void {
  dir = path.resolve(dir)
  const { directories, root, inState } = privateDirectoryPath(dir)
  // Never inspect or repair checkout ancestors: the Git directory already permits installing executable hooks.
  // Directory.CreateDirectory on Windows is recursive; never let it create checkout ancestors.
  if (!fs.statSync(path.dirname(inState ? root : dir)).isDirectory()) throw new Error(`Room state parent must be a directory: ${dir}`)
  for (const directory of inState ? directories : [dir]) {
    if (process.platform === 'win32' && (!inState || directory === root)) {
      if (fs.existsSync(directory)) {
        const stat = fs.lstatSync(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Room state path must be a directory, not a symlink or junction: ${directory}`)
      }
      windowsAcl(directory, false, true, inState)
    } else initializePrivateDirectory(directory, inState)
  }
}
