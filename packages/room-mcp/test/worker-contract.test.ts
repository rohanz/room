import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { CURRENT_COMPAT } from '@room/hub-core'
const { listing } = vi.hoisted(() => ({ listing: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: listing }))
import { installedCodexRoomContract } from '../src/worker-config.js'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks() })
it('reads only the selected install and verifies its executable digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-contract-')); dirs.push(dir)
  const server = join(dir, 'plugins/cache/room/room/0.17.32/server'); mkdirSync(server, { recursive: true })
  const bundle = 'actual-executable'
  const descriptor = { v: 1, release: '0.17.32', compat: CURRENT_COMPAT, workerRecordSchema: 1, bundleSha256: createHash('sha256').update(bundle).digest('hex') }
  writeFileSync(join(server, 'room-mcp.mjs'), bundle); writeFileSync(join(server, 'compat.json'), JSON.stringify(descriptor))
  // A larger cache directory is not proof of the selected executable.
  mkdirSync(join(dir, 'plugins/cache/room/room/99.0.0/.codex-plugin'), { recursive: true })
  listing.mockReturnValue(JSON.stringify({ installed: [{ pluginId: 'room@room', version: '0.17.32' }] }))
  expect(installedCodexRoomContract({ CODEX_HOME: dir })).toMatchObject({ release: '0.17.32', workerRecordSchema: 1 })
  writeFileSync(join(server, 'room-mcp.mjs'), 'updated while lead alive')
  expect(installedCodexRoomContract({ CODEX_HOME: dir })).toBeUndefined()
  expect(listing.mock.calls[0][1]).toEqual(['plugin', 'list', '--json'])
})
it('keeps unknown, disabled, ambiguous and missing descriptors unverified', () => {
  listing.mockImplementation(() => { throw new Error('timeout') })
  expect(installedCodexRoomContract({})).toBeUndefined()
  listing.mockReturnValue(JSON.stringify({ installed: [{ pluginId: 'room@room', version: '99.0.0', enabled: false }] }))
  expect(installedCodexRoomContract({})).toBeUndefined()
  listing.mockReturnValue(JSON.stringify({ installed: [{ pluginId: 'room@room', version: '../outside' }] }))
  expect(installedCodexRoomContract({})).toBeUndefined()
})

it('authenticates every v2 executable and refuses omission, mutation and descriptor downgrade', async () => {
  const { EXECUTABLE_BUNDLES } = await import('../src/hosts/codex-install.js')
  const dir = mkdtempSync(join(tmpdir(), 'worker-contract-v2-')); dirs.push(dir)
  const server = join(dir, 'plugins/cache/room/room/0.17.32/server'); mkdirSync(server, { recursive: true })
  const hashes = Object.fromEntries(EXECUTABLE_BUNDLES.map(name => {
    writeFileSync(join(server, name), name)
    return [name, createHash('sha256').update(name).digest('hex')]
  }))
  const descriptor = { v: 2, release: '0.17.32', compat: CURRENT_COMPAT, workerRecordSchema: 1, bundleSha256: hashes }
  const write = (value: unknown) => writeFileSync(join(server, 'compat.json'), JSON.stringify(value))
  listing.mockReturnValue(JSON.stringify({ installed: [{ pluginId: 'room@room', version: '0.17.32' }] }))
  write(descriptor)
  expect(installedCodexRoomContract({ CODEX_HOME: dir })).toMatchObject({ release: '0.17.32' })
  for (const name of EXECUTABLE_BUNDLES) {
    writeFileSync(join(server, name), 'tampered')
    expect(installedCodexRoomContract({ CODEX_HOME: dir }), name).toBeUndefined()
    writeFileSync(join(server, name), name)
    const omitted = { ...hashes }; delete omitted[name]
    write({ ...descriptor, bundleSha256: omitted })
    expect(installedCodexRoomContract({ CODEX_HOME: dir }), name).toBeUndefined()
    write(descriptor)
  }
  write({ ...descriptor, v: 1, bundleSha256: hashes['room-mcp.mjs'] })
  expect(installedCodexRoomContract({ CODEX_HOME: dir })).toBeUndefined()
})
