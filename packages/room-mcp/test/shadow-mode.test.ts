// Mode and intermediate-motion regressions run in default and TEST_SCALE=1 passes.
import './shadow-git-fixture.js'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ShadowGraph } from '../src/shadow-graph.js'
import * as snapshots from '../src/shadow-snapshot.js'
import { repo, put, git } from './worker-refresh-fixture.js'
import { stabilityFixture, delayedConflict } from './shadow-stability-fixture.js'

afterEach(() => vi.restoreAllMocks())
const noExecutableBit = process.platform === 'win32'

it.skipIf(noExecutableBit)('rejects an executable-bit change although file bytes remain equal', async () => {
  const graph = new ShadowGraph(path.join(repo, '.git/room/shadow/mode'), repo)
  await graph.init()
  try {
    put(repo, 'new-file', 'same bytes\n'); fs.chmodSync(path.join(repo, 'new-file'), 0o644)
    const base = git(repo, 'rev-parse', 'HEAD'), first = await snapshots.captureShadow(graph, repo, base)
    fs.chmodSync(path.join(repo, 'new-file'), 0o755)
    expect(await first.current()).toBe(false)
    const fresh = await snapshots.captureShadow(graph, repo, base)
    expect(first.entries.get('new-file')?.mode).toBe('100644')
    expect(fresh.entries.get('new-file')?.mode).toBe('100755')
    const ancestor = await graph.event('base', await graph.tree(await graph.entries(base)), [])
    const left = await graph.event('left', await graph.tree(first.entries), [ancestor])
    const right = await graph.event('right', await graph.tree(fresh.entries), [ancestor])
    expect((await graph.compare(left, right)).paths).toContain('new-file')
  } finally { graph.abort(); await fs.promises.rm(graph.root, { recursive: true, force: true }) }
})

it.skipIf(noExecutableBit)('does not append a stale clean row after chmod immediately following comparison', async () => {
  const f = await stabilityFixture(), state = f.shadow as any
  try {
    put(f.d.dir, 'new-file', 'D\n'); put(f.u.dir, 'new-file', 'U\n')
    for (const worker of [f.d, f.u]) fs.chmodSync(path.join(worker.dir, 'new-file'), 0o644)
    await f.publish(1); await f.settle()
    put(f.u.dir, 'new-file', 'D\n'); await f.publish(2); await state.pass()
    expect(state.pending.size).toBeGreaterThan(0)
    const compare = f.shadow.graph.compare.bind(f.shadow.graph)
    let pairs = 0
    vi.spyOn(f.shadow.graph, 'compare').mockImplementation(async (...args) => {
      const result = await compare(...args)
      if (++pairs === 3) fs.chmodSync(path.join(f.u.dir, 'new-file'), 0o755)
      return result
    })
    f.advance(60_001); await state.pass()
    expect(pairs).toBe(3); expect(f.rows()).toEqual([]); expect(state.pending.size).toBe(0)
    const a = state.actors.get(f.d.name), b = state.actors.get(f.u.name)
    const fresh = await snapshots.captureShadow(f.shadow.graph, f.u.dir, b.base, b.carried)
    const changed = await f.shadow.graph.event('fresh-mode', await f.shadow.graph.tree(fresh.entries), [b.node])
    expect((await compare(a.node, changed)).paths).toContain('new-file')
  } finally { f.shadow.stop(); await state.cleanup }
}, 30_000)

it('resets the episode when an unrelated path moves and is restored after its pair check', async () => {
  const f = await stabilityFixture(), state = f.shadow as any
  const file = path.join(f.d.dir, 'keep.txt'), original = fs.readFileSync(file, 'utf8')
  fs.utimesSync(file, 1_000_000_000, 1_000_000_000)
  try {
    await delayedConflict(f); await state.pass()
    expect(state.pending.size).toBeGreaterThan(0)
    const compare = f.shadow.graph.compare.bind(f.shadow.graph), capture = snapshots.captureShadow
    let pairs = 0, moved = false, restored = false
    vi.spyOn(f.shadow.graph, 'compare').mockImplementation(async (...args) => {
      const result = await compare(...args)
      if (++pairs === 3) { fs.writeFileSync(file, 'unpublished edit\n'); moved = true }
      return result
    })
    vi.spyOn(snapshots, 'captureShadow').mockImplementation(async (...args) => {
      const result = await capture(...args), current = result.current
      result.current = async () => {
        const valid = await current()
        if (args[1] === f.d.dir && moved && !restored) {
          fs.writeFileSync(file, original); fs.utimesSync(file, 1_000_000_000, 1_000_000_000); restored = true
        }
        return valid
      }
      return result
    })
    f.advance(60_001); await state.pass()
    expect(pairs).toBe(3); expect(restored).toBe(true)
    expect(f.rows()).toEqual([]); expect(state.pending.size).toBe(0)
  } finally { f.shadow.stop(); await state.cleanup }
}, 30_000)
