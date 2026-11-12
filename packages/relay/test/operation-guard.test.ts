import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { withGuardAsyncOperation, type InstanceToken } from '../src/leases.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function file() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-operation-guard-')); roots.push(root); return path.join(root, 'operation') }
const holder: InstanceToken = { pid: process.pid, startTime: 'birth', executable: 'node', sessionId: 'session', nonce: 'holder' }

it.each(['alive', 'unknown', 'malformed', 'null'] as const)('times out without writing or stealing from a %s holder', async state => {
  const target = file(), guard = `${target}.guard`
  const content = state === 'malformed' ? '{' : state === 'null' ? 'null' : JSON.stringify(holder)
  fs.writeFileSync(guard, content)
  const open = vi.spyOn(fs.promises, 'open'), link = vi.spyOn(fs.promises, 'link'), unlink = vi.spyOn(fs.promises, 'unlink')
  const callback = vi.fn()
  const start = performance.now()
  await expect(withGuardAsyncOperation(target, callback, { timeoutMs: 160,
    probe: () => state === 'alive' ? holder : { pid: process.pid, startTime: '', executable: '' },
  })).rejects.toThrow(`timed out acquiring lease guard ${guard}; holder pid ${state === 'malformed' || state === 'null' ? 'unknown' : process.pid}`)
  expect(performance.now() - start).toBeGreaterThanOrEqual(150)
  expect(callback).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled(); expect(link).not.toHaveBeenCalled(); expect(unlink).not.toHaveBeenCalled()
  expect(fs.readFileSync(guard, 'utf8')).toBe(content)
})

it('releases after an awaited callback fails and uses no synchronous fsync even for a missing directory', async () => {
  const target = path.join(path.dirname(file()), 'room', 'operation')
  const sync = vi.spyOn(fs, 'fsyncSync')
  await expect(withGuardAsyncOperation(target, async () => { await Promise.resolve(); throw new Error('operation failed') }, { timeoutMs: 1000 })).rejects.toThrow('operation failed')
  expect(sync).not.toHaveBeenCalled()
  expect(fs.existsSync(`${target}.guard`)).toBe(false)
  expect(await withGuardAsyncOperation(target, async () => 42, { timeoutMs: 1000 })).toBe(42)
})

it('also polls a live recovery guard read-only while the primary holder is dead', async () => {
  const target = file(), dead = { ...holder, pid: 999_999_999 }
  fs.writeFileSync(`${target}.guard`, JSON.stringify(dead))
  fs.writeFileSync(`${target}.guard.guard`, JSON.stringify(holder))
  const open = vi.spyOn(fs.promises, 'open'), unlink = vi.spyOn(fs.promises, 'unlink')
  await expect(withGuardAsyncOperation(target, () => 'unexpected', { timeoutMs: 160,
    probe: pid => pid === holder.pid ? holder : undefined,
  })).rejects.toThrow('timed out acquiring lease guard')
  expect(open).not.toHaveBeenCalled(); expect(unlink).not.toHaveBeenCalled()
  expect(JSON.parse(fs.readFileSync(`${target}.guard`, 'utf8'))).toEqual(dead)
})
