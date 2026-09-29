import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { RoomDoc } from '@room/shared'
import { carriedContentHash } from '@room/roomd/baseline'
import { setGitObserver } from '@room/roomd/git'
import { startAutoTaggedRoomd } from '../src/session.js'
import { countOtherPreviewChecks, currentToolTiming, previewCheck, previewPhase, registerPrepareGitTiming, startEventLoopWatchdog, ToolTiming, ToolTimingTracker } from '../src/timing.js'

const joinClock = vi.hoisted(() => ({ now: 0 }))
vi.mock('@room/roomd', async importOriginal => ({
  ...await importOriginal<typeof import('@room/roomd')>(),
  startRoomd: vi.fn(async options => {
    joinClock.now += 900
    const roomDoc = new RoomDoc(), awareness = new Awareness(roomDoc.doc)
    awareness.setLocalState({ user: { name: options.name, kind: 'agent' } })
    return { name: options.name, roomDoc, provider: { awareness }, touch() {}, stop: async () => { awareness.destroy(); roomDoc.doc.destroy() } }
  }),
}))

describe('tool timing', () => {
  it('records phases and nested git worktree calls, and logs only slow calls', async () => {
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    await tracker.run('room_spawn', async () => {
      const timing = currentToolTiming()!
      await timing.phase('settle', async () => { now += 3 })
      timing.add('lease', 0)
      await timing.phase('prepare', async () => {
        now += 3500; timing.recordGit(['worktree', 'add'], 3500)
        now += 400; timing.recordGit(['status'], 400)
        now += 200
      })
      await timing.phase('launch', async () => { now += 1200 })
    })
    expect(lines).toEqual(['slow tool room_spawn 5303ms: settle 3ms, lease 0ms, prepare 4100ms (git 2 calls 3900ms, worktree add 3500ms), launch 1200ms'])
    now = 0
    await tracker.run('room_state', async () => { now += 1999 })
    expect(lines).toHaveLength(1)
    await tracker.run('room_state', async () => { now += 2000 })
    expect(lines[1]).toBe('slow tool room_state 2000ms: body 2000ms')
  })

  it('keeps concurrent call phases separate, including rejected work', async () => {
    let releaseA!: () => void
    const gate = new Promise<void>(resolve => { releaseA = resolve })
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => performance.now(), log: line => lines.push(line) })
    let first: ToolTiming | undefined
    let second: ToolTiming | undefined
    const a = tracker.run('room_spawn', async () => { first = currentToolTiming(); first!.add('prepare', 2100); await gate; expect(currentToolTiming()).toBe(first) })
    const b = tracker.run('room_state', async () => { second = currentToolTiming(); second!.add('settle', 2200); expect(second).not.toBe(first); throw Error('test') })
    await expect(b).rejects.toThrow('test')
    expect(tracker.runningAt()).toEqual([expect.stringMatching(/^room_spawn \d+ms$/)])
    releaseA()
    await a
    expect(tracker.runningAt()).toEqual([])
    expect(lines[0]).toMatch(/^slow tool room_state .*: settle 2200ms, body /)
    expect(lines[1]).toMatch(/^slow tool room_spawn .*: prepare 2100ms$/)
  })

  it('records dispatch queue time before spawn starts', async () => {
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    await tracker.run('room_spawn', async () => {
      const timing = currentToolTiming()!
      timing.startQueue()
      now = 2050
      timing.endQueue()
      timing.add('lease', 0)
    })
    expect(lines).toEqual(['slow tool room_spawn 2050ms: queue 2050ms, lease 0ms'])
  })

  it('accounts for time between spawn queue and preparation', async () => {
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    await tracker.run('room_spawn', async () => {
      const timing = currentToolTiming()!
      timing.startQueue(); now += 100; timing.endQueue()
      now += 118_000 // ensureWorkersRoom / resolveConfig
      timing.add('lease', 100)
      now += 100
      await timing.phase('prepare', () => { now += 500 })
    })
    expect(lines).toEqual(['slow tool room_spawn 118700ms: queue 100ms, lease 100ms, prepare 500ms, other 118000ms'])
  })

  it('subtracts settle from a non-spawn body', async () => {
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    await tracker.run('room_state', async () => {
      await currentToolTiming()!.phase('settle', () => { now += 3000 })
      now += 100
    })
    expect(lines).toEqual(['slow tool room_state 3100ms: settle 3000ms, body 100ms'])
  })

  it('prints join phases instead of collapsing them into body', async () => {
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    await tracker.run('room_join', async () => {
      const timing = currentToolTiming()!
      await timing.phase('resolve', () => { now += 100 })
      await timing.phase('preflight', () => { now += 1200 })
      await timing.phase('connect', () => { now += 50 })
      await timing.phase('sync', () => { now += 2100 })
      await timing.phase('daemon start', () => { now += 900 })
    })
    expect(lines).toEqual(['slow tool room_join 4350ms: resolve 100ms, preflight 1200ms, connect 50ms, sync 2100ms, daemon start 900ms'])
  })

  it('logs preview merge, setup, check, collect, remainder, and sampled concurrent checks', async () => {
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    await tracker.run('room_preview_merge', async () => {
      await previewPhase('merge', () => { now += 1000 })
      await previewPhase('setup', () => { now += 500 })
      await previewPhase('check', () => { now += 2310 })
      await previewPhase('collect', () => { now += 100 })
      currentToolTiming()!.notePreviewCheckOverlap(2)
      now += 190
    })
    expect(lines[0]).toBe('slow tool room_preview_merge 4100ms: merge 1000ms, setup 500ms, check 2310ms, overlapped 2 other preview check(s), collect 100ms, other 190ms')
    now = 0
    await tracker.run('room_preview_merge', async () => { await previewPhase('merge', () => { now += 2100 }) })
    expect(lines[1]).toBe('slow tool room_preview_merge 2100ms: merge 2100ms')
  })

  it('counts other fresh markers, ignores stale-age and dead-pid markers, and removes none of them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-marker-test-'))
    const markerDir = path.join(root, 'room-preview-checks')
    fs.mkdirSync(markerDir)
    const own = path.join(markerDir, `${process.pid}-a1`)
    const fresh = path.join(markerDir, `${process.pid}-b2`)
    const stale = path.join(markerDir, `${process.pid}-c3`)
    const dead = path.join(markerDir, '99999999-d4')
    for (const file of [own, fresh, stale, dead]) fs.writeFileSync(file, '')
    const old = new Date(Date.now() - 7 * 60_000)
    fs.utimesSync(stale, old, old)
    try {
      expect(countOtherPreviewChecks(own, markerDir)).toBe(1)
      expect(fs.existsSync(own)).toBe(true)
      expect(fs.existsSync(fresh)).toBe(true)
      expect(fs.existsSync(stale)).toBe(true) // only a check's own marker is ever removed
      expect(fs.existsSync(dead)).toBe(true)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('ignores a marker removed between directory read and stat', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-marker-race-'))
    const own = path.join(root, `${process.pid}-a1`)
    const removed = path.join(root, `${process.pid}-b2`)
    const fresh = path.join(root, `${process.pid}-c3`)
    for (const file of [own, removed, fresh]) fs.writeFileSync(file, '')
    try {
      expect(countOtherPreviewChecks(own, root, Date.now(), file => {
        if (file === removed) fs.unlinkSync(file)
        return fs.lstatSync(file)
      })).toBe(1)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps both slow overlap samples outside the check phase', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-clock-'))
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    const sample = vi.fn(() => { now += 400; return 0 })
    try {
      await tracker.run('room_preview_merge', async () => {
        expect(await previewCheck(() => { now += 2310; return 'ok' }, { markerDir: root, sample })).toBe('ok')
      })
      expect(sample).toHaveBeenCalledTimes(2)
      expect(lines).toEqual(['slow tool room_preview_merge 3110ms: check 2310ms, overlapped 0 other preview check(s), other 800ms'])
      expect(fs.readdirSync(root)).toEqual([])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('does not sample overlap where the marker directory owner cannot be checked (no process.getuid)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-nouid-'))
    const getuid = Object.getOwnPropertyDescriptor(process, 'getuid')!
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    const sample = vi.fn(() => 3)
    try {
      Object.defineProperty(process, 'getuid', { value: undefined, configurable: true })
      await tracker.run('room_preview_merge', () => previewCheck(() => { now += 2100 }, { markerDir: path.join(root, 'markers'), sample }))
      expect(sample).not.toHaveBeenCalled()
      expect(fs.readdirSync(root)).toEqual([])
      expect(lines).toEqual(['slow tool room_preview_merge 2100ms: check 2100ms'])
    } finally {
      Object.defineProperty(process, 'getuid', getuid)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([[undefined, 0], [0, undefined]])('omits overlap when either sample is unknown (%s, %s)', async (first, second) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-unknown-'))
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    const sample = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    try {
      await tracker.run('room_preview_merge', () => previewCheck(() => { now += 2100 }, { markerDir: root, sample }))
      expect(sample).toHaveBeenCalledTimes(2)
      expect(lines).toEqual(['slow tool room_preview_merge 2100ms: check 2100ms'])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('removes its marker after a failed check', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-failed-'))
    const markerDir = path.join(root, 'room-preview-checks')
    try {
      const tracker = new ToolTimingTracker({ log: () => {} })
      await expect(tracker.run('room_preview_merge', () => previewCheck(() => {
        const markers = fs.readdirSync(markerDir)
        expect(markers).toHaveLength(1)
        expect(markers[0]).toMatch(new RegExp(`^${process.pid}-[0-9a-f]+$`))
        expect(fs.statSync(markerDir).mode & 0o777).toBe(0o700)
        expect(fs.statSync(path.join(markerDir, markers[0])).mode & 0o777).toBe(0o600)
        throw Error('check failed')
      }, { markerDir }))).rejects.toThrow('check failed')
      expect(fs.readdirSync(markerDir)).toEqual([])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps running when the marker directory cannot be created', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-no-marker-'))
    const blockingFile = path.join(root, 'file')
    fs.writeFileSync(blockingFile, '')
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    try {
      expect(await tracker.run('room_preview_merge', () => previewCheck(() => { now += 2100; return 'ok' }, { markerDir: path.join(blockingFile, 'markers') }))).toBe('ok')
      expect(lines).toEqual(['slow tool room_preview_merge 2100ms: check 2100ms'])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('leaves overlap unknown when the marker entry cap is reached', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-cap-'))
    try {
      for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(root, `${process.pid}-${i.toString(16).padStart(4, '0')}`), '')
      expect(countOtherPreviewChecks(path.join(root, `${process.pid}-ffff`), root)).toBeUndefined()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('leaves the overlap unknown when the marker directory is a symlink, and writes nothing through it', async () => {
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-symlink-'))
    try {
      const target = path.join(root, 'elsewhere')
      fs.mkdirSync(target)
      fs.writeFileSync(path.join(target, '99999999-d4'), '')
      const markerDir = path.join(root, 'markers')
      fs.symlinkSync(target, markerDir)
      expect(await tracker.run('room_preview_merge', () => previewCheck(() => { now += 2100; return 'ok' }, { markerDir }))).toBe('ok')
      expect(fs.readdirSync(target)).toEqual(['99999999-d4'])
      expect(lines).toEqual(['slow tool room_preview_merge 2100ms: check 2100ms'])
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('records delayed sync and daemon start through the redesign join path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-join-timing-'))
    execFileSync('git', ['init', '-q', dir])
    joinClock.now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => joinClock.now, log: line => lines.push(line) })
    try {
      await tracker.run('room_join', async () => {
        const { daemon } = await startAutoTaggedRoomd({
          dir, room: 'ws://unused/room', name: 'Timing', kind: 'agent', log: () => {},
          providerFactory: (_server, _room, doc): WebsocketProvider => {
            joinClock.now += 50
            const events = new EventEmitter(), awareness = new Awareness(doc)
            const provider = Object.assign(events, { synced: false, awareness, destroy() { events.removeAllListeners() } })
            setTimeout(() => { joinClock.now += 2100; provider.synced = true; events.emit('sync', true) }, 0)
            return provider as unknown as WebsocketProvider
          },
        })
        await daemon.stop()
      })
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/sync 2100ms.*daemon start 900ms/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('counts baseline hash-object Git during a real preparation path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-timing-'))
    try {
      execFileSync('git', ['init', '-q', dir])
      fs.writeFileSync(path.join(dir, 'carried.txt'), 'carried')
      const lines: string[] = []
      const tracker = new ToolTimingTracker({ log: line => lines.push(line) })
      registerPrepareGitTiming()
      await tracker.run('room_spawn', async () => {
        await currentToolTiming()!.phase('prepare', () => {
          expect(carriedContentHash(dir, 'carried.txt', true)).toMatch(/^[a-f0-9]{40}$/)
        })
        currentToolTiming()!.add('prepare', 2100)
      })
      expect(lines).toMatchObject([expect.stringMatching(/prepare \d+ms \(git 1 calls \d+ms\)/)])
    } finally {
      setGitObserver(undefined)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['room_wait', 'room_login'])('does not call an intentional %s slow, but reports a slow settle or queue', async name => {
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    await tracker.run(name, async () => {
      expect(tracker.runningAt()).toEqual([`${name} 0ms`])
      now = 100_000
      expect(tracker.runningAt()).toEqual([`${name} 100000ms`])
    })
    expect(lines).toEqual([])
    await tracker.run(name, async () => {
      const timing = currentToolTiming()!
      await timing.phase('settle', async () => { now += 2100 })
      now += 100_000
    })
    expect(lines).toEqual([`slow tool ${name} 102100ms: settle 2100ms`])
    await tracker.run(name, async () => {
      const timing = currentToolTiming()!
      timing.startQueue(); now += 2200; timing.endQueue()
      now += 100_000
    })
    expect(lines[1]).toBe(`slow tool ${name} 102200ms: queue 2200ms`)
  })
})

describe('event loop watchdog', () => {
  it('is unrefed, reports excessive drift with in-flight names, and stops', async () => {
    let now = 0
    let tick!: () => void
    const unref = vi.fn()
    const clear = vi.fn()
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    const watchdog = startEventLoopWatchdog(tracker, { now: () => now, log: line => lines.push(line),
      every: (_callback, _ms) => { tick = _callback; return { unref } as unknown as NodeJS.Timeout }, clear })
    expect(unref).toHaveBeenCalledOnce()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const work = tracker.run('room_spawn', () => gate)
    now = 2499; tick()
    expect(lines).toEqual([])
    now = 5500; tick()
    expect(lines).toEqual(['event loop lag 2501ms: in flight room_spawn 5500ms'])
    watchdog.stop()
    expect(clear).toHaveBeenCalledOnce()
    release(); await work
  })
})
