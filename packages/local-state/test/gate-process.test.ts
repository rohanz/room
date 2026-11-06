/** Real processes, real identity probes: initialization races, owner death and suspension, admission vs drain. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { closeStorageGates, openStorageGate } from '../src/gate.js'
import { createExclusive, type InstanceToken } from '../src/leases.js'
import { probeOwnProcess } from '../src/process.js'
import { STORAGE_PATHS } from '../src/protocol.js'

const require = createRequire(import.meta.url)
const roots: string[] = [], children: ChildProcess[] = []
afterEach(async () => {
  await closeStorageGates()
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { if (process.platform !== 'win32') child.kill('SIGCONT'); child.kill('SIGKILL') }
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function commonDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-gate-proc-'))
  roots.push(dir)
  fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n')
  return fs.realpathSync.native(dir)
}
function child(...args: string[]): { process: ChildProcess; next: () => Promise<any>; exited: Promise<number | null> } {
  const proc = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, fileURLToPath(new URL('./gate-child.ts', import.meta.url)), ...args],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.push(proc)
  let stderr = ''
  proc.stderr!.on('data', chunk => { stderr += chunk })
  const queue: any[] = [], waiters: ((value: any) => void)[] = []
  proc.on('message', value => { const waiter = waiters.shift(); if (waiter) waiter(value); else queue.push(value) })
  const exited = new Promise<number | null>(resolve => proc.on('exit', code => resolve(code)))
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
    waiters.push(resolve)
    void exited.then(code => reject(new Error(`child exited ${code}: ${stderr.slice(-2000)}`)))
  })
  return { process: proc, next, exited }
}
function self(): InstanceToken {
  const own = probeOwnProcess()
  return { pid: process.pid, startTime: own?.startTime ?? '', executable: own?.executable ?? '', sessionId: 'test', nonce: randomBytes(16).toString('hex') }
}
async function exitOf(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise(resolve => proc.on('exit', resolve))
}
const lock = (dir: string) => path.join(dir, STORAGE_PATHS.migrationLock)

it('two processes initializing at once produce one gate at generation 1', async () => {
  const dir = commonDir(), barrier = path.join(dir, 'go')
  const a = child('init', dir, barrier), b = child('init', dir, barrier)
  await new Promise(resolve => setTimeout(resolve, 300))
  fs.writeFileSync(barrier, '')
  const [first, second] = await Promise.all([a.next(), b.next()])
  expect(first.generation).toBe(1)
  expect(second.generation).toBe(1)
  expect(first.cloneId).toBe(second.cloneId)
  expect(JSON.parse(fs.readFileSync(path.join(dir, STORAGE_PATHS.gate), 'utf8'))).toMatchObject({ generation: 1, phase: 'legacy', cloneId: first.cloneId })
}, 60_000)

it('an owner killed before publication leaves legacy admission open; killed after, the generation stays closed until a verified successor', async () => {
  const dir = commonDir(), gate = openStorageGate(dir)
  const me = self(), registration = await gate.register({ instance: me, kind: 'mcp', release: 'test' })

  const early = child('owner', dir, 'early-token', 'hold')
  await early.next()
  early.process.kill('SIGKILL')
  await exitOf(early.process)
  expect(await gate.observe()).toEqual({ generation: 1, phase: 'legacy' })
  await gate.finish(await gate.admit(registration, 'spawn'))
  await gate.unregister(registration)
  fs.rmSync(lock(dir)) // the dead holder's lock: recovery of migration.lock itself is the offline command's job

  const late = child('owner', dir, 'late-token', 'publish')
  expect((await late.next()).generation).toBe(2)
  late.process.kill('SIGKILL')
  await exitOf(late.process)
  // Owner death never reopens or resets the generation.
  expect(await gate.observe()).toEqual({ generation: 2, phase: 'draining' })
  const restarted = await gate.register({ instance: me, kind: 'mcp', release: 'test' })
  await expect(gate.admit(restarted, 'spawn')).rejects.toMatchObject({ reason: 'maintenance' })

  // A successor recovers the lock from the dead holder and takes over with the real identity probe.
  fs.rmSync(lock(dir))
  const successor = self()
  expect(createExclusive(lock(dir), successor)).toBe(true)
  await gate.register({ instance: successor, kind: 'maintenance', release: 'test' })
  const owner = { instance: successor, token: 'successor' }
  expect(await gate.takeOver(owner)).toMatchObject({ generation: 3, phase: 'draining', complete: true })
  expect((await gate.reopen(owner))).toMatchObject({ generation: 3, phase: 'legacy' })
}, 60_000)

it('a suspended owner is alive: no successor can take over its generation', async () => {
  if (process.platform === 'win32') return // no SIGSTOP; Windows suspension is covered by identity probes elsewhere
  const dir = commonDir(), gate = openStorageGate(dir)
  const owner = child('owner', dir, 'paused-token', 'publish')
  const ready = await owner.next()
  owner.process.kill('SIGSTOP')
  const successor = self()
  await gate.register({ instance: successor, kind: 'maintenance', release: 'test' })
  await expect(gate.takeOver({ instance: successor, token: 'successor' })).rejects.toMatchObject({ reason: 'maintenance' })
  expect(JSON.parse(fs.readFileSync(path.join(dir, STORAGE_PATHS.gate), 'utf8'))).toMatchObject({ generation: 2, owner: { token: 'paused-token', instance: { nonce: ready.instance.nonce } } })
  owner.process.kill('SIGCONT')
}, 60_000)

it('admission racing a drain never succeeds in the successor generation, and drain completes once admitters stop', async () => {
  const dir = commonDir(), gate = openStorageGate(dir), stop = path.join(dir, 'stop')
  await gate.register({ instance: self(), kind: 'mcp', release: 'test' }) // initialize first
  const admitters = [child('admitter', dir, stop), child('admitter', dir, stop), child('admitter', dir, stop)]
  await Promise.all(admitters.map(admitter => admitter.next())) // registered
  expect(await Promise.all(admitters.map(admitter => admitter.next()))).toEqual(admitters.map(() => ({ firstAdmitted: true })))
  const me = self()
  expect(createExclusive(lock(dir), me)).toBe(true)
  await gate.register({ instance: me, kind: 'maintenance', release: 'test' })
  const owner = { instance: me, token: 'racer' }
  const first = await gate.drain(owner)
  expect(first.generation).toBe(2)
  // Every ticket still present was admitted under generation 1 and is visible to the drain.
  for (const view of [...first.live, ...first.unknown, ...first.dead]) expect(view.generation).toBe(1)
  // Every admitter has now been refused at least once in the successor generation.
  expect(await Promise.all(admitters.map(admitter => admitter.next()))).toEqual(admitters.map(() => ({ firstRefused: true })))
  fs.writeFileSync(stop, '')
  const results = await Promise.all(admitters.map(admitter => admitter.next()))
  for (const result of results) {
    expect(result.admitted.length).toBeGreaterThan(0)
    expect(result.admitted.every((generation: number) => generation === 1)).toBe(true)
    expect(result.refused.length).toBeGreaterThan(0)
    expect(result.refused.every((reason: string) => reason === 'maintenance')).toBe(true)
  }
  await Promise.all(admitters.map(admitter => admitter.exited))
  expect((await gate.drain(owner)).complete).toBe(true)
}, 90_000)


it.each([false, true])('retains dead-holder reconciliation after process death (unsynced ticket lost: %s)', async lost => {
  const dir = commonDir(), gate = openStorageGate(dir)
  const holder = child('held-ticket', dir)
  const ready = await holder.next()
  holder.process.kill('SIGKILL')
  await exitOf(holder.process)
  const intent = path.join(dir, 'room/registry/unfinished-intent.json')
  const evidence = fs.readFileSync(intent, 'utf8')
  if (lost) fs.unlinkSync(path.join(dir, STORAGE_PATHS.tickets, `${ready.instance.nonce}.${ready.ticket.id}.json`))
  const me = self()
  expect(createExclusive(lock(dir), me)).toBe(true)
  await gate.register({ instance: me, kind: 'maintenance', release: 'test' })
  const owner = { instance: me, token: 'crash-recovery' }
  const progress = await gate.drain(owner)
  expect(progress.complete).toBe(false)
  expect(progress.dead.some(view => view.holder === ready.instance.nonce)).toBe(true)
  expect(fs.readFileSync(intent, 'utf8')).toBe(evidence)
  expect(fs.existsSync(path.join(dir, STORAGE_PATHS.registrations, `${ready.instance.nonce}.json`))).toBe(true)
  // The gate cannot interpret lifecycle intent. Only the owner, after recovery, may clear its evidence.
  for (let pass = 0; pass < 2; pass++) {
    for (const view of (await gate.drain(owner)).dead) await gate.resolveDead(owner, view.id, 'test owner reconciled lifecycle intent')
  }
  expect((await gate.drain(owner)).complete).toBe(true)
  expect(fs.readFileSync(intent, 'utf8')).toBe(evidence)
  expect(fs.readdirSync(path.join(dir, STORAGE_PATHS.resolutions)).length).toBeGreaterThan(0)
}, 60_000)

it('a live helper keeps drain blocked after the MCP that started it has died, and only its own death frees it', async () => {
  if (process.platform === 'win32') return // the helper identity probe here uses the POSIX process table
  const dir = commonDir(), gate = openStorageGate(dir)
  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(helper)
  await new Promise(resolve => helper.once('spawn', resolve))
  const owner = child('helper-owner', dir, String(helper.pid))
  const ready = await owner.next()
  await gate.finish(ready.parent) // the parent operation acknowledged; its helper outlives it
  owner.process.kill('SIGKILL')
  await exitOf(owner.process)
  const me = self()
  expect(createExclusive(lock(dir), me)).toBe(true)
  await gate.register({ instance: me, kind: 'maintenance', release: 'test' })
  const maintenanceOwner = { instance: me, token: 'helper-survivor' }
  const progress = await gate.drain(maintenanceOwner)
  expect(progress.complete).toBe(false)
  // Judged by the helper's identity, not the dead MCP's.
  expect(progress.live.map(view => view.id)).toContain(ready.helperTicket.id)
  await expect(gate.resolveDead(maintenanceOwner, ready.helperTicket.id, 'must refuse while the helper runs')).rejects.toMatchObject({ reason: 'blocked' })
  helper.kill('SIGKILL')
  await exitOf(helper)
  for (let pass = 0; pass < 2; pass++) {
    for (const view of (await gate.drain(maintenanceOwner)).dead) await gate.resolveDead(maintenanceOwner, view.id, 'test owner reconciled the helper and its MCP')
  }
  expect((await gate.drain(maintenanceOwner)).complete).toBe(true)
}, 60_000)
