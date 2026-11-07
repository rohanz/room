/** Launcher ownership without subprocesses or sockets: the authenticated winner can be a racing child. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { CURRENT_COMPAT } from '@room/hub-core'
import { cloneId } from '../src/index.js'
import { daemonChildEnvironment, ensureLocalDaemon } from '../src/daemon.js'
import { privateStateDirectory, verifyPrivatePath } from '../src/private-state.js'
import * as proof from '../src/proof.js'

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn() }))
// These tests are about the launcher's wait and ownership logic against a real clock. The native Windows ACL
// check (5-10 s of PowerShell on CI) is covered by private-state tests; here it only adds wall time.
vi.mock('../src/private-state.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/private-state.js')>()
  const { mkdirSync } = await import('node:fs')
  return process.platform === 'win32' ? { ...real, primePrivateState: async () => {}, verifyPrivatePath: () => {}, privateStateDirectory: (dir: string) => { mkdirSync(dir, { recursive: true }) } } : real
})

const dirs: string[] = []

it.each(['win32', 'linux'] as const)('passes Windows OS basics only on win32 and excludes session identity and credentials on %s', platform => {
  const windows = ['SystemDrive', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'ComSpec', 'PATHEXT', 'APPDATA', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME']
  const excluded = ['ROOM_TAG', 'ROOM_OWNER', 'ROOM_SERVER', 'ROOM_WORKER_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_HOME', 'NODE_OPTIONS', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PSModulePath']
  const source = Object.fromEntries([...windows, ...excluded, 'PATH', 'SystemRoot', 'TEMP', 'HOME'].map(name => [name, `fixture-${name}`]))
  const env = daemonChildEnvironment(source, platform)
  for (const name of windows) expect(env[name]).toBe(platform === 'win32' ? source[name] : undefined)
  for (const name of excluded) expect(env[name]).toBeUndefined()
  for (const name of ['PATH', 'SystemRoot', 'TEMP', 'HOME']) expect(env[name]).toBe(source[name])
  // Windows variable names are case-insensitive; preserve the supplied spelling as Node does.
  expect(daemonChildEnvironment({ SYSTEMDRIVE: 'C:', comspec: 'cmd.exe', node_options: 'excluded' }, 'win32'))
    .toEqual({ SYSTEMDRIVE: 'C:', comspec: 'cmd.exe' })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(childProcess.spawn).mockReset(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-launch-ownership-')); dirs.push(dir)
  privateStateDirectory(path.join(dir, 'room'))
  let pid = 0
  const publish = (winner: number) => {
    pid = winner
    const file = path.join(dir, 'room', 'relay.json')
    fs.writeFileSync(file, JSON.stringify({ schema: 2, runtime: 'daemon', pid, port: 4401, room: 'local/test', key: 'fixture-only', startedAt: 1 }), { mode: 0o600 })
    verifyPrivatePath(file, true)
  }
  vi.spyOn(proof, 'relayHealth').mockImplementation(async () => ({
    pid, clone: cloneId(dir), runtime: 'daemon', ready: true, idleMs: 300000,
    compat: { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] } },
  }))
  return { dir, publish }
}

it('reports adoption without launching a child when an instance is already ready', async () => {
  const { dir, publish } = fixture(); publish(2147483000)
  const spawn = vi.mocked(childProcess.spawn).mockImplementation(() => { throw new Error('unexpected launch') })
  const daemon = await ensureLocalDaemon(dir, 'local/test', { admitStart: async () => {} })
  expect(daemon).toMatchObject({ pid: 2147483000, launched: false })
  expect(spawn).not.toHaveBeenCalled()
})

it.each([true, false])('reports launched=%s only when its own child wins authority', async wins => {
  const { dir, publish } = fixture(), ownPid = 2147483000, winner = wins ? ownPid : ownPid - 1
  const child = Object.assign(new EventEmitter(), { pid: ownPid, unref: vi.fn() })
  const spawn = vi.mocked(childProcess.spawn).mockImplementation(() => {
    publish(winner)
    return child as childProcess.ChildProcess
  })
  const daemon = await ensureLocalDaemon(dir, 'local/test', { admitStart: async () => {}, entryPath: path.resolve(import.meta.filename) })
  expect(daemon).toMatchObject({ pid: winner, launched: wins })
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(child.unref).toHaveBeenCalledOnce()
})

it('asks for start admission only when it must spawn, and a refusal prevents the spawn', async () => {
  const { dir, publish } = fixture()
  const spawn = vi.mocked(childProcess.spawn).mockImplementation(() => { throw new Error('unexpected launch') })
  // No daemon answers (the adopted owner exited): the start admission runs and refuses.
  const beforeStart = vi.fn(async () => { throw new Error('legacy clients still live') })
  await expect(ensureLocalDaemon(dir, 'local/test', { entryPath: path.resolve(import.meta.filename), admitStart: beforeStart })).rejects.toThrow('legacy clients still live')
  expect(beforeStart).toHaveBeenCalledOnce()
  expect(spawn).not.toHaveBeenCalled()
  // A ready daemon is adopted without the start admission.
  publish(2147483000)
  const adopt = vi.fn(async () => {})
  await expect(ensureLocalDaemon(dir, 'local/test', { admitStart: adopt })).resolves.toMatchObject({ launched: false })
  expect(adopt).not.toHaveBeenCalled()
})

function launchFixture(onSpawn: (child: EventEmitter, dir: string, publish: (pid: number) => void) => void) {
  const { dir, publish } = fixture(), ownPid = 2147483000
  const child = Object.assign(new EventEmitter(), { pid: ownPid, unref: vi.fn() })
  vi.mocked(childProcess.spawn).mockImplementation(() => {
    onSpawn(child, dir, publish)
    return child as childProcess.ChildProcess
  })
  return { dir, ownPid, child, launch: (startupTimeoutMs?: number) => ensureLocalDaemon(dir, 'local/test', { admitStart: async () => {}, entryPath: path.resolve(import.meta.filename), startupTimeoutMs }) }
}
function phase(dir: string, pid: number, name: string) {
  fs.appendFileSync(path.join(dir, 'room', 'daemon.log'), `startup pid ${pid}: ${name}\n`, { mode: 0o600 })
}
function authority(dir: string) {
  const hub = path.join(dir, 'room', 'hub')
  fs.mkdirSync(hub)
  fs.writeFileSync(path.join(hub, 'authority.lock'), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
}

it('waits for a live slow child beyond ten seconds while fresh startup phases advance', async () => {
  const f = launchFixture((_child, dir, publish) => {
    setTimeout(() => phase(dir, 2147483000, 'state verified'), 12_000)
    setTimeout(() => phase(dir, 2147483000, 'listening'), 30_000)
    setTimeout(() => publish(2147483000), 40_000)
  })
  vi.useFakeTimers()
  const launch = f.launch()
  await vi.advanceTimersByTimeAsync(40_100)
  await expect(launch).resolves.toMatchObject({ pid: f.ownPid, launched: true })
})

it('keeps waiting after its losing child exits while a live authority makes progress and publishes', async () => {
  const f = launchFixture((child, dir, publish) => {
    authority(dir)
    setTimeout(() => child.emit('exit', 0, null), 1)
    setTimeout(() => phase(dir, process.pid, 'authority acquired'), 12_000)
    setTimeout(() => phase(dir, process.pid, 'listening'), 30_000)
    setTimeout(() => publish(process.pid), 40_000)
  })
  vi.useFakeTimers()
  const launch = f.launch()
  await vi.advanceTimersByTimeAsync(40_100)
  await expect(launch).resolves.toMatchObject({ pid: process.pid, launched: false })
})

it('fails fast with a bounded private log tail when its child exits and no winner holds authority', async () => {
  const f = launchFixture((child, dir) => {
    fs.writeFileSync(path.join(dir, 'room', 'daemon.log'), 'excluded old line\n' + 'x'.repeat(2000) + '\nstartup failed: EACCES fixture\n', { mode: 0o600 })
    setTimeout(() => child.emit('exit', 1, null), 1)
  })
  vi.useFakeTimers()
  const start = Date.now(), failure = f.launch().catch(error => error as Error)
  await vi.advanceTimersByTimeAsync(200)
  const error = await failure as Error
  expect(Date.now() - start).toBeLessThan(1000)
  expect(error.message).toContain(`local daemon startup unavailable (child pid ${f.ownPid}): child exited (code 1); no live authority contender`)
  expect(error.message).toContain('daemon.log (last 1024 bytes, up to 5 lines):\nstartup failed: EACCES fixture')
  expect(error.message).not.toContain('excluded old line')
  expect(error.message.length).toBeLessThan(1500)
})

it('reports a fatal error the child wrote before daemon.log existed, and removes the report directory', async () => {
  const { dir } = fixture(), child = Object.assign(new EventEmitter(), { pid: 2147483000, unref: vi.fn() })
  let report = ''
  vi.mocked(childProcess.spawn).mockImplementation((_cmd, args) => {
    report = (args as string[])[(args as string[]).indexOf('--startup-report') + 1]
    if (process.platform !== 'win32') expect(fs.statSync(path.dirname(report)).mode & 0o777).toBe(0o700)
    fs.writeFileSync(report, 'Cannot verify the Windows owner/DACL for C:\\fixture (PowerShell timed out)', { flag: 'wx', mode: 0o600 })
    setTimeout(() => child.emit('exit', 1, null), 1)
    return child as childProcess.ChildProcess
  })
  vi.useFakeTimers()
  const failure = ensureLocalDaemon(dir, 'local/test', { admitStart: async () => {}, entryPath: path.resolve(import.meta.filename) }).catch(error => error as Error)
  await vi.advanceTimersByTimeAsync(200)
  const error = await failure as Error
  expect(error.message).toContain('child exited (code 1); no live authority contender; daemon error: Cannot verify the Windows owner/DACL for C:\\fixture (PowerShell timed out)')
  expect(path.basename(path.dirname(report))).toMatch(/^room-daemon-start-/)
  expect(fs.existsSync(path.dirname(report))).toBe(false)
})

it.skipIf(process.platform === 'win32')('never exposes a symlinked log in startup diagnostics', async () => {
  const f = launchFixture((child, dir) => {
    const outside = path.join(dir, 'outside.log')
    fs.writeFileSync(outside, 'must not leak')
    fs.symlinkSync(outside, path.join(dir, 'room', 'daemon.log'))
    setTimeout(() => child.emit('exit', 1, null), 1)
  })
  vi.useFakeTimers()
  const failure = f.launch().catch(error => error as Error)
  await vi.advanceTimersByTimeAsync(200)
  const error = await failure as Error
  expect(error.message).toContain('no readable private daemon.log tail')
  expect(error.message).not.toContain('must not leak')
})

it('stops waiting for an alive child with no new phases, and caps even continuous phase progress', async () => {
  const f = launchFixture((_child, dir) => {
    for (let second = 10; second <= 60; second += 10) setTimeout(() => phase(dir, 2147483000, `progress ${second}`), second * 1000)
  })
  vi.useFakeTimers()
  const progressing = f.launch().catch(error => error as Error)
  await vi.advanceTimersByTimeAsync(60_100)
  expect((await progressing as Error).message).toContain('startup hard cap reached')
  vi.clearAllTimers()
  vi.mocked(childProcess.spawn).mockImplementation(() => Object.assign(new EventEmitter(), { pid: f.ownPid, unref: vi.fn() }) as childProcess.ChildProcess)
  const stalled = f.launch().catch(error => error as Error)
  await vi.advanceTimersByTimeAsync(25_100)
  expect((await stalled as Error).message).toContain('startup phase stalled')
})

it('honors an explicitly shorter startup hard cap', async () => {
  const f = launchFixture(() => {})
  vi.useFakeTimers()
  const failure = f.launch(500).catch(error => error as Error)
  await vi.advanceTimersByTimeAsync(600)
  expect((await failure as Error).message).toContain('startup hard cap reached')
})
