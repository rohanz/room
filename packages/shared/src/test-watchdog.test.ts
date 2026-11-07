import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { startWatchdog, watchdogTick } from './test-watchdog.js'

// Process-tree integration is unavailable in sandboxes that deny ps (and on Windows).
const canInspectProcesses = process.platform !== 'win32' && spawnSync('ps', ['-axo', 'pid='], { stdio: 'ignore' }).status === 0

const stops: (() => void)[] = []
const dirs: string[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function reportFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-watchdog-'))
  dirs.push(dir)
  return path.join(dir, 'report')
}

it.skipIf(!canInspectProcesses)('ends a synchronous command that outlives its timeout, and names the test and the command', () => {
  const report = reportFile()
  stops.push(startWatchdog({ stallMs: 600, pollMs: 100, killSelf: false, reportFile: report, describe: () => 'example.test.ts > blocks' }).stop)
  const marker = 30 + process.pid / 1e7
  // SIGCONT cannot terminate the child, even if load delays its startup past the timeout.
  // SIGTERM races the shell installing its trap and can return before the watchdog fires.
  expect(() => execFileSync('sh', ['-c', `trap "" TERM; sleep ${marker} & wait`], { timeout: 50, killSignal: 'SIGCONT', stdio: 'ignore' })).toThrow()
  // The grandchild went too: left behind, it would hold the worker's output pipe open after the worker exits.
  expect(execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })).not.toContain(`sleep ${marker}`)
  const lines = fs.readFileSync(report, 'utf8')
  expect(lines).toMatch(/^example\.test\.ts > blocks: the event loop has been blocked for \d+ s; killing what it waits on: sh -c trap "" TERM; sleep 30\.\d+ & wait \(pid \d+\)/)
})

it('stays quiet while the event loop turns', async () => {
  const limits = { stallMs: 300, pollMs: 50, fileLimitMs: 10_000 }
  let beats!: Int32Array
  vi.useFakeTimers()
  const watchdog = startWatchdog({ ...limits, createWorker: (_source, options) => {
    beats = new Int32Array(options.workerData.beat)
    return { unref: vi.fn(), terminate: vi.fn(async () => 0) }
  } })
  try {
    let state = { seen: Atomics.load(beats, 0), still: 0, elapsed: 0 }
    for (let poll = 0; poll < 24; poll++) {
      await vi.advanceTimersByTimeAsync(limits.pollMs)
      const beat = Atomics.load(beats, 0)
      expect(beat).toBe(state.seen + 1) // the actual scheduled heartbeat reached shared memory
      const next = watchdogTick(state, beat, limits)
      expect(next.stalled).toBe(false)
      expect(next.overLimit).toBe(false)
      state = next
    }
    // The same policy must detect a stopped loop; it cannot simply always stay quiet.
    for (let poll = 0; poll < 5; poll++) state = watchdogTick(state, state.seen, limits)
    expect(watchdogTick(state, state.seen, limits).stalled).toBe(true)
    expect(watchdogTick(state, state.seen + 1, limits).still).toBe(0)
    watchdog.stop()
    const stoppedBeat = Atomics.load(beats, 0)
    await vi.advanceTimersByTimeAsync(300)
    expect(Atomics.load(beats, 0)).toBe(stoppedBeat)
    expect(Atomics.load(beats, 2)).toBe(1)
  } finally { watchdog.stop(); vi.useRealTimers() }
})

it('reaches the file limit even when every poll sees a heartbeat', () => {
  const limits = { stallMs: 300, pollMs: 50, fileLimitMs: 300 }
  let state = { seen: 0, still: 0, elapsed: 0 }
  for (let beat = 1; beat < 6; beat++) {
    const next = watchdogTick(state, beat, limits)
    expect(next.overLimit).toBe(false)
    state = next
  }
  expect(watchdogTick(state, 6, limits)).toMatchObject({ overLimit: true, stalled: false })
})

it.skipIf(!canInspectProcesses)('reports a file that runs past its limit and ends what the file started', async () => {
  const report = reportFile()
  const child = spawn('sh', ['-c', 'sleep 60 & wait'], { stdio: 'ignore' })
  const exited = new Promise<NodeJS.Signals | null>(resolve => child.once('exit', (_code, signal) => resolve(signal)))
  stops.push(startWatchdog({ fileLimitMs: 300, pollMs: 50, killSelf: false, reportFile: report, describe: () => 'slow.test.ts' }).stop)
  // Exit is the completion event: the watchdog writes its report before signalling.
  expect(await exited).toBe('SIGKILL')
  expect(fs.readFileSync(report, 'utf8')).toMatch(/^slow\.test\.ts: the file has run for \d+ s; ending this test worker/)
})
