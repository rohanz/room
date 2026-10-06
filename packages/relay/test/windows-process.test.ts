import { describe, expect, it, vi } from 'vitest'
import { createProcessProbe, parseWindowsProcessTable, probeProcess, readWindowsProcessTable, type ProcessReaders } from '../src/process.js'

const birth = '2026-10-06T01:23:45.1234567Z'
const row = { pid: 42, ppid: 12, creationDate: birth, name: 'ClAuDe.EXE' }
const readers = (output: string): ProcessReaders => ({ platform: 'win32', readFile: () => { throw Error('no proc') }, readLink: () => '', exec: vi.fn(() => output) })

describe('Windows process identity (offline CIM fixtures)', () => {
  it('preserves submillisecond birth precision and normalizes Windows executable basenames', () => {
    const table = parseWindowsProcessTable('\uFEFF' + JSON.stringify([row, { ...row, pid: 43, name: 'C:\\Program Files\\NodeJS\\NODE.exe' }]))
    expect(table.get(42)).toEqual({ ppid: 12, startTime: `windows:${birth}`, executable: 'claude' })
    expect(table.get(43)?.executable).toBe('node')
    expect(parseWindowsProcessTable(JSON.stringify(row)).get(42)).toEqual(table.get(42))
  })
  it('rejects malformed records and retains partial identity without inventing a birth', () => {
    expect(parseWindowsProcessTable('not json').size).toBe(0)
    expect(parseWindowsProcessTable(JSON.stringify([{ ...row, pid: -1 }, { ...row, pid: '42' }, { ...row, pid: 1.5 }])).size).toBe(0)
    expect(parseWindowsProcessTable(JSON.stringify({ ...row, creationDate: 'yesterday', name: null })).get(42)).toEqual({ ppid: 12, startTime: undefined, executable: undefined })
    expect(parseWindowsProcessTable(JSON.stringify({ ...row, creationDate: '2026-02-30T01:23:45.1234567Z' })).get(42)?.startTime).toBeUndefined()
  })
  it('probes only the requested PID with bounded noninteractive PowerShell and no command-line/environment query', () => {
    const r = readers(JSON.stringify(row))
    expect(probeProcess(42, r)).toEqual({ startTime: `windows:${birth}`, executable: 'claude' })
    const [file, args, options] = vi.mocked(r.exec).mock.calls[0]
    expect(file).toBe('powershell.exe')
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']))
    expect(args.at(-1)).toContain('ProcessId = 42')
    expect(args.at(-1)).not.toMatch(/CommandLine|Environment|ExecutionPolicy/i)
    expect(options).toMatchObject({ timeout: 3000, maxBuffer: 8 * 1024 * 1024 })
    expect(readWindowsProcessTable(r, -1).size).toBe(0)
    expect(vi.mocked(r.exec).mock.calls).toHaveLength(1)
  })
  it('caches Windows probes but refreshes identity for signalling and a reused PID', () => {
    let now = 0, output = JSON.stringify(row)
    const r = { ...readers(output), exec: vi.fn(() => output), alive: () => true }
    const p = createProcessProbe(r, { now: () => now, wall: () => Date.parse(birth) + 60_000 })
    for (let n = 0; n < 100; n++) expect(p(42)?.startTime).toBe(`windows:${birth}`)
    expect(r.exec).toHaveBeenCalledTimes(1)
    output = JSON.stringify({ ...row, creationDate: '2026-10-06T01:23:45.1234568Z' })
    expect(p.fresh(42)?.startTime).not.toBe(`windows:${birth}`)
    now = 2500
    p(42)
    expect(r.exec).toHaveBeenCalledTimes(3)
  })
  it('briefly caches an unreadable Windows identity and retries without accepting it as ownership', () => {
    let now = 0
    const r = { ...readers(''), exec: vi.fn(() => { throw Error('PowerShell denied') }), alive: () => true }
    const p = createProcessProbe(r, { now: () => now })
    for (let n = 0; n < 100; n++) expect(p(process.pid)).toEqual({})
    expect(r.exec).toHaveBeenCalledTimes(1)
    now += 250
    expect(p(process.pid)).toEqual({})
    expect(r.exec).toHaveBeenCalledTimes(2)
    expect(p.fresh(process.pid)).toEqual({})
    expect(r.exec).toHaveBeenCalledTimes(3)
  })
  it('does not bind an unrelated row to the PID requested', () => {
    expect(probeProcess(process.pid, readers(JSON.stringify(row)))).toEqual({})
  })
})
