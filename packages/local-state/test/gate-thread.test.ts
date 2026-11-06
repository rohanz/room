import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as threads from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import { openStorageGate } from '../src/gate.js'
import { StorageRefused } from '../src/protocol.js'

vi.mock('node:worker_threads', async importOriginal => ({ ...await importOriginal<typeof threads>(), Worker: vi.fn() }))
const OriginalWorker = (await vi.importActual<typeof threads>('node:worker_threads')).Worker
const roots: string[] = []
const workers: threads.Worker[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(workers.splice(0).map(worker => worker.terminate()))
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'room-gate-thread-')))
  roots.push(dir)
  fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n')
  const instance = { pid: process.pid, startTime: '', executable: '', sessionId: 'test', nonce: randomUUID() }
  return { dir, input: { instance, kind: 'mcp' as const, release: 'test' } }
}
function captureWorkers(prelude = '', workerData?: unknown) {
  return vi.mocked(threads.Worker).mockClear().mockImplementation(function (entry, options) {
    const worker = new OriginalWorker(prelude ? prelude + entry : entry, { ...options, workerData })
    workers.push(worker)
    return worker
  })
}

it('keeps the caller responsive through a 300 ms fsync stall in each production write operation', async () => {
  const stall = new Int32Array(new SharedArrayBuffer(8))
  const constructors = captureWorkers(`
    import fs from 'node:fs';
    import { workerData } from 'node:worker_threads';
    const stall = new Int32Array(workerData);
    const sync = fs.fsyncSync;
    fs.fsyncSync = fd => {
      if (Atomics.exchange(stall, 0, 0)) {
        const until = performance.now() + 300;
        while (performance.now() < until) {}
        Atomics.add(stall, 1, 1);
      }
      return sync(fd);
    };
  `, stall.buffer)
  const { dir, input } = fixture(), gate = openStorageGate(dir)
  expect(constructors).not.toHaveBeenCalled() // constructing/observing never starts an I/O worker
  await gate.observe()
  expect(constructors).not.toHaveBeenCalled()
  await gate.status() // warm the loader before measuring only the file operations

  async function responsive<T>(operation: () => Promise<T>): Promise<T> {
    const before = Atomics.load(stall, 1)
    let last = performance.now(), ticks = 0, maximum = 0
    const timer = setInterval(() => {
      const now = performance.now()
      maximum = Math.max(maximum, now - last); last = now; ticks++
    }, 5)
    Atomics.store(stall, 0, 1)
    try {
      const result = await operation()
      maximum = Math.max(maximum, performance.now() - last)
      expect(Atomics.load(stall, 1)).toBe(before + 1)
      expect(ticks).toBeGreaterThan(5)
      expect(maximum).toBeLessThan(50)
      return result
    } finally { clearInterval(timer) }
  }
  const registration = await responsive(() => gate.register(input))
  const ticket = await responsive(() => gate.admit(registration, 'preview'))
  await responsive(() => gate.finish(ticket))
  await responsive(() => gate.unregister(registration))
  await openStorageGate(fixture().dir).status()
  expect(constructors).toHaveBeenCalledTimes(1) // one worker, including across clones/proxies
})

it('rehydrates refusal reason/detail/remedy and preserves cloneable options', async () => {
  captureWorkers()
  const { dir, input } = fixture(), gate = openStorageGate(dir, { limits: { tickets: 1 } })
  const registration = await gate.register(input)
  const ticket = await gate.admit(registration, 'preview')
  const error = await gate.admit(registration, 'preview').catch(error => error)
  expect(error).toBeInstanceOf(StorageRefused)
  expect(error).toMatchObject({ reason: 'capacity', detail: '1 operations are in progress for this clone', remedy: 'retry after current operations finish' })
  await expect(gate.unregister(registration)).rejects.toMatchObject({ reason: 'busy' })
  await gate.finish(ticket)
  await gate.unregister(registration)
})

it('rejects every pending call on worker death without replay and can start a fresh worker', async () => {
  captureWorkers()
  const { dir } = fixture(), gate = openStorageGate(dir)
  await gate.status()
  const worker = workers[0]
  // Stop the worker before dispatch; both requests must settle on the exit event.
  const stopped = worker.terminate()
  const calls = [gate.status(), gate.status()]
  const results = Promise.allSettled(calls)
  await stopped
  for (const result of await results) {
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(StorageRefused)
  }
  expect(await gate.status()).toMatchObject({ state: 'absent' })
  expect(workers).toHaveLength(2)
})
