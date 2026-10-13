import { manifestText } from './manifest-assert.js'
import { policyFromLevel } from '../src/policy.js'
import { it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Awareness } from 'y-protocols/awareness'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd } from '../src/index.js'
import { DiskBatch } from '../src/disk-batch.js'

vi.setConfig({ testTimeout: 60_000 })
beforeAll(() => { vi.stubEnv('CHOKIDAR_USEPOLLING', '1') })
afterAll(() => { vi.unstubAllEnvs() })

it('expires cold publication histories and hot membership on later lifecycle activity', () => {
  vi.useFakeTimers()
  let now = 0
  const batch = new DiskBatch(() => {}, 20, () => now)
  const state = batch as unknown as { publications: Map<string, number[]>; hot: Set<string> }
  try {
    batch.published('cold')
    for (let i = 0; i < 6; i++) batch.published('hot')
    expect(batch.deferHot('hot')).toBe(true)
    now = 120_001
    batch.published('new')
    expect([...state.publications.keys()]).toEqual(['new'])
    expect(state.hot.size).toBe(0)
    expect(batch.deferHot('hot')).toBe(false)
    batch.stop()
    expect(state.publications.size).toBe(0)
  } finally { batch.stop(); vi.useRealTimers() }
})

it('drains 5000 stale histories through bounded sweeps while continued publication keeps hot throttling', () => {
  let now = 0
  const batch = new DiskBatch(() => {}, 20, () => now)
  const state = batch as unknown as { publications: Map<string, number[]>; hot: Set<string> }
  try {
    for (let i = 0; i < 5000; i++) batch.published(`old-${i}`)
    expect(state.publications.size).toBe(5000)
    now = 120_001
    const removed = vi.spyOn(state.publications, 'delete')
    const originalEntries = state.publications.entries.bind(state.publications)
    let inspected = 0
    const countedEntries = () => {
      const iterator = originalEntries()
      const next = iterator.next.bind(iterator)
      iterator.next = () => { inspected++; return next() }
      return iterator
    }
    vi.spyOn(state.publications, 'entries').mockImplementation(countedEntries)
    vi.spyOn(state.publications, Symbol.iterator).mockImplementation(countedEntries)
    for (let i = 0; i < 20; i++) {
      removed.mockClear()
      inspected = 0
      batch.published('live')
      // At most 256 expired keys plus moving the live key to the newest position.
      expect(removed.mock.calls.length).toBeLessThanOrEqual(257)
      expect(inspected).toBeLessThanOrEqual(256)
      if (i === 0) expect(state.publications.size).toBe(5000 - 256 + 1)
    }
    expect([...state.publications.keys()]).toEqual(['live'])
    expect(state.publications.get('live')).toHaveLength(6)
    expect(state.hot.has('live')).toBe(true)
    now += 29_999
    expect(batch.deferHot('live')).toBe(true)
    now++
    expect(batch.deferHot('live')).toBe(false)
  } finally { batch.stop(); vi.restoreAllMocks() }
})

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)) }
}

it('does not throttle a changed file because edits elsewhere republished its unchanged text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-path-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'a.py'), 'a = 0\n'); fs.writeFileSync(path.join(dir, 'b.py'), 'b = 0\n')
  git('add', '.'); git('commit', '-qm', 'base')
  fs.writeFileSync(path.join(dir, 'a.py'), 'a = 1\n')
  // Default hot throttle (30 s): only a file that really republished often may be deferred.
  const daemon = await startRoomd({ policy: policyFromLevel('full'), dir, name: 'Test', room: 'ws://memory/hot-path', debounceMs: 20,
    trackedRefreshMs: 0, basePollMs: 0, reconcileIntervalMs: 0, log: () => {},
    providerFactory: (_server, _room, doc) => {
      const awareness = new Awareness(doc)
      return { synced: true, awareness, on() {}, off() {}, destroy() { awareness.destroy() } } as unknown as WebsocketProvider
    } })
  try {
    await until(() => manifestText(daemon.roomDoc, 'a.py', 'Test') === 'a = 1\n', 15_000)
    // Five edits to b.py (fewer than make b itself hot): each reconcile carries a.py's unchanged text too.
    for (let n = 1; n <= 5; n++) {
      fs.writeFileSync(path.join(dir, 'b.py'), `b = ${n}\n`)
      await until(() => manifestText(daemon.roomDoc, 'b.py', 'Test') === `b = ${n}\n`, 15_000)
      await daemon.settle()
    }
    fs.writeFileSync(path.join(dir, 'a.py'), 'a = 2\n')
    // a.py changed once in this whole run: it publishes within the debounce, not after the 30 s hot deferral.
    await until(() => manifestText(daemon.roomDoc, 'a.py', 'Test') === 'a = 2\n', 10_000)
  } finally {
    await daemon.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
