import { expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { RoomDoc } from '@room/shared'
import { setParticipantBase } from '@room/shared/testing'
import { GraphIndex } from '../src/graph-index.js'
import { ParseWorker } from '../src/parse/client.js'
import { clearFixture, deleteFixture, publishFixture, setFixtureLocalRoot } from './fixtures/manifest.js'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check()) { if (Date.now() >= end) throw new Error('condition timed out'); await sleep(10) }
}
function fixture(count = 4, text = (i: number) => `export function f${i}(){return external${i}();}`) {
  const dir = mkdtempSync(join(tmpdir(), 'room-graph-retention-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  // Large fixtures can trigger detached Git maintenance, racing directory teardown.
  git('config', 'gc.auto', '0'); git('config', 'maintenance.auto', 'false')
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `base${i}.js`), text(i))
  git('add', '.'); git('commit', '-qm', 'synthetic graph')
  const base = git('rev-parse', 'HEAD'), room = new RoomDoc()
  setParticipantBase(room, 'A', base); setFixtureLocalRoot(room, 'A', dir)
  return { room, dir, base, cleanup: () => { room.doc.destroy(); rmSync(dir, { recursive: true, force: true }) } }
}

it('recovers graph coverage after a parser crash without an external refresh event', async () => {
  const f = fixture(2), threads: Worker[] = []
  const parser = new ParseWorker({ restartCooldownMs: 100, createWorker: () => {
    const crash = !threads.length
    const thread = new Worker(`const {parentPort} = require('node:worker_threads'); parentPort.on('message', ({id,texts}) => {
      if (${crash}) throw new Error('synthetic parser crash');
      parentPort.postMessage({id,parsed:texts.map(text => text === undefined ? undefined : {defs:[{name:'recovered',from:1,to:1,signature:'function recovered()'}],refs:[],ownRefs:[],imports:[]})});
    });`, { eval: true })
    threads.push(thread); return thread
  } })
  const gi = new GraphIndex(f.room, 'A', f.dir, vi.fn(), { random: () => 0, minPublishMs: 0, parser })
  try {
    gi.start(); await gi.whenIdle()
    expect(gi.isReady).toBe(false)
    await eventually(() => gi.isReady && gi.graph.size === 2)
    expect(gi.graph.definersOf('recovered')).toHaveLength(2)
    expect(threads).toHaveLength(2)
  } finally { gi.stop(); parser.stop(); await Promise.all(threads.map(thread => thread.terminate())); f.cleanup() }
})

it('keeps exhausted parser failures degraded instead of scheduling a restart storm', async () => {
  const f = fixture(2), createWorker = vi.fn(() => new Worker('throw new Error("synthetic permanent crash")', { eval: true }))
  const parser = new ParseWorker({ maxRestarts: 0, restartCooldownMs: 10, createWorker, log: vi.fn() })
  const gi = new GraphIndex(f.room, 'A', f.dir, vi.fn(), { random: () => 0, minPublishMs: 0, parser })
  try {
    gi.start(); await gi.whenIdle(); await sleep(100)
    expect(gi.isReady).toBe(false)
    expect(createWorker).toHaveBeenCalledTimes(1)
  } finally { gi.stop(); parser.stop(); f.cleanup() }
})

it('caps combined base, overlay and event admission and prioritizes own changes and claims', async () => {
  const f = fixture(5), log = vi.fn()
  writeFileSync(join(f.dir, 'own.js'), 'export function owned() {}')
  publishFixture(f.room, 'A', 'own.js', 'export function owned() {}', { base: f.base })
  f.room.addClaim({ path: 'base4.js', from: 1, to: 1, by: 'A', byKind: 'agent', intent: 'claimed priority' })
  const gi = new GraphIndex(f.room, 'A', f.dir, log, { random: () => 0, minPublishMs: 0, maxPaths: 3 })
  try {
    gi.start(); await gi.whenIdle()
    expect(gi.graph.size).toBeLessThanOrEqual(3)
    expect(gi.graph.has('own.js')).toBe(true)
    expect(gi.graph.has('base4.js')).toBe(true)
    for (let i = 0; i < 30; i++) {
      const path = `overlay${String(i).padStart(2, '0')}.js`, text = `export function overlay${i}() {}`
      writeFileSync(join(f.dir, path), text); publishFixture(f.room, 'A', path, text, { base: f.base })
    }
    await gi.whenIdle()
    expect(gi.graph.size).toBeLessThanOrEqual(3)
    await eventually(() => f.room.graphs.get('A')?.truncated === true)
    expect(f.room.graphs.get('A')?.uncoveredPaths?.length).toBeGreaterThan(0)
    expect(log.mock.calls.filter(([line]) => line.includes('retained graph budget'))).toHaveLength(1)
    expect(f.room.graphs.get('A')?.paths.every(path => gi.graph.has(path))).toBe(true)
  } finally { gi.stop(); f.cleanup() }
})

it('bounds retained symbols across both graphs, refunds removals and declines dense files', async () => {
  const f = fixture(8), gi = new GraphIndex(f.room, 'A', f.dir, undefined,
    { random: () => 0, minPublishMs: 0, maxRetainedSymbols: 12, maxSymbolsPerFile: 4 })
  try {
    gi.start(); await gi.whenIdle()
    expect(gi.retainedBudgetForTest.symbols).toBeLessThanOrEqual(12)
    expect(gi.graph.size).toBe(3) // each path retains two defs+refs pairs: local and published.
    const kept = f.room.graphs.get('A')!.paths[0]!
    rmSync(join(f.dir, kept)); deleteFixture(f.room, 'A', kept, { base: f.base })
    await gi.whenIdle()
    expect(gi.retainedBudgetForTest.symbols).toBeLessThan(12)
    await gi.refresh('base7.js'); await gi.whenIdle()
    expect(gi.graph.has('base7.js')).toBe(true)
    const dense = Array.from({ length: 5 }, (_, i) => `export function dense${i}(){}`).join('\n')
    writeFileSync(join(f.dir, 'dense.js'), dense); publishFixture(f.room, 'A', 'dense.js', dense, { base: f.base })
    await gi.whenIdle()
    expect(gi.graph.has('dense.js')).toBe(false)
    await eventually(() => f.room.graphs.get('A')?.uncoveredPaths?.includes('dense.js') ?? false)
    expect(gi.retainedBudgetForTest.symbols).toBeLessThanOrEqual(12)
  } finally { gi.stop(); f.cleanup() }
})

it('shares retained accounting across rooms and refunds a stopped index', async () => {
  const f = fixture(3), other = new RoomDoc(); setParticipantBase(other, 'B', f.base)
  const first = new GraphIndex(f.room, 'A', f.dir, undefined, { random: () => 0, minPublishMs: 0, maxRetainedSymbols: 12 })
  const second = new GraphIndex(other, 'B', f.dir, undefined, { random: () => 0, minPublishMs: 0, maxRetainedSymbols: 12 })
  try {
    first.start(); await first.whenIdle(); second.start(); await second.whenIdle()
    expect(first.retainedBudgetForTest.processSymbols).toBeLessThanOrEqual(12)
    expect(second.graph.size).toBe(0)
    first.stop()
    await second.refresh('base0.js'); await second.whenIdle()
    expect(second.graph.has('base0.js')).toBe(true)
    expect(second.retainedBudgetForTest.processSymbols).toBeLessThanOrEqual(12)
  } finally { first.stop(); second.stop(); other.doc.destroy(); f.cleanup() }
})

it('bounds many dense valid base files by their retained symbol weight', async () => {
  const f = fixture(12, i => Array.from({ length: 50 }, (_, n) => `export function dense${i}_${n}(){return external${i}_${n}();}`).join('\n'))
  const gi = new GraphIndex(f.room, 'A', f.dir, undefined,
    { random: () => 0, minPublishMs: 0, maxRetainedSymbols: 600, maxSymbolsPerFile: 200 })
  try {
    gi.start(); await gi.whenIdle()
    expect(gi.graph.size).toBe(3)
    expect(gi.retainedBudgetForTest.symbols).toBe(600)
    expect(f.room.graphs.get('A')?.uncoveredPaths).toHaveLength(9)
    expect(f.room.graphs.get('A')?.truncated).toBe(true)
  } finally { gi.stop(); f.cleanup() }
})

it('withdraws old published facts when replacement exceeds the symbol or byte allowance', async () => {
  const f = fixture(1), gi = new GraphIndex(f.room, 'A', f.dir, undefined,
    { random: () => 0, minPublishMs: 0, maxRetainedBytes: 4096, maxSymbolsPerFile: 4 })
  try {
    gi.start(); await gi.whenIdle()
    expect(gi.graph.has('base0.js')).toBe(true)
    const text = `export function ${'L'.repeat(4000)}(){}`
    writeFileSync(join(f.dir, 'base0.js'), text); publishFixture(f.room, 'A', 'base0.js', text, { base: f.base })
    await gi.whenIdle()
    expect(gi.graph.has('base0.js')).toBe(false)
    await eventually(() => f.room.graphs.get('A')?.uncoveredPaths?.includes('base0.js') ?? false)
    expect(f.room.graphs.get('A')?.paths).not.toContain('base0.js')
    expect(gi.retainedBudgetForTest.bytes).toBeLessThanOrEqual(4096)
    clearFixture(f.room, 'A', 'base0.js')
  } finally { gi.stop(); f.cleanup() }
})

it('declining a single oversized own path preserves affordable base facts', async () => {
  const f = fixture(3), gi = new GraphIndex(f.room, 'A', f.dir, undefined,
    { random: () => 0, minPublishMs: 0, maxRetainedBytes: 4096 })
  try {
    gi.start(); await gi.whenIdle(); expect(gi.graph.size).toBe(3)
    const text = `export function ${'L'.repeat(4000)}(){}`
    writeFileSync(join(f.dir, 'own.js'), text); publishFixture(f.room, 'A', 'own.js', text, { base: f.base })
    await gi.whenIdle()
    expect(gi.graph.size).toBe(3)
    expect(gi.graph.has('own.js')).toBe(false)
  } finally { gi.stop(); f.cleanup() }
})

it('promotes a newly claimed path ahead of other base paths', async () => {
  const f = fixture(4), gi = new GraphIndex(f.room, 'A', f.dir, undefined,
    { random: () => 0, minPublishMs: 0, maxPaths: 2 })
  try {
    gi.start(); await gi.whenIdle(); expect(gi.graph.has('base3.js')).toBe(false)
    f.room.addClaim({ path: 'base3.js', from: 1, to: 1, by: 'A', byKind: 'agent', intent: 'new claimed priority' })
    await eventually(() => gi.graph.has('base3.js'))
    expect(gi.graph.size).toBeLessThanOrEqual(2)
    expect(gi.graph.has('base1.js')).toBe(false)
  } finally { gi.stop(); f.cleanup() }
})

it('bounds queued refresh metadata during reverse-priority overlay bursts', async () => {
  const f = fixture(4)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const read = vi.fn(async () => { await gate; return 'export function base() {}' })
  const gi = new GraphIndex(f.room, 'A', f.dir, undefined,
    { random: () => 0, minPublishMs: 0, maxPaths: 3, read })
  try {
    gi.start(); await eventually(() => read.mock.calls.length >= 3)
    for (let i = 199; i >= 0; i--) publishFixture(f.room, 'A', `overlay${String(i).padStart(3, '0')}.js`, 'export function overlay() {}', { base: f.base })
    const total = Number(gi.indexingStatus.match(/of (\d+)/)?.[1])
    expect(total).toBeLessThanOrEqual(3 + 8) // admitted paths plus the bounded active refreshes.
    release(); await gi.whenIdle(); expect(gi.graph.size).toBeLessThanOrEqual(3)
  } finally { release(); gi.stop(); f.cleanup() }
})

const cheapParser = () => ({ stop: vi.fn(), parse: vi.fn(async (_path: string, texts: (string | undefined)[]) => texts.map(text =>
  text === undefined ? undefined : { defs: [{ name: 'synthetic', kind: 'function', from: 1, to: 1, signature: 'function synthetic()' }], refs: [], ownRefs: [], imports: [] })) })

it('coalesces 500 published-path withdrawals into one immediate guarded snapshot', async () => {
  const f = fixture(501), options = { random: () => 0, minPublishMs: 60_000, maxPaths: 501, parser: cheapParser(), read: async () => 'function synthetic() {}' }
  const gi = new GraphIndex(f.room, 'A', f.dir, undefined, options)
  try {
    gi.start(); await gi.whenIdle(); expect(f.room.graphs.get('A')?.paths).toHaveLength(501)
    const set = vi.spyOn(f.room.graphs, 'set')
    // Rebuild admissions in one observer pass: changed paths displace 500 published base paths.
    for (let i = 0; i < 500; i++) writeFileSync(join(f.dir, `own${i}.js`), 'function synthetic() {}')
    f.room.doc.transact(() => {
      for (let i = 0; i < 500; i++) publishFixture(f.room, 'A', `own${i}.js`, 'function synthetic() {}', { base: f.base })
    })
    await gi.whenIdle()
    await eventually(() => f.room.graphs.get('A')?.paths.filter(path => path.startsWith('base')).length === 1)
    expect(set).toHaveBeenCalledTimes(1)
    expect(f.room.graphs.get('A')?.paths.filter(path => path.startsWith('base'))).toEqual(['base0.js'])
    set.mockRestore()
  } finally { gi.stop(); f.cleanup() }
})

it('rebuilds 3000 paths and 20 claims with linear priority scans in under one second', async ({ task }) => {
  const timings: Record<string, number> = {}
  const profile = Object.assign(task.meta, { phase: 'fixture', timings, claimScans: 0 })
  // The injected reader/parser already use identical content. Keep 3000 real
  // Git paths but share one blob instead of writing 3000 unused loose objects.
  const setup = performance.now(), f = fixture(3000, () => 'function synthetic() {}'), parser = cheapParser()
  timings.fixture = performance.now() - setup
  for (let i = 0; i < 20; i++) f.room.addClaim({ path: `base${i}.js`, from: 1, to: 1, by: 'A', byKind: 'agent', intent: 'priority scale' })
  const original = f.room.openClaims.bind(f.room)
  let calls = 0
  const claims = vi.spyOn(f.room, 'openClaims').mockImplementation(() => {
    if (++calls > 3000) throw new Error('priority scan is superlinear')
    return original()
  })
  const gi = new GraphIndex(f.room, 'A', f.dir, undefined,
    { random: () => 0, minPublishMs: 0, parser, read: async () => 'function synthetic() {}' })
  try {
    profile.phase = 'rebuild'
    const start = performance.now()
    gi.start(); await gi.whenIdle()
    timings.rebuild = performance.now() - start
    profile.claimScans = calls
    expect(gi.graph.size).toBe(3000)
    expect(parser.parse).toHaveBeenCalledTimes(3000)
    expect(calls).toBeLessThanOrEqual(3000)
    expect(performance.now() - start).toBeLessThan(1000)
  } finally {
    profile.phase = 'cleanup'
    const start = performance.now()
    claims.mockRestore(); gi.stop(); f.cleanup()
    timings.cleanup = performance.now() - start
    profile.phase = 'finished'
  }
})
