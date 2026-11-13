import fs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, statSync, utimesSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { CURRENT_COMPAT } from '@room/hub-core'
const { listing } = vi.hoisted(() => ({ listing: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: listing }))
import { installedCodexRoomContract } from '../src/hosts/codex-install.js'
const dirs: string[] = []
it.each([
  ['ETIMEDOUT', /listing timed out.*run.*codex plugin list --json --marketplace room.*retry/i],
  ['ENOENT', /listing could not run.*codex.*PATH/i],
])('explains listing failure %s without prescribing an update', async (code, expected) => {
  const { workerContractWarning } = await import('../src/hosts/codex-worker-warning.js')
  vi.stubEnv('ROOM_HOST', 'claude')
  listing.mockImplementation(() => { throw Object.assign(new Error('listing failed'), { code }) })
  try {
    const warning = workerContractWarning('codex')
    expect(warning).toMatch(expected)
    expect(warning).not.toMatch(/update Room|reconnect Room/)
  } finally { vi.unstubAllEnvs() }
})

it('distinguishes a failed executable verification from listing failure', async () => {
  const { workerContractWarning } = await import('../src/hosts/codex-worker-warning.js')
  const { dir } = verifiedFixture()
  writeFileSync(join(dir, 'plugins/cache/room/room/0.17.40/server/room-mcp.mjs'), 'tampered')
  vi.stubEnv('ROOM_HOST', 'claude')
  vi.stubEnv('CODEX_HOME', dir)
  try {
    expect(workerContractWarning('codex')).toMatch(/installed copy failed verification.*update Room.*reconnect Room/i)
  } finally { vi.unstubAllEnvs() }
})
function selectionEnv(dir: string): NodeJS.ProcessEnv {
  return { CODEX_HOME: dir, ProgramData: join(dir, 'system') }
}
function selectionConfig(dir: string, enabled = true): void {
  writeFileSync(join(dir, 'config.toml'), `[plugins."room@room"]\nenabled = ${enabled}\n`)
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks() })
it('reads only the selected install and verifies its executable digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-contract-')); dirs.push(dir); selectionConfig(dir)
  const server = join(dir, 'plugins/cache/room/room/0.17.32/server'); mkdirSync(server, { recursive: true })
  const bundle = 'actual-executable'
  const descriptor = { v: 1, release: '0.17.32', compat: CURRENT_COMPAT, workerRecordSchema: 1, bundleSha256: createHash('sha256').update(bundle).digest('hex') }
  writeFileSync(join(server, 'room-mcp.mjs'), bundle); writeFileSync(join(server, 'compat.json'), JSON.stringify(descriptor))
  // A larger cache directory is not proof of the selected executable.
  mkdirSync(join(dir, 'plugins/cache/room/room/99.0.0/.codex-plugin'), { recursive: true })
  listing.mockReturnValue(JSON.stringify({ installed: [{ pluginId: 'room@room', version: '0.17.32' }] }))
  expect(installedCodexRoomContract(selectionEnv(dir))).toMatchObject({ release: '0.17.32', workerRecordSchema: 1 })
  writeFileSync(join(server, 'room-mcp.mjs'), 'updated while lead alive')
  expect(installedCodexRoomContract(selectionEnv(dir))).toBeUndefined()
  expect(listing.mock.calls[0][1]).toEqual(['plugin', 'list', '--json', '--marketplace', 'room'])
})
it('keeps unknown, disabled, ambiguous and missing descriptors unverified', () => {
  listing.mockImplementation(() => { throw new Error('timeout') })
  expect(installedCodexRoomContract({})).toBeUndefined()
  listing.mockReturnValue(JSON.stringify({ installed: [{ pluginId: 'room@room', version: '99.0.0', enabled: false }] }))
  expect(installedCodexRoomContract({})).toBeUndefined()
  listing.mockReturnValue(JSON.stringify({ installed: [{ pluginId: 'room@room', version: '../outside' }] }))
  expect(installedCodexRoomContract({})).toBeUndefined()
})

it('reuses a verified contract while the listing is slow, but invalidates changed evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-contract-cache-')); dirs.push(dir); selectionConfig(dir)
  const server = join(dir, 'plugins/cache/room/room/0.17.32/server'); mkdirSync(server, { recursive: true })
  const bundle = 'verified-executable'
  const descriptor = { v: 1, release: '0.17.32', compat: CURRENT_COMPAT, workerRecordSchema: 1, bundleSha256: createHash('sha256').update(bundle).digest('hex') }
  writeFileSync(join(server, 'room-mcp.mjs'), bundle)
  writeFileSync(join(server, 'compat.json'), JSON.stringify(descriptor))
  listing.mockReturnValue(JSON.stringify({ installed: [{ pluginId: 'room@room', version: '0.17.32', enabled: true }] }))
  const env = selectionEnv(dir)
  const verified = installedCodexRoomContract(env)
  expect(verified).toBeDefined()
  listing.mockImplementation(() => { throw new Error('ETIMEDOUT') })
  expect(installedCodexRoomContract(env)).toEqual(verified)
  expect(listing).toHaveBeenCalledTimes(1)
  writeFileSync(join(server, 'compat.json'), JSON.stringify({ ...descriptor, workerRecordSchema: 2 }))
  expect(installedCodexRoomContract(env)).toBeUndefined()
  expect(listing).toHaveBeenCalledTimes(2)
  listing.mockReturnValue(JSON.stringify({ installed: [{ pluginId: 'room@room', version: '0.17.32', enabled: true }] }))
  expect(installedCodexRoomContract(env)?.workerRecordSchema).toBe(2)
  expect(listing).toHaveBeenCalledTimes(3)
  writeFileSync(join(server, 'room-mcp.mjs'), 'mismatched executable')
  expect(installedCodexRoomContract(env)).toBeUndefined()
  expect(listing).toHaveBeenCalledTimes(4)
})

it.skipIf(process.platform === 'win32')('rechecks after an in-place same-size rewrite with restored mtime, or a permission change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-contract-inplace-')); dirs.push(dir); selectionConfig(dir)
  const server = join(dir, 'plugins/cache/room/room/0.17.32/server'); mkdirSync(server, { recursive: true })
  const bundle = 'verified-executable'
  writeFileSync(join(server, 'room-mcp.mjs'), bundle)
  writeFileSync(join(server, 'compat.json'), JSON.stringify({ v: 1, release: '0.17.32', compat: CURRENT_COMPAT, workerRecordSchema: 1, bundleSha256: createHash('sha256').update(bundle).digest('hex') }))
  listing.mockReturnValue(JSON.stringify({ installed: [{ pluginId: 'room@room', version: '0.17.32', enabled: true }] }))
  const env = selectionEnv(dir)
  expect(installedCodexRoomContract(env)).toBeDefined()
  expect(listing).toHaveBeenCalledTimes(1)
  // Same inode, same size, mtime put back: only ctime records the rewrite.
  const before = statSync(join(server, 'room-mcp.mjs'))
  writeFileSync(join(server, 'room-mcp.mjs'), 'tampered-executable'.slice(0, bundle.length).padEnd(bundle.length, 'x'))
  utimesSync(join(server, 'room-mcp.mjs'), before.atime, before.mtime)
  expect(statSync(join(server, 'room-mcp.mjs')).ino).toBe(before.ino)
  expect(installedCodexRoomContract(env)).toBeUndefined()
  expect(listing).toHaveBeenCalledTimes(2)
  // An unreadable executable is never served from the cache.
  writeFileSync(join(server, 'room-mcp.mjs'), bundle)
  expect(installedCodexRoomContract(env)).toBeDefined()
  const calls = listing.mock.calls.length
  chmodSync(join(server, 'room-mcp.mjs'), 0o000)
  try { expect(installedCodexRoomContract(env)).toBeUndefined() } finally { chmodSync(join(server, 'room-mcp.mjs'), 0o644) }
  expect(listing.mock.calls.length).toBeGreaterThan(calls)
})

it.each(['compat.json', 'room-mcp.mjs'])('rechecks replaced %s evidence even with identical contents, size and mtime', file => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-contract-replace-')); dirs.push(dir); selectionConfig(dir)
  const server = join(dir, 'plugins/cache/room/room/0.17.32/server'); mkdirSync(server, { recursive: true })
  const bundle = 'verified-executable'
  const descriptor = JSON.stringify({ v: 1, release: '0.17.32', compat: CURRENT_COMPAT, workerRecordSchema: 1, bundleSha256: createHash('sha256').update(bundle).digest('hex') })
  writeFileSync(join(server, 'room-mcp.mjs'), bundle)
  writeFileSync(join(server, 'compat.json'), descriptor)
  const selected = { pluginId: 'room@room', version: '0.17.32', enabled: true }
  listing.mockReturnValue(JSON.stringify({ installed: [selected] }))
  const env = selectionEnv(dir)
  utimesSync(join(server, file), 1000, 1000)
  expect(installedCodexRoomContract(env)).toBeDefined()
  const before = statSync(join(server, file))
  writeFileSync(join(server, 'replacement'), file === 'compat.json' ? descriptor : bundle)
  utimesSync(join(server, 'replacement'), before.atime, before.mtime)
  renameSync(join(server, 'replacement'), join(server, file))
  const after = statSync(join(server, file))
  expect(after.size).toBe(before.size)
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect(after.ino).not.toBe(before.ino)
  // The selection is now ambiguous. Changed evidence must not fall back to the old verified contract.
  listing.mockReturnValue(JSON.stringify({ installed: [selected, selected] }))
  expect(installedCodexRoomContract(env)).toBeUndefined()
  expect(listing).toHaveBeenCalledTimes(2)
  listing.mockReturnValue(JSON.stringify({ installed: [{ ...selected, enabled: false }] }))
  expect(installedCodexRoomContract(env)).toBeUndefined()
  expect(listing).toHaveBeenCalledTimes(3)
})

it.each(['disabled', 'another version', 'ambiguous'])('invalidates cached selection when %s without changing the old executable', change => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-selection-')); dirs.push(dir); selectionConfig(dir)
  const install = (version: string) => {
    const server = join(dir, 'plugins/cache/room/room', version, 'server'); mkdirSync(server, { recursive: true })
    const bundle = `bundle-${version}`
    writeFileSync(join(server, 'room-mcp.mjs'), bundle)
    writeFileSync(join(server, 'compat.json'), JSON.stringify({ v: 1, release: version, compat: CURRENT_COMPAT,
      workerRecordSchema: 1, bundleSha256: createHash('sha256').update(bundle).digest('hex') }))
    return server
  }
  const old = install('0.17.40'), env = selectionEnv(dir)
  const row = { pluginId: 'room@room', version: '0.17.40', enabled: true }
  listing.mockReturnValue(JSON.stringify({ installed: [row] }))
  expect(installedCodexRoomContract(env)?.release).toBe('0.17.40')
  const before = ['room-mcp.mjs', 'compat.json'].map(file => statSync(join(old, file), { bigint: true }))
  if (change === 'disabled') {
    selectionConfig(dir, false)
    listing.mockReturnValue(JSON.stringify({ installed: [{ ...row, enabled: false }] }))
  } else if (change === 'another version') {
    install('0.17.41')
    listing.mockReturnValue(JSON.stringify({ installed: [{ ...row, version: '0.17.41' }] }))
  } else {
    writeFileSync(join(dir, 'config.toml'), '[plugins."room@room"]\nenabled = true\n# selection changed\n')
    listing.mockReturnValue(JSON.stringify({ installed: [row, row] }))
  }
  const result = installedCodexRoomContract(env)
  if (change === 'another version') expect(result?.release).toBe('0.17.41')
  else expect(result).toBeUndefined()
  expect(listing).toHaveBeenCalledTimes(2)
  for (const [i, file] of ['room-mcp.mjs', 'compat.json'].entries()) {
    const after = statSync(join(old, file), { bigint: true })
    expect([after.dev, after.ino, after.size, after.mtimeNs]).toEqual([before[i].dev, before[i].ino, before[i].size, before[i].mtimeNs])
  }
})

function verifiedFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'worker-selection-evidence-')); dirs.push(dir); selectionConfig(dir)
  const server = join(dir, 'plugins/cache/room/room/0.17.40/server'); mkdirSync(server, { recursive: true })
  writeFileSync(join(server, 'room-mcp.mjs'), 'bundle')
  writeFileSync(join(server, 'compat.json'), JSON.stringify({ v: 1, release: '0.17.40', compat: CURRENT_COMPAT,
    workerRecordSchema: 1, bundleSha256: createHash('sha256').update('bundle').digest('hex') }))
  const row = { pluginId: 'room@room', version: '0.17.40', enabled: true }, env = selectionEnv(dir)
  listing.mockReturnValue(JSON.stringify({ installed: [row] }))
  expect(installedCodexRoomContract(env)?.release).toBe(row.version)
  return { dir, env, row }
}

it.each(['config.toml', 'plugins/cache/room/room'])('never serves a cached contract with unreadable %s', file => {
  const { dir, env } = verifiedFixture()
  const access = fs.accessSync
  const denied = vi.spyOn(fs, 'accessSync').mockImplementation((target, mode) => {
    if (String(target) === join(dir, file)) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return access(target, mode)
  })
  try {
    listing.mockImplementation(() => { throw new Error('ETIMEDOUT') })
    expect(installedCodexRoomContract(env)).toBeUndefined()
    expect(listing).toHaveBeenCalledTimes(2)
  } finally { denied.mockRestore() }
})

it('does not cache a successful listing when selection evidence is missing', () => {
  const { dir, env, row } = verifiedFixture()
  rmSync(join(dir, 'config.toml'))
  expect(installedCodexRoomContract(env)?.release).toBe(row.version)
  listing.mockImplementation(() => { throw new Error('ETIMEDOUT') })
  expect(installedCodexRoomContract(env)).toBeUndefined()
  expect(listing).toHaveBeenCalledTimes(3)
})

it.each(['config', 'versions'])('refuses selection changes during the listing (%s)', change => {
  const { dir, env, row } = verifiedFixture()
  selectionConfig(dir, false) // Force a fresh verification.
  listing.mockImplementation(() => {
    if (change === 'config') selectionConfig(dir, true)
    else mkdirSync(join(dir, 'plugins/cache/room/room/0.17.41'))
    return JSON.stringify({ installed: [row] })
  })
  expect(installedCodexRoomContract(env)).toBeUndefined()
  expect(listing).toHaveBeenCalledTimes(2)
})

it('re-verifies when a project config is created after verification', () => {
  const { dir, env, row } = verifiedFixture()
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(dir, 'project'))
  try {
    expect(installedCodexRoomContract(env)?.release).toBe(row.version)
    mkdirSync(join(dir, 'project/.codex'), { recursive: true })
    writeFileSync(join(dir, 'project/.codex/config.toml'), '[plugins."room@room"]\nenabled = false\n')
    listing.mockReturnValue(JSON.stringify({ installed: [{ ...row, enabled: false }] }))
    expect(installedCodexRoomContract(env)).toBeUndefined()
    expect(listing).toHaveBeenCalledTimes(3)
  } finally { cwd.mockRestore() }
})
