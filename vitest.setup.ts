// Runs before every test file, also when vitest starts in a package directory (each package's vitest.config.ts).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, expect } from 'vitest'
import { isolateTestEnv } from './packages/shared/src/test-env.js'
import { startWatchdog } from './packages/shared/src/test-watchdog.js'
import { resetProcessLifecycle } from './packages/room-mcp/src/process-lifecycle.js'

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

// Each test models a fresh process: an earlier test's tools shutdown ends room-mcp's process lifecycle, which then
// refuses registry opens and storage admissions until a new holder begins one.
beforeEach(resetProcessLifecycle)
