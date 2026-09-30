// A test whose synchronous call never returns (an external command that does not exit, or does not die on the
// SIGTERM a `timeout` option sends) blocks its worker's event loop. Vitest times tests out with timers on that loop,
// and the run has no per-file limit, so nothing fires: the whole run waits on one idle worker without naming it.
// This watchdog runs on a second thread in every test worker. When the loop has not turned for `stallMs` it names the
// file, the test and the commands the worker is waiting on, and kills those commands so the blocked call throws and
// the test fails in the ordinary way. A worker that is still blocked after that, or a file that runs past
// `fileLimitMs`, is killed itself: vitest reports the lost worker and the run ends.
import { Worker } from 'node:worker_threads'

export interface WatchdogOptions {
  /** How long the event loop may stand still. The slowest synchronous git calls in the suite take about 35 s on a loaded machine. */
  stallMs?: number
  /** Wall time one test file may take. The longest file takes about 6 minutes; CI gives the whole job 20. */
  fileLimitMs?: number
  pollMs?: number
  /** What the worker is running, for the report. */
  describe?: () => string
  /** Reports go to this file instead of stderr (the watchdog's own test reads them). */
  reportFile?: string
  /** False keeps a blocked process alive after the report (the watchdog's own test). */
  killSelf?: boolean
}

const thread = `
const { workerData } = require('node:worker_threads')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const { beat, label, pid, stallMs, fileLimitMs, pollMs, killSelf, reportFile } = workerData
const beats = new Int32Array(beat), text = new Uint8Array(label)
const sleeper = new Int32Array(new SharedArrayBuffer(4))
const say = line => {
  try { reportFile ? fs.appendFileSync(reportFile, line + '\\n') : fs.writeSync(2, '[test watchdog] ' + line + '\\n') }
  catch { /* stderr is gone with the run */ }
}
const what = () => Buffer.from(text.slice(0, Atomics.load(beats, 1))).toString('utf8') || 'a file that has not started a test'
// Every descendant, children first: a grandchild left behind would keep the worker's output pipe open.
const descendants = () => {
  try {
    const all = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5000 }).split('\\n')
      .map(line => /^\\s*(\\d+)\\s+(\\d+)\\s+(.*)$/.exec(line)).filter(match => match && !match[3].startsWith('ps -axo'))
      .map(match => ({ pid: Number(match[1]), parent: Number(match[2]), command: match[3].slice(0, 300) }))
    const found = []
    for (let parents = [pid]; parents.length;) {
      const next = all.filter(p => parents.includes(p.parent) && !found.includes(p))
      found.push(...next); parents = next.map(p => p.pid)
    }
    return found
  } catch { return [] }
}
let seen = Atomics.load(beats, 0), still = 0, elapsed = 0, killedChildren = false
for (;;) {
  Atomics.wait(sleeper, 0, 0, pollMs)
  if (Atomics.load(beats, 2)) break
  elapsed += pollMs
  const now = Atomics.load(beats, 0)
  if (now !== seen) { seen = now; still = 0; killedChildren = false }
  else still += pollMs
  const overLimit = elapsed >= fileLimitMs
  if (still < stallMs && !overLimit) continue
  if (!overLimit && !killedChildren) {
    const waiting = descendants()
    say(what() + ': the event loop has been blocked for ' + Math.round(still / 1000) + ' s' + (waiting.length
      ? '; killing what it waits on: ' + waiting.filter(child => child.parent === pid).map(child => child.command + ' (pid ' + child.pid + ')').join('; ')
      : '; it waits on no child process'))
    for (const child of waiting) { try { process.kill(child.pid, 'SIGKILL') } catch { /* it exited */ } }
    if (waiting.length) { killedChildren = true; still = Math.max(0, stallMs - 4 * pollMs); continue }
  }
  say(what() + (overLimit ? ': the file has run for ' + Math.round(elapsed / 1000) + ' s' : ': still blocked') + '; ending this test worker')
  if (killSelf) process.kill(pid, 'SIGKILL')
  break
}
`

/** Start watching this process's event loop. `beat` records a turn now (and what is running); `stop` ends the watch. */
export function startWatchdog(options: WatchdogOptions = {}): { beat: () => void; stop: () => void } {
  const beat = new SharedArrayBuffer(12), label = new SharedArrayBuffer(1024)
  const beats = new Int32Array(beat), text = new Uint8Array(label)
  const encoder = new TextEncoder()
  const turn = () => {
    const bytes = encoder.encode(options.describe?.() ?? '').subarray(0, text.length)
    text.set(bytes)
    Atomics.store(beats, 1, bytes.length)
    Atomics.add(beats, 0, 1)
  }
  turn()
  const pollMs = options.pollMs ?? 5000
  // A real interval: created before any test installs fake timers, it keeps running under them.
  const timer = setInterval(turn, Math.min(1000, pollMs))
  timer.unref()
  const worker = new Worker(thread, { eval: true, workerData: {
    beat, label, pid: process.pid, pollMs, stallMs: options.stallMs ?? 120_000, fileLimitMs: options.fileLimitMs ?? 15 * 60_000,
    killSelf: options.killSelf ?? true, reportFile: options.reportFile,
  } })
  worker.unref()
  return { beat: turn, stop: () => { clearInterval(timer); Atomics.store(beats, 2, 1); void worker.terminate() } }
}
