import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { main, runLegacyImport, legacyStatus, withMaintenance } from '../src/offline/room-state.js'
import { importLegacyWorkers, type LegacySource } from '../src/offline/legacy-import.js'
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
