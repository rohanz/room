import { settleWorkerPublication } from '../src/worker-publication.js'
import { acknowledgeKeptPublication } from '../src/kept-publication.js'
import { RoomDoc } from '@room/shared'
import type { Session } from '../src/session.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openStorageGate } from '@room/local-state/gate'
import { createExclusive, compareAndRelease } from '@room/local-state/leases'
import { GATE_LIMITS } from '@room/local-state/protocol'
import { WorkerRegistry } from '../src/worker-registry.js'
import { admitStorageHelper, closeStorageAdmissions, currentAdmission, detachedAdmission, storageGate, storageInstance, storageRegistration, withAdmission, withValidatedRead, withoutAdmission, withDirectoryAdmission, requireAdmission } from '../src/storage-admission.js'
import * as runtime from '@room/local-state/preflight'
import * as gateModule from '@room/local-state/gate'
import { previewProcessGate } from '../src/tools/files.js'
import { openAdmittedStore } from './fixtures/storage-admission.js'

const roots: string[] = []
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-storage-admission-')); roots.push(dir)
  execFileSync('git', ['init', '-q', dir])
  return { dir, common: path.join(dir, '.git') }
}
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve() } }
async function maintenance(common: string) {
  const gate = openStorageGate(common), instance = storageInstance(), owner = { instance, token: 'maintenance-test' }
  const lock = path.join(common, 'room/registry/migration.lock')
  createExclusive(lock, instance)
  const registration = await gate.register({ instance, kind: 'maintenance', release: 'test' })
  return { gate, owner, async close() { await gate.unregister(registration); compareAndRelease(lock, instance) } }
}
afterEach(async () => { vi.restoreAllMocks(); await closeStorageAdmissions(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('whole-operation storage admission', () => {
  it('runs preflight once before registration and writes nothing on runtime refusal', async () => {
    const { common } = fixture()
    const check = vi.spyOn(runtime, 'preflight').mockResolvedValue({ ok: false, failure: 'node-version', detail: 'runtime refused', remedy: 'install official runtime', evidence: { surface: 'mcp', executable: '/node', node: '20', vendor: { name: 'node', platform: process.platform, arch: process.arch }, elapsedMs: 1 } })
    await expect(storageRegistration(common)).rejects.toMatchObject({ reason: 'unavailable' })
    expect(fs.existsSync(path.join(common, 'room'))).toBe(false)
    check.mockRestore()
    const success = vi.spyOn(runtime, 'preflight')
    const [a, b] = await Promise.all([storageRegistration(common), storageRegistration(common)])
    expect(a).toBe(b); expect(success).toHaveBeenCalledTimes(1)
    expect(a.preflight.ok).toBe(true)
  })

  it('holds collect admission from its first read through Git, acknowledgement and lane release', async () => {
    const { dir, common } = fixture(), admitted = deferred(), gitEntered = deferred(), gitRelease = deferred(), acknowledge = deferred(), acknowledged = deferred()
    const registry = await WorkerRegistry.open(common, { watch: false })
    const operation = withAdmission(common, 'collect', async () => {
      admitted.resolve()
      await registry.withCollectLease(dir, async () => {
        await registry.snapshot()
        execFileSync('git', ['-C', dir, 'status', '--porcelain'])
        gitEntered.resolve(); await gitRelease.promise
        await acknowledge.promise
        acknowledged.resolve()
      })
    })
    await admitted.promise
    const m = await maintenance(common)
    expect((await m.gate.drain(m.owner)).complete).toBe(false)
    await expect(withAdmission(common, 'collect', async () => {})).rejects.toMatchObject({ reason: 'maintenance' })
    await gitEntered.promise
    expect((await m.gate.drain(m.owner)).complete).toBe(false)
    gitRelease.resolve()
    expect((await m.gate.drain(m.owner)).complete).toBe(false)
    acknowledge.resolve(); await acknowledged.promise; await operation
    expect((await m.gate.drain(m.owner)).complete).toBe(true)
    expect(fs.readdirSync(path.join(common, 'room/registry/collect')).filter(file => file.endsWith('.json'))).toEqual([])
    await m.gate.reopen(m.owner); await m.close(); registry.close()
  })

  it('keeps detached helpers admitted after their parent finishes and isolates concurrent/cancelled calls', async () => {
    const { common } = fixture(), started = deferred(), release = deferred()
    let child!: Awaited<ReturnType<typeof detachedAdmission>>, outer = ''
    const one = withAdmission(common, 'preview', async ticket => {
      outer = ticket.id
      expect(await withAdmission(common, 'stop', async nested => nested.id)).toBe(outer)
      child = await detachedAdmission(common, 'preview')
      started.resolve(); await release.promise
    })
    await started.promise
    const other = await withoutAdmission(() => withAdmission(common, 'stop', async ticket => ticket.id))
    expect(other).not.toBe(outer)
    release.resolve(); await one
    expect(currentAdmission(common)).toBeUndefined()
    const m = await maintenance(common)
    expect((await m.gate.drain(m.owner)).complete).toBe(false)
    expect((await m.gate.status()).tickets).toBe(1)
    await child.run(async () => { expect(currentAdmission(common)?.parent).toBe(outer) })
    expect((await m.gate.drain(m.owner)).complete).toBe(true)
    await m.gate.reopen(m.owner); await m.close()
    await expect(withAdmission(common, 'collect', async () => { throw new Error('cancelled') })).rejects.toThrow('cancelled')
    expect((await openStorageGate(common).status()).tickets).toBe(0)
  })

  it('refuses a display spanning drain and retries a completed legacy generation change', async () => {
    const { common } = fixture(); await storageRegistration(common)
    const m = await maintenance(common)
    await expect(withValidatedRead(common, async () => { await m.gate.drain(m.owner); return 'stale' })).rejects.toMatchObject({ reason: 'maintenance' })
    await m.gate.reopen(m.owner)
    let calls = 0
    expect(await withValidatedRead(common, async () => {
      if (++calls === 1) { await m.gate.drain(m.owner); await m.gate.reopen(m.owner) }
      return 'fresh'
    })).toBe('fresh')
    expect(calls).toBe(2)
    await m.close()
  })

  it('stops reconciliation while draining and reopens before the next admitted operation', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { common } = fixture(), registry = await WorkerRegistry.open(common)
    const m = await maintenance(common)
    await m.gate.drain(m.owner)
    await expect(registry.reconcile()).rejects.toMatchObject({ reason: 'maintenance' })
    const admit = vi.spyOn(storageGate(common), 'admit')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(admit).not.toHaveBeenCalled()
    await m.gate.reopen(m.owner)
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(admit).toHaveBeenCalled())
    await registry.reconcile()
    expect((await registry.snapshot()).available).toBe(true)
    await m.close(); registry.close(); vi.useRealTimers()
  })
})

it('cleans a registration that settles after the startup deadline and retries the next attempt', async () => {
  const { common } = fixture(), gate = openStorageGate(common), delayed = deferred(), entered = deferred(), cleaned = deferred()
  const gates = await import('@room/local-state/gate')
  const register = gate.register.bind(gate), release = gate.unregister.bind(gate)
  const unregister = vi.spyOn(gate, 'unregister').mockImplementation(async registration => {
    await release(registration)
    cleaned.resolve()
  })
  let attempts = 0
  vi.spyOn(gate, 'register').mockImplementation(async input => {
    if (++attempts === 1) { entered.resolve(); await delayed.promise }
    return register(input)
  })
  vi.spyOn(gates, 'openStorageGate').mockReturnValue(gate)
  vi.spyOn(runtime, 'preflight').mockResolvedValue({ ok: true, storage: 'unqualified', evidence: { surface: 'mcp', executable: process.execPath, node: process.versions.node, vendor: { name: 'node', platform: process.platform, arch: process.arch }, elapsedMs: 0 } })
  vi.useFakeTimers()
  try {
    const first = storageRegistration(common)
    const refused = expect(first).rejects.toMatchObject({ reason: 'unavailable', detail: 'storage startup check exceeded 10 s' })
    await entered.promise
    await vi.advanceTimersByTimeAsync(GATE_LIMITS.startupMs + 1)
    await refused
    delayed.resolve()
    await cleaned.promise // the real worker I/O must settle; advancing fake timers cannot flush it
    expect(unregister).toHaveBeenCalledTimes(1)
    expect((await gate.status()).registrations).toBe(0)
    await storageRegistration(common)
    expect(attempts).toBe(2)
  } finally { vi.useRealTimers() }
})


it('validates a complete nested display once without registering or creating tickets', async () => {
  const { common } = fixture()
  const reader = await WorkerRegistry.openReader(common)
  const gate = storageGate(common), observe = vi.spyOn(gate, 'observe')
  await reader.validatedRead(async () => {
    await reader.list()
    await reader.occupancy()
    await reader.projectable('lead', 'room')
  })
  expect(observe).toHaveBeenCalledTimes(2)
  expect(fs.existsSync(path.join(common, 'room'))).toBe(false)
  reader.close()
})

it('keeps an actual preview helper visible to drain after its parent call returns', async () => {
  // Preview helpers are POSIX process groups; Windows previews run without lock helpers or tracked groups.
  if (process.platform === 'win32') return
  const { common } = fixture()
  const child = spawn('sh', ['-c', previewProcessGate, 'sh', process.execPath, '-e', 'process.stdout.write("effect\\n"); setInterval(() => {}, 1000)'], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
  await once(child, 'spawn')
  const exited = once(child, 'exit')
  let finish: (() => Promise<void>) | undefined
  let m: Awaited<ReturnType<typeof maintenance>> | undefined
  try {
    await withAdmission(common, 'preview', async () => { finish = await admitStorageHelper(child.pid!) })
    const started = once(child.stdout, 'data')
    child.stdin.end('GO\n')
    await started
    // The shell must remain the registered executable after the gated command starts.
    const listing = await storageGate(common).listTickets()
    expect(listing.tickets[0].holderState).toBe('alive')
    m = await maintenance(common)
    const drain = await m.gate.drain(m.owner)
    expect(drain.complete).toBe(false)
    expect((await m.gate.status()).tickets).toBe(1)
    process.kill(-child.pid!, 'SIGTERM'); await exited
    await finish!(); finish = undefined
    // With its last admission finished during a drain, this MCP acknowledges by unregistering.
    await vi.waitFor(async () => expect((await m.gate.drain(m.owner)).complete).toBe(true), { timeout: 3000 })
    await m.gate.reopen(m.owner)
  } finally {
    if (child.exitCode === null && child.signalCode === null) { process.kill(-child.pid!, 'SIGTERM'); await exited }
    await finish?.()
    await m?.close()
  }
})


describe('lazy directory admission', () => {
  it('does no gate I/O or Git resolution for a call with no lifecycle work, including an undefined session directory', async () => {
    const canonical = vi.spyOn(gateModule, 'canonicalCommonDir')
    const open = vi.spyOn(gateModule, 'openStorageGate')
    const flight = vi.spyOn(runtime, 'preflight')
    expect(await withDirectoryAdmission(undefined, 'message', async () => 'sent')).toBe('sent')
    expect(await withDirectoryAdmission('/not/a/git/directory', 'message', async () => 'read')).toBe('read')
    expect(canonical).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(flight).not.toHaveBeenCalled()
  })

  it('acquires once on the first lifecycle read, reuses nested/concurrent requests and finishes on scope exit', async () => {
    const { common, dir } = fixture(), gate = storageGate(common)
    await storageRegistration(common)
    const admit = vi.spyOn(gate, 'admit'), finish = vi.spyOn(gate, 'finish')
    await withDirectoryAdmission(dir, 'collect', async () => {
      await withValidatedRead(common, async () => undefined)
      expect(admit).toHaveBeenCalledTimes(1)
      const [a, b] = await Promise.all([requireAdmission(common), requireAdmission(common)])
      expect(a.id).toBe(b.id)
      await withDirectoryAdmission(dir, 'stop', async () => {
        expect((await requireAdmission(common)).id).toBe(a.id)
        expect(await withAdmission(common, 'stop', async ticket => ticket.id)).toBe(a.id)
      })
      expect(finish).not.toHaveBeenCalled()
    })
    expect(admit).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledTimes(1)
    expect((await gate.status()).tickets).toBe(0)
  })

  it('holds admission from its first read through a paused lifecycle-derived effect', async () => {
    const { common, dir } = fixture(), read = deferred(), release = deferred(), effect = vi.fn()
    const registry = await WorkerRegistry.openReader(common)
    const operation = withDirectoryAdmission(dir, 'message', async () => {
      await registry.snapshot()
      read.resolve()
      await release.promise
      expect(currentAdmission(common)).toBeDefined()
      effect()
    })
    await read.promise
    const m = await maintenance(common)
    try {
      expect((await m.gate.drain(m.owner)).complete).toBe(false)
      expect(effect).not.toHaveBeenCalled()
      release.resolve(); await operation
      expect(effect).toHaveBeenCalledTimes(1)
      expect((await m.gate.drain(m.owner)).complete).toBe(true)
      await m.gate.reopen(m.owner)
    } finally { release.resolve(); await operation; await m.close(); registry.close() }
  })

  it('leaves display reads outside tool scopes ticket-free', async () => {
    const { common } = fixture(), gate = storageGate(common)
    const admit = vi.spyOn(gate, 'admit'), register = vi.spyOn(gate, 'register')
    const reader = await WorkerRegistry.openReader(common)
    await reader.snapshot()
    expect(admit).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(common, 'room', 'storage-gate.json'))).toBe(false)
    reader.close()
  })

  it('finishes an acquired ticket even when the tool throws', async () => {
    const { common, dir } = fixture(), gate = storageGate(common)
    const finish = vi.spyOn(gate, 'finish')
    await expect(withDirectoryAdmission(dir, 'collect', async () => {
      await requireAdmission(common)
      throw new Error('tool failed')
    })).rejects.toThrow('tool failed')
    expect(finish).toHaveBeenCalledTimes(1)
    expect((await gate.status()).tickets).toBe(0)
  })
})


it('admits detached work from a live parent during drain and holds it through its effect', async () => {
  const { common, dir } = fixture()
  await storageRegistration(common)
  const m = await maintenance(common)
  let child!: Awaited<ReturnType<typeof detachedAdmission>>
  try {
    await withDirectoryAdmission(dir, 'preview', async () => {
      await withValidatedRead(common, async () => 'before')
      expect((await m.gate.drain(m.owner)).complete).toBe(false)
      child = await detachedAdmission(common, 'preview')
    })
    expect((await m.gate.drain(m.owner)).complete).toBe(false)
    await child.run(async () => { expect(currentAdmission(common)).toBeDefined() })
    expect((await m.gate.drain(m.owner)).complete).toBe(true)
    await m.gate.reopen(m.owner)
  } finally { await child?.finish(); await m.close() }
})

it.each(['done', 'kept'] as const)('keeps delayed %s publication admitted after the timeout returns', async kind => {
  const { dir, common } = fixture(), entered = deferred(), release = deferred(), settled = deferred()
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@test', 'commit', '--allow-empty', '-qm', 'base'])
  const room = new RoomDoc(), log = vi.fn()
  const session = { dir, room, me: { name: 'lead' }, policyStore: { policy: { level: 'full' } },
    daemon: { fence: 'fence', reconcileGitChanges: async () => { entered.resolve(); await release.promise },
      settle: async () => { expect(currentAdmission(common)).toBeDefined(); settled.resolve() } },
  } as unknown as Session
  let expire!: () => void
  const setTimer = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
    if (ms === 5000) { expire = fn; return setTimer(() => {}, 60_000) }
    return setTimer(fn, ms, ...args)
  }) as typeof setTimeout)
  const operation = withDirectoryAdmission(dir, 'report', async () => {
    await withValidatedRead(common, async () => undefined)
    if (kind === 'done') await settleWorkerPublication(session, log)
    else expect((await acknowledgeKeptPublication(session, undefined, [])).pending).toBe(true)
  })
  await entered.promise
  expire(); await operation
  const m = await maintenance(common)
  try {
    expect((await m.gate.status()).tickets).toBe(1)
    expect((await m.gate.drain(m.owner)).complete).toBe(false)
    release.resolve(); await settled.promise
    await vi.waitFor(async () => expect((await m.gate.status()).tickets).toBe(0))
    expect((await m.gate.drain(m.owner)).complete).toBe(true)
    await m.gate.reopen(m.owner)
  } finally { release.resolve(); await m.close(); room.doc.destroy() }
})

it('coalesces a burst of background reconcile triggers into one run plus one rerun', async () => {
  const { common } = fixture()
  const { FileWorkerStore } = await import('../src/worker-file-store.js')
  const store = await openAdmittedStore(common, () => FileWorkerStore.open(common, { watch: false }))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let runs = 0
  const reconcile = vi.spyOn(FileWorkerStore.prototype, 'reconcile').mockImplementation(async () => { runs++; await gate })
  try {
    const background = store as unknown as { backgroundReconcile(): void; backgroundClosed: boolean; backgroundRun?: Promise<void> }
    background.backgroundClosed = false
    for (let n = 0; n < 6; n++) background.backgroundReconcile()
    await vi.waitFor(() => expect(runs).toBe(1))
    for (let n = 0; n < 6; n++) background.backgroundReconcile()
    release()
    await background.backgroundRun
    expect(runs).toBe(2)
  } finally { reconcile.mockRestore() }
})

it('keeps a registration whose ticket file vanished while its operation is still running, until the operation ends', async () => {
  const { common } = fixture()
  const paused = deferred(), entered = deferred()
  const operation = withAdmission(common, 'collect', async ticket => {
    // Simulate loss of the non-durable ticket file while the effect is still in progress.
    fs.rmSync(path.join(common, 'room/storage-gate/tickets', `${ticket.holder}.${ticket.id}.json`))
    entered.resolve()
    await paused.promise
  })
  await entered.promise
  const m = await maintenance(common)
  try {
    expect((await m.gate.drain(m.owner)).complete).toBe(false)
    // Give the MCP's draining sweep (1 s interval) time to run: it must not acknowledge for work still running.
    await new Promise(resolve => setTimeout(resolve, 1300))
    const during = await m.gate.drain(m.owner)
    expect(during.complete).toBe(false)
    expect(during.live.map(view => view.id)).toEqual([expect.stringMatching(/^registration:/)])
    paused.resolve()
    await operation
    // Finishing the operation lets the sweep acknowledge by unregistering.
    await vi.waitFor(async () => expect((await m.gate.drain(m.owner)).complete).toBe(true), { timeout: 3000 })
    await m.gate.reopen(m.owner)
  } finally { paused.resolve(); await operation.catch(() => {}); await m.close() }
})

it('a production preview helper keeps drain blocked after its MCP is killed, until the helper itself is gone', async () => {
  if (process.platform === 'win32') return
  const { common } = fixture()
  const { createRequire } = await import('node:module')
  const { fileURLToPath } = await import('node:url')
  const require = createRequire(import.meta.url)
  const mcp = spawn(process.execPath, ['--import', require.resolve('tsx'), fileURLToPath(new URL('./fixtures/storage-helper-owner.ts', import.meta.url)), common],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let helperPid: number | undefined
  try {
    const ready = await new Promise<{ helperPid: number; mcpPid: number }>((resolve, reject) => {
      mcp.once('message', value => resolve(value as { helperPid: number; mcpPid: number }))
      mcp.once('exit', code => reject(new Error(`helper owner exited ${code}`)))
    })
    helperPid = ready.helperPid
    mcp.kill('SIGKILL'); await once(mcp, 'exit')
    const m = await maintenance(common)
    try {
      const progress = await m.gate.drain(m.owner)
      expect(progress.complete).toBe(false)
      // The helper ticket is judged by the helper's own identity, written by production admitStorageHelper.
      const helperTicket = progress.live.find(view => view.pid === ready.helperPid)
      expect(helperTicket).toBeDefined()
      expect(progress.live.every(view => view.pid !== ready.mcpPid)).toBe(true) // never judged by the dead MCP
      await expect(m.gate.resolveDead(m.owner, helperTicket!.id, 'must refuse while the helper runs')).rejects.toMatchObject({ reason: 'blocked' })
      process.kill(-ready.helperPid, 'SIGKILL'); helperPid = undefined
      await vi.waitFor(async () => expect((await m.gate.drain(m.owner)).live).toEqual([]), { timeout: 5000 })
      for (let pass = 0; pass < 2; pass++)
        for (const view of (await m.gate.drain(m.owner)).dead) await m.gate.resolveDead(m.owner, view.id, 'test reconciled the helper and its MCP')
      expect((await m.gate.drain(m.owner)).complete).toBe(true)
      await m.gate.reopen(m.owner)
    } finally { await m.close() }
  } finally {
    if (mcp.exitCode === null && mcp.signalCode === null) mcp.kill('SIGKILL')
    if (helperPid) { try { process.kill(-helperPid, 'SIGKILL') } catch { /* gone */ } }
  }
}, 60_000)

it('a draining sweep never retires the registration that an admission started meanwhile will use', async () => {
  const { common } = fixture()
  await withAdmission(common, 'reconcile', async () => {}) // registered and idle
  const gate = storageGate(common)
  // Pause the sweep right after it reads `draining`, before it decides to acknowledge.
  const observe = gate.observe.bind(gate), observed = deferred(), resume = deferred()
  let paused = false
  vi.spyOn(gate, 'observe').mockImplementation(async () => {
    const value = await observe()
    if (!paused && value.phase === 'draining') { paused = true; observed.resolve(); await resume.promise }
    return value
  })
  const unregister = vi.spyOn(gate, 'unregister')
  // Hold the new admission's RPC until any unregister the sweep issued has completed.
  const admit = gate.admit.bind(gate), admitting = deferred(), proceed = deferred()
  vi.spyOn(gate, 'admit').mockImplementation(async (...args: Parameters<typeof admit>) => {
    admitting.resolve(); await proceed.promise
    await Promise.allSettled(unregister.mock.results.map(result => result.value))
    return admit(...args)
  })
  const m = await maintenance(common)
  try {
    await m.gate.drain(m.owner)
    await observed.promise // the 1 s idle sweep is paused inside its phase read
    await m.gate.reopen(m.owner)
    const operation = withAdmission(common, 'reconcile', async () => 'ran')
    await admitting.promise // counted and registration read; its admit RPC is held
    resume.resolve()
    for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve))
    proceed.resolve()
    await expect(operation).resolves.toBe('ran')
    expect(unregister).not.toHaveBeenCalled()
  } finally { resume.resolve(); proceed.resolve(); await m.close() }
})
