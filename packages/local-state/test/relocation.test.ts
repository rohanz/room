import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { FileStorageGate } from '../src/gate.js'
import { STORAGE_PATHS } from '../src/protocol.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })) })
const input = () => ({ instance: { pid: 99999999, startTime: 'gone', executable: '/gone', sessionId: 'test', nonce: randomBytes(16).toString('hex') }, kind: 'mcp' as const, release: 'test' })
const gate = (dir: string) => new FileStorageGate(dir, {})
const record = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, STORAGE_PATHS.gate), 'utf8'))
async function fixture(copy = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-relocation-'))); roots.push(root)
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
it('refuses maintenance even during confirmed rebind', async () => {
  const { current, before } = await fixture()
  const maintained = { ...before, phase: 'draining', generation: 2, drainingFrom: 1, owner: { instance: input().instance, token: 'owner' } }
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify(maintained))
  await expect(gate(current).register(input())).rejects.toThrow('If you moved it, run:')
  await expect(gate(current).repairLocation('moved')).rejects.toThrow('relocation requires legacy phase; found draining')
  expect(record(current)).toEqual(maintained)
})
it('refuses live holders even with confirmation', async () => {
  const { current } = await fixture()
  await expect(new FileStorageGate(current, { liveness: () => 'alive' }).repairLocation('moved')).rejects.toThrow('relocation blocked by a live or unknown registration')
})
it('rebinds worker paths and cutover clone hashes without changing arbitrary text', async () => {
  const { old, current } = await fixture()
  const file = path.join(current, 'room', 'worker.json')
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  fs.writeFileSync(file, JSON.stringify({ dir: path.join(path.dirname(old), 'worker'), clone: hash(old), prompt: old }))
  await gate(current).repairLocation('moved')
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ dir: path.join(path.dirname(current), 'worker'), clone: hash(current), prompt: old })
})

it('recovers a copy interrupted after the archive rename', async () => {
  const { current, before } = await fixture(true)
  const aside = 'room.copied-1-abcdefabcdef'
  fs.writeFileSync(path.join(current, 'room-location-pending.json'), JSON.stringify({ v: 1, gate: before, current, copied: true, aside, fresh: { cloneId: "c".repeat(32), relocationNonce: "d".repeat(32) } }))
  fs.renameSync(path.join(current, 'room'), path.join(current, aside))
  await gate(current).register(input())
  expect(record(current).cloneId).not.toBe(before.cloneId)
  expect(fs.existsSync(path.join(current, 'room-location-pending.json'))).toBe(false)
  expect(fs.readdirSync(current).filter(n => n.startsWith('room.copied-'))).toEqual([aside])
})


it('rekeys publisher, collection leases and review holds, and preserves import assignments', async () => {
  const { old, current } = await fixture()
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const from = path.dirname(old), to = path.dirname(current)
  const room = path.join(current, 'room')
  for (const family of ['publishers', 'registry/collect', 'registry/collection-reviews']) {
    fs.mkdirSync(path.join(room, family), { recursive: true })
    fs.writeFileSync(path.join(room, family, `${hash(from)}.json`), JSON.stringify(family.endsWith('collection-reviews') ? [{ owner: 'reviewer' }] : { worktree: from, holder: input().instance }))
  }
  fs.writeFileSync(path.join(room, 'registry/migration.json'), JSON.stringify({ sources: { [`worktree:${from}`]: { id: 'stable' } } }))
  await gate(current).repairLocation('moved')
  for (const family of ['publishers', 'registry/collect', 'registry/collection-reviews']) {
    expect(fs.readdirSync(path.join(room, family))).toEqual([`${hash(to)}.json`])
  }
  expect(JSON.parse(fs.readFileSync(path.join(room, 'registry/migration.json'), 'utf8'))).toEqual({ sources: { [`worktree:${to}`]: { id: 'stable' } } })
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
it('rebinds a case-only alias on a case-insensitive filesystem', async () => {
  const { current, before } = await fixture()
  const old = current.replace('/new/', '/NEW/')
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify({ ...before, commonDir: old }))
  // Simulate case-insensitive lookup on every test platform; retain real inode evidence.
  const stat = fs.statSync, real = fs.realpathSync
  vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, ...args: unknown[]) => (stat as Function)(String(p) === old ? current : p, ...args)) as typeof fs.statSync)
  vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, ...args: unknown[]) => (real as Function)(String(p) === old ? current : p, ...args)) as typeof fs.realpathSync)
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
it.each(['generation', 'cloneId', 'archive', 'live'])('refuses %s journal evidence without mutation', async kind => {
  const { current, before } = await fixture(true)
  const aside = 'room.copied-1-abcdefabcdef'
  const source = { ...before, ...(kind === 'generation' ? { generation: before.generation + 1 } : {}), ...(kind === 'cloneId' ? { cloneId: 'b'.repeat(32) } : {}) }
  fs.writeFileSync(path.join(current, 'room-location-pending.json'), JSON.stringify({ v: 1, gate: source, current, copied: true, aside, fresh: { cloneId: "c".repeat(32), relocationNonce: "d".repeat(32) } }))
  if (kind === 'archive') {
    fs.mkdirSync(path.join(current, aside))
    fs.writeFileSync(path.join(current, aside, 'storage-gate.json'), JSON.stringify({ ...before, cloneId: 'b'.repeat(32) }))
  }
  if (kind === 'live') fs.writeFileSync(path.join(current, 'room/live.json'), JSON.stringify({ pid: process.pid }))
  await expect(gate(current).repairLocation('copied')).rejects.toThrow('repair-location')
  expect(record(current)).toEqual(before)
})
it('replays an interrupted per-record rebind idempotently', async () => {
  const { old, current, before } = await fixture()
  const a = path.join(current, 'room/a.json'), b = path.join(current, 'room/b.json')
  fs.writeFileSync(a, JSON.stringify({ cwd: path.dirname(old) }))
  fs.writeFileSync(b, JSON.stringify({ cwd: path.dirname(old) }))
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === b) throw new Error('interrupted record write')
    return rename(from, to)
  })
  await expect(gate(current).repairLocation('moved')).rejects.toThrow('interrupted record write')
  expect(JSON.parse(fs.readFileSync(a, 'utf8')).cwd).toBe(path.dirname(current))
  vi.restoreAllMocks()
  await gate(current).repairLocation()
  for (const file of [a, b]) expect(JSON.parse(fs.readFileSync(file, 'utf8')).cwd).toBe(path.dirname(current))
  expect(record(current).cloneId).toBe(before.cloneId)
})
it('rejects overlapping roots before journaling or rebinding', async () => {
  const { current, before } = await fixture()
  const old = path.join(path.dirname(path.dirname(current)), '.git')
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify({ ...before, commonDir: old }))
  await expect(gate(current).repairLocation('moved')).rejects.toThrow('overlapping relocation roots')
  expect(fs.existsSync(path.join(current, 'room-location-pending.json'))).toBe(false)
})

it.each(['draining', 'staging', 'db-complete', 'active'])('refuses confirmation and journal replay in %s phase', async phase => {
  const { current, before } = await fixture()
  const source = { ...before, phase, generation: 2, drainingFrom: 1, owner: { instance: input().instance, token: 'owner' } }
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify(source))
  for (const mode of ['moved', 'copied'] as const) await expect(gate(current).repairLocation(mode)).rejects.toThrow('legacy phase')
  fs.writeFileSync(path.join(current, 'room-location-pending.json'), JSON.stringify({ v: 1, gate: before, current, copied: false }))
  await expect(gate(current).repairLocation()).rejects.toThrow('stale or foreign')
  expect(record(current)).toEqual(source)
})
it('refuses a live archived holder during replay', async () => {
  const { current, before } = await fixture(true)
  const aside = 'room.copied-1-abcdefabcdef'
  fs.writeFileSync(path.join(current, 'room-location-pending.json'), JSON.stringify({ v: 1, gate: before, current, copied: true, aside, fresh: { cloneId: "c".repeat(32), relocationNonce: "d".repeat(32) } }))
  fs.renameSync(path.join(current, 'room'), path.join(current, aside))
  fs.writeFileSync(path.join(current, aside, 'live.json'), JSON.stringify({ pid: process.pid }))
  await expect(gate(current).repairLocation('copied')).rejects.toThrow('live or unknown')
  expect(fs.existsSync(path.join(current, 'room'))).toBe(false)
})



it.each([false, true])('blocks the legacy worker host, including archive replay=%s', async replay => {
  const { current, before } = await fixture(true)
  const aside = 'room.copied-1-abcdefabcdef'
  let room = path.join(current, 'room')
  if (replay) {
    fs.writeFileSync(path.join(current, 'room-location-pending.json'), JSON.stringify({ v: 1, gate: before, current, copied: true, aside, fresh: { cloneId: "c".repeat(32), relocationNonce: "d".repeat(32) } }))
    fs.renameSync(room, path.join(current, aside)); room = path.join(current, aside)
  }
  fs.writeFileSync(path.join(room, '1.report.json'), JSON.stringify({ run: 1, nonce: 'n', joinedAt: 1,
    chain: [{ pid: 99999999, startTime: 'dead', executable: 'node' }, { pid: process.pid, startTime: 'host', executable: 'claude' }] }))
  await expect(new FileStorageGate(current, { liveness: p => p.pid === process.pid ? 'alive' : 'dead' }).repairLocation('copied')).rejects.toThrow('live or unknown')
})
it.each([null, undefined])('refuses unverifiable worker host %s', async hostProcess => {
  const { current } = await fixture()
  fs.writeFileSync(path.join(current, 'room/1.report.json'), JSON.stringify({ chain: [input().instance], hostProcess }))
  await expect(gate(current).repairLocation('copied')).rejects.toThrow('live or unknown')
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
it('refuses overlapping roots through a filesystem alias', async () => {
  const { current, before } = await fixture()
  const root = path.dirname(path.dirname(current)), alias = path.join(root, 'alias')
  fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify({ ...before, commonDir: path.join(alias, '.git') }))
  await expect(gate(current).repairLocation('moved')).rejects.toThrow('overlapping relocation roots')
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

it.runIf(process.platform === 'win32')('refuses case-normalized overlapping roots on Windows', async () => {
  const { current, before } = await fixture()
  const old = path.join(path.dirname(path.dirname(current)).toUpperCase(), '.git')
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify({ ...before, commonDir: old }))
  await expect(gate(current).repairLocation('moved')).rejects.toThrow('overlapping relocation roots')
})
it('refuses overlapping roots after case normalization on a case-insensitive volume', async () => {
  const { current, before } = await fixture()
  const root = path.dirname(path.dirname(current)), variant = root.toUpperCase()
  const real = fs.realpathSync
  vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike, ...args: unknown[]) =>
    (real as Function)(String(p) === variant ? root : p, ...args)) as typeof fs.realpathSync)
  fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify({ ...before, commonDir: path.join(variant, '.git') }))
  await expect(gate(current).repairLocation('moved')).rejects.toThrow('overlapping relocation roots')
})

it('refuses a confirmed move when a distinct same-id original remains', async () => {
  const { current, before } = await fixture(true)
  await expect(gate(current).repairLocation('moved')).rejects.toThrow('evidence of a copy; use --confirm-copied')
  expect(record(current)).toEqual(before)
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
  const stat = fs.statSync, real = fs.realpathSync
  const large = 2n ** 54n
  expect(Number(large)).toBe(Number(large + 1n))
  vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, options: unknown) => {
    if (String(p) === old || String(p) === current) {
      expect(options).toEqual({ bigint: true })
      return { isDirectory: () => true, dev: large, ino: large, [field]: String(p) === old ? large : large + 1n }
    }
    return (stat as Function)(p, options)
  }) as typeof fs.statSync)
  vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => String(p) === old ? current : real(p)) as typeof fs.realpathSync)
  await expect(gate(current).repairLocation()).rejects.toThrow('--confirm-copied')
  expect(record(current)).toEqual(before)
})

it.each(['register', 'repair', 'foreign-clone', 'foreign-nonce', 'damaged-archive'])('recovers after fresh gate publication via %s, refusing foreign evidence', async route => {
  const { current } = await fixture(true)
  const journal = path.join(current, 'room-location-pending.json')
  const unlink = fs.unlinkSync
  vi.spyOn(fs, 'unlinkSync').mockImplementation(p => {
    if (String(p) === journal) throw new Error('interrupted before journal removal')
    unlink(p)
  })
  await expect(gate(current).repairLocation('copied')).rejects.toThrow('interrupted before journal removal')
  vi.restoreAllMocks()
  const fresh = record(current)
  const intent = JSON.parse(fs.readFileSync(journal, 'utf8'))
  expect(fresh).toMatchObject(intent.fresh)
  if (route.startsWith('foreign')) {
    fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify({ ...fresh,
      [route === 'foreign-clone' ? 'cloneId' : 'relocationNonce']: 'e'.repeat(32) }))
    await expect(gate(current).register(input())).rejects.toThrow('foreign gate')
    expect(fs.existsSync(journal)).toBe(true)
  } else if (route === 'damaged-archive') {
    fs.writeFileSync(path.join(current, intent.aside, 'storage-gate.json'), '{}')
    await expect(gate(current).repairLocation()).rejects.toThrow('archive source cannot be verified')
    expect(fs.existsSync(journal)).toBe(true)
  } else {
    if (route === 'register') await gate(current).register(input())
    else await gate(current).repairLocation()
    expect(record(current)).toEqual(fresh)
    expect(fs.existsSync(journal)).toBe(false)
    expect(fs.readdirSync(current).filter(n => n.startsWith('room.copied-'))).toEqual([intent.aside])
  }
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
    expect(fs.readdirSync(room).sort()).toEqual(['location-notice.json', ...(kind.includes('preflight') ? ['preflight'] : []), 'storage-gate.json'])
    if (kind.includes('preflight')) expect(fs.readdirSync(path.join(room, 'preflight'))).toEqual([])
  } else {
    await expect(gate(current).repairLocation('copied')).rejects.toThrow('destination is not empty')
    expect(fs.existsSync(path.join(current, 'room-location-pending.json'))).toBe(true)
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


it('validates unmappable review holds before journaling and allows confirmed copy afterward', async () => {
  const { current, before } = await fixture()
  const holds = path.join(current, 'room/registry/collection-reviews')
  fs.mkdirSync(holds, { recursive: true })
  fs.writeFileSync(path.join(holds, 'unknown.json'), '[{"owner":"reviewer"}]')
  await expect(gate(current).repairLocation('moved')).rejects.toThrow('collection review destination cannot be proven')
  expect(fs.existsSync(path.join(current, 'room-location-pending.json'))).toBe(false)
  expect(record(current)).toEqual(before)
  await gate(current).repairLocation('copied')
  expect(record(current).cloneId).not.toBe(before.cloneId)
})

it('validates all lease targets before journaling or rewriting any record', async () => {
  const { old, current } = await fixture()
  const room = path.join(current, 'room'), publishers = path.join(room, 'publishers')
  fs.mkdirSync(publishers)
  const worktree = path.dirname(old)
  for (const name of ['a', 'b']) fs.writeFileSync(path.join(publishers, name + '.json'), JSON.stringify({ worktree, holder: input().instance }))
  const original = fs.readFileSync(path.join(publishers, 'a.json'), 'utf8')
  await expect(gate(current).repairLocation('moved')).rejects.toThrow('lease relocation target already exists')
  expect(fs.readFileSync(path.join(publishers, 'a.json'), 'utf8')).toBe(original)
  expect(fs.existsSync(path.join(current, 'room-location-pending.json'))).toBe(false)
})

it.each(['move-intent', 'move-partial', 'move-published', 'copy-intent', 'copy-archived', 'copy-published', 'old-move'])('handles mode switch at %s', async stage => {
  const { old, current, before } = await fixture()
  const journal = path.join(current, 'room-location-pending.json')
  const copied = stage.startsWith('copy')
  fs.writeFileSync(path.join(current, 'room/a.json'), JSON.stringify({ cwd: path.dirname(old) }))
  fs.writeFileSync(path.join(current, 'room/b.json'), JSON.stringify({ cwd: path.dirname(old) }))
  const rename = fs.renameSync, unlink = fs.unlinkSync
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (stage.endsWith('intent') && String(to) === journal) { rename(from, to); throw new Error('stop') }
    if (stage === 'move-partial' && String(to) === path.join(current, 'room/b.json')) throw new Error('stop')
    rename(from, to)
    if (stage === 'copy-archived' && path.basename(String(to)).startsWith('room.copied-')) throw new Error('stop')
  })
  vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (String(file) === journal) throw new Error('stop')
    unlink(file)
  })
  await expect(gate(current).repairLocation(copied ? 'copied' : 'moved')).rejects.toThrow('stop')
  vi.restoreAllMocks()
  if (stage === 'old-move') {
    fs.writeFileSync(path.join(current, STORAGE_PATHS.gate), JSON.stringify(before))
    const intent = JSON.parse(fs.readFileSync(journal, 'utf8')); delete intent.sourceDigest
    fs.writeFileSync(journal, JSON.stringify(intent))
  }
  const bytes = fs.readFileSync(journal, 'utf8')
  const snapshot = () => fs.readdirSync(current, { recursive: true }).map(String).sort().map(name => {
    const file = path.join(current, name); return [name, fs.statSync(file).isFile() ? fs.readFileSync(file).toString('base64') : null]
  })
  const untouched = snapshot()
  const status = await gate(current).status()
  expect(snapshot()).toEqual(untouched)
  expect(status.refusal?.detail).toContain(`pending relocation requires recovery: ${copied ? 'copied' : 'moved'}`)
  expect(status.refusal?.detail).toContain(`old path: ${old}; new path: ${current}`)
  const stages: Record<string, string> = { 'move-intent': 'move source unchanged', 'move-partial': 'move records changed',
    'move-published': 'move gate published', 'copy-intent': 'copy archive not yet renamed', 'copy-archived': 'copy archive renamed',
    'copy-published': 'copy archive and fresh gate published', 'old-move': 'move progress cannot be verified (older journal)' }
  expect(status.refusal?.detail).toContain(`stage: ${stages[stage]}`)
  if (copied) expect(status.refusal?.detail).toContain(`archive: ${path.join(current, JSON.parse(bytes).aside)}`)
  expect(status.refusal?.remedy).toContain(`repair-location --common-dir '${current}' --confirm-${copied ? 'copied' : 'moved'}`)
  expect(status.refusal?.remedy).not.toContain('<plugin>')
  expect(fs.readFileSync(journal, 'utf8')).toBe(bytes)
  if (stage.endsWith('intent')) {
    await gate(current).repairLocation(copied ? 'moved' : 'copied')
    expect(fs.existsSync(journal)).toBe(false)
    expect(record(current).cloneId === before.cloneId).toBe(copied)
  } else {
    const detail = stage === 'move-partial' ? 'move records changed' : stage === 'move-published' ? 'move gate published'
      : stage === 'copy-archived' ? 'copy archive renamed' : stage === 'copy-published' ? 'copy archive and fresh gate published'
      : 'move progress cannot be verified (older journal)'
    await expect(gate(current).repairLocation(copied ? 'moved' : 'copied')).rejects.toThrow(detail)
    expect(fs.readFileSync(journal, 'utf8')).toBe(bytes)
    await gate(current).repairLocation(copied ? 'copied' : 'moved')
    expect(fs.existsSync(journal)).toBe(false)
  }
})

it('status leaves a same-directory alias untouched', async () => {
  const { old, current, before } = await fixture()
  fs.rmdirSync(path.dirname(old))
  fs.symlinkSync(path.dirname(current), path.dirname(old), 'dir')
  expect((await gate(current).status()).maintenanceRequired).toBe(true)
  expect(record(current)).toEqual(before)
  expect(fs.existsSync(path.join(current, 'room-storage-location.guard'))).toBe(false)
})

it.each(['malformed', 'foreign', 'archive'])('status explains unverifiable %s journal without modifying it', async kind => {
  const { current, before } = await fixture(true)
  const journal = path.join(current, 'room-location-pending.json')
  const aside = 'room.copied-1-abcdefabcdef'
  const intent = { v: 1, gate: before, current: kind === 'foreign' ? '/foreign' : current, copied: true, aside,
    fresh: { cloneId: 'c'.repeat(32), relocationNonce: 'd'.repeat(32) } }
  fs.writeFileSync(journal, kind === 'malformed' ? '{broken' : JSON.stringify(intent))
  if (kind === 'archive') { fs.mkdirSync(path.join(current, aside)); fs.writeFileSync(path.join(current, aside, 'storage-gate.json'), '{}') }
  const bytes = fs.readFileSync(journal, 'utf8')
  const status = await gate(current).status()
  expect(status.refusal?.detail).toContain('pending relocation cannot be verified:')
  expect(status.refusal?.detail).toContain(kind === 'archive' ? 'archive source cannot be verified' : kind === 'foreign' ? 'invalid relocation journal' : 'JSON')
  expect(fs.readFileSync(journal, 'utf8')).toBe(bytes)
  expect(record(current)).toEqual(before)
})
