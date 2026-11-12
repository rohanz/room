// Runs before every test file, also when vitest starts in a package directory (each package's vitest.config.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, expect } from 'vitest'
import { isolateTestEnv } from './packages/shared/src/test-env.js'
import { startWatchdog } from './packages/shared/src/test-watchdog.js'

// Host, Room, git and server state must not leak into tests or the child processes they spawn.
const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'room-test-config-'))
isolateTestEnv(process.env, configHome)
afterAll(() => fs.rmSync(configHome, { recursive: true, force: true }))

// A worker whose event loop is blocked cannot time its own test out; the watchdog names it and ends the wait.
const watchdog = startWatchdog({ describe: () => {
  const state = expect.getState()
  const file = state.testPath ? path.relative(process.cwd(), state.testPath) : ''
  return [file, state.currentTestName].filter(Boolean).join(' > ')
} })
beforeEach(watchdog.beat)

// Signalling pid 0 signals the caller's whole process group: every test worker, vitest and npm.
// `Number('')` is 0, so an empty pid file read by a test is enough. Refuse it and say which test asked.
const kill = process.kill.bind(process)
process.kill = ((pid: number, signal?: string | number) => {
  if (pid === 0) {
    const state = expect.getState()
    const message = `[test guard] refused process.kill(0, ${String(signal)}) from ${state.testPath ?? 'unknown file'} > ${state.currentTestName ?? ''}`
    process.stderr.write(message + '\n')
    throw new Error(message)
  }
  return kill(pid, signal)
}) as typeof process.kill
