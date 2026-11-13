/** Review reproducers: real ensure/stop control flow, mocked OS and transport boundaries. */
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

function fixture(initialRelease = '0.17.38', olderSuccessors = 0) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rev5-upgrade-'))); dirs.push(dir)
  privateStateDirectory(path.join(dir, 'room'))
  let serial = 1, alive = true, currentRelease = initialRelease, startupDelay = false
  const pid = () => 2147483000 - serial
  const nonce = () => `11111111-1111-1111-1111-${String(serial).padStart(12, '0')}`
  const publish = () => fs.writeFileSync(path.join(dir, 'room/relay.json'), JSON.stringify({
    schema: 2, discovery: 1, runtime: 'daemon', pid: pid(), nonce: nonce(), port: 4405, room: 'local/test',
    key: 'fixture-only', startedAt: 1, lead: { pid: pid(), startTime: 'fixture', executable: '/fixture/node' },
  }), { mode: 0o600 })
  publish()
  vi.spyOn(proof, 'relayHealth').mockImplementation(async () => {
    if (startupDelay) {
      startupDelay = false
      if (vi.isFakeTimers()) vi.setSystemTime(Date.now() + 40)
    }
    return alive ? ({
    pid: pid(), nonce: nonce(), release: currentRelease, clone: cloneId(dir), runtime: 'daemon', ready: true, idleMs: 300000,
    compat: { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] } },
    }) : undefined
  })
  vi.spyOn(leases, 'liveness').mockImplementation(identity => alive && identity.pid === pid() ? 'alive' : 'dead')
  const fetcher = vi.fn(async () => {
    alive = false
    return new Response(JSON.stringify({ saved: true }))
  })
  vi.stubGlobal('fetch', fetcher)
  const spawn = vi.mocked(childProcess.spawn).mockImplementation(() => {
    serial++; alive = true
    currentRelease = serial <= olderSuccessors + 1 ? initialRelease : '0.17.49'
    publish()
    // An older client's reconnect launch wins each contested authority acquisition.
    // Give each startup 40ms; the requested absolute startup budget is 100ms.
    startupDelay = true
    return Object.assign(new EventEmitter(), { pid: pid() - 100, unref: vi.fn() }) as childProcess.ChildProcess
  })
  return { fetcher, spawn, pid, stop: () => { alive = false }, ensure: () => ensureLocalDaemon(dir, 'local/test', {
    entryPath: path.resolve(import.meta.filename), startupTimeoutMs: 100,
  }) }
}

it.each(['', '0.17.38garbage'])('does not infer a numbered release order for malformed daemon release %j', async value => {
  const f = fixture(value), original = f.pid()
  await expect(f.ensure()).resolves.toMatchObject({ pid: original })
  expect(f.fetcher).not.toHaveBeenCalled()
})

it('hands over once per call and accepts an older client that wins the restart', async () => {
  const f = fixture('0.17.38', 8), original = f.pid()
  const daemon = await f.ensure()
  expect(daemon.pid).not.toBe(original)
  expect(f.fetcher).toHaveBeenCalledOnce()
  expect(f.spawn).toHaveBeenCalledOnce()
})

it('rediscovers after a stop succeeded but its response was lost', async () => {
  const f = fixture(), original = f.pid()
  f.fetcher.mockImplementationOnce(async () => {
    f.stop()
    throw new TypeError('fetch failed after server stopped')
  })
  const daemon = await f.ensure()
  expect(daemon.pid).not.toBe(original)
  expect(f.spawn).toHaveBeenCalledOnce()
})
