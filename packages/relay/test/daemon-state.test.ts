import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WriterIdleClock, ensureLocalDaemon } from '../src/daemon.js'
import { MemoryLoadError, RoomMemory, memoryFile } from '../src/memory.js'
import { checkWindowsAcl } from '../src/private-state.js'
import { CURRENT_COMPAT, LEGACY_COMPAT, selectContract } from '@room/hub-core'

const dirs: string[] = [], memories: RoomMemory[] = []
afterEach(() => { vi.restoreAllMocks(); for (const m of memories.splice(0)) { m.detach(); m.doc.destroy() }; vi.useRealTimers(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function memory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-daemon-state-')); dirs.push(dir); const memory = new RoomMemory(dir, 'local/test', () => {}); memories.push(memory); return { dir, memory } }
it('uses exactly five minutes with no writer and resets only on the last writer departure', () => {
  let now = 0
  const clock = new WriterIdleClock(() => now)
  now = 299999; expect(clock.expired()).toBe(false)
  now++; expect(clock.expired()).toBe(true)
  clock.changed(1); now += 900000; expect(clock.expired()).toBe(false)
  clock.changed(2); clock.changed(1); expect(clock.expired()).toBe(false)
  clock.changed(0); now += 299999; expect(clock.expired()).toBe(false)
  clock.changed(0); now++; expect(clock.expired()).toBe(true)
})
it('retries I/O failures without new traffic and exposes dirty versus saved generations', () => {
  vi.useFakeTimers()
  const { dir, memory: m } = memory()
  m.doc.getMap('meta').set('saved', 'first'); expect(m.save()).toBeUndefined()
  const saved = m.status.savedGeneration
  const rename = fs.renameSync
  let full = true
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (full) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); rename(from, to) })
  m.doc.getMap('meta').set('saved', 'second')
  expect(m.save()).toMatch(/ENOSPC/)
  expect(m.status).toMatchObject({ io: 'ENOSPC', savedGeneration: saved, dirtyGeneration: saved + 1 })
  expect(m.status.capacity).toBeUndefined()
  full = false
  vi.advanceTimersByTime(1000)
  expect(m.status.savedGeneration).toBe(m.status.dirtyGeneration)
  expect(m.status.io).toBeUndefined()
  expect(fs.existsSync(memoryFile(dir, 'local/test'))).toBe(true)
})
it('names a fail-closed snapshot load error rather than creating a replacement', () => {
  const { dir, memory: m } = memory(); m.detach(); m.doc.destroy(); memories.pop()
  const file = memoryFile(dir, 'local/test'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Uint8Array.of(255))
  expect(() => new RoomMemory(dir, 'local/test', () => {})).toThrow(MemoryLoadError)
  expect(fs.readFileSync(file)).toEqual(Buffer.from([255]))
})
it('requires the explicit daemon lifecycle contract, leaving the legacy baseline unchanged', () => {
  const daemon = { ...CURRENT_COMPAT, capabilities: { ...CURRENT_COMPAT.capabilities, 'room.daemon': [1] } }
  const policy = { activeSchema: 2, requiredCapabilities: { 'room.daemon': [1] } }
  expect(selectContract(LEGACY_COMPAT, daemon, policy).ok).toBe(false)
  const selected = selectContract(daemon, daemon, policy)
  expect(selected.ok && selected.selection.capabilities['room.daemon']).toBe(1)
  expect(CURRENT_COMPAT.capabilities['room.daemon']).toBeUndefined()
})
it('accepts only the private native Windows owner and protected effective DACL', () => {
  const privateAcl = { owner: 'S-1-user', user: 'S-1-user', protected: true, grants: ['S-1-user', 'S-1-5-18', 'S-1-5-32-544'] }
  expect(() => checkWindowsAcl(privateAcl, 'state')).not.toThrow()
  // An elevated administrator's files are owned by BUILTIN\\Administrators on Windows Server: ownership alone grants no access.
  expect(() => checkWindowsAcl({ ...privateAcl, owner: 'S-1-5-32-544' }, 'state')).not.toThrow()
  // A file inheriting from its protected Room directory is private when its effective grants are; a directory must be protected.
  expect(() => checkWindowsAcl({ ...privateAcl, protected: false, directory: false }, 'state')).not.toThrow()
  expect(() => checkWindowsAcl({ ...privateAcl, protected: false, directory: true }, 'state')).toThrow(/not private/)
  for (const report of [{ ...privateAcl, owner: 'other' }, { ...privateAcl, protected: false }, { ...privateAcl, grants: [...privateAcl.grants, 'S-1-1-0'] }]) expect(() => checkWindowsAcl(report, 'state')).toThrow(/not private/)
})

it('malformed discovery blocks launch without echoing private discovery contents', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-daemon-invalid-')); dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'room'), { mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'room/relay.json'), 'PRIVATE-CLONE-KEY malformed', { mode: 0o600 })
  await expect(ensureLocalDaemon(dir, 'local/test')).rejects.toThrow(/preserve and repair/)
  await expect(ensureLocalDaemon(dir, 'local/test')).rejects.not.toThrow(/PRIVATE-CLONE-KEY/)
})

it('initializes the private root idempotently before any client/preflight/daemon writer', async () => {
  const { privateStateDirectory, verifyPrivatePath } = await import('../src/private-state.js')
  const { writeAtomic } = await import('../src/leases.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-private-root-')); dirs.push(dir)
  const state = path.join(dir, 'room')
  // Preflight creates the root and writes first; a later daemon validates the same root.
  privateStateDirectory(state)
  writeAtomic(path.join(state, 'daemon-cutover.json'), { v: 1 })
  privateStateDirectory(state)
  verifyPrivatePath(state)
  expect(fs.readFileSync(path.join(state, 'daemon-cutover.json'), 'utf8')).toContain('"v":1')
  const other = path.join(dir, 'client-first')
  privateStateDirectory(other); privateStateDirectory(other); verifyPrivatePath(other)
})

it.each([new Error('EACCES retained leases'), [{ name: 'invalid' }]])('strict authority startup refuses unreadable/invalid leases; permissive hosts retain prior behavior (%j)', async evidence => {
  const { startHub } = await import('@room/hub-core')
  const { RoomDoc } = await import('@room/shared')
  const read = async () => { if (evidence instanceof Error) throw evidence; return evidence as never }
  const write = vi.fn(async () => {})
  for (const strict of [true, false]) {
    const doc = new RoomDoc()
    const work = startHub({ doc, mono: () => 0, wall: () => 10000, store: { advance: async floor => floor }, leases: { read, write }, requireLeaseLoad: strict, log: () => {} })
    if (strict) await expect(work).rejects.toThrow(/authority lease recovery failed/)
    else (await work).stop()
    doc.doc.destroy()
  }
  expect(write).not.toHaveBeenCalled()
})

it('an atomic writer creating Room state first uses the same initializer, and unsafe existing state stays refused', async () => {
  const { writeAtomic } = await import('../src/leases.js')
  const { privateStateDirectory } = await import('../src/private-state.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-atomic-private-')); dirs.push(dir)
  const state = path.join(dir, 'room')
  writeAtomic(path.join(state, 'sessions', 'first', 'record.json'), { v: 1 })
  expect(() => privateStateDirectory(state)).not.toThrow()
  const link = path.join(dir, 'linked-state'); fs.symlinkSync(state, link, 'junction')
  expect(() => privateStateDirectory(link)).toThrow()
  if (process.platform !== 'win32') {
    fs.chmodSync(state, 0o755)
    expect(() => privateStateDirectory(state)).not.toThrow()
    expect(fs.statSync(state).mode & 0o777).toBe(0o700)
  }
})
