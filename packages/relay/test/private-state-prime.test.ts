/** Exercise Windows scheduling and cache behavior on every OS; native ACL semantics run in Windows CI. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as childProcess from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { writeAtomic } from '../src/leases.js'
import { primePrivateDirectory, primePrivateState, privateStateDirectory, verifyPrivatePath } from '../src/private-state.js'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFile: vi.fn(), execFileSync: vi.fn(),
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []
const report = JSON.stringify({ owner: 'user', user: 'user', protected: true, directory: true, grants: ['user', 'S-1-5-18', 'S-1-5-32-544'] })
let finish: (error: Error | null, stdout: string, stderr: string) => void
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.mocked(childProcess.execFile).mockImplementation(((...args: any[]) => { finish = args.at(-1); return {} }) as typeof childProcess.execFile)
  vi.mocked(childProcess.execFileSync).mockReturnValue(report)
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.resetAllMocks(); vi.unstubAllEnvs()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'room-prime-')); roots.push(common)
  const room = path.join(common, 'room'); fs.mkdirSync(room)
  return { common, room }
}

it('keeps the event loop responsive, coalesces primes, and warms the synchronous identity cache', async () => {
  const { common, room } = fixture()
  vi.stubEnv('PSModulePath', 'host-specific modules')
  const first = primePrivateState(common)
  expect(primePrivateState(common)).toBe(first)
  await new Promise(resolve => setImmediate(resolve))
  expect(childProcess.execFile).toHaveBeenCalledTimes(1)
  expect(childProcess.execFileSync).not.toHaveBeenCalled()
  const options = vi.mocked(childProcess.execFile).mock.calls[0][2] as { env: NodeJS.ProcessEnv }
  expect(Object.keys(options.env).some(key => key.toLowerCase() === 'psmodulepath')).toBe(false)
  expect(options.env.ROOM_PRIVATE_PATH).toBe(room)
  finish(null, report, '')
  await first
  privateStateDirectory(path.join(room, 'sessions', 'sid'))
  await primePrivateState(common)
  expect(childProcess.execFile).toHaveBeenCalledTimes(1)
  expect(childProcess.execFileSync).not.toHaveBeenCalled()
})

it('uses the same idempotent script for a synchronous caller during a prime and then reuses the cache', async () => {
  const { common, room } = fixture()
  const prime = primePrivateState(common)
  privateStateDirectory(room)
  privateStateDirectory(room)
  expect(childProcess.execFileSync).toHaveBeenCalledTimes(1)
  expect(vi.mocked(childProcess.execFileSync).mock.calls[0][1]).toEqual(vi.mocked(childProcess.execFile).mock.calls[0][1])
  finish(null, report, '')
  await prime
  privateStateDirectory(room)
  expect(childProcess.execFileSync).toHaveBeenCalledTimes(1)
})

it('checks a replaced directory again instead of trusting the old path', async () => {
  const { common, room } = fixture()
  const first = primePrivateState(common); finish(null, report, ''); await first
  fs.renameSync(room, `${room}-old`); fs.mkdirSync(room)
  const second = primePrivateState(common)
  expect(childProcess.execFile).toHaveBeenCalledTimes(2)
  finish(null, report, ''); await second
  privateStateDirectory(room)
  expect(childProcess.execFileSync).not.toHaveBeenCalled()
})

it('does not trust a root-only ACL check as verification of its descendants', async () => {
  const { common, room } = fixture(), child = path.join(room, 'record.json')
  fs.writeFileSync(child, '{}')
  verifyPrivatePath(room)
  verifyPrivatePath(child)
  expect(childProcess.execFileSync).toHaveBeenCalledTimes(2) // no subtree has been inspected yet
  const prime = primePrivateState(common)
  expect(childProcess.execFile).toHaveBeenCalledTimes(1) // a cached root-only check must not skip the walk
  finish(null, report, ''); await prime
  privateStateDirectory(room)
  verifyPrivatePath(child)
  expect(childProcess.execFileSync).toHaveBeenCalledTimes(2)
})

it('does not cache failed inspections and permits a later prime or synchronous fallback', async () => {
  const { common, room } = fixture()
  const failed = primePrivateState(common)
  finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), '', '')
  await expect(failed).rejects.toThrow('PowerShell timed out')
  const retry = primePrivateState(common)
  finish(null, JSON.stringify({ owner: 'user', user: 'user', protected: true, grants: ['Everyone'] }), '')
  await expect(retry).rejects.toThrow('offending grants Everyone')
  privateStateDirectory(room)
  expect(childProcess.execFileSync).toHaveBeenCalledTimes(1)
  expect(childProcess.execFile).toHaveBeenCalledTimes(2)
})

it('primes a new private config leaf without allowing repairs', async () => {
  const { common } = fixture(), config = path.join(common, 'config')
  const prime = primePrivateDirectory(config)
  const script = vi.mocked(childProcess.execFile).mock.calls[0][1]!.at(-1)!
  expect(script).toContain('[IO.Directory]::CreateDirectory')
  expect(script).not.toContain('Set-Acl -LiteralPath')
  fs.mkdirSync(config) // native CreateDirectory completes before returning its ACL report
  finish(null, report, ''); await prime
  privateStateDirectory(config)
  expect(childProcess.execFileSync).not.toHaveBeenCalled()
})

it('refuses missing checkout ancestors before launching recursive native creation', async () => {
  const { common } = fixture()
  await expect(primePrivateState(path.join(common, 'missing'))).rejects.toThrow()
  expect(childProcess.execFile).not.toHaveBeenCalled()
  expect(fs.existsSync(path.join(common, 'missing'))).toBe(false)
})

it('leaves POSIX initialization to the existing synchronous policy', async () => {
  Object.defineProperty(process, 'platform', platform)
  if (process.platform === 'win32') return
  const { common } = fixture()
  fs.rmSync(path.join(common, 'room'), { recursive: true })
  await primePrivateState(common)
  expect(fs.existsSync(path.join(common, 'room'))).toBe(false)
  expect(childProcess.execFile).not.toHaveBeenCalled()
})

it('uses only one native private leaf creation for a nested Windows config write', () => {
  const { common } = fixture(), leaf = path.join(common, 'new-config', 'intermediate', 'private-leaf')
  vi.mocked(childProcess.execFileSync).mockImplementation(((...args: any[]) => {
    const target = args[2]?.env?.ROOM_PRIVATE_PATH
    if (target) fs.mkdirSync(target)
    return report
  }) as typeof childProcess.execFileSync)
  writeAtomic(path.join(leaf, 'credentials.json'), { value: 1 })
  const privateCalls = vi.mocked(childProcess.execFileSync).mock.calls.filter(call => (call[2] as { env?: NodeJS.ProcessEnv })?.env?.ROOM_PRIVATE_PATH)
  expect(privateCalls).toHaveLength(1)
  expect((privateCalls[0][2] as { env: NodeJS.ProcessEnv }).env.ROOM_PRIVATE_PATH).toBe(leaf)
  expect(JSON.parse(fs.readFileSync(path.join(leaf, 'credentials.json'), 'utf8'))).toEqual({ value: 1 })
})

it('does not inspect or change an existing config directory', async () => {
  const { common } = fixture()
  await primePrivateDirectory(common)
  expect(childProcess.execFile).not.toHaveBeenCalled()
  expect(childProcess.execFileSync).not.toHaveBeenCalled()
})

it('creates only plain config ancestors before native private leaf creation, coalescing writers', async () => {
  const { common } = fixture(), leaf = path.join(common, 'missing', 'parent', 'leaf')
  const first = primePrivateDirectory(leaf)
  expect(primePrivateDirectory(leaf)).toBe(first)
  expect(fs.statSync(path.dirname(leaf)).isDirectory()).toBe(true)
  expect(fs.existsSync(leaf)).toBe(false)
  fs.mkdirSync(leaf)
  finish(null, report, ''); await first
  privateStateDirectory(leaf)
  expect(childProcess.execFile).toHaveBeenCalledTimes(1)
  expect(childProcess.execFileSync).not.toHaveBeenCalled()
})
