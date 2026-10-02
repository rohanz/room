// rc12 review: the R4 probe cache reuses a live pid's identity for up to 2 s. A worker that exits and whose pid is
// reused inside that window must not be signalled on the cached identity: signalling reads the identity afresh.
import { afterEach, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'

const fresh = vi.hoisted(() => ({ reads: 0 }))
vi.mock('@room/relay/process', async importOriginal => {
  const actual = await importOriginal<typeof import('@room/relay/process')>()
  // The cached reader still holds the exited worker's identity for this pid.
  return { ...actual, probeProcess: () => ({ startTime: 'darwin:1:100', executable: 'claude' }),
    probeProcessNow: (pid: number) => { fresh.reads++; return actual.probeProcessNow(pid) },
    probeProcessSince: (pid: number, start: string | undefined) => { fresh.reads++; return actual.probeProcessSince(pid, start) } }
})
import { signalWorker } from '../src/worker-process.js'

let child: ChildProcess | undefined
afterEach(() => { child?.kill('SIGKILL'); child = undefined })

it('verifies a worker afresh before signalling it, never from a cached identity', async () => {
  child = spawn('sleep', ['30'], { stdio: 'ignore' })
  await new Promise(resolve => child!.once('spawn', resolve))
  expect(signalWorker(child.pid!, 'SIGTERM', undefined, undefined, { processStartTime: 'darwin:1:100', host: 'claude' })).toBe(false)
  expect(child.exitCode).toBeNull()
  expect(child.signalCode).toBeNull()
})

it('confirms "not ours" from the cached probe with a fresh read', async () => {
  const { workerProcessOwnership } = await import('../src/worker-process.js')
  child = spawn('sleep', ['30'], { stdio: 'ignore' })
  await new Promise(resolve => child!.once('spawn', resolve))
  const { probeProcessNow } = await import('@room/relay/process')
  const live = probeProcessNow(child.pid!)!
  // The cached reader still says darwin:1:100; the live process is the recorded one.
  expect(workerProcessOwnership(child.pid!, { processStartTime: live.startTime, host: 'sleep' as never })).toBe('ours')
})

it('answers a vanished pid not ours without a fresh read (R4: status reads of exited workers)', async () => {
  const { workerProcessOwnership } = await import('../src/worker-process.js')
  fresh.reads = 0
  for (let i = 0; i < 50; i++) expect(workerProcessOwnership(2 ** 30, { processStartTime: 'darwin:1:200', host: 'claude' })).toBe('not-ours')
  expect(fresh.reads).toBe(0)
})
