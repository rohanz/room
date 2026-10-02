// rc12 review: the R4 probe cache reuses a live pid's identity for up to 2 s. A worker that exits and whose pid is
// reused inside that window must not be signalled on the cached identity: signalling reads the identity afresh.
import { afterEach, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'

vi.mock('@room/relay/process', async importOriginal => {
  const actual = await importOriginal<typeof import('@room/relay/process')>()
  // The cached reader still holds the exited worker's identity for this pid.
  return { ...actual, probeProcess: () => ({ startTime: 'darwin:1:100', executable: 'claude' }) }
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
