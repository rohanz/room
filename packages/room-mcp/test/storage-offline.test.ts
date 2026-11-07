import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { main, runLegacyImport, legacyStatus, withMaintenance } from '../src/offline/room-state.js'
import { discoverLegacyWorktrees, importBudget, importLegacyWorkers, type LegacySource } from '../src/offline/legacy-import.js'
import { WorkerRegistry } from '../src/worker-registry.js'
import { closeStorageAdmissions } from '../src/storage-admission.js'

const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-storage-offline-')); roots.push(root)
  execFileSync('git', ['init', '-q', root])
  const common = path.join(root, '.git')
  const source: LegacySource = { key: 'worktree:old', tag: 'old', dir: path.join(root, '.room/workers/old'), branch: 'room/old', host: 'codex' }
  return { root, common, source }
}
afterEach(async () => { vi.restoreAllMocks(); await closeStorageAdmissions(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('status is read-only and startup refuses pre-registry evidence rather than importing', async () => {
  const { common } = fixture()
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  expect(await main(['status', '--common-dir', common, '--json'])).toBe(0)
  expect(JSON.parse(String(out.mock.calls[0][0])).state).toBe('absent')
  expect(fs.existsSync(path.join(common, 'room'))).toBe(false)
  fs.mkdirSync(path.join(common, 'room-carry'))
  fs.writeFileSync(path.join(common, 'room-carry/old.json'), '{}')
  expect((await legacyStatus(common)).maintenanceRequired).toBe(true)
  await expect(WorkerRegistry.open(common, { watch: false })).rejects.toMatchObject({ reason: 'maintenance', remedy: expect.stringContaining('room-state.mjs import-legacy') })
  expect(fs.existsSync(path.join(common, 'room/registry/migration.json'))).toBe(false)
})

it('offline import owns durable assignments and reopens legacy storage without SQL', async () => {
  const { common, source } = fixture()
  await runLegacyImport(common, { sources: () => [source] })
  const map = JSON.parse(fs.readFileSync(path.join(common, 'room/registry/migration.json'), 'utf8'))
  expect(map.done).toBe(true)
  expect(map.sources[source.key].state).toBe('imported')
  const registry = await WorkerRegistry.open(common, { watch: false })
  expect((await registry.read(map.sources[source.key].id))?.legacy?.unowned).toBe(true)
  expect((await legacyStatus(common)).gate?.phase).toBe('legacy')
  expect(fs.existsSync(path.join(common, 'room/state.sqlite'))).toBe(false)
  registry.close()
})

it('reuses a durable source assignment after an interrupted import', async () => {
  const { common, source } = fixture()
  fs.mkdirSync(path.join(common, 'room/registry'), { recursive: true })
  fs.writeFileSync(path.join(common, 'room/registry/migration.json'), JSON.stringify({ v: 1, done: false, sources: { [source.key]: { id: 'w_stable', state: 'assigned' } } }))
  await runLegacyImport(common, { sources: () => [source] })
  expect(fs.readdirSync(path.join(common, 'room/registry/workers'))).toEqual(['w_stable.json'])
})

it('CLI imports an empty clone and reports its generation, counts and status', async () => {
  const { common } = fixture(), out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  expect(await main(['import-legacy', '--common-dir', common])).toBe(0)
  expect(await main(['status', '--common-dir', common, '--json'])).toBe(0)
  const status = JSON.parse(String(out.mock.calls.at(-1)?.[0]))
  expect(status).toMatchObject({ legacyImport: 'done', tickets: 0, registrations: 0, gate: { phase: 'legacy', generation: 2 } })
  expect(await main(['reopen', '--common-dir', common])).toBe(0)
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  expect(await main(['resolve-ticket', '--common-dir', common, '--ticket', 'missing'])).toBe(1)
  expect(err).toHaveBeenCalled()
})

it('preserves assigned IDs across owner death and resumes only from a verified successor', async () => {
  const { common, source } = fixture()
  const script = `import { runLegacyImport } from ${JSON.stringify(new URL('../src/offline/room-state.ts', import.meta.url).href)};
    const source = JSON.parse(process.argv[2]);
    Object.defineProperty(source, 'oldId', { get() { process.exit(23) } });
    await runLegacyImport(process.argv[1], { sources: () => [source] });`
  const { spawnSync } = await import('node:child_process')
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, common, JSON.stringify(source)], { cwd: process.cwd(), encoding: 'utf8' })
  expect(child.status, child.stderr).toBe(23)
  const file = path.join(common, 'room/registry/migration.json')
  const assigned = JSON.parse(fs.readFileSync(file, 'utf8')).sources[source.key]
  expect(assigned.state).toBe('assigned')
  expect((await legacyStatus(common)).gate?.phase).toBe('draining')
  await runLegacyImport(common, { sources: () => [source] })
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).sources[source.key]).toEqual({ id: assigned.id, state: 'imported' })
  expect((await legacyStatus(common)).gate?.generation).toBe(3)
})

it('resolves a verified-dead ticket with an audit note, then explicitly reopens from a new process', async () => {
  const { common } = fixture(), { spawnSync } = await import('node:child_process')
  await runLegacyImport(common)
  const admission = `import { storageRegistration } from ${JSON.stringify(new URL('../src/storage-admission.ts', import.meta.url).href)};
    const { gate, registration } = await storageRegistration(process.argv[1]);
    const ticket = await gate.admit(registration, 'collect'); process.stdout.write(ticket.id); process.exit(0);`
  const dead = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', admission, common], { cwd: process.cwd(), encoding: 'utf8' })
  expect(dead.status, dead.stderr).toBe(0)
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { main } from ${JSON.stringify(new URL('../src/offline/room-state.ts', import.meta.url).href)}; process.exit(await main(JSON.parse(process.argv[1])));`, JSON.stringify(args)], { cwd: process.cwd(), encoding: 'utf8' })
  const resolved = run(['resolve-ticket', '--common-dir', common, '--ticket', dead.stdout.trim(), '--note', 'intent inspected; no external effects occurred'])
  expect(resolved.status, resolved.stderr).toBe(0)
  expect((await legacyStatus(common)).gate?.phase).toBe('draining')
  expect((await legacyStatus(common)).tickets).toBe(0)
  expect(fs.readdirSync(path.join(common, 'room/storage-gate/resolutions'))).toHaveLength(1)
  const reopened = run(['reopen', '--common-dir', common])
  expect(reopened.status, reopened.stderr).toBe(0)
  expect((await legacyStatus(common)).gate?.phase).toBe('legacy')
})


it('persists the pre-registry decision before newer worker worktrees appear', async () => {
  const { root, common } = fixture()
  const registry = await WorkerRegistry.open(common, { watch: false })
  registry.close()
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-q', '--allow-empty', '-m', 'base'])
  execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', 'room/new', path.join(root, '.room/workers/new')])
  await closeStorageAdmissions()
  expect((await legacyStatus(common)).maintenanceRequired).toBe(false)
  const reopened = await WorkerRegistry.open(common, { watch: false })
  reopened.close()
  expect(fs.existsSync(path.join(common, 'room/registry/migration.json'))).toBe(false)
})

it('refuses unreadable registered Room worktrees instead of omitting them from inventory', () => {
  const { root, common } = fixture()
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-q', '--allow-empty', '-m', 'base'])
  const worker = path.join(root, '.room/workers/old')
  execFileSync('git', ['-C', root, 'worktree', 'add', '-qb', 'room/old', worker])
  const original = fs.realpathSync
  vi.spyOn(fs, 'realpathSync').mockImplementation(((file: fs.PathLike) => {
    if (String(file).replaceAll('\\', '/').endsWith('/.room/workers/old')) throw Object.assign(new Error('inventory I/O failure'), { code: 'EACCES' })
    return original(file)
  }) as typeof fs.realpathSync)
  expect(() => discoverLegacyWorktrees(common)).toThrow('inventory is incomplete')
})

it('never completes a checkpoint with a previously assigned source absent from inventory', async () => {
  const { common, source } = fixture(), file = path.join(common, 'room/registry/migration.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ v: 1, done: false, sources: { [source.key]: { id: 'w_stable', state: 'assigned' } } }))
  await expect(runLegacyImport(common, { sources: () => [] })).rejects.toThrow('assignments remain unresolved')
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).done).toBe(false)
  expect((await legacyStatus(common)).gate?.phase).toBe('draining')
})

it('expires the whole offline attempt before publication and leaves the gate draining', async () => {
  const { common, source } = fixture()
  let elapsed = 0
  await expect(runLegacyImport(common, {
    mono: () => elapsed,
    sources: () => { elapsed = 10 * 60_000; return [source] },
  })).rejects.toThrow('exceeded 10 minutes')
  expect(fs.existsSync(path.join(common, 'room/registry/migration.json'))).toBe(false)
  expect((await legacyStatus(common)).gate?.phase).toBe('draining')
})

it('checks the deadline again after Git preparation and before publishing worker records', async () => {
  const { common, source } = fixture()
  let elapsed = 0
  Object.defineProperty(source, 'oldId', { get() { elapsed = 10 * 60_000; return undefined } })
  await expect(runLegacyImport(common, { mono: () => elapsed, sources: () => [source] })).rejects.toThrow('exceeded 10 minutes')
  const map = JSON.parse(fs.readFileSync(path.join(common, 'room/registry/migration.json'), 'utf8'))
  expect(map.done).toBe(false)
  expect(map.sources[source.key].state).toBe('assigned')
  expect(fs.existsSync(path.join(common, 'room/registry/workers', map.sources[source.key].id + '.json'))).toBe(false)
  expect((await legacyStatus(common)).gate?.phase).toBe('draining')
})

it('bounds every Git subprocess by the remaining absolute attempt budget', () => {
  let now = 0
  const budget = importBudget(() => now, 4000)
  expect(budget.gitTimeout()).toBe(3000)
  now = 3900
  expect(budget.gitTimeout()).toBe(100)
  now = 4000
  expect(() => budget.gitTimeout()).toThrow('exceeded 10 minutes')
})

it('repair-location requires confirmation and rebinds through the CLI', async () => {
  const { common } = fixture()
  fs.mkdirSync(path.join(common, 'room'))
  const previous = { v: 1, cloneId: 'a'.repeat(32), commonDir: path.join(path.dirname(common), 'missing-other'), generation: 7,
    phase: 'legacy', minReader: 1, minWriter: 1, preRegistryImport: 'not-needed', updatedAt: 0 }
  const file = path.join(common, 'room/storage-gate.json')
  fs.writeFileSync(file, JSON.stringify(previous))
  const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  expect(await main(['repair-location', '--common-dir', common])).toBe(1)
  expect(error).toHaveBeenCalledWith('Room storage unavailable: repair-location requires exactly one of --confirm-moved or --confirm-copied\n')
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(previous)
  expect(await main(['repair-location', '--common-dir', common, '--confirm-moved'])).toBe(0)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ cloneId: previous.cloneId, generation: 7, commonDir: fs.realpathSync(common) })
})

it('keeps both location commands visible over pending import advice', async () => {
  const { common } = fixture()
  fs.mkdirSync(path.join(common, 'room'))
  const old = path.join(path.dirname(common), 'previous')
  fs.writeFileSync(path.join(common, 'room/storage-gate.json'), JSON.stringify({ v: 1, cloneId: 'a'.repeat(32), commonDir: old, generation: 1,
    phase: 'legacy', minReader: 1, minWriter: 1, preRegistryImport: 'required', updatedAt: 0 }))
  const status = await legacyStatus(common)
  expect(status.remedy).toBe(status.refusal?.detail)
  expect(status.remedy).toContain(`recorded at \`${old}\``)
  expect(status.remedy).toContain('--confirm-moved')
  expect(status.remedy).toContain('--confirm-copied')
  expect(status.remedy).not.toContain('<plugin>')
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  expect(await main(['status', '--common-dir', common, '--json'])).toBe(1)
  expect(JSON.parse(String(output.mock.calls[0][0])).refusal.detail).toBe(status.refusal?.detail)
  await expect(WorkerRegistry.open(common, { watch: false })).rejects.toThrow(status.refusal!.detail)
})


it('CLI can confirm copy after an unmappable move refusal without a stuck journal', async () => {
  const { common } = fixture()
  const holds = path.join(common, 'room/registry/collection-reviews')
  fs.mkdirSync(holds, { recursive: true })
  const previous = { v: 1, cloneId: 'a'.repeat(32), commonDir: path.join(path.dirname(common), 'missing-other'), generation: 7,
    phase: 'legacy', minReader: 1, minWriter: 1, preRegistryImport: 'not-needed', updatedAt: 0 }
  fs.writeFileSync(path.join(common, 'room/storage-gate.json'), JSON.stringify(previous))
  fs.writeFileSync(path.join(holds, 'unknown.json'), '[{"owner":"reviewer"}]')
  const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  expect(await main(['repair-location', '--common-dir', common, '--confirm-moved'])).toBe(1)
  expect(String(error.mock.calls[0][0])).toContain('collection review destination cannot be proven')
  expect(fs.existsSync(path.join(common, 'room-location-pending.json'))).toBe(false)
  expect(await main(['repair-location', '--common-dir', common, '--confirm-copied'])).toBe(0)
  expect(JSON.parse(fs.readFileSync(path.join(common, 'room/storage-gate.json'), 'utf8')).cloneId).not.toBe(previous.cloneId)
})

it('JSON and text status retain unresolved tickets and registration-only evidence while draining', async () => {
  const { common } = fixture()
  const { FileStorageGate } = await import('@room/local-state/gate')
  const { randomUUID } = await import('node:crypto')
  const gate = new FileStorageGate(fs.realpathSync(common), {})
  const register = () => gate.register({ instance: { pid: 99999999, startTime: 'gone', executable: '/gone', sessionId: 'test', nonce: randomUUID() }, kind: 'mcp', release: 'test', preRegistryImport: 'not-needed' })
  const holder = await register(), orphan = await register()
  const ticket = await gate.admit(holder, 'collect')
  const finished = await gate.admit(orphan, 'preview')
  await gate.finish(finished)
  const file = path.join(common, 'room/storage-gate.json')
  const previous = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...previous, phase: 'draining', generation: 2, drainingFrom: 1, owner: { instance: holder.instance, token: 'interrupted' } }))
  const listing = await gate.listTickets()
  const evidence = listing.tickets.find(item => item.id.startsWith('registration:') && item.pid === orphan.instance.pid)!
  expect(evidence).toBeDefined()
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  expect(await main(['status', '--common-dir', common, '--json'])).toBe(1)
  const status = JSON.parse(String(out.mock.calls.at(-1)?.[0]))
  expect(status.refusal.reason).toBe('maintenance')
  expect(status.ticketListing.tickets).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: ticket.id, holderState: 'dead' }),
    expect.objectContaining({ id: evidence.id, kind: 'reconcile', holderState: 'dead' }),
  ]))
  expect(await main(['status', '--common-dir', common])).toBe(1)
  const text = String(out.mock.calls.at(-1)?.[0])
  expect(text).toContain(`ticket ${ticket.id}: collect; generation 1; pid 99999999; dead`)
  expect(text).toContain(`ticket ${evidence.id}: reconcile; generation 1; pid 99999999; dead`)
})

it.each([false, true])('JSON and text status show the verified relocation choice (copied=%s)', async copied => {
  const { common } = fixture()
  const current = fs.realpathSync(common), old = path.join(path.dirname(current), 'missing')
  const original = { v: 1, cloneId: 'a'.repeat(32), commonDir: old, generation: 1,
    phase: 'legacy', minReader: 1, minWriter: 1, preRegistryImport: 'not-needed', updatedAt: 0 }
  fs.mkdirSync(path.join(current, 'room'))
  fs.writeFileSync(path.join(current, 'room/storage-gate.json'), JSON.stringify(original))
  const intent = { v: 1, gate: original, current, copied, aside: copied ? 'room.copied-1-abcdefabcdef' : undefined,
    fresh: copied ? { cloneId: 'c'.repeat(32), relocationNonce: 'd'.repeat(32) } : undefined }
  const journal = path.join(current, 'room-location-pending.json'), bytes = JSON.stringify(intent)
  fs.writeFileSync(journal, bytes)
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  expect(await main(['status', '--common-dir', common, '--json'])).toBe(1)
  const status = JSON.parse(String(out.mock.calls.at(-1)?.[0]))
  expect(status.refusal.detail).toContain(`recovery: ${copied ? 'copied' : 'moved'}; old path: ${old}; new path: ${current}`)
  expect(status.refusal.detail).toContain('stage:')
  expect(status.remedy).toContain(`repair-location --common-dir '${current}' --confirm-${copied ? 'copied' : 'moved'}`)
  expect(await main(['status', '--common-dir', common])).toBe(1)
  const text = String(out.mock.calls.at(-1)?.[0])
  expect(text).toContain(status.refusal.detail)
  expect(text).toContain(status.remedy)
  expect(fs.readFileSync(journal, 'utf8')).toBe(bytes)
})
