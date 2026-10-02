// rc11 all-Codex rehearsal R4: with eight workers, a lead's MCP spent 120 of 316 s blocked in synchronous `ps` and
// `sysctl` (three per macOS probe), probing every worker on every status read; room_state took up to 17 s.
import { describe, expect, it } from 'vitest'
import { createProcessProbe, type ProcessReaders } from '../src/process.js'

const LSTART = 'Thu Oct  2 09:00:00 2026' // 1790931600 s
const START_S = Date.UTC(2026, 9, 2, 9, 0, 0) / 1000

function darwin(alive: Set<number>, names: Map<number, string>) {
  const calls: string[] = []
  const readers: ProcessReaders & { alive(pid: number): boolean } = {
    platform: 'darwin',
    readFile() { throw new Error('no /proc on macOS') },
    readLink() { throw new Error('no /proc on macOS') },
    exec(file, args) {
      calls.push(`${file} ${args.join(' ')}`)
      if (file === 'sysctl') return '{ sec = 1789781721, usec = 0 } Thu Sep 19 09:00:00 2026\n'
      const pid = Number(args.at(-1))
      if (!alive.has(pid)) throw new Error('no such process')
      return args[1] === 'lstart=' ? `${LSTART}\n` : `${names.get(pid) ?? 'codex'}\n`
    },
    alive: pid => alive.has(pid),
  }
  return { readers, calls }
}

describe('the cached process probe', () => {
  it('probes a settled live process at most once per interval, however many callers ask', () => {
    let now = (START_S + 60) * 1000
    const { readers, calls } = darwin(new Set([42]), new Map())
    const probe = createProcessProbe(readers, { now: () => now })
    for (let i = 0; i < 500; i++) expect(probe(42)).toEqual({ startTime: `darwin:1789781721:${START_S}`, executable: 'codex' })
    expect(calls.filter(c => c.startsWith('ps '))).toHaveLength(2)
    expect(calls.filter(c => c.startsWith('sysctl'))).toHaveLength(1)
    now += 2_500
    probe(42)
    expect(calls.filter(c => c.startsWith('ps '))).toHaveLength(4)
  })

  it('answers dead at once, without a cached identity', () => {
    const alive = new Set([42])
    const { readers } = darwin(alive, new Map())
    const probe = createProcessProbe(readers, { now: () => (START_S + 60) * 1000 })
    expect(probe(42)).toBeDefined()
    alive.delete(42)
    expect(probe(42)).toBeUndefined()
  })

  it('rereads a process young enough to still exec into its host after a quarter second', () => {
    let now = (START_S + 1) * 1000
    const names = new Map([[42, 'nice']])
    const { readers, calls } = darwin(new Set([42]), names)
    const probe = createProcessProbe(readers, { now: () => now })
    for (let i = 0; i < 100; i++) expect(probe(42)?.executable).toBe('nice')
    names.set(42, 'codex')
    now += 250
    expect(probe(42)?.executable).toBe('codex')
    expect(calls.filter(c => c.startsWith('ps '))).toHaveLength(4)
  })
})

describe('reading a process no earlier than its recorded start', () => {
  it('rereads when the cached read predates the recorded process, then trusts the newer read', () => {
    let now = (START_S + 60) * 1000
    const { readers, calls } = darwin(new Set([42]), new Map())
    const probe = createProcessProbe(readers, { now: () => now })
    probe(42)
    const ps = () => calls.filter(c => c.startsWith('ps ')).length
    expect(ps()).toBe(2)
    // A process recorded as starting after that read (a reused pid) cannot be described by it.
    now = (START_S + 61.5) * 1000
    probe.readSince(42, `darwin:1789781721:${START_S + 61}`)
    expect(ps()).toBe(4)
    // Within a second of its start a read may still be of the predecessor: read again once later.
    now = (START_S + 62.5) * 1000
    probe.readSince(42, `darwin:1789781721:${START_S + 61}`)
    expect(ps()).toBe(6)
    now += 500
    for (let i = 0; i < 100; i++) probe.readSince(42, `darwin:1789781721:${START_S + 61}`)
    expect(ps()).toBe(6)
  })

  it('trusts a cached read made after the recorded start, however often a mismatch is confirmed', () => {
    const { readers, calls } = darwin(new Set([42]), new Map([[42, 'node']]))
    const probe = createProcessProbe(readers, { now: () => (START_S + 60) * 1000 })
    probe(42)
    // A record taken before its shell exec'd (executable "sh") mismatches every read; that alone costs no ps.
    for (let i = 0; i < 100; i++) expect(probe.readSince(42, `darwin:1789781721:${START_S}`)?.executable).toBe('node')
    expect(calls.filter(c => c.startsWith('ps '))).toHaveLength(2)
  })
})
