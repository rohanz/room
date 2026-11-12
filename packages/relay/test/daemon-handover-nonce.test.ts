/** authenticated health must belong to the final published incarnation. */
import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as childProcess from 'node:child_process'
import { CURRENT_COMPAT } from '@room/hub-core'
import { cloneId } from '../src/index.js'
import { ensureLocalDaemon } from '../src/daemon.js'
import { privateStateDirectory } from '../src/private-state.js'
import * as proof from '../src/proof.js'
import * as leases from '../src/leases.js'

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }))
let dir: string | undefined
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(childProcess.spawn).mockReset()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

it('reprobes when a ready reply belongs to an earlier incarnation of the final published PID', async () => {
  const common = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'review-race-nonce-')))
  dir = common
  privateStateDirectory(path.join(common, 'room'))
  const predecessor = 2147483000, reusedPid = predecessor - 1
  const nonceA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const nonceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const nonceC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const publish = (pid: number, nonce: string) => fs.writeFileSync(path.join(common, 'room/relay.json'), JSON.stringify({
    schema: 2, discovery: 1, runtime: 'daemon', pid, nonce, port: 4405,
    room: 'local/review', key: 'fixture-only', startedAt: 1,
    lead: { pid, startTime: nonce, executable: '/fixture/node' },
  }), { mode: 0o600 })
  publish(predecessor, nonceA)
  vi.spyOn(leases, 'liveness').mockReturnValue('alive')
  let probes = 0
  vi.spyOn(proof, 'relayHealth').mockImplementation(async () => {
    probes++
    // B publishes and sends ready. Before the caller handles its reply, B exits and C
    // publishes on the same endpoint with a reused PID. No simultaneous owners assumed.
    // This models PID reuse / a suspended caller, not the usual one-successor race.
    if (probes === 1) { publish(reusedPid, nonceB); publish(reusedPid, nonceC) }
    return {
      pid: reusedPid, nonce: probes === 1 ? nonceB : nonceC, clone: cloneId(common),
      runtime: 'daemon', ready: true, draining: false, idleMs: 300000,
      compat: { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] } },
    }
  })
  await expect(ensureLocalDaemon(common, 'local/review', { startupTimeoutMs: 1000 }))
    .resolves.toMatchObject({ pid: reusedPid, launched: false })
  expect(childProcess.spawn).not.toHaveBeenCalled()
  expect(probes).toBe(2)
})
