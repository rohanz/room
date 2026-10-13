import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import { GraphIndex } from '../src/graph-index.js'
import { HooksBridge } from '../src/hooks-bridge.js'
import type { Session } from '../src/session.js'

afterEach(() => vi.useRealTimers())

describe('independent memory-hardening adversarial cases', () => {
  it('bounds snapshots when legal path names alone exceed the body budget', async () => {
    const room = new RoomDoc()
    const gi = new GraphIndex(room,'tester','/tmp/synthetic-unused',undefined,{minPublishMs:0})
    const internal=gi as any
    internal.base='b'.repeat(40)
    for(let i=0;i<1000;i++) {
      const p=`${'x'.repeat(225)}${String(i).padStart(4,'0')}.js`
      internal.publishedCache.set(p,{defs:[],refs:[]})
      internal.publishedSource.set(p,{kind:'base',base:internal.base})
      internal.publishedGraph.set(p,'')
    }
    try {
      await internal.publishSnapshot('ready',0)
      const snapshot=room.graphs.get('tester')!
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(200*1024)
      expect(snapshot.truncated).toBe(true)
      expect(snapshot.paths.length).toBeLessThan(1000)
      expect(snapshot.edges.every(edge=>snapshot.paths.includes(edge.source)&&snapshot.paths.includes(edge.target))).toBe(true)
    } finally {gi.stop();room.doc.destroy()}
  })

  for (const extra of [0, 1]) it(`preserves edges at the byte limit and drops them at limit + ${extra}`, async () => {
    const room = new RoomDoc()
    const gi = new GraphIndex(room, 'tester', '/tmp/synthetic-unused', undefined, { minPublishMs: 0 })
    const internal = gi as any
    internal.base = 'synthetic-base'
    const paths = ['a.js', 'b.js']
    const emptyEdge = { source: 'a.js', target: 'b.js', symbols: [''] }
    const overhead = Buffer.byteLength(JSON.stringify({ paths, edges: [emptyEdge], observed: [], uncoveredPaths: [], uncoveredTruncated: false }))
    // Include JSON escapes and UTF-8 bytes rather than equating character count with bytes.
    const prefix = '\"\\\né'
    const encodedPrefix = Buffer.byteLength(JSON.stringify(prefix)) - 2
    const symbol = prefix + 'x'.repeat(200 * 1024 - 512 - overhead - encodedPrefix + extra)
    for (const p of paths) {
      internal.publishedCache.set(p, { defs: [], refs: [] })
      internal.publishedSource.set(p, { kind: 'base', base: internal.base })
    }
    vi.spyOn(internal.publishedGraph, 'dependenciesOf').mockImplementation((p: unknown) => p === 'b.js' ? [{ symbol, definedIn: ['a.js'] }] : [])
    try {
      await internal.publishSnapshot('ready', 0)
      const snapshot = room.graphs.get('tester')!
      expect(snapshot.edges.every(edge=>snapshot.paths.includes(edge.source)&&snapshot.paths.includes(edge.target))).toBe(true)
      expect(snapshot.truncated).toBe(extra === 1)
      expect(snapshot.edges).toEqual(extra ? [] : [{ source: 'a.js', target: 'b.js', symbols: [symbol] }])
      expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(200 * 1024)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('does not launch a dirty hook rerun after stopping during an in-flight failure', async () => {
    const room = new RoomDoc()
    const s = { room, me: { name: 'tester' } } as Session
    const log = vi.fn()
    const bridge = new HooksBridge(s, { owedCount: () => 0, fenced: () => true, sessionDir: () => undefined, log })
    let reject!: (e: Error) => void
    const write = vi.spyOn(bridge, 'write').mockImplementation(() => new Promise<void>((_, r) => { reject = r }))
    vi.useFakeTimers()
    try {
      bridge.scheduleWrite(); await vi.advanceTimersByTimeAsync(150)
      bridge.scheduleWrite(); await vi.advanceTimersByTimeAsync(150)
      bridge.stop()
      reject(new Error('synthetic delayed failure'))
      await vi.advanceTimersByTimeAsync(1000)
      expect(write).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledTimes(1)
    } finally { bridge.stop(); room.doc.destroy() }
  })

  it('recovers a failed hook pass once for dirty activity, without overlapping passes', async () => {
    const room = new RoomDoc()
    const s = { room, me: { name: 'tester' } } as Session
    const log = vi.fn()
    const bridge = new HooksBridge(s, { owedCount: () => 0, fenced: () => true, sessionDir: () => undefined, log })
    let reject!: (e: Error) => void
    const write = vi.spyOn(bridge, 'write').mockImplementationOnce(() => new Promise<void>((_, r) => { reject = r })).mockResolvedValue(undefined)
    vi.useFakeTimers()
    try {
      bridge.scheduleWrite(); await vi.advanceTimersByTimeAsync(150)
      for (let i = 0; i < 20; i++) bridge.scheduleWrite()
      await vi.advanceTimersByTimeAsync(150)
      expect(write).toHaveBeenCalledTimes(1)
      reject(new Error('synthetic delayed failure'))
      await vi.advanceTimersByTimeAsync(1000)
      expect(write).toHaveBeenCalledTimes(2)
      expect(log).toHaveBeenCalledTimes(1)
    } finally { bridge.stop(); room.doc.destroy() }
  })
})
