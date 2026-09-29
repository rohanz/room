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

  it('counts fresh scratch previews across processes but ignores stale directories, file merges and its own', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-count-'))
    const own = path.join(root, 'room-merge-own')
    const fresh = path.join(root, 'room-merge-fresh')
    const stale = path.join(root, 'room-merge-stale')
    const unrelated = path.join(root, 'unrelated')
    const mergeFile = path.join(root, 'room-merge-file-abc') // merge.ts's per-file three-way merge, not a preview check
    for (const dir of [own, fresh, stale, unrelated, mergeFile]) fs.mkdirSync(dir)
    const now = Date.now()
    try {
      const count = countOtherPreviewChecks(own, root, now, file => {
        const stat = fs.lstatSync(file)
        return file === stale ? new Proxy(stat, { get(target, key) { return key === 'birthtimeMs' ? now - 7 * 60_000 : Reflect.get(target, key) } }) : stat
      })
      expect(count).toBe(1)
      expect(countOtherPreviewChecks(own, root, now, () => { throw Error('vanished') })).toBe(0)
      expect(countOtherPreviewChecks(own, path.join(root, 'missing'), now)).toBeUndefined()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps both slow overlap samples outside the check phase', async () => {
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    const sample = vi.fn(() => { now += 400; return 0 })
    await tracker.run('room_preview_merge', async () => {
      expect(await previewCheck('/tmp/room-merge-own', () => { now += 2310; return 'ok' }, sample)).toBe('ok')
    })
    expect(sample).toHaveBeenCalledTimes(2)
    expect(lines).toEqual(['slow tool room_preview_merge 3110ms: check 2310ms, overlapped 0 other preview check(s), other 800ms'])
  })

  it.each([[undefined, 0], [0, undefined]])('omits overlap when either sample is unknown (%s, %s)', async (first, second) => {
    let now = 0
    const lines: string[] = []
    const tracker = new ToolTimingTracker({ now: () => now, log: line => lines.push(line) })
    const sample = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    await tracker.run('room_preview_merge', () => previewCheck('/tmp/room-merge-own', () => { now += 2100 }, sample))
    expect(sample).toHaveBeenCalledTimes(2)
    expect(lines).toEqual(['slow tool room_preview_merge 2100ms: check 2100ms'])
  })

  it('stops after 50 matching scratch directories and leaves the overlap unknown', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-limit-'))
    try {
      for (let i = 0; i < 51; i++) fs.mkdirSync(path.join(root, `room-merge-${i}`))
      const readStat = vi.fn((file: string) => fs.lstatSync(file))
      expect(countOtherPreviewChecks(path.join(root, 'room-merge-own'), root, Date.now(), readStat)).toBeUndefined()
      expect(readStat).toHaveBeenCalledTimes(50)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('stops scanning after 2000 directory entries and closes the iterator', () => {
    const readSync = vi.fn(() => ({ name: 'unrelated', isDirectory: () => true }) as fs.Dirent)
    const closeSync = vi.fn()
    const openDir = vi.fn(() => ({ readSync, closeSync }))
    const readStat = vi.fn((file: string) => fs.lstatSync(file))
    expect(countOtherPreviewChecks('/tmp/room-merge-own', '/tmp', Date.now(), readStat, openDir)).toBeUndefined()
    expect(readSync).toHaveBeenCalledTimes(2000)
    expect(readStat).not.toHaveBeenCalled()
    expect(closeSync).toHaveBeenCalledOnce()
  })

  it('records connect, delayed sync, and daemon start through startAutoTaggedRoomd', async () => {
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
      expect(lines[0]).toMatch(/connect 50ms, sync 2100ms, daemon start 900ms/)
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
