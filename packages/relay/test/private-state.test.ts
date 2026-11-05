import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { privateStateDirectory, verifyPrivatePath } from '../src/private-state.js'
import { stopLocalDaemon } from '../src/daemon.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-private-upgrade-')); roots.push(root)
  return { root, room: path.join(root, 'room') }
}

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
