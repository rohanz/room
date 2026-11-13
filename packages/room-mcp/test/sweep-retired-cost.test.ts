import { expectRetired, git, lead, setup, worker } from './collect-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoRetire } from '../src/retire.js'
import { registryForDir } from '../src/worker-registry.js'

/**
 * Observed 2026-11-14: in a clone with 105 retired worker records, the hourly retention pass (first run one minute
 * after a session starts) took a durable operation on every one of them to delete log files that were already gone,
 * and blocked the session's event loop for 11 to 14 seconds.
 */
type Setup = ReturnType<typeof setup>
const rooms = (t: Setup) => ({ ...t.state.rooms, probe: () => undefined, listCwdProcesses: () => [] }) as never
const realNow = Date.now.bind(Date)
let offset = 0
/** The clone's retention pass runs at most hourly per process; step past its window. */
function nextSweepWindow() {
  offset += 2 * 60 * 60 * 1000
  const ahead = offset
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ahead)
}
afterEach(() => { vi.restoreAllMocks() })

async function retiredWorker(t: Setup) {
  t.set('test', { ...t.w, hostSessionId: 'thread-test', exitCode: 0, finishedAt: 1 })
  await t.sync()
  await t.state.rooms.project()
  git(lead, 'worktree', 'remove', '--force', worker)
  git(lead, 'branch', '-D', 'room/test')
  nextSweepWindow()
  await autoRetire(t.s, rooms(t))
  await expectRetired(t)
}

describe('the retention pass over retired workers', () => {
  it('takes no operation on a retired record whose log files are already gone', async () => {
    const t = setup()
    await retiredWorker(t)
    const registry = await registryForDir(lead)
    const begin = vi.spyOn(registry, 'beginOperation')
    nextSweepWindow()
    await autoRetire(t.s, rooms(t))
    expect(begin).not.toHaveBeenCalled()
  })

  it('still removes a log file left beside a retired record', async () => {
    const t = setup()
    await retiredWorker(t)
    const log = path.join(lead, '.room', 'workers', 'test.log')
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.writeFileSync(log, 'late output')
    nextSweepWindow()
    await autoRetire(t.s, rooms(t))
    expect(fs.existsSync(log)).toBe(false)
  })
})
