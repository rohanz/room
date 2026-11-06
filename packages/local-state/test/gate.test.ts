import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openStorageGate, type GateOptions } from '../src/gate.js'
import * as leases from '../src/leases.js'
import { createExclusive, type InstanceToken, type Liveness } from '../src/leases.js'
import { STORAGE_PATHS, StorageRefused, type GateOwner, type StorageGate } from '../src/protocol.js'

const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function commonDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-gate-'))
  roots.push(dir)
  fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n')
  return fs.realpathSync.native(dir)
}
let pid = 50_000
function token(): InstanceToken {
  pid++
  return { pid, startTime: `start-${pid}`, executable: '/usr/bin/node', sessionId: `s-${pid}`, nonce: randomBytes(16).toString('hex') }
}
/** Liveness by pid: everything is alive unless listed. */
function world(states: Map<number, Liveness> = new Map()): GateOptions & { states: Map<number, Liveness> } {
  return { states, liveness: identity => states.get(identity.pid) ?? 'alive' }
}
async function refusal(promise: Promise<unknown>): Promise<StorageRefused> {
  try { await promise } catch (error) { if (error instanceof StorageRefused) return error; throw error }
  throw new Error('expected a StorageRefused')
}
function takeLock(dir: string, instance: InstanceToken): void {
  expect(createExclusive(path.join(dir, STORAGE_PATHS.migrationLock), instance)).toBe(true)
}
async function maintenance(gate: StorageGate, dir: string): Promise<GateOwner> {
  const instance = token()
  takeLock(dir, instance)
  await gate.register({ instance, kind: 'maintenance', release: 'test' })
  return { instance, token: randomBytes(16).toString('hex') }
}
const gateRecord = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, STORAGE_PATHS.gate), 'utf8'))

describe('initialization', () => {
  it('initializes an absent gate once, at generation 1 in legacy phase, and registration is idempotent', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    const instance = token()
    const [a, b] = await Promise.all([gate.register({ instance, kind: 'mcp', release: 'x' }), gate.register({ instance: token(), kind: 'mcp', release: 'x' })])
    expect(a.generation).toBe(1)
    expect(b.generation).toBe(1)
    const record = gateRecord(dir)
    expect(record).toMatchObject({ v: 1, generation: 1, phase: 'legacy', minReader: 1, minWriter: 1, commonDir: dir })
    expect(await gate.register({ instance, kind: 'mcp', release: 'x' })).toEqual(a)
    expect(gateRecord(dir).cloneId).toBe(record.cloneId)
  })

  it('status and observe are read-only on a fresh clone', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    expect(await gate.status()).toMatchObject({ state: 'absent', maintenanceRequired: false, legacyImport: 'absent', tickets: 0 })
    expect(await gate.observe()).toEqual({ generation: 0, phase: 'legacy' })
    expect(fs.existsSync(path.join(dir, 'room'))).toBe(false)
    await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    expect(await gate.observe()).toEqual({ generation: 1, phase: 'legacy' })
  })

  it('refuses to initialize when activation evidence exists, and writes nothing', async () => {
    const dir = commonDir()
    fs.mkdirSync(path.join(dir, 'room'))
    fs.writeFileSync(path.join(dir, STORAGE_PATHS.database), '')
    const gate = openStorageGate(dir, world())
    expect((await refusal(gate.register({ instance: token(), kind: 'mcp', release: 'x' }))).reason).toBe('unavailable')
    expect(fs.existsSync(path.join(dir, STORAGE_PATHS.gate))).toBe(false)
    expect((await gate.status()).state).toBe('evidence-without-gate')
    expect((await refusal(gate.observe())).reason).toBe('unavailable')
  })

  it('never reinitializes a corrupt gate', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    fs.writeFileSync(path.join(dir, STORAGE_PATHS.gate), '{"v":1,')
    expect((await refusal(gate.register({ instance: token(), kind: 'mcp', release: 'x' }))).reason).toBe('unavailable')
    expect(fs.readFileSync(path.join(dir, STORAGE_PATHS.gate), 'utf8')).toBe('{"v":1,')
    expect((await gate.status())).toMatchObject({ state: 'unreadable', maintenanceRequired: true })
  })

  it('refuses a gate recorded for another location (copied clone)', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    const record = gateRecord(dir)
    fs.writeFileSync(path.join(dir, STORAGE_PATHS.gate), JSON.stringify({ ...record, commonDir: '/elsewhere/.git' }))
    expect((await refusal(gate.register({ instance: token(), kind: 'mcp', release: 'x' }))).reason).toBe('incompatible')
  })

  it('refuses builds below the recorded minimum and build 1 on an active gate', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    const record = gateRecord(dir)
    fs.writeFileSync(path.join(dir, STORAGE_PATHS.gate), JSON.stringify({ ...record, minWriter: 2 }))
    expect((await refusal(gate.register({ instance: token(), kind: 'mcp', release: 'x' }))).reason).toBe('incompatible')
    expect(await gate.register({ instance: token(), kind: 'mcp', release: 'x', build: 2 })).toMatchObject({ build: 2 })
    expect((await gate.status())).toMatchObject({ maintenanceRequired: true, refusal: { reason: 'incompatible' } })
  })

  it('refuses a directory without HEAD before writing anything', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-gate-nohead-'))
    roots.push(dir)
    expect(() => openStorageGate(dir)).toThrow(StorageRefused)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

describe('admission and drain', () => {
  it('admits and finishes tickets durably; finish is idempotent', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    const reg = await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    const ticket = await gate.admit(reg, 'collect')
    expect(ticket).toMatchObject({ holder: reg.instance.nonce, generation: 1, kind: 'collect' })
    expect(fs.readdirSync(path.join(dir, STORAGE_PATHS.tickets))).toEqual([`${reg.instance.nonce}.${ticket.id}.json`])
    await expect(gate.unregister(reg)).rejects.toMatchObject({ reason: 'busy' })
    await gate.finish(ticket)
    await gate.finish(ticket)
    expect(fs.readdirSync(path.join(dir, STORAGE_PATHS.tickets))).toEqual([])
    await gate.unregister(reg)
    expect((await gate.status()).registrations).toBe(0)
  })

  it('refuses admission without a registration', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    const reg = await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    await gate.unregister(reg)
    expect((await refusal(gate.admit(reg, 'spawn'))).reason).toBe('unavailable')
  })

  it('drain requires migration.lock, publishes the next generation and closes unparented admission', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    const reg = await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    const held = await gate.admit(reg, 'collect')
    const stranger = token()
    await gate.register({ instance: stranger, kind: 'maintenance', release: 'x' })
    expect((await refusal(gate.drain({ instance: stranger, token: 'nope' }))).reason).toBe('maintenance')
    expect(gateRecord(dir).phase).toBe('legacy')

    const owner = await maintenance(gate, dir)
    const first = await gate.drain(owner)
    expect(first).toMatchObject({ generation: 2, phase: 'draining', complete: false })
    expect(first.live.map(view => view.id)).toEqual([held.id])
    expect(gateRecord(dir)).toMatchObject({ generation: 2, phase: 'draining', drainingFrom: 1 })
    expect(await gate.observe()).toEqual({ generation: 2, phase: 'draining' })

    expect((await refusal(gate.admit(reg, 'spawn'))).reason).toBe('maintenance')
    // A detached child of a live predecessor ticket registers before its parent finishes.
    const child = await gate.admit(reg, 'launch-callback', { parent: held })
    expect(child).toMatchObject({ generation: 1, parent: held.id })
    await gate.finish(held)
    expect((await refusal(gate.admit(reg, 'launch-callback', { parent: held }))).reason).toBe('maintenance')
    expect((await gate.drain(owner)).complete).toBe(false)
    await gate.finish(child)
    const done = await gate.drain(owner)
    expect(done).toMatchObject({ complete: true, generation: 2 })

    // A second owner with a different token cannot act on this generation.
    expect((await refusal(gate.drain({ ...owner, token: 'other' }))).reason).toBe('maintenance')
    const reopened = await gate.reopen(owner)
    expect(reopened).toMatchObject({ generation: 2, phase: 'legacy' })
    expect(reopened.owner).toBeUndefined()
    expect((await gate.admit(reg, 'spawn')).generation).toBe(2)
  })

  it('reports unknown and dead holders; only resolveDead removes a verified-dead ticket, with an audit record', async () => {
    const options = world(), dir = commonDir(), gate = openStorageGate(dir, options)
    const deadReg = await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    const unknownReg = await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    const deadTicket = await gate.admit(deadReg, 'collect'), unknownTicket = await gate.admit(unknownReg, 'discard')
    options.states.set(deadReg.instance.pid, 'dead')
    options.states.set(unknownReg.instance.pid, 'unknown')
    const owner = await maintenance(gate, dir)
    const progress = await gate.drain(owner)
    expect(progress.dead.map(view => view.id)).toEqual([deadTicket.id])
    expect(progress.unknown.map(view => view.id)).toEqual([unknownTicket.id])
    expect(progress.complete).toBe(false)
    // Drain alone never removes them, however often it runs.
    expect((await gate.drain(owner)).dead).toHaveLength(1)

    expect((await refusal(gate.resolveDead(owner, unknownTicket.id, 'guess'))).reason).toBe('blocked')
    await gate.resolveDead(owner, deadTicket.id, 'worker registry recovery verified\nno pending intent')
    const audit = JSON.parse(fs.readFileSync(path.join(dir, STORAGE_PATHS.resolutions, `${deadTicket.id}.json`), 'utf8'))
    expect(audit).toMatchObject({ ticket: { id: deadTicket.id }, owner: owner.instance.nonce, generation: 2, note: 'worker registry recovery verified no pending intent' })
    expect((await gate.drain(owner)).dead).toHaveLength(0)
    expect((await gate.drain(owner)).complete).toBe(false)
  })

  it('a successor owner takes over only from a verified-dead owner, and the stale owner cannot publish', async () => {
    const options = world(), dir = commonDir(), gate = openStorageGate(dir, options)
    const first = await maintenance(gate, dir)
    await gate.drain(first)
    const second: GateOwner = { instance: token(), token: randomBytes(16).toString('hex') }
    await gate.register({ instance: second.instance, kind: 'maintenance', release: 'x' })
    expect((await refusal(gate.takeOver(second))).reason).toBe('maintenance') // first is alive
    options.states.set(first.instance.pid, 'dead')
    // The successor recovers migration.lock from the dead holder before taking over.
    fs.rmSync(path.join(dir, STORAGE_PATHS.migrationLock))
    takeLock(dir, second.instance)
    expect(await gate.takeOver(second)).toMatchObject({ generation: 3, phase: 'draining' })
    options.states.set(first.instance.pid, 'alive') // a suspended owner resumes
    expect((await refusal(gate.drain(first))).reason).toBe('maintenance')
    expect((await refusal(gate.reopen(first))).reason).toBe('maintenance')
    expect(gateRecord(dir)).toMatchObject({ generation: 3, owner: { token: second.token } })
  })

  it('generation never decreases across drain, reopen and drain', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    const owner = await maintenance(gate, dir)
    const seen: number[] = []
    for (let round = 0; round < 3; round++) {
      seen.push((await gate.drain(owner)).generation)
      await gate.reopen(owner)
    }
    expect(seen).toEqual([2, 3, 4])
  })

  it('refuses admission at the ticket cap without touching existing tickets', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, { ...world(), limits: { tickets: 4 } })
    const reg = await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    const held = await Promise.all([1, 2, 3, 4].map(() => gate.admit(reg, 'spawn')))
    const tickets = path.join(dir, STORAGE_PATHS.tickets)
    expect((await refusal(gate.admit(reg, 'spawn'))).reason).toBe('capacity')
    expect(fs.readdirSync(tickets).sort()).toEqual(held.map(ticket => `${reg.instance.nonce}.${ticket.id}.json`).sort())
    await gate.finish(held[0])
    expect((await gate.admit(reg, 'spawn')).holder).toBe(reg.instance.nonce)
  })

  it('refuses registration at the cap after pruning only verified-dead ticketless registrations', async () => {
    const options = { ...world(), limits: { registrations: 3 } }, dir = commonDir(), gate = openStorageGate(dir, options)
    const busy = await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    await gate.admit(busy, 'collect')
    const idle = await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    options.states.set(busy.instance.pid, 'dead')
    expect((await refusal(gate.register({ instance: token(), kind: 'mcp', release: 'x' }))).reason).toBe('capacity')
    options.states.set(idle.instance.pid, 'dead')
    await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    const names = fs.readdirSync(path.join(dir, STORAGE_PATHS.registrations))
    expect(names).toContain(`${busy.instance.nonce}.json`) // holds a ticket: kept for reconciliation
    expect(names).not.toContain(`${idle.instance.nonce}.json`)
  })
})

describe('operator listing', () => {
  it('lists tickets with holder liveness without writing, bounded by the scan batch', async () => {
    const options = { ...world(), limits: { scanBatch: 2 } }, dir = commonDir(), gate = openStorageGate(dir, options)
    const reg = await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    const tickets = [await gate.admit(reg, 'collect'), await gate.admit(reg, 'discard'), await gate.admit(reg, 'spawn')]
    options.states.set(reg.instance.pid, 'dead')
    const before = fs.readdirSync(path.join(dir, STORAGE_PATHS.tickets)).sort()
    const listing = await gate.listTickets()
    expect(listing).toMatchObject({ total: 3, truncated: true })
    expect(listing.tickets).toHaveLength(2)
    expect(listing.tickets.every(ticket => ticket.holderState === 'dead' && tickets.some(t => t.id === ticket.id))).toBe(true)
    expect(fs.readdirSync(path.join(dir, STORAGE_PATHS.tickets)).sort()).toEqual(before)
    fs.writeFileSync(path.join(dir, STORAGE_PATHS.tickets, `${reg.instance.nonce}.${'0'.repeat(32)}.json`), '{')
    expect((await gate.listTickets(1)).tickets[0]).toMatchObject({ id: '0'.repeat(32), holderState: 'unreadable' })
  })
})

describe('observation cost', () => {
  it('observes an unchanged gate with one stat, and sees every publication', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    await gate.register({ instance: token(), kind: 'mcp', release: 'x' })
    expect(await gate.observe()).toEqual({ generation: 1, phase: 'legacy' })
    const reads = vi.spyOn(fs, 'readFileSync'), stats = vi.spyOn(fs, 'lstatSync')
    for (let i = 0; i < 5; i++) expect(await gate.observe()).toEqual({ generation: 1, phase: 'legacy' })
    expect(reads).not.toHaveBeenCalled()
    expect(stats).toHaveBeenCalledTimes(5)
    reads.mockRestore(); stats.mockRestore()
    const owner = await maintenance(gate, dir)
    await gate.drain(owner)
    expect(await gate.observe()).toEqual({ generation: 2, phase: 'draining' })
    await gate.reopen(owner)
    expect(await gate.observe()).toEqual({ generation: 2, phase: 'legacy' })
  })

  it('observes an absent gate with one stat and one directory read', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    fs.mkdirSync(path.join(dir, 'room'))
    const calls = [vi.spyOn(fs, 'lstatSync'), vi.spyOn(fs, 'readdirSync'), vi.spyOn(fs, 'readFileSync')]
    expect(await gate.observe()).toEqual({ generation: 0, phase: 'legacy' })
    expect(calls.map(spy => spy.mock.calls.length)).toEqual([1, 1, 0])
    for (const spy of calls) spy.mockRestore()
  })
})

describe('pre-registry import decision', () => {
  it('records the initializer\'s decision once; later registrations cannot change it', async () => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    await gate.register({ instance: token(), kind: 'mcp', release: 'x', preRegistryImport: 'not-needed' })
    await gate.register({ instance: token(), kind: 'mcp', release: 'x', preRegistryImport: 'required' })
    expect(gateRecord(dir).preRegistryImport).toBe('not-needed')
    const other = commonDir(), second = openStorageGate(other, world())
    await second.register({ instance: token(), kind: 'mcp', release: 'x' })
    expect(gateRecord(other).preRegistryImport).toBe('required')
  })
})

describe('reader compatibility', () => {
  it.each([{ minReader: 999 }, { minWriter: 999 }, { phase: 'active' }])('refuses fresh and previously cached reads after %j', async changed => {
    const dir = commonDir(), gate = openStorageGate(dir, world())
    await gate.register({ instance: token(), kind: 'mcp', release: 'test' })
    expect(await gate.observe()).toEqual({ generation: 1, phase: 'legacy' })
    expect(await gate.observe()).toEqual({ generation: 1, phase: 'legacy' }) // cached compatible read
    const owner = { instance: token(), token: 'owner' }
    fs.writeFileSync(path.join(dir, STORAGE_PATHS.gate), JSON.stringify({ ...gateRecord(dir), owner, ...changed }))
    // The old instance must invalidate its compatible cache. A refusal must never cache a permissive value.
    for (const reader of [gate, openStorageGate(dir, world())]) {
      await expect(reader.observe()).rejects.toMatchObject({ reason: 'incompatible' })
      await expect(reader.observe()).rejects.toMatchObject({ reason: 'incompatible' })
    }
  })
})

it('256 interrupted maintenance owners cannot exhaust registration or erase takeover evidence', async () => {
  const options = world(), dir = commonDir(), gate = openStorageGate(dir, options)
  const first = await maintenance(gate, dir)
  await gate.drain(first)
  options.states.set(first.instance.pid, 'dead')
  // Seed the on-disk crash state directly; 255 full durable registrations would obscure this pruning test.
  const registrationDir = path.join(dir, STORAGE_PATHS.registrations)
  for (let n = 1; n < 256; n++) {
    const instance = token()
    options.states.set(instance.pid, 'dead')
    fs.writeFileSync(path.join(registrationDir, `${instance.nonce}.json`), JSON.stringify({
      v: 1, instance, kind: 'maintenance', build: 1, release: 'test', generation: 2, registeredAt: 0,
    }))
  }
  expect(fs.readdirSync(registrationDir)).toHaveLength(256)
  const next = { instance: token(), token: 'successor' }
  await gate.register({ instance: next.instance, kind: 'maintenance', release: 'test' })
  expect(fs.readdirSync(registrationDir)).toEqual([`${next.instance.nonce}.json`])
  expect(gateRecord(dir).owner).toEqual(first)
  fs.rmSync(path.join(dir, STORAGE_PATHS.migrationLock))
  takeLock(dir, next.instance)
  expect(await gate.takeOver(next)).toMatchObject({ generation: 3, phase: 'draining', complete: true })
  expect(gateRecord(dir).owner).toEqual(next)
})

it('keeps admission closed when the reopen deadline passes while waiting for the guard', async () => {
  let now = 100
  const dir = commonDir(), gate = openStorageGate(dir, { ...world(), now: () => now })
  const owner = await maintenance(gate, dir)
  await gate.drain(owner)
  const before = gateRecord(dir)
  // Simulate a contending guard holder advancing the injected clock while this caller waits.
  const guard = vi.spyOn(leases, 'withGuard').mockImplementationOnce(() => {
    now = 200
    throw new Error('lease guard busy: simulated holder')
  })
  try {
    await expect(gate.reopen(owner, { notAfter: 200 })).rejects.toMatchObject({
      reason: 'maintenance', detail: 'import attempt deadline passed; admission stays closed',
    })
    expect(guard).toHaveBeenCalledTimes(2) // refused inside the acquired guard, not before the wait
    expect(gateRecord(dir)).toEqual(before)
    expect(await gate.reopen(owner, { notAfter: 201 })).toMatchObject({ phase: 'legacy', generation: before.generation })
  } finally { guard.mockRestore() }
})
