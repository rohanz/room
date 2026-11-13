/** Release handover exercises the real authenticated stop path without sockets or subprocesses. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import * as childProcess from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { CURRENT_COMPAT } from '@room/hub-core'
import { cloneId } from '../src/index.js'
import * as proof from '../src/proof.js'
import * as leases from '../src/leases.js'
import { privateStateDirectory } from '../src/private-state.js'

vi.hoisted(() => { vi.stubGlobal('__ROOM_DAEMON_RELEASE__', '0.17.49') })
import { ensureLocalDaemon } from '../src/daemon.js'

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }))
const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(childProcess.spawn).mockReset()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(daemonRelease = '0.17.38') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-upgrade-'))); dirs.push(dir)
  privateStateDirectory(path.join(dir, 'room'))
  const oldPid = 2147483000, newPid = oldPid - 1
  const oldNonce = '11111111-1111-1111-1111-111111111111', newNonce = '22222222-2222-2222-2222-222222222222'
  let pid = oldPid, nonce = oldNonce, currentRelease = daemonRelease, stopped = false
  const publish = () => fs.writeFileSync(path.join(dir, 'room', 'relay.json'), JSON.stringify({
    schema: 2, discovery: 1, runtime: 'daemon', pid, nonce, port: 4405, room: 'local/test',
    key: 'fixture-only', startedAt: 1, lead: { pid, startTime: 'fixture', executable: '/fixture/node' },
  }), { mode: 0o600 })
  publish()
  vi.spyOn(proof, 'relayHealth').mockImplementation(async () => stopped && pid === oldPid ? undefined : ({
    pid, nonce, release: currentRelease, clone: cloneId(dir), runtime: 'daemon', ready: true, idleMs: 300000,
    compat: { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] } },
  }))
  vi.spyOn(leases, 'liveness').mockImplementation(identity => identity.pid === oldPid && stopped ? 'dead' : 'alive')
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    expect(String(url)).toBe(`http://127.0.0.1:4405/daemon/stop?pid=${oldPid}&nonce=${oldNonce}`)
    expect(options?.method).toBe('POST')
    expect(options?.headers).toEqual({ Authorization: expect.stringMatching(/^Room-Proof /) })
    expect(options?.signal).toBeDefined()
    stopped = true
    return new Response(JSON.stringify({ saved: true }))
  })
  vi.stubGlobal('fetch', fetcher)
  const spawn = vi.mocked(childProcess.spawn).mockImplementation(() => {
    expect(stopped).toBe(true)
    pid = newPid; nonce = newNonce; currentRelease = '0.17.49'; publish()
    return Object.assign(new EventEmitter(), { pid, unref: vi.fn() }) as childProcess.ChildProcess
  })
  const logs: string[] = []
  return { dir, oldPid, newPid, fetcher, spawn, logs, ensure: () => ensureLocalDaemon(dir, 'local/test', { entryPath: path.resolve(import.meta.filename), log: line => logs.push(line) }) }
}

it('replaces an older-release daemon when a newer client ensures it', async () => {
  const f = fixture()
  await expect(f.ensure()).resolves.toMatchObject({ pid: f.newPid, launched: true })
  expect(f.fetcher).toHaveBeenCalledOnce()
  expect(f.spawn).toHaveBeenCalledOnce()
})

it.each(['0.17.49', '0.17.50', '0.17.100', 'development'])('reuses daemon release %s without stopping or launching', async daemonRelease => {
  const f = fixture(daemonRelease)
  await expect(f.ensure()).resolves.toMatchObject({ pid: f.oldPid, launched: false })
  expect(f.fetcher).not.toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
  expect(f.logs).toEqual([])
})

it('a development client reuses a numbered daemon', async () => {
  const f = fixture()
  vi.resetModules(); vi.stubGlobal('__ROOM_DAEMON_RELEASE__', 'development')
  const freshProof = await import('../src/proof.js')
  vi.spyOn(freshProof, 'relayHealth').mockImplementation(vi.mocked(proof.relayHealth))
  const fresh = await import('../src/daemon.js')
  await expect(fresh.ensureLocalDaemon(f.dir, 'local/test')).resolves.toMatchObject({ pid: f.oldPid, launched: false })
  expect(f.fetcher).not.toHaveBeenCalled()
  expect(f.spawn).not.toHaveBeenCalled()
})

it.each(['refused', 'timed out', 'unconfirmed save'])('keeps using the running daemon when graceful stop is %s', async failure => {
  const f = fixture(), kill = vi.spyOn(process, 'kill')
  f.fetcher.mockImplementationOnce(async () => {
    if (failure === 'timed out') throw new DOMException('request timed out', 'TimeoutError')
    return failure === 'refused' ? new Response('save blocked\nEIO', { status: 409 }) : new Response('{}')
  })
  await expect(f.ensure()).resolves.toMatchObject({ pid: f.oldPid, launched: false })
  expect(f.fetcher).toHaveBeenCalledOnce()
  expect(f.spawn).not.toHaveBeenCalled()
  expect(kill).not.toHaveBeenCalled()
  expect(f.logs).toHaveLength(1)
  expect(f.logs[0]).toMatch(/^local daemon upgrade 0.17.38 -> 0.17.49: stop not confirmed:/)
  expect(f.logs[0]).not.toContain('\n')
})

it('simultaneous clients replace once and then reuse the successor', async () => {
  const f = fixture()
  const daemons = await Promise.all([f.ensure(), f.ensure()])
  expect(daemons.map(d => d.pid)).toEqual([f.newPid, f.newPid])
  expect(f.fetcher).toHaveBeenCalledOnce()
  expect(f.spawn).toHaveBeenCalledOnce()
})

it('upgrades after a slow first health probe and retains ownership of the successor it launches', async () => {
  const f = fixture()
  vi.mocked(proof.relayHealth).mockResolvedValueOnce(undefined)
  await expect(f.ensure()).resolves.toMatchObject({ pid: f.newPid, launched: true })
  expect(f.fetcher).toHaveBeenCalledOnce()
  expect(f.spawn).toHaveBeenCalledOnce()
})

it('never kills or replaces a daemon that confirmed its save but has not exited', async () => {
  const f = fixture(), kill = vi.spyOn(process, 'kill')
  vi.mocked(leases.liveness).mockReturnValue('alive')
  vi.useFakeTimers()
  const ensuring = f.ensure().catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(15_100 + 130_000)
  // It no longer serves, so it is not returned as usable; its live owner is waited for under the startup caps.
  expect(String(await ensuring)).toMatch(/pid 2147483000 is live or has unknown identity and did not become ready; retry without taking over/)
  expect(f.spawn).not.toHaveBeenCalled()
  expect(kill).not.toHaveBeenCalled()
  expect(f.logs).toHaveLength(1)
  expect(f.logs[0]).toContain('process exit could not be verified')
})
