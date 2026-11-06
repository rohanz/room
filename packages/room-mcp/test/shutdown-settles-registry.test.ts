import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { closeStorageAdmissions, storageGate, storageInstance, withAdmission } from '../src/storage-admission.js'
import { createTools } from '../src/tools.js'
import { Rooms } from '../src/registry.js'
import { beginWorkerRegistries, registryForDir, shutdownWorkerRegistries, type WorkerRegistry } from '../src/worker-registry.js'
import { openStorageGate } from '@room/local-state/gate'
import { createExclusive, compareAndRelease } from '@room/local-state/leases'
import type { Session } from '../src/session.js'
import { testPolicyStore } from './policy-fixture.js'
import { hubSeam } from './fixtures/hub.js'

const dirs: string[] = []
let endRegistries: () => Promise<void>
beforeEach(() => { endRegistries = beginWorkerRegistries() })
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await endRegistries(); await shutdownWorkerRegistries(); await closeStorageAdmissions(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('shutdown settles the tracked session registry open, so closing admissions leaves nothing registered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-shutdown-settle-'))
  dirs.push(dir)
  execFileSync('git', ['-C', dir, 'init', '-q'])
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  const room = new RoomDoc()
  const awareness = new Awareness(room.doc)
  const s = { room, awareness, me: { name: 'Rohan', kind: 'agent' }, dir, roomUrl: 'ws://127.0.0.1:9/r', roomName: 'r', browserUrl: '', shareMax: 'full', shareRequested: 'full', ...hubSeam(room), policyStore: testPolicyStore(), provider: { synced: true } as never, daemon: { touch() {}, async stop() {} } as never } as Session
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
  tools.attachHooks(s)
  await tools.shutdown()
  awareness.destroy()
  await closeStorageAdmissions()
  // Nothing the session started may register or admit after this process acknowledged its close.
  for (let n = 0; n < 20; n++) await new Promise(resolve => setTimeout(resolve, 50))
  const status = await storageGate(join(dir, '.git')).status()
  expect(status.registrations).toBe(0)
  expect(status.tickets).toBe(0)
})

it('bounds the shutdown settle: hung background work is reported, not awaited forever', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-shutdown-settle-'))
  dirs.push(dir)
  execFileSync('git', ['-C', dir, 'init', '-q'])
  const room = new RoomDoc()
  const s = { room, dir } as Session
  let stopped = false, release!: () => void
  const hung = new Promise<void>(resolve => { release = resolve })
  const rooms = new Rooms({ primary: () => null, setPrimary: () => {}, log: () => {}, attach: () => ({ stop() { stopped = true }, settled: () => hung }) })
  rooms.add(s, 'primary')
  rooms.remove(s)
  expect(stopped).toBe(true)
  const started = performance.now()
  expect(await rooms.settle(100)).toBe(false)
  expect(performance.now() - started).toBeLessThan(2000)
  // Once the hung work ends, the same settle completes, the tracked registry open included.
  release()
  expect(await rooms.settle(30_000)).toBe(true)
})

it('shutdown stops a watching registry for good: a queued and a later change never reconcile after admissions close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-shutdown-settle-'))
  dirs.push(dir)
  execFileSync('git', ['-C', dir, 'init', '-q'])
  const common = join(dir, '.git')
  vi.stubEnv('VITEST', '') // registryForDir watches outside tests
  const registry = await registryForDir(dir)
  vi.unstubAllEnvs()
  const admit = vi.spyOn(storageGate(common), 'admit')
  const store = (registry as unknown as { file: { watchSettle?: unknown } }).file
  const root = join(common, 'room', 'registry')
  // A single write is not guaranteed to reach fs.watch (FSEvents may coalesce or miss one just after the watcher
  // starts), so each poll makes a fresh change until the watcher reacts.
  let change = 0
  const touch = () => writeFileSync(join(root, `probe-${++change}`), 'x')
  // Control: a registry change reaches a background reconcile that admits, so the checks below are not vacuous.
  // Polls slower than the 100 ms watch settle, which each change re-arms.
  await vi.waitFor(() => { touch(); expect(admit).toHaveBeenCalled() }, { timeout: 10_000, interval: 300 })
  await vi.waitFor(async () => expect((await storageGate(common).status()).tickets).toBe(0), { timeout: 10_000, interval: 20 })
  // Queue a reconcile: the watcher saw a change and its settle timer is armed when shutdown begins.
  await vi.waitFor(() => { if (!store.watchSettle) touch(); expect(store.watchSettle).toBeDefined() }, { timeout: 10_000, interval: 5 })
  await shutdownWorkerRegistries()
  await closeStorageAdmissions()
  const calls = admit.mock.calls.length
  for (let n = 0; n < 5; n++) { touch(); await new Promise(resolve => setTimeout(resolve, 20)) }
  // Longer than the watch settle (100 ms) and many watcher deliveries; the control above shows a live watcher admits.
  await new Promise(resolve => setTimeout(resolve, 600))
  expect(store.watchSettle).toBeUndefined()
  expect(admit.mock.calls.length).toBe(calls)
  expect((await storageGate(common).status()).registrations).toBe(0)
})

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'room-shutdown-settle-'))
  dirs.push(dir)
  execFileSync('git', ['-C', dir, 'init', '-q'])
  return dir
}
const storeOf = (registry: WorkerRegistry) => (registry as unknown as { file: { watchers: unknown[]; shut: boolean } }).file

it('refuses opens during shutdown and an open that began before it, even one still resolving its Git directory', async () => {
  const dir = gitRepo()
  const late = registryForDir(dir) // resolving the common dir through Git when shutdown begins
  const shutdown = shutdownWorkerRegistries()
  const during = registryForDir(dir) // made while the shutdown runs
  const [lateResult, duringResult] = await Promise.allSettled([late, during])
  expect(lateResult).toMatchObject({ status: 'rejected', reason: { reason: 'unavailable' } })
  expect(duringResult).toMatchObject({ status: 'rejected', reason: { reason: 'unavailable' } })
  await shutdown
  await closeStorageAdmissions()
  // Neither left a registration or a watching registry behind.
  expect((await storageGate(join(dir, '.git')).status()).registrations).toBe(0)
})

it('an evicted registry shuts down for good: a later generation change never restarts its watchers', async () => {
  vi.stubEnv('VITEST', '') // registryForDir watches outside tests
  const first = gitRepo(), common = join(first, '.git')
  const evicted = await registryForDir(first)
  expect(storeOf(evicted).watchers.length).toBeGreaterThan(0)
  for (let n = 0; n < 24; n++) await registryForDir(gitRepo()) // fills the 24-entry cache, evicting the first
  vi.unstubAllEnvs()
  await vi.waitFor(() => expect(storeOf(evicted).shut).toBe(true))
  expect(storeOf(evicted).watchers).toEqual([])
  // A holder (such as a projector) that uses it after a generation change must not reopen its watchers.
  const gate = openStorageGate(common), instance = storageInstance(), owner = { instance, token: 'evicted-test' }
  const lock = join(common, 'room/registry/migration.lock')
  createExclusive(lock, instance)
  const registration = await gate.register({ instance, kind: 'maintenance', release: 'test' })
  try {
    await gate.drain(owner)
    await gate.reopen(owner)
  } finally { await gate.unregister(registration); compareAndRelease(lock, instance) }
  await withAdmission(common, 'reconcile', () => evicted.snapshot())
  expect(storeOf(evicted).watchers).toEqual([])
}, 60_000)
