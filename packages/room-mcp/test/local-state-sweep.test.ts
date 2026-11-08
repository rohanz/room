import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ROOM_STALE_MS } from '@room/shared'
import { sweepLocalState, SWEEP_TEMP_AGE_MS } from '../src/local-state-sweep.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function commonDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-sweep-'))
  dirs.push(dir)
  for (const sub of ['publishers', 'sessions', 'relay', 'hub-leases']) fs.mkdirSync(path.join(dir, 'room', sub), { recursive: true })
  return dir
}
const HOUR = 60 * 60 * 1000
const now = 1_800_000_000_000
const alive = { startTime: 'fixture-start', executable: 'fixture-node' }
const probe = (pid: number) => pid === 100 ? alive : undefined
const touch = (file: string, at: number, content = '{}') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); fs.utimesSync(file, at / 1000, at / 1000) }
const lease = (pid: number, extra: Record<string, unknown> = {}) => JSON.stringify({ worktree: '/w', holder: { pid, ...alive, sessionId: 's', nonce: 'n' }, attachments: {}, ...extra })

describe('local state sweep', () => {
  it('removes publisher lease files whose holder is dead and idle, keeps live, unknown and recent ones', () => {
    const common = commonDir(), dir = path.join(common, 'room', 'publishers')
    touch(path.join(dir, 'dead-old.json'), now - 2 * HOUR, lease(200))
    touch(path.join(dir, 'dead-recent.json'), now - 10 * 60_000, lease(200))
    touch(path.join(dir, 'dead-active.json'), now - 2 * HOUR, lease(200, { lastActive: now - 10 * 60_000 }))
    touch(path.join(dir, 'alive.json'), now - 2 * HOUR, lease(100))
    touch(path.join(dir, 'unknown.json'), now - 2 * HOUR, lease(0))
    touch(path.join(dir, 'garbage.json'), now - 2 * HOUR, 'not json')
    const removed = sweepLocalState(common, { now: () => now, probe })
    expect(removed.map(p => path.basename(p))).toEqual(['dead-old.json'])
    expect(fs.readdirSync(dir).sort()).toEqual(['alive.json', 'dead-active.json', 'dead-recent.json', 'garbage.json', 'unknown.json'])
  })

  it('removes session directories untouched for the stale period and keeps the shared idle episode file', () => {
    const common = commonDir(), dir = path.join(common, 'room', 'sessions')
    touch(path.join(dir, 'old', 'cursor.json'), now - ROOM_STALE_MS - 1)
    touch(path.join(dir, 'old', 'notices.json'), now - ROOM_STALE_MS - 1)
    touch(path.join(dir, 'mixed', 'cursor.json'), now - ROOM_STALE_MS - 1)
    touch(path.join(dir, 'mixed', 'runtime.json'), now - HOUR)
    touch(path.join(dir, 'fresh', 'cursor.json'), now - HOUR)
    touch(path.join(dir, 'idle-episode.json'), now - ROOM_STALE_MS - 1)
    const removed = sweepLocalState(common, { now: () => now, probe })
    expect(removed.map(p => path.basename(p))).toEqual(['old'])
    expect(fs.readdirSync(dir).sort()).toEqual(['fresh', 'idle-episode.json', 'mixed'])
  })

  it('removes abandoned atomic-write temporaries older than an hour under relay and hub-leases', () => {
    const common = commonDir()
    touch(path.join(common, 'room', 'relay', 'r.ydoc.123-abcdef.tmp'), now - SWEEP_TEMP_AGE_MS - 1)
    touch(path.join(common, 'room', 'relay', 'r.ydoc.124-abcdef.tmp'), now - 60_000)
    touch(path.join(common, 'room', 'relay', 'r.ydoc'), now - 30 * 24 * HOUR)
    touch(path.join(common, 'room', 'hub-leases', 'leases.json.roomtmp-p5-su-nx.tmp'), now - SWEEP_TEMP_AGE_MS - 1)
    const removed = sweepLocalState(common, { now: () => now, probe }).map(p => path.relative(path.join(common, 'room'), p)).sort()
    expect(removed).toEqual(['hub-leases/leases.json.roomtmp-p5-su-nx.tmp', 'relay/r.ydoc.123-abcdef.tmp'])
    expect(fs.readdirSync(path.join(common, 'room', 'relay')).sort()).toEqual(['r.ydoc', 'r.ydoc.124-abcdef.tmp'])
  })

  it('tolerates a clone without any Room state directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-sweep-empty-'))
    dirs.push(dir)
    expect(sweepLocalState(dir, { now: () => now, probe })).toEqual([])
  })
})
