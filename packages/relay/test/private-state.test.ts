import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { primePrivateState, privateStateDirectory, verifyPrivatePath } from '@room/local-state/private-state'
import { stopLocalDaemon } from '../src/daemon.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-private-upgrade-')); roots.push(root)
  return { root, room: path.join(root, 'room') }
}

function inspectWindows(target: string): { user: string; protected: boolean; grants: string[]; inherited: boolean[]; explicit: number } {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:ROOM_TEST_PATH; $r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); @{user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;protected=$a.AreAccessRulesProtected;grants=@($r | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Value});inherited=@($r | ForEach-Object {$_.IsInherited});explicit=@($r | Where-Object {!$_.IsInherited}).Count} | ConvertTo-Json -Compress"],
  { env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')), ROOM_TEST_PATH: target }, encoding: 'utf8', timeout: 20_000 }).trim())
}

it.runIf(process.platform === 'win32').each(['protected directory', 'explicit file grant'])('Windows priming repairs an existing descendant with %s', async kind => {
  const { root, room } = fixture(), child = path.join(room, 'sessions', 'legacy'), file = path.join(child, 'session.json')
  fs.mkdirSync(child, { recursive: true }); fs.writeFileSync(file, '{}')
  const target = kind === 'protected directory' ? child : file
  if (kind === 'protected directory') execFileSync('icacls', [child, '/inheritance:d'], { stdio: 'pipe' })
  execFileSync('icacls', [target, '/grant', kind === 'protected directory' ? '*S-1-1-0:(OI)(CI)R' : '*S-1-1-0:R'], { stdio: 'pipe' })
  const before = inspectWindows(target)
  expect(before.grants).toContain('S-1-1-0')
  expect(before.explicit).toBeGreaterThan(0)
  expect(before.protected).toBe(kind === 'protected directory')
  await primePrivateState(root) // the async root inspection must repair even unrequested descendants
  for (const descendant of [child, file]) {
    const after = inspectWindows(descendant)
    expect(after.protected).toBe(false)
    expect(after.explicit).toBe(0)
    expect(after.inherited.length).toBeGreaterThan(0)
    expect(after.inherited.every(Boolean)).toBe(true)
    expect(after.grants.length).toBeGreaterThan(0)
    expect(after.grants.filter(sid => ![after.user, 'S-1-5-18', 'S-1-5-32-544'].includes(sid))).toEqual([])
  }
  expect(fs.readFileSync(file, 'utf8')).toBe('{}')
  privateStateDirectory(child)
  verifyPrivatePath(file)
}, 90_000)

it.runIf(process.platform === 'win32')('refuses a Windows Room subtree above the 20000 entry inspection limit', async () => {
  const { root, room } = fixture()
  fs.mkdirSync(room)
  for (let index = 0; index <= 20000; index++) fs.writeFileSync(path.join(room, String(index)), '')
  await expect(primePrivateState(root)).rejects.toThrow('20000 entry inspection limit')
  // Failure cannot warm the cache: even a synchronous caller must refuse this subtree.
  expect(() => privateStateDirectory(room)).toThrow('20000 entry inspection limit')
}, 90_000)

it.runIf(process.platform === 'win32')('repairs a protected Windows root without inheritable grants before creating children', async () => {
  const { root, room } = fixture()
  fs.mkdirSync(room)
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object Security.AccessControl.DirectorySecurity; $a.SetOwner($u); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($u,'FullControl','Allow'))); Set-Acl -LiteralPath $env:ROOM_TEST_PATH -AclObject $a"],
  { env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')), ROOM_TEST_PATH: room }, timeout: 20_000, stdio: 'pipe' })
  await primePrivateState(root)
  const child = path.join(room, 'sessions', 'new'), file = path.join(child, 'session.json')
  privateStateDirectory(child)
  fs.writeFileSync(file, '{}')
  const after = inspectWindows(file)
  expect(after.explicit).toBe(0)
  expect(after.inherited.length).toBeGreaterThan(0)
  expect(after.grants).toContain(after.user)
  expect(after.grants.filter(sid => ![after.user, 'S-1-5-18', 'S-1-5-32-544'].includes(sid))).toEqual([])
}, 90_000)

it.skipIf(process.platform === 'win32')('accepts a group-writable git parent (umask 002) and leaves its mode alone', () => {
  const { root } = fixture(), common = path.join(root, '.git')
  fs.mkdirSync(common)
  for (const mode of [0o755, 0o775, 0o1777]) {
    fs.chmodSync(common, mode)
    privateStateDirectory(path.join(common, 'room', 'sessions'))
    expect(fs.statSync(common).mode & 0o7777).toBe(mode)
    expect(fs.statSync(path.join(common, 'room')).mode & 0o777).toBe(0o700)
  }
})

it.skipIf(process.platform === 'win32')('repairs only owned legacy directories along the requested state path, once each', () => {
  const { root, room } = fixture(), session = path.join(room, 'sessions', 'old-session')
  fs.mkdirSync(session, { recursive: true })
  const dirs = [room, path.dirname(session), session]
  for (const dir of dirs) fs.chmodSync(dir, 0o755)
  const outsideMode = fs.statSync(root).mode
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  privateStateDirectory(session)
  privateStateDirectory(session)
  expect(dirs.map(dir => fs.statSync(dir).mode & 0o777)).toEqual([0o700, 0o700, 0o700])
  expect(log).toHaveBeenCalledTimes(3)
  expect(fs.statSync(root).mode).toBe(outsideMode)
})

it.skipIf(process.platform === 'win32')('refuses another uid without chmod, using injected lstat ownership', () => {
  const { room } = fixture(); fs.mkdirSync(room, { mode: 0o755 })
  const original = fs.lstatSync
  vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, ...args: any[]) => {
    const stat = original(file, ...args)
    if (String(file) === room) Object.defineProperty(stat, 'uid', { value: process.getuid!() + 1 })
    return stat
  }) as typeof fs.lstatSync)
  const chmod = vi.spyOn(fs, 'fchmodSync')
  expect(() => privateStateDirectory(room)).toThrow(/owned by the current user and private/)
  expect(chmod).not.toHaveBeenCalled()
})

it('refuses symlinks in the root or any requested descendant, without touching their target', () => {
  const { root, room } = fixture(), outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  const mode = fs.statSync(outside).mode
  fs.symlinkSync(outside, room, 'junction')
  expect(() => privateStateDirectory(path.join(room, 'sessions', 'sid'))).toThrow(/symlink/)
  expect(fs.existsSync(path.join(outside, 'sessions'))).toBe(false)
  fs.unlinkSync(room); fs.mkdirSync(room, { mode: 0o700 })
  fs.symlinkSync(outside, path.join(room, 'sessions'), 'junction')
  expect(() => privateStateDirectory(path.join(room, 'sessions', 'sid'))).toThrow(/symlink/)
  expect(fs.existsSync(path.join(outside, 'sid'))).toBe(false)
  expect(fs.statSync(outside).mode).toBe(mode)
})

it.skipIf(process.platform === 'win32')('never repairs unrelated directories or creates missing ancestors outside Room state', () => {
  const { root } = fixture(), unrelated = path.join(root, 'unrelated')
  fs.mkdirSync(unrelated); fs.chmodSync(unrelated, 0o755)
  expect(() => privateStateDirectory(unrelated)).toThrow(/private/)
  expect(fs.statSync(unrelated).mode & 0o777).toBe(0o755)
  expect(() => privateStateDirectory(path.join(root, 'missing', 'room'))).toThrow()
  expect(fs.existsSync(path.join(root, 'missing'))).toBe(false)
})

it('does not contact or stop a different daemon instance when fixture ownership is stale', async () => {
  const { root, room } = fixture(); privateStateDirectory(room)
  fs.writeFileSync(path.join(room, 'relay.json'), JSON.stringify({ schema: 2, runtime: 'daemon',
    pid: 2147483000, port: 1, key: 'test-only', room: 'local/test', startedAt: 1,
    nonce: '22222222-2222-2222-2222-222222222222' }), { mode: 0o600 })
  verifyPrivatePath(path.join(room, 'relay.json'), true)
  const fetch = vi.spyOn(globalThis, 'fetch')
  await expect(stopLocalDaemon(root, undefined, '11111111-1111-1111-1111-111111111111')).resolves.toBe('different daemon instance')
  expect(fetch).not.toHaveBeenCalled()
})

// Windows only: protecting the room/ root must propagate to what a hook already wrote below it with plain calls.
it.runIf(process.platform === 'win32')('protecting the Windows Room root makes existing hook-written files private', () => {
  const { root, room } = fixture(), session = path.join(room, 'sessions', 'sid'), file = path.join(session, 'session.json')
  fs.mkdirSync(session, { recursive: true }); fs.writeFileSync(file, '{}')
  const grants = (target: string) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@((Get-Acl -LiteralPath $env:T).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }) -join ','`],
  { env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath')), T: target }, encoding: 'utf8' }).trim().split(',')
  // Loosen the root the way a broad parent would: an inheritable grant to Everyone (S-1-1-0) reaches the file.
  execFileSync('icacls', [room, '/grant', '*S-1-1-0:(OI)(CI)R'], { stdio: 'ignore' })
  expect(grants(file)).toContain('S-1-1-0')
  privateStateDirectory(session)
  expect(grants(file)).not.toContain('S-1-1-0')
  expect(grants(room)).not.toContain('S-1-1-0')
  void root
})

it.runIf(process.platform === 'win32')('async Windows priming creates the protected Room root before inheriting descendant writes', async () => {
  const { root, room } = fixture()
  const first = primePrivateState(root)
  expect(primePrivateState(root)).toBe(first)
  await first
  const session = path.join(room, 'sessions', 'primed'), file = path.join(session, 'session.json')
  privateStateDirectory(session)
  fs.writeFileSync(file, '{}')
  verifyPrivatePath(file, true)
  const report = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $root=Get-Acl -LiteralPath $env:ROOM_TEST_ROOT; $a=Get-Acl -LiteralPath $env:ROOM_TEST_FILE; @{user=$u;protected=$root.AreAccessRulesProtected;grants=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Value})} | ConvertTo-Json -Compress"],
  { env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')), ROOM_TEST_ROOT: room, ROOM_TEST_FILE: file }, encoding: 'utf8', timeout: 20_000 }).trim()) as { user: string; protected: boolean; grants: string[] }
  expect(report.protected).toBe(true)
  expect(report.grants.length).toBeGreaterThan(0)
  expect(report.grants.filter(sid => ![report.user, 'S-1-5-18', 'S-1-5-32-544'].includes(sid))).toEqual([])
}, 45_000) // async native initialization and an independent native ACL assertion each have a 20 s bound

// Windows only: a descendant owned by someone else can rewrite its own DACL later, so its owner is refused even
// when its grants look private. The CI runner is elevated, which lets the test hand ownership to SYSTEM.
it.runIf(process.platform === 'win32')('refuses a Windows Room descendant owned by another principal', async () => {
  const { root, room } = fixture(), file = path.join(room, 'sessions', 'owned', 'session.json')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{}')
  execFileSync('icacls', [file, '/setowner', '*S-1-5-18'], { stdio: 'pipe' })
  await expect(primePrivateState(root)).rejects.toThrow(/owned by S-1-5-18/)
})
