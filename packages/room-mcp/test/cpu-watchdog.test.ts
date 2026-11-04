import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CpuWatchdog, formatProcessHealth, topSelfFrames, writeCpuProfile, type CpuProfile } from '../src/cpu-watchdog.js'
import { startEventLoopWatchdog, ToolTimingTracker } from '../src/timing.js'

const profile: CpuProfile = {
  nodes: [
    { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 } },
    { id: 2, callFrame: { functionName: 'hot', url: 'file:///x/room.mjs', lineNumber: 9 } },
    { id: 3, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
    { id: 4, callFrame: { functionName: '', url: 'file:///x/room.mjs', lineNumber: 19 } },
    { id: 5, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 } },
  ],
  // sample i stands for timeDeltas[i + 1] µs
  samples: [2, 3, 4, 2, 5, 2],
  timeDeltas: [0, 1000, 50_000, 9000, 1000, 2000],
}

function harness(o: { busy?: () => boolean; activity?: () => number } = {}) {
  let now = 0, cpu = 0
  const lines: string[] = []
  const written: { dir: string; at: Date }[] = []
  const capture = vi.fn(async (_ms: number) => profile)
  const dog = new CpuWatchdog({
    profileDir: () => '/repo/.git/room/profiles', log: line => lines.push(line), busy: o.busy ?? (() => false), ...(o.activity ? { activity: o.activity } : {}),
    now: () => now, wallClock: () => new Date(Date.UTC(2026, 10, 4, 12, 0, 0) + now), cpuUsage: () => ({ user: cpu * 0.75, system: cpu * 0.25 }),
    capture, write: async (dir, _p, at) => { written.push({ dir, at }); return `${dir}/${at.toISOString()}.cpuprofile` },
  })
  /** Advance by `ms` in 500 ms ticks at `share` of one core; returns profiles started. */
  const run = async (ms: number, share: number) => {
    const started: Promise<void>[] = []
    for (let t = 0; t < ms; t += 500) { now += 500; cpu += 500 * 1000 * share; const p = dog.sample(); if (p) started.push(p) }
    await Promise.all(started)
    return started.length
  }
  return { dog, lines, written, capture, run, clock: () => now }
}

describe('CPU watchdog', () => {
  it('profiles after a minute above half a core, logs the file and the top frames, then waits an hour', async () => {
    const h = harness()
    expect(await h.run(60_000, 0.9)).toBe(0) // first sample at 0.5 s: the window is 59.5 s long
    expect(await h.run(500, 0.9)).toBe(1)
    expect(h.capture).toHaveBeenCalledWith(10_000)
    expect(h.written).toEqual([{ dir: '/repo/.git/room/profiles', at: new Date(Date.UTC(2026, 10, 4, 12, 1, 0, 500)) }])
    expect(h.lines).toEqual([`cpu high: 90% of one core over 60 s with no tool call in flight; 10 s profile /repo/.git/room/profiles/2026-11-04T12:01:00.500Z.cpuprofile; top self time: (anonymous) room.mjs:20 9ms, hot room.mjs:10 2ms, (garbage collector) 2ms`])
    expect(h.dog.latest).toBe('/repo/.git/room/profiles/2026-11-04T12:01:00.500Z.cpuprofile')
    // Still hot for the rest of the hour: no second profile.
    expect(await h.run(60 * 60_000 - 1_000, 0.9)).toBe(0)
    expect(await h.run(1_000, 0.9)).toBe(1)
    expect(h.capture).toHaveBeenCalledTimes(2)
  })

  it('does not fire at or below half a core', async () => {
    const h = harness()
    expect(await h.run(5 * 60_000, 0.5)).toBe(0)
    expect(await h.run(5 * 60_000, 0.2)).toBe(0)
    expect(h.capture).not.toHaveBeenCalled()
  })

  it('restarts the window while a tool call is in flight', async () => {
    let busy = false
    const h = harness({ busy: () => busy })
    await h.run(50_000, 0.9)
    busy = true
    await h.run(20_000, 1)
    busy = false
    expect(await h.run(60_000, 0.9)).toBe(0)
    expect(await h.run(500, 0.9)).toBe(1)
  })

  it('reports a failed profile and still waits out the cooldown', async () => {
    const h = harness()
    h.capture.mockRejectedValueOnce(new Error('inspector busy'))
    expect(await h.run(60_500, 1)).toBe(1)
    expect(h.lines).toEqual(['cpu high: 100% of one core over 60 s with no tool call in flight; profile failed: inspector busy'])
    expect(await h.run(30 * 60_000, 1)).toBe(0)
  })

  it('samples on the event-loop watchdog tick', () => {
    let tick!: () => void
    const onTick = vi.fn()
    const tracker = new ToolTimingTracker({ log: () => {} })
    const watchdog = startEventLoopWatchdog(tracker, { log: () => {}, onTick, every: cb => { tick = cb; return { unref() {} } as unknown as NodeJS.Timeout }, clear: () => {} })
    tick(); tick()
    expect(onTick).toHaveBeenCalledTimes(2)
    watchdog.stop()
  })
})

describe('profile files', () => {
  it('writes mode 0600 files and keeps the newest five', async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'room-cpu-')), 'room', 'profiles')
    try {
      for (let i = 0; i < 7; i++) await writeCpuProfile(dir, profile, new Date(Date.UTC(2026, 10, 4, 12, i)))
      const names = fs.readdirSync(dir).sort()
      expect(names).toHaveLength(5)
      expect(names[0]).toBe('2026-11-04T12-02-00-000Z.cpuprofile')
      if (process.platform !== 'win32') for (const name of names) expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o600)
      expect(JSON.parse(fs.readFileSync(path.join(dir, names[4]!), 'utf8'))).toEqual(profile)
    } finally { fs.rmSync(path.dirname(path.dirname(dir)), { recursive: true, force: true }) }
  })

  it('summarizes hit counts when a profile has no sample timeline', () => {
    expect(topSelfFrames({ nodes: [{ id: 1, callFrame: { functionName: 'a', url: '', lineNumber: 0 }, hitCount: 3 }, { id: 2, callFrame: { functionName: 'b', url: '', lineNumber: 0 }, hitCount: 1 }], startTime: 0, endTime: 4000 }))
      .toEqual([{ frame: 'a', ms: 3 }, { frame: 'b', ms: 1 }])
  })

  it('captures a real profile without blocking the loop', async () => {
    const { captureCpuProfile } = await import('../src/cpu-watchdog.js')
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 10)
    try {
      const real = await captureCpuProfile(200)
      expect(real.nodes.length).toBeGreaterThan(0)
      expect(ticks).toBeGreaterThan(5)
    } finally { clearInterval(timer) }
  })
})

it('formats the server process line for room_state(check=true)', () => {
  expect(formatProcessHealth({ cpu: { user: 3_500_000, system: 1_000_000 }, rss: 120 * 1048576, uptime: 3 * 3600 + 125, latest: '/r/p.cpuprofile' }))
    .toBe(`INFO  Room server process: pid ${process.pid}; CPU 4.5 s (user 3.5, system 1.0); RSS 120 MB; up 3 h 2 min; last CPU profile /r/p.cpuprofile`)
})

it('a tool call that started and finished between two samples resets the idle window', async () => {
  let calls = 0
  const h = harness({ activity: () => calls })
  expect(await h.run(50_000, 0.9)).toBe(0)
  calls++ // a short call ran entirely between two ticks; no sample ever saw it in flight
  expect(await h.run(50_000, 0.9)).toBe(0) // the window restarted at the call, so 50 s later it is still short
  expect(await h.run(12_000, 0.9)).toBe(1) // first post-call sample at 51 s; 60 s of samples by 111 s
})
