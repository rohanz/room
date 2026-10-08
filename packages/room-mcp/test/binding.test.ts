import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../src/worker-process.js', () => ({ probeProcess: (pid: number) => ({ pid, startTime: 'birth', executable: 'codex' }) }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn((file, args, options) => file === 'ps' ? 'codex app-server --managed-daemon' : actual.execFileSync(file, args, options)) }
})
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
async function binding(log?: (line: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-thread-binding-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', dir])
  const { createSessionBinding } = await import('../src/binding.js')
  return createSessionBinding(dir, { ROOM_HOST: 'codex' }, () => 0, { log })
}

it('admits a daemon thread immediately in every binding, even after an unbound result was cached', async () => {
  vi.resetModules()
  const b = await binding()
  const other = await binding()
  expect(other.bound()).toBeUndefined()
  expect(b.bound()).toBeUndefined()
  b.admitCodexThread('01a119cb-010e-7883-a11e-04bf44b77f04')
  expect(b.bound()).toEqual({ id: '01a119cb-010e-7883-a11e-04bf44b77f04', host: 'codex' })
  expect(other.bound()).toEqual(b.bound())
  expect(b.id()).toBe('01a119cb-010e-7883-a11e-04bf44b77f04')
  const { sessionDirectory } = await import('../src/session.js')
  expect(b.dir()).toBe(sessionDirectory(b.commonDir()!, b.id()))
})

it('rejects invalid ids and pins the first valid id, logging each distinct conflict once', async () => {
  vi.resetModules()
  const log = vi.fn()
  const b = await binding(log)
  for (const id of ['', '../foreign', 'a_b', 'a'.repeat(129), 'thread\n']) b.admitCodexThread(id)
  expect(b.bound()).toBeUndefined()
  b.admitCodexThread('first-thread')
  b.admitCodexThread('first-thread')
  expect(log).not.toHaveBeenCalled()
  b.admitCodexThread('second-thread')
  b.admitCodexThread('third-thread')
  b.admitCodexThread('second-thread')
  b.admitCodexThread('third-thread')
  expect(b.bound()).toEqual({ id: 'first-thread', host: 'codex' })
  expect(log).toHaveBeenCalledTimes(2)
  expect(log.mock.calls[0][0]).toContain('second-thread')
  expect(log.mock.calls[1][0]).toContain('third-thread')
})

it('bounds the distinct conflict log to 32 ids', async () => {
  vi.resetModules()
  const log = vi.fn()
  const b = await binding(log)
  b.admitCodexThread('first-thread')
  for (let i = 0; i < 40; i++) b.admitCodexThread(`conflict-${i}`)
  expect(log).toHaveBeenCalledTimes(32)
  expect(b.bound()).toEqual({ id: 'first-thread', host: 'codex' })
})
