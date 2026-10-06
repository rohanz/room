import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseWindowsProcessTable, probeProcess } from '@room/relay/process'
import { quiesceWorktreeProcesses, signalWorker, workerProcessOwnership } from '../src/worker-process.js'

const cwdFixture = vi.hoisted(() => ({ enabled: false }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
    if (cwdFixture.enabled) return ''
    return actual.execFileSync(...args)
  } }
})

const birth = '2026-10-06T01:23:45.1234567Z'
const hooks = () => import(/* @vite-ignore */ pathToFileURL(path.resolve(__dirname, '../../../plugins/room/hooks/common.mjs')).href)

describe('Windows worker safety (offline fixtures)', () => {
  it('normalizes .exe names only for Windows identities and requires the recorded birth', () => {
    const w = { host: 'claude' as const, processStartTime: `windows:${birth}` }
    expect(workerProcessOwnership(42, w, () => ({ startTime: w.processStartTime, executable: 'C:\\Tools\\ClAuDe.EXE' }))).toBe('ours')
    expect(workerProcessOwnership(42, w, () => ({ startTime: w.processStartTime, executable: 'node.exe' }))).toBe('ours')
    expect(workerProcessOwnership(42, w, () => ({ startTime: w.processStartTime + 'reused', executable: 'claude.exe' }))).toBe('not-ours')
    expect(workerProcessOwnership(42, w, () => ({ executable: 'claude.exe' }))).toBe('unknown')
    expect(workerProcessOwnership(42, w, () => ({ startTime: w.processStartTime, executable: 'claude.exe.other' }))).toBe('not-ours')
    expect(workerProcessOwnership(42, { ...w, processStartTime: 'linux:boot:1' }, () => ({ startTime: 'linux:boot:1', executable: 'claude.exe' }))).toBe('not-ours')
  })
  it('keeps hook ancestor identities identical to runtime probes, terminates ancestor cycles', async () => {
    const { processChain } = await hooks()
    const output = JSON.stringify([
      { pid: 42, ppid: 12, creationDate: birth, name: 'CLAUDE.exe' },
      { pid: 12, ppid: 42, creationDate: birth, name: 'NODE.exe' },
    ])
    const exec = vi.fn((_file: string, _args: string[], _options?: { timeout: number; maxBuffer: number }) => output)
    const r = { platform: 'win32' as const, readFile: () => '', readLink: () => '', readDir: () => [], exec }
    expect(processChain(42, 8, r)).toEqual([
      { pid: 42, startTime: `windows:${birth}`, executable: 'claude' },
      { pid: 12, startTime: `windows:${birth}`, executable: 'node' },
    ])
    const runtime = parseWindowsProcessTable(output).get(42)!
    expect(probeProcess(42, r)).toEqual({ startTime: runtime.startTime, executable: runtime.executable })
    expect(exec.mock.calls[0][2]).toMatchObject({ timeout: 3000, maxBuffer: 8 * 1024 * 1024 })
  })
  it('does not bind a reused parent PID born after the child', async () => {
    const { processChain } = await hooks()
    const r = { platform: 'win32', exec: () => JSON.stringify([
      { pid: 42, ppid: 12, creationDate: birth, name: 'node.exe' },
      { pid: 12, ppid: 1, creationDate: '2026-10-06T01:23:45.1234568Z', name: 'claude.exe' },
    ]) }
    expect(processChain(42, 8, r)).toEqual([{ pid: 42, startTime: `windows:${birth}`, executable: 'node' }])
  })
  it('keeps hook and runtime parsers/query generation equal for malformed and partial tables', async () => {
    const { parseWindowsProcessTable: hookParse, readWindowsProcessTable: hookRead } = await hooks()
    for (const data of ['no json', 'null', '{}', JSON.stringify({ pid: 42, ppid: 1, creationDate: null, name: null }),
      JSON.stringify({ pid: 42, ppid: 1, creationDate: '2026-02-30T01:23:45.1234567Z', name: 'NODE.exe' })]) {
      expect(hookParse(data)).toEqual(parseWindowsProcessTable(data))
    }
    const runtimeCalls: unknown[] = [], hookCalls: unknown[] = []
    const { readWindowsProcessTable } = await import('@room/relay/process')
    readWindowsProcessTable({ exec: (...args) => { runtimeCalls.push(args); return '[]' } }, 42)
    hookRead({ exec: (...args: unknown[]) => { hookCalls.push(args); return '[]' } }, 42)
    expect(hookCalls).toEqual(runtimeCalls)
  })
  it('refuses unknown/reused PID signals while permitting the verified worker PID without cwd guessing', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const w = { host: 'claude' as const, processStartTime: `windows:${birth}` }
    try {
      expect(signalWorker(42, 'SIGTERM', undefined, undefined, w, () => ({}))).toBe(false)
      expect(signalWorker(42, 'SIGTERM', undefined, undefined, w, () => ({ startTime: 'windows:2026-10-06T01:23:45.1234568Z', executable: 'claude' }))).toBe(false)
      expect(kill).not.toHaveBeenCalled()
      expect(signalWorker(42, 'SIGTERM', undefined, undefined, w, () => ({ startTime: w.processStartTime, executable: 'CLAUDE.EXE' }))).toBe(true)
      expect(kill).toHaveBeenCalledExactlyOnceWith(42, 'SIGTERM')
    } finally { kill.mockRestore() }
  })
  it('fails closed when Windows cannot enumerate worktree cwd; refuses cwd-based PID signals', async () => {
    // Passing win32 is an offline simulation of the unsupported OS cwd contract.
    cwdFixture.enabled = true
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      expect(await quiesceWorktreeProcesses(process.cwd(), 'win32')).toBe(false)
      expect(signalWorker(42, 'SIGTERM', process.cwd(), () => [], { host: 'claude', processStartTime: `windows:${birth}` }, () => ({ startTime: `windows:${birth}`, executable: 'claude' }))).toBe(false)
      expect(kill).not.toHaveBeenCalled()
    } finally { cwdFixture.enabled = false; kill.mockRestore() }
  })
})
