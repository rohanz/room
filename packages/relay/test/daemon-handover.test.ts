/** Review reproducer: a live successor answers before replacing its predecessor's discovery. */
import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import * as childProcess from 'node:child_process'
import { CURRENT_COMPAT } from '@room/hub-core'
import { cloneId } from '../src/index.js'
import { ensureLocalDaemon } from '../src/daemon.js'
import { privateStateDirectory } from '../src/private-state.js'
import * as proof from '../src/proof.js'
import * as leases from '../src/leases.js'

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }))
const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(childProcess.spawn).mockReset()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

it.each([false, true])('retries stale discovery when successor readiness is %s', async readyDuringProbe => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'review-cutover-startup-')))
  dirs.push(dir)
  privateStateDirectory(path.join(dir, 'room'))
  const oldPid = 2147483000, successorPid = oldPid - 1
  const discovery = path.join(dir, 'room', 'relay.json')
  const publish = (pid: number) => fs.writeFileSync(discovery, JSON.stringify({
    schema: 2, discovery: 1, runtime: 'daemon', pid, port: 4405, room: 'local/review',
    key: 'fixture-only', startedAt: 1,
    lead: { pid, startTime: 'dead-fixture', executable: '/fixture/node' },
  }), { mode: 0o600 })
  publish(oldPid)
  const child = Object.assign(new EventEmitter(), { pid: successorPid, unref: vi.fn() })
  vi.mocked(childProcess.spawn).mockReturnValue(child as childProcess.ChildProcess)
  let probes = 0
  vi.spyOn(proof, 'relayHealth').mockImplementation(async () => {
    probes++
    if (probes === 1) return undefined // dead predecessor allows launch
    // startLocalDaemon listens, awaits lease initialization, then publishes discovery.
    // Poll 2 observes the listening phase; a subsequent poll sees the published successor.
    // Publication can also happen during the health await, after ready() captured old discovery.
    if (probes >= 3 || readyDuringProbe) publish(successorPid)
    return {
      pid: successorPid, clone: cloneId(dir), runtime: 'daemon', ready: readyDuringProbe || probes >= 3,
      draining: false, idleMs: 300000, // as the real daemon: not ready, and not draining, until it has published
      compat: { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] } },
    }
  })
  await expect(ensureLocalDaemon(dir, 'local/review', {
    entryPath: path.resolve(import.meta.filename), startupTimeoutMs: 1000,
  })).resolves.toMatchObject({ pid: successorPid, launched: true })
})

function fixture() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-handover-')))
  dirs.push(dir)
  privateStateDirectory(path.join(dir, 'room'))
  const info = {
    schema: 2, discovery: 1, runtime: 'daemon', pid: 2147483000, port: 4405,
    room: 'local/test', key: 'fixture-only', startedAt: 1,
    lead: { pid: 2147483000, startTime: 'fixture', executable: '/fixture/node' },
  }
  const publish = (record = info) => fs.writeFileSync(path.join(dir, 'room', 'relay.json'), JSON.stringify(record), { mode: 0o600 })
  const health = (pid = info.pid) => ({
    pid, clone: cloneId(dir), runtime: 'daemon', ready: true, idleMs: 300000,
    compat: { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] } },
  })
  publish()
  return { dir, info, publish, health }
}

it.each(['pid', 'port', 'key'] as const)('does not adopt an obsolete ready reply when discovery changes its %s during authentication', async field => {
  const f = fixture(), successorPid = f.info.pid - 1
  const successor = { ...f.info, pid: successorPid, lead: { ...f.info.lead, pid: successorPid },
    ...(field === 'port' ? { port: f.info.port + 1 } : {}), ...(field === 'key' ? { key: 'replacement-key' } : {}) }
  vi.mocked(childProcess.spawn).mockReturnValue(Object.assign(new EventEmitter(), { pid: successorPid, unref: vi.fn() }) as childProcess.ChildProcess)
  let probes = 0
  vi.spyOn(proof, 'relayHealth').mockImplementation(async (port, key) => {
    if (++probes === 1) { f.publish(successor); return f.health() }
    expect([port, key]).toEqual([successor.port, successor.key])
    return f.health(successorPid)
  })
  await expect(ensureLocalDaemon(f.dir, 'local/test', {
    entryPath: path.resolve(import.meta.filename), startupTimeoutMs: 1000,
  })).resolves.toMatchObject({ pid: successorPid, port: successor.port, key: successor.key })
  expect(probes).toBe(2)
})

it.each(['alive', 'unknown'] as const)('waits without launching over a published %s owner when a not-ready reply arrives after publication', async state => {
  const f = fixture(), successorPid = f.info.pid - 1
  const successor = { ...f.info, pid: successorPid, lead: { ...f.info.lead, pid: successorPid } }
  vi.spyOn(leases, 'liveness').mockReturnValue(state)
  let probes = 0
  vi.spyOn(proof, 'relayHealth').mockImplementation(async () => {
    if (++probes === 1) { f.publish(successor); return { ...f.health(successorPid), ready: false, draining: true } }
    return f.health(successorPid)
  })
  await expect(ensureLocalDaemon(f.dir, 'local/test', { startupTimeoutMs: 1000 }))
    .resolves.toMatchObject({ pid: successorPid, launched: false })
  expect(childProcess.spawn).not.toHaveBeenCalled()
})

it('refuses a stable discovery PID mismatch without launching a replacement', async () => {
  const f = fixture()
  vi.spyOn(proof, 'relayHealth').mockResolvedValue(f.health(f.info.pid - 1))
  await expect(ensureLocalDaemon(f.dir, 'local/test')).rejects.toThrow(/PID does not match the authenticated listener/)
  expect(childProcess.spawn).not.toHaveBeenCalled()
})

it.each(['alive', 'unknown'] as const)('never launches over an unauthenticated published %s owner, and bounds its wait', async state => {
  const f = fixture()
  vi.spyOn(leases, 'liveness').mockReturnValue(state)
  vi.spyOn(proof, 'relayHealth').mockResolvedValue(undefined)
  await expect(ensureLocalDaemon(f.dir, 'local/test', { startupTimeoutMs: 1 })).rejects.toThrow(/startup hard cap reached/)
  expect(childProcess.spawn).not.toHaveBeenCalled()
})
