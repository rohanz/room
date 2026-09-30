import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startWatchdog } from './test-watchdog.js'

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

it('ends a synchronous command that outlives its timeout, and names the test and the command', () => {
  if (process.platform === 'win32') return
  const report = reportFile()
  stops.push(startWatchdog({ stallMs: 600, pollMs: 100, killSelf: false, reportFile: report, describe: () => 'example.test.ts > blocks' }).stop)
  const started = Date.now(), marker = 30 + process.pid / 1e7
  // The shell ignores the SIGTERM that `timeout` sends, so without the watchdog this call returns after 30 s.
  expect(() => execFileSync('sh', ['-c', `trap "" TERM; sleep ${marker} & wait`], { timeout: 50, stdio: 'ignore' })).toThrow()
  expect(Date.now() - started).toBeLessThan(15_000)
  // The grandchild went too: left behind, it would hold the worker's output pipe open after the worker exits.
  expect(execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })).not.toContain(`sleep ${marker}`)
  const lines = fs.readFileSync(report, 'utf8')
  expect(lines).toMatch(/^example\.test\.ts > blocks: the event loop has been blocked for \d+ s; killing what it waits on: sh -c trap "" TERM; sleep 30\.\d+ & wait \(pid \d+\)/)
})

it('stays quiet while the event loop turns', async () => {
  const report = reportFile()
  stops.push(startWatchdog({ stallMs: 300, pollMs: 50, killSelf: false, reportFile: report }).stop)
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect(fs.existsSync(report)).toBe(false)
})

it('reports a file that runs past its limit', async () => {
  const report = reportFile()
  stops.push(startWatchdog({ fileLimitMs: 300, pollMs: 50, killSelf: false, reportFile: report, describe: () => 'slow.test.ts' }).stop)
  await expect.poll(() => fs.existsSync(report) && fs.readFileSync(report, 'utf8'), { timeout: 5000 }).toMatch(/^slow\.test\.ts: the file has run for \d+ s; ending this test worker/)
})
