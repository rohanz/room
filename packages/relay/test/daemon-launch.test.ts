/** Launcher ownership without subprocesses or sockets: the authenticated winner can be a racing child. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { CURRENT_COMPAT } from '@room/hub-core'
import { cloneId } from '../src/index.js'
import { ensureLocalDaemon } from '../src/daemon.js'
import { privateStateDirectory, verifyPrivatePath } from '../src/private-state.js'
import * as proof from '../src/proof.js'

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn() }))

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); vi.mocked(childProcess.spawn).mockReset(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

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
  const daemon = await ensureLocalDaemon(dir, 'local/test')
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
  const daemon = await ensureLocalDaemon(dir, 'local/test', { entryPath: path.resolve(import.meta.filename) })
  expect(daemon).toMatchObject({ pid: winner, launched: wins })
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(child.unref).toHaveBeenCalledOnce()
})
