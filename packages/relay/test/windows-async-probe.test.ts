// A Windows user saw `host session ended` a minute after joining: synchronous PowerShell identity reads from the
// 30 s presence tick and status reads blocked the event loop for seconds and timed out on a slow machine. A cache
// miss now answers unreadable at once and reads in the background; only `fresh` and `confirm` read synchronously.
import { describe, expect, it, vi } from 'vitest'
import { createProcessProbe, type ProcessReaders } from '../src/process.js'

const birth = '2026-10-06T01:23:45.1234567Z'
const row = (pid: number) => JSON.stringify({ pid, ppid: 12, creationDate: birth, name: 'codex.exe' })
const identity = { startTime: `windows:${birth}`, executable: 'codex' }

function windows(alive = new Set([42, 43, 44, 45, 46, 47])) {
  const pending: { pid: number; options: { timeout: number; maxBuffer: number }; done: (error: Error | null, stdout: string) => void }[] = []
  const readers: ProcessReaders & { alive(pid: number): boolean } = {
    platform: 'win32',
    readFile() { throw new Error('no /proc on Windows') },
    readLink() { throw new Error('no /proc on Windows') },
    exec: vi.fn((_file: string, args: string[]) => row(Number(/ProcessId = (\d+)/.exec(args.at(-1)!)![1]))),
    execAsync: vi.fn((_file, args, options, done) => { pending.push({ pid: Number(/ProcessId = (\d+)/.exec(args.at(-1)!)![1]), options, done }) }),
    alive: pid => alive.has(pid),
  }
  const complete = (index = 0, stdout?: string, error: Error | null = null) => {
    const [read] = pending.splice(index, 1)
    read.done(error, stdout ?? row(read.pid))
  }
  return { readers, pending, complete, alive }
}

describe('the Windows cached probe reads in the background', () => {
  it('answers a miss as pending at once and fills the cache when the read completes', async () => {
    const { readers, pending, complete } = windows()
    const probe = createProcessProbe(readers, { now: () => 0, wall: () => Date.parse(birth) + 60_000 })
    expect(probe(42)).toEqual({ pending: true })
    expect(readers.exec).not.toHaveBeenCalled()
    expect(pending).toHaveLength(1)
    expect(pending[0].options).toEqual({ timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })
    const read = probe.read(42)
    complete()
    await expect(read).resolves.toEqual(identity)
    expect(probe(42)).toEqual(identity)
    expect(readers.execAsync).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent requests for a pid into one read and bounds reads in flight', async () => {
    const { readers, pending, complete } = windows()
    const probe = createProcessProbe(readers, { now: () => 0, wall: () => Date.parse(birth) + 60_000 })
    const waits = [probe.read(42), probe.read(42)]
    for (let n = 0; n < 50; n++) probe(42)
    expect(pending).toHaveLength(1)
    for (const pid of [43, 44, 45, 46, 47]) probe(pid)
    expect(pending.map(read => read.pid)).toEqual([42, 43, 44, 45])
    // Beyond the bound a miss stays unreadable without starting a read.
    await expect(probe.read(47)).resolves.toEqual({})
    complete()
    await expect(Promise.all(waits)).resolves.toEqual([identity, identity])
    probe(47)
    expect(pending.map(read => read.pid)).toEqual([43, 44, 45, 47])
  })

  it('treats a timed-out or failed read as unreadable, never as death, and retries after the short TTL', async () => {
    let now = 0
    const { readers, complete } = windows()
    const probe = createProcessProbe(readers, { now: () => now })
    const read = probe.read(42)
    complete(0, '', Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }))
    await expect(read).resolves.toEqual({})
    expect(probe(42)).toEqual({})
    now += 250
    expect(probe(42)).toEqual({ pending: true })
    expect(readers.execAsync).toHaveBeenCalledTimes(2)
  })

  it('answers a pid that exits during the read as gone, and a gone pid at once', async () => {
    const { readers, complete, alive } = windows()
    const probe = createProcessProbe(readers, { now: () => 0 })
    const read = probe.read(42)
    alive.delete(42)
    complete(0, '[]')
    await expect(read).resolves.toBeUndefined()
    expect(probe(42)).toBeUndefined()
    expect(readers.execAsync).toHaveBeenCalledTimes(1)
  })

  it('treats a reader that throws as unreadable', async () => {
    const { readers } = windows()
    readers.execAsync = vi.fn(() => { throw new Error('spawn EPERM') })
    const probe = createProcessProbe(readers, { now: () => 0 })
    expect(probe(42)).toEqual({ pending: true })
    await expect(probe.read(42)).resolves.toEqual({})
  })

  it('keeps fresh and confirm synchronous and definitive, with the 10 s limit', () => {
    const { readers, pending } = windows()
    const probe = createProcessProbe(readers, { now: () => 0, wall: () => Date.parse(birth) + 60_000 })
    expect(probe.fresh(42)).toEqual(identity)
    expect(vi.mocked(readers.exec).mock.calls[0][2]).toMatchObject({ timeout: 10_000 })
    expect(probe.confirm(43, { startTime: `windows:${birth}`, executable: 'claude' })).toEqual(identity)
    expect(readers.exec).toHaveBeenCalledTimes(2)
    expect(pending).toHaveLength(0)
  })

  it('never replaces a fresh read with an older background result', async () => {
    let output = row(42)
    const { readers, complete } = windows()
    readers.exec = vi.fn(() => output)
    const probe = createProcessProbe(readers, { now: () => 0, wall: () => Date.parse(birth) + 60_000 })
    const read = probe.read(42)
    output = JSON.stringify({ pid: 42, ppid: 12, creationDate: birth, name: 'claude.exe' })
    expect(probe.fresh(42)?.executable).toBe('claude')
    complete()
    await expect(read).resolves.toMatchObject({ executable: 'claude' })
    expect(probe(42)?.executable).toBe('claude')
  })
})
