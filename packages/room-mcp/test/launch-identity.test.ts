// rc12 review round 4: a launch recorded the new worker's start time and its executable from two separate probe
// reads, through the shared cache. One fresh snapshot now gives both, so the registry never stores a mix.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../src/port-reservations.js', () => ({
  reserveWorkerPort: () => ({ port: 4409, release: () => {} }),
  bindWorkerPortReservation: () => {},
}))
import { captureOwnedWorkerIdentity, launchWorkerProcess } from '../src/worker-launch.js'
import type { Session } from '../src/session.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('takes the launched worker\'s start time and executable from one probe read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-launch-identity-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  const answers = [{ startTime: 'darwin:1:5', executable: 'codex' }, { startTime: 'darwin:1:6', executable: 'nice' }]
  let reads = 0
  const proc = { pid: 4242, started: Promise.resolve(), onExit: () => {}, kill: () => true, killForce: () => false, isRunning: () => true }
  const result = await launchWorkerProcess({ session: { dir: root, roomName: 'local/repo' } as Session, id: 'w_launch', tag: 'tests', dir: root,
    lead: 'lead', owner: 'lead', host: 'claude', share: 'intent', run: 1, nonce: 'nonce', registry: root,
    budget: { threads: 1, memGb: 1, nice: 10 }, server: 'local', isWorker: false,
    spawner: () => proc, probe: () => answers[Math.min(reads++, 1)], log: () => {} },
  { mode: 'fresh', task: 'test', links: [] },
  { setHandle: () => {}, watch: () => {}, aborted: () => false }, async () => {}, async () => {}, async () => {})
  expect(result).toMatchObject({ processStartTime: 'darwin:1:5', processExecutable: 'codex' })
  expect(reads).toBe(1)
})

it('retries an unreadable owned-child identity before publishing the durable launch snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-launch-identity-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  const identity = { startTime: 'windows:2026-10-06T01:23:45.1234567Z', executable: 'node' }
  const probe = vi.fn().mockReturnValueOnce({}).mockReturnValue(identity)
  const proc = { pid: 4242, started: Promise.resolve(), onExit: () => {}, kill: () => true, isRunning: () => true }
  const persisted = vi.fn(async () => {})
  await launchWorkerProcess({ session: { dir: root, roomName: 'local/repo' } as Session, id: 'w_launch', tag: 'tests', dir: root,
    lead: 'lead', owner: 'lead', host: 'claude', share: 'intent', run: 1, nonce: 'nonce', registry: root,
    budget: { threads: 1, memGb: 1, nice: 10 }, server: 'local', isWorker: false,
    spawner: () => proc, probe, log: () => {} },
  { mode: 'fresh', task: 'test', links: [] },
  { setHandle: () => {}, watch: () => {}, aborted: () => false }, async () => {}, persisted, async () => {})
  expect(persisted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    processStartTime: identity.startTime, processExecutable: identity.executable,
  }))
  expect(probe).toHaveBeenCalledTimes(2)
})

it('never adopts a reused PID when the retained child exits during a blocking probe before close is delivered', async () => {
  let alive = true
  const proc = { pid: 4242, started: Promise.resolve(), onExit: () => {}, kill: () => true, isRunning: () => alive }
  const probe = vi.fn(() => {
    alive = false // the OS handle observes death before the JS close callback runs
    return { startTime: 'windows:reused', executable: 'node' }
  })
  expect(await captureOwnedWorkerIdentity(proc, () => true, probe)).toBeUndefined()
  expect(probe).toHaveBeenCalledTimes(1)
})

it('bounds unreadable identity retries and stops reading after cancellation', async () => {
  const proc = { pid: 4242, started: Promise.resolve(), onExit: () => {}, kill: () => true, isRunning: () => true }
  const unreadable = vi.fn(() => ({}))
  expect(await captureOwnedWorkerIdentity(proc, () => true, unreadable)).toBeUndefined()
  expect(unreadable).toHaveBeenCalledTimes(3)
  let active = true
  const cancelled = vi.fn(() => { active = false; return { startTime: 'birth', executable: 'node' } })
  expect(await captureOwnedWorkerIdentity(proc, () => active, cancelled)).toBeUndefined()
  expect(cancelled).toHaveBeenCalledTimes(1)
})

it.each(['unreadable', 'missing handle', 'cancelled'] as const)('stops the owned Windows child when launch is %s', async failure => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-launch-identity-'))
  roots.push(root)
  execFileSync('git', ['init', '-q', root])
  let onExit: (code: number | null) => void = () => {}
  let aborted = false
  const kill = vi.fn(() => { onExit(0); return true })
  const proc = { pid: 4242, started: Promise.resolve(), onExit: () => {}, kill,
    ...(failure === 'missing handle' ? {} : { isRunning: () => true }) }
  const probe = vi.fn(() => { if (failure === 'cancelled') aborted = true; return {} })
  const persisted = vi.fn(async () => {})
  const operation = launchWorkerProcess({ session: { dir: root, roomName: 'local/repo' } as Session, id: 'w_launch', tag: 'tests', dir: root,
    lead: 'lead', owner: 'lead', host: 'claude', share: 'intent', run: 1, nonce: 'nonce', registry: root,
    budget: { threads: 1, memGb: 1, nice: 10 }, server: 'local', isWorker: false, platform: 'win32',
    spawner: () => proc, probe, log: () => {} },
  { mode: 'fresh', task: 'test', links: [] },
  { setHandle: () => {}, watch: (_id, _proc, cb) => { onExit = cb }, aborted: () => aborted }, async () => {}, persisted, async () => {})
  await expect(operation).rejects.toMatchObject({ delivered: true, stopped: true, pid: 4242,
    phase: failure === 'cancelled' ? 'cancelled' : 'start' })
  expect(kill).toHaveBeenCalledTimes(1)
  expect(persisted).not.toHaveBeenCalled()
  expect(probe).toHaveBeenCalledTimes(failure === 'missing handle' ? 0 : failure === 'cancelled' ? 1 : 3)
})
