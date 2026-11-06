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
  const { common } = fixture(), gate = openStorageGate(common), delayed = deferred()
  const gates = await import('@room/local-state/gate')
  const register = gate.register.bind(gate), unregister = vi.spyOn(gate, 'unregister')
  let attempts = 0
  vi.spyOn(gate, 'register').mockImplementation(async input => {
    if (++attempts === 1) await delayed.promise
    return register(input)
  })
  vi.spyOn(gates, 'openStorageGate').mockReturnValue(gate)
  vi.spyOn(runtime, 'preflight').mockResolvedValue({ ok: true, storage: 'unqualified', evidence: { surface: 'mcp', executable: process.execPath, node: process.versions.node, vendor: { name: 'node', platform: process.platform, arch: process.arch }, elapsedMs: 0 } })
  vi.useFakeTimers()
  try {
    const first = storageRegistration(common)
    const refused = expect(first).rejects.toMatchObject({ reason: 'unavailable', detail: 'storage startup check exceeded 10 s' })
    await vi.advanceTimersByTimeAsync(GATE_LIMITS.startupMs + 1)
    await refused
    delayed.resolve()
    await vi.advanceTimersByTimeAsync(0)
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
    expect((await m.gate.drain(m.owner)).complete).toBe(true)
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

  it('acquires once on the first mutation, reuses nested/concurrent requests and finishes on scope exit', async () => {
    const { common, dir } = fixture(), gate = storageGate(common)
    await storageRegistration(common)
    const admit = vi.spyOn(gate, 'admit'), finish = vi.spyOn(gate, 'finish')
    await withDirectoryAdmission(dir, 'collect', async () => {
      await withValidatedRead(common, async () => undefined)
      expect(admit).not.toHaveBeenCalled()
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

  it('refuses a generation changed since its pre-ticket read, before effects', async () => {
    const { common, dir } = fixture()
    await storageRegistration(common)
    const m = await maintenance(common), effect = vi.fn()
    try {
      await expect(withDirectoryAdmission(dir, 'collect', async () => {
        await withValidatedRead(common, async () => 'old facts')
        await m.gate.drain(m.owner); await m.gate.reopen(m.owner)
        await withAdmission(common, 'collect', async () => effect())
      })).rejects.toMatchObject({ reason: 'maintenance' })
      expect(effect).not.toHaveBeenCalled()
      expect((await m.gate.status()).tickets).toBe(0)
    } finally { await m.close() }
  })

  it('treats first initialization (absent gate 0 -> 1) as the same epoch, not maintenance', async () => {
    const { common, dir } = fixture(), effect = vi.fn()
    expect(fs.existsSync(path.join(common, 'room', 'storage-gate.json'))).toBe(false)
    await withDirectoryAdmission(dir, 'spawn', async () => {
      await withValidatedRead(common, async () => 'facts before the gate exists')
      await withAdmission(common, 'spawn', async ticket => { expect(ticket.generation).toBe(1); effect() })
    })
    expect(effect).toHaveBeenCalledTimes(1)
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


it('fences detached work against the lazy parent’s pre-ticket generation', async () => {
  const { common, dir } = fixture()
  await storageRegistration(common)
  const m = await maintenance(common)
  try {
    await expect(withDirectoryAdmission(dir, 'preview', async () => {
      await withValidatedRead(common, async () => 'before')
      await m.gate.drain(m.owner); await m.gate.reopen(m.owner)
      await detachedAdmission(common, 'preview')
    })).rejects.toMatchObject({ reason: 'maintenance' })
    expect((await m.gate.status()).tickets).toBe(0)
  } finally { await m.close() }
})
