import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { FileStorageGate } from '../src/gate.js'
import { STORAGE_PATHS } from '../src/protocol.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })) })
const input = () => ({ instance: { pid: 99999999, startTime: 'gone', executable: '/gone', sessionId: 'test', nonce: randomBytes(16).toString('hex') }, kind: 'mcp' as const, release: 'test' })
const gate = (dir: string) => new FileStorageGate(dir, {})
const record = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, STORAGE_PATHS.gate), 'utf8'))
async function fixture(copy = false) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'room-relocation-'))); roots.push(root)
  const old = path.join(root, 'old', '.git'), current = path.join(root, 'new', '.git')
  fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'HEAD'), 'ref: refs/heads/main\n')
  await gate(old).register(input())
  const before = record(old)
  if (copy) fs.cpSync(path.dirname(old), path.dirname(current), { recursive: true })
  else { fs.renameSync(path.dirname(old), path.dirname(current)); fs.mkdirSync(path.dirname(old)) }
  return { old, current, before }
}
it('confirms a move once under concurrent repairs, preserving identity, phase and generation', async () => {
  const { old, current, before } = await fixture()
  const notice = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  await Promise.all([gate(current).repairLocation('moved'), gate(current).repairLocation('moved')])
  expect(record(current)).toMatchObject({ cloneId: before.cloneId, generation: before.generation, phase: before.phase, commonDir: current })
  expect(notice).toHaveBeenCalledExactlyOnceWith(`Room moved: ${old} -> ${current}\n`)
})

it('copies once, preserving all old state aside and leaving original untouched', async () => {
  const { old, current, before } = await fixture(true)
  const notice = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  await gate(current).repairLocation('copied')
  const archives = fs.readdirSync(current).filter(n => n.startsWith('room.copied-'))
  expect(archives).toHaveLength(1)
  expect(JSON.parse(fs.readFileSync(path.join(current, archives[0], 'storage-gate.json'), 'utf8'))).toEqual(before)
  expect(record(old)).toEqual(before); expect(record(current).cloneId).not.toBe(before.cloneId)
  expect(record(current)).toMatchObject({ generation: 1, phase: 'legacy' }); expect(notice).toHaveBeenCalledTimes(1)
})
it('refuses unreadable original with executable repair remedy, then accepts confirmed move', async () => {
  const { old, current, before } = await fixture(true)
  fs.writeFileSync(path.join(old, STORAGE_PATHS.gate), 'unreadable JSON')
  await expect(gate(current).register(input())).rejects.toThrow('--confirm-moved')
  expect(record(current)).toEqual(before)
  await gate(current).repairLocation('moved')
  expect(record(current).cloneId).toBe(before.cloneId)
})
it('refuses maintenance even during confirmed move', async () => {
  const { current, before } = await fixture()
  const maintained = { ...before, phase: 'draining', generation: 2, drainingFrom: 1, owner: { instance: input().instance, token: 'owner' } }
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify(maintained))
  await expect(gate(current).register(input())).rejects.toThrow('If you moved it, run:')
  await expect(gate(current).repairLocation('moved')).rejects.toThrow('relocation requires legacy phase; found draining')
  expect(record(current)).toEqual(maintained)
})
it('refuses live holders even with confirmation', async () => {
  const { current } = await fixture()
  await expect(new FileStorageGate(current, { liveness: () => 'alive' }).repairLocation('moved')).rejects.toThrow('live or unknown')
})
it.runIf(process.platform !== 'win32')('serializes independent starter processes through real symlink aliases', async () => {
  const { current, before } = await fixture()
  const source = new URL('../src/gate.ts', import.meta.url).href
  const program = `import { FileStorageGate, canonicalCommonDir } from ${JSON.stringify(source)}; const gate = new FileStorageGate(canonicalCommonDir(process.argv[1]), {}); await gate.register(JSON.parse(process.argv[2]));`
  const alias = path.join(path.dirname(path.dirname(current)), 'alias')
  fs.symlinkSync(path.dirname(current), alias, 'dir')
  const start = (dir: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program, dir, JSON.stringify(input())], { timeout: 15000 })
  fs.rmdirSync(path.dirname(before.commonDir))
  fs.symlinkSync(path.dirname(current), path.dirname(before.commonDir), 'dir')
  const results = await Promise.all([start(current), start(path.join(alias, '.git'))])
  expect(results.flatMap(result => result.stderr.split('\n').filter(line => line.startsWith('Room location alias:')))).toHaveLength(1)
  expect(record(current)).toMatchObject({ cloneId: before.cloneId, generation: before.generation })
})

it('status reports fresh import state after copy isolation', async () => {
  const { current } = await fixture(true)
  fs.mkdirSync(path.join(current, 'room/registry'), { recursive: true })
  fs.writeFileSync(path.join(current, 'room/registry/migration.json'), JSON.stringify({ done: false }))
  await gate(current).repairLocation('copied')
  expect(await gate(current).status()).toMatchObject({ state: 'present', legacyImport: 'absent', maintenanceRequired: false })
})

it('refuses a missing ancestor (an unmounted original)', async () => {
  const { old, current, before } = await fixture()
  fs.rmdirSync(path.dirname(old))
  await expect(gate(current).repairLocation()).rejects.toThrow('repair-location')
  expect(record(current)).toEqual(before)
})
it('refuses copied confirmation for a symlink alias, then auto-updates path text', async () => {
  const { old, current, before } = await fixture()
  fs.rmdirSync(path.dirname(old))
  fs.symlinkSync(path.dirname(current), path.dirname(old), 'dir')
  await expect(gate(current).repairLocation('copied')).rejects.toThrow('same directory')
  await gate(current).repairLocation()
  expect(record(current)).toEqual({ ...before, commonDir: current })
  expect(record(current).cloneId).toBe(before.cloneId)
  expect(fs.readdirSync(current).some(n => n.startsWith('room.copied-'))).toBe(false)
})
it('updates a case-only alias on a case-insensitive filesystem', async () => {
  const { current, before } = await fixture()
  const old = current.replace('/new/', '/NEW/')
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify({ ...before, commonDir: old }))
  // Simulate case-insensitive lookup on every test platform; retain real inode evidence.
  const stat = fs.statSync, real = fs.realpathSync.native
  vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...args: unknown[]) => (stat as Function)(String(p) === old ? current : p, ...args)) as typeof fs.statSync)
  vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike, ...args: unknown[]) => (real as Function)(String(p) === old ? current : p, ...args)) as typeof fs.realpathSync)
  await gate(current).repairLocation()
  expect(record(current).cloneId).toBe(before.cloneId)
  expect(fs.readdirSync(current).some(n => n.startsWith('room.copied-'))).toBe(false)
})
it('ignores a surviving ancestor shell but refuses a live positional host', async () => {
  const { current } = await fixture()
  const file = path.join(current, 'room/session.json')
  const dead = { pid: 99999999, startTime: 'gone', executable: 'claude' }
  fs.writeFileSync(file, JSON.stringify({ chain: [dead, { pid: process.pid, startTime: '', executable: 'zsh' }] }))
  await gate(current).repairLocation('moved')
  const next = { ...record(current), commonDir: path.join(path.dirname(current), 'absent') }
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify(next))
  fs.writeFileSync(file, JSON.stringify({ chain: [{ pid: process.pid, startTime: '', executable: '' }] }))
  await expect(gate(current).repairLocation('copied')).rejects.toThrow('session host identity')
})
it('refuses unknown record kinds even with dead pids', async () => {
  const { current } = await fixture()
  fs.writeFileSync(path.join(current, 'room/future.json'), JSON.stringify({ owner: input().instance }))
  await expect(gate(current).repairLocation('moved')).rejects.toThrow('unknown record kind')
})

it('leaves unchanged location records and behavior intact', async () => {
  const { current } = await fixture()
  await gate(current).repairLocation('moved')
  const before = record(current)
  const file = path.join(current, 'room/future.json'), text = JSON.stringify({ pid: process.pid })
  fs.writeFileSync(file, text)
  await gate(current).repairLocation()
  expect(record(current)).toEqual(before)
  expect(fs.readFileSync(file, 'utf8')).toBe(text)
  await expect(gate(current).register(input())).resolves.toBeDefined()
})
it.runIf(process.platform === 'win32')('recognizes native junction aliases', async () => {
  const { old, current, before } = await fixture()
  fs.rmdirSync(path.dirname(old)); fs.symlinkSync(path.dirname(current), path.dirname(old), 'junction')
  await gate(current).repairLocation()
  expect(record(current).cloneId).toBe(before.cloneId)
})
it.runIf(process.platform === 'win32')('recognizes native drive-letter case aliases', async () => {
  const { current, before } = await fixture()
  const old = current[0] === current[0].toUpperCase() ? current[0].toLowerCase() + current.slice(1) : current[0].toUpperCase() + current.slice(1)
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify({ ...before, commonDir: old }))
  await gate(current).repairLocation()
  expect(record(current).cloneId).toBe(before.cloneId)
})

it.each(['missing', 'same-id', 'different-id', 'unreadable'])('asks once for %s originals with exact runnable commands', async kind => {
  const { old, current, before } = await fixture(kind !== 'missing')
  if (kind === 'different-id') fs.writeFileSync(path.join(old, STORAGE_PATHS.gate), JSON.stringify({ ...before, cloneId: 'b'.repeat(32) }))
  if (kind === 'unreadable') fs.writeFileSync(path.join(old, STORAGE_PATHS.gate), 'broken')
  const bundle = fileURLToPath(new URL('../../../plugins/room/server/room-state.mjs', import.meta.url))
  expect(fs.existsSync(bundle)).toBe(true)
  const command = `node '${bundle}' repair-location --common-dir '${current}'`
  const message = `This repository's Room state was recorded at \`${old}\`; it is now at \`${current}\`. If you moved it, run: \`${command} --confirm-moved\`. If it is a copy, run: \`${command} --confirm-copied\`.`
  await expect(gate(current).register(input())).rejects.toMatchObject({ detail: message })
  expect((await gate(current).status()).refusal?.detail).toBe(message)
  expect(record(current)).toEqual(before)
  expect(fs.existsSync(path.join(current, 'room-location-pending.json'))).toBe(false)
})

it('refuses lifecycle cleanup at a mismatched location without deleting records', async () => {
  const { current, before } = await fixture()
  const registrationFile = fs.readdirSync(path.join(current, 'room/storage-gate/registrations'))[0]
  const registration = JSON.parse(fs.readFileSync(path.join(current, 'room/storage-gate/registrations', registrationFile), 'utf8'))
  await expect(gate(current).unregister(registration)).rejects.toThrow('If you moved it, run:')
  await expect(gate(current).listTickets()).rejects.toThrow('--confirm-copied')
  expect(record(current)).toEqual(before)
  expect(fs.existsSync(path.join(current, 'room/storage-gate/registrations', registrationFile))).toBe(true)
})

it.each(['dev', 'ino'])('does not collapse large bigint %s identities or fall back to realpath', async field => {
  const { old, current, before } = await fixture(true)
  const stat = fs.statSync, real = fs.realpathSync.native
  const large = 2n ** 54n
  expect(Number(large)).toBe(Number(large + 1n))
  vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, options: unknown) => {
    if (String(p) === old || String(p) === current) {
      expect(options).toEqual({ bigint: true })
      return { isDirectory: () => true, dev: large, ino: large, [field]: String(p) === old ? large : large + 1n }
    }
    return (stat as Function)(p, options)
  }) as typeof fs.statSync)
  vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike) => String(p) === old ? current : real(p)) as typeof fs.realpathSync)
  await expect(gate(current).repairLocation()).rejects.toThrow('--confirm-copied')
  expect(record(current)).toEqual(before)
})

it.each(['source', 'bundle'])('recovers archive-rename interruption through the actual %s CLI entry and filesystem preflight', async route => {
  const { current } = await interruptedCopy()
  const entry = fileURLToPath(new URL(route === 'source' ? '../../room-mcp/src/offline/entry.ts' : '../../../plugins/room/server/room-state.mjs', import.meta.url))
  await promisify(execFile)(process.execPath, ['--import', 'tsx', entry, 'repair-location', '--common-dir', current, '--confirm-copied'], { timeout: 15000 })
  expect(record(current)).toMatchObject({ commonDir: current, phase: 'legacy' })
  expect(fs.existsSync(path.join(current, 'room-location-pending.json'))).toBe(false)
})

it.each(['empty-preflight', 'dead-preflight', 'dead-temp', 'live-temp', 'live-preflight', 'unknown-preflight', 'invalid-preflight', 'invalid-temp', 'foreign', 'foreign-probe'])('handles pre-publication destination %s conservatively', async kind => {
  const { current } = await interruptedCopy()
  const room = path.join(current, 'room')
  fs.mkdirSync(room)
  if (kind.includes('preflight') || kind === 'foreign-probe') {
    const root = path.join(room, 'preflight')
    fs.mkdirSync(root)
    if (kind !== 'empty-preflight') {
      const child = path.join(root, kind === 'unknown-preflight' ? 'abcdefabcdefabcd' : `p${kind === 'invalid-preflight' ? 2147483648 : kind === 'live-preflight' ? process.pid : 99999999}-nabcdefabcdefabcd`)
      fs.mkdirSync(child)
      fs.writeFileSync(path.join(child, kind === 'foreign-probe' ? 'foreign.txt' : 'probe.sqlite'), 'probe')
    }
  } else fs.writeFileSync(path.join(room, kind === 'foreign' ? 'foreign.txt' : `storage-gate.json.roomtmp-p${kind === 'invalid-temp' ? 2147483648 : kind === 'live-temp' ? process.pid : 99999999}-su-n12345678-1234-1234-1234-123456789abc.tmp`), 'partial')
  if (['empty-preflight', 'dead-preflight', 'dead-temp'].includes(kind)) {
    await gate(current).repairLocation('copied')
    expect(record(current).commonDir).toBe(current)
    expect(fs.readdirSync(room).sort()).toEqual([...(kind.includes('preflight') ? ['preflight'] : []), 'storage-gate.json'])
    if (kind.includes('preflight')) expect(fs.readdirSync(path.join(room, 'preflight'))).toEqual([])
  } else {
    await expect(gate(current).repairLocation('copied')).rejects.toThrow('destination is not empty')
    expect(fs.readdirSync(current).some(n => n.startsWith('room.copied-'))).toBe(true)
    expect(fs.existsSync(path.join(room, 'storage-gate.json'))).toBe(false)
  }
})

it('recovers the actual atomic temp left by a process exiting before exclusive gate publication', async () => {
  const { current } = await fixture(true)
  const program = `import fs from 'node:fs';
    import { FileStorageGate } from ${JSON.stringify(new URL('../src/gate.ts', import.meta.url).href)};
    const link = fs.linkSync;
    fs.linkSync = (from, to) => { if (String(to).endsWith('storage-gate.json')) process.exit(23); return link(from, to); };
    await new FileStorageGate(process.argv[1], {}).repairLocation('copied');`
  await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, current], { timeout: 15000 })).rejects.toMatchObject({ code: 23 })
  const names = fs.readdirSync(path.join(current, 'room'))
  expect(names).toHaveLength(1)
  expect(names[0]).toMatch(/^storage-gate.json\.roomtmp-/)
  await gate(current).repairLocation('copied')
  expect(record(current).commonDir).toBe(current)
  expect(fs.existsSync(path.join(current, 'room', names[0]))).toBe(false)
})

it('retains the preflight parent checked by a concurrent starter', async () => {
  const { current } = await interruptedCopy()
  const parent = path.join(current, 'room/preflight')
  fs.mkdirSync(parent, { recursive: true })
  const before = fs.statSync(parent, { bigint: true })
  const remove = vi.spyOn(fs, 'rmdirSync')
  await gate(current).repairLocation('copied')
  expect(remove.mock.calls.some(([dir]) => String(dir) === parent)).toBe(false)
  expect(fs.statSync(parent, { bigint: true }).ino).toBe(before.ino)
  // The paused starter resumes after recovery, using its already-verified parent.
  const child = path.join(parent, `p${process.pid}-nabcdefabcdefabcd`)
  fs.mkdirSync(child)
  fs.writeFileSync(path.join(child, 'probe.sqlite'), 'probe')
})


it('status leaves a same-directory alias untouched', async () => {
  const { old, current, before } = await fixture()
  fs.rmdirSync(path.dirname(old))
  fs.symlinkSync(path.dirname(current), path.dirname(old), 'dir')
  expect(await gate(current).status()).toMatchObject({ maintenanceRequired: false, locationUpdate: { recorded: old, canonical: current } })
  expect(record(current)).toEqual(before)
  expect(fs.existsSync(path.join(current, 'room-storage-location.guard'))).toBe(false)
})


it('moves clean state with only the gate bytes changed', async () => {
  const { current, before } = await fixture()
  const snapshot = () => fs.readdirSync(current, { recursive: true }).map(String).filter(n => fs.statSync(path.join(current, n)).isFile()).map(n => [n, fs.readFileSync(path.join(current, n), 'utf8')])
  const prior = snapshot().filter(([n]) => n !== STORAGE_PATHS.gate)
  await gate(current).repairLocation('moved')
  expect(record(current)).toEqual({ ...before, commonDir: current })
  expect(snapshot().filter(([n]) => n !== STORAGE_PATHS.gate)).toEqual(prior)
})

it('lists path-bearing records and review holds without changing them', async () => {
  const { current, old, before } = await fixture()
  const room = path.join(current, 'room')
  fs.mkdirSync(path.join(room, 'registry/collection-reviews'), { recursive: true })
  fs.writeFileSync(path.join(room, 'worker.json'), JSON.stringify({ dir: old, keptWorktree: old }))
  fs.writeFileSync(path.join(room, 'registry/migration.json'), JSON.stringify({ sources: { [`worktree:${old}`]: {} } }))
  fs.writeFileSync(path.join(room, 'registry/collection-reviews/hash.json'), '[{"owner":"reviewer"}]')
  await expect(gate(current).repairLocation('moved')).rejects.toThrow('finish (collect or discard) your workers and release review holds, then rerun; remaining: registry/collection-reviews/hash.json, registry/migration.json, worker.json')
  expect(record(current)).toEqual(before)
})

it.each(['marker', 'archive', 'fresh'])('recovers copy interrupted at %s', async step => {
  const { current, before } = await fixture(true)
  const rename = fs.renameSync, unlink = fs.unlinkSync
  vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
    rename(a, b)
    if (step === 'marker' && String(b).endsWith('copy-pending.json') || step === 'archive' && path.basename(String(b)).startsWith('room.copied-')) throw new Error('interrupted')
  })
  vi.spyOn(fs, 'unlinkSync').mockImplementation(p => {
    if (step === 'fresh' && String(p).endsWith('copy-pending.json')) throw new Error('interrupted')
    unlink(p)
  })
  await expect(gate(current).repairLocation('copied')).rejects.toThrow('interrupted')
  vi.restoreAllMocks()
  const status = await gate(current).status()
  expect(status.refusal?.detail).toContain('pending copy repair')
  await gate(current).repairLocation('copied')
  expect(record(current).cloneId).not.toBe(before.cloneId)
  expect(fs.readdirSync(current).filter(n => n.startsWith('room.copied-'))).toHaveLength(1)
})

it.each(['draining', 'staging', 'db-complete', 'active'])('refuses repair in %s phase', async phase => {
  const { current, before } = await fixture()
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify({ ...before, phase, generation: 2, drainingFrom: 1, owner: { instance: input().instance, token: 'owner' } }))
  for (const mode of ['moved', 'copied'] as const) await expect(gate(current).repairLocation(mode)).rejects.toThrow('legacy phase')
})

it.runIf(process.platform === 'win32')('recognises native Windows short and long directory spellings', async () => {
  const { current, before } = await fixture()
  const { stdout } = await promisify(execFile)('cmd.exe', ['/d', '/c', `for %I in ("${current}") do @echo %~sI`])
  const short = stdout.trim()
  const a = fs.statSync(short, { bigint: true }), b = fs.statSync(current, { bigint: true })
  expect([a.dev, a.ino]).toEqual([b.dev, b.ino])
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify({ ...before, commonDir: short }))
  await gate(current).repairLocation()
  expect(record(current).commonDir).toBe(current)
})

async function interruptedCopy() {
  const state = await fixture(true)
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    rename(from, to)
    if (path.basename(String(to)).startsWith('room.copied-')) throw new Error('interrupted after archive rename')
  })
  await expect(gate(state.current).repairLocation('copied')).rejects.toThrow('interrupted after archive rename')
  vi.restoreAllMocks()
  return state
}

it.each([null, undefined])('refuses unverifiable worker report host %s', async hostProcess => {
  const { current } = await fixture()
  fs.writeFileSync(path.join(current, 'room/1.report.json'), JSON.stringify({ chain: [input().instance], hostProcess }))
  await expect(gate(current).repairLocation('copied')).rejects.toThrow('live or unknown')
})
it('uses worker report host fallback', async () => {
  const { current } = await fixture()
  fs.writeFileSync(path.join(current, 'room/1.report.json'), JSON.stringify({ chain: [input().instance, { ...input().instance, pid: process.pid }] }))
  await expect(new FileStorageGate(current, { liveness: p => p.pid === process.pid ? 'alive' : 'dead' }).repairLocation('copied')).rejects.toThrow('live or unknown')
})

it.each(['ticket', 'guard', 'publisher'])('refuses a live %s holder in either repair mode', async kind => {
  const { current } = await fixture()
  const holder = { ...input().instance, pid: process.pid }
  const file = kind === 'ticket' ? `room/storage-gate/tickets/${holder.nonce}.${'a'.repeat(32)}.json`
    : kind === 'guard' ? 'room/some.guard' : 'room/publishers/key.json'
  fs.mkdirSync(path.dirname(path.join(current, file)), { recursive: true })
  fs.writeFileSync(path.join(current, file), JSON.stringify(kind === 'ticket' ? { identity: holder } : { holder }))
  for (const mode of ['moved', 'copied'] as const)
    await expect(new FileStorageGate(current, { liveness: p => p.pid === process.pid ? 'alive' : 'dead' }).repairLocation(mode)).rejects.toThrow('live or unknown')
})

it('does not overwrite a foreign fresh gate during interrupted copy recovery', async () => {
  const { current } = await interruptedCopy()
  fs.mkdirSync(path.join(current, 'room'))
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify({ v: 1, cloneId: 'f'.repeat(32), commonDir: current,
    generation: 1, phase: 'legacy', minReader: 1, minWriter: 1, updatedAt: 1 }))
  const before = record(current)
  await expect(gate(current).repairLocation('copied')).rejects.toThrow('foreign gate')
  expect(record(current)).toEqual(before)
})

it('mentions Git repair for linked worktrees without touching their metadata', async () => {
  const { current } = await fixture()
  fs.mkdirSync(path.join(current, 'worktrees'))
  const notice = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  await gate(current).repairLocation('moved')
  expect(notice).toHaveBeenCalledWith(expect.stringContaining('git worktree repair'))
})

it('permits empty review holds and path-free metadata', async () => {
  const { current } = await fixture()
  const holds = path.join(current, 'room/registry/collection-reviews')
  fs.mkdirSync(holds, { recursive: true })
  fs.writeFileSync(path.join(holds, 'old-path-hash.json'), '[]')
  fs.writeFileSync(path.join(current, 'room/metadata.json'), '{"summary":"old path is historical text"}')
  await gate(current).repairLocation('moved')
  expect(fs.readFileSync(path.join(holds, 'old-path-hash.json'), 'utf8')).toBe('[]')
})

it.each(['worker', 'cutover', 'session'])('refuses remaining %s path state', async kind => {
  const { current, old } = await fixture()
  const file = kind === 'worker' ? 'registry/workers/retained.json' : kind === 'cutover' ? 'daemon-cutover.json' : 'sessions/old/session.json'
  const value = kind === 'worker' ? { lead: { instance: input().instance }, runs: [], phase: 'active', dir: old, keptWorktree: old }
    : kind === 'cutover' ? { clone: 'old-path-hash' } : { cwd: old, transcript_path: path.join(old, 'transcript'), chain: [{ ...input().instance, executable: 'claude' }] }
  fs.mkdirSync(path.dirname(path.join(current, 'room', file)), { recursive: true })
  fs.writeFileSync(path.join(current, 'room', file), JSON.stringify(value))
  await expect(gate(current).repairLocation('moved')).rejects.toThrow(`remaining: ${file}`)
})
