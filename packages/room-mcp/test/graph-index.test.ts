import { clearFixture, deleteFixture, publishFixture, setFixtureLocalRoot } from './fixtures/manifest.js'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc, type Msg } from '@room/shared'
import { setParticipantBase } from '@room/shared/testing'
import * as gitModule from '@room/roomd/git'
import { languageLoadAttemptsForTest } from '../src/parse/engine.js'
import { ParseWorker } from '../src/parse/client.js'
import { GraphIndex, consumesSymbol } from '../src/graph-index.js'
import { handlers as fileHandlers } from '../src/tools/files.js'
import { createInbox } from '../src/tools/messaging.js'
import type { Session } from '../src/session.js'
import type { HandlerState } from '../src/tools/context.js'
import { closeRegistryForDir } from '../src/worker-registry.js'
import { seedRegistryWorker } from './registry-fixture.js'

let dir: string, base: string
async function eventually(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition not met before timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-graph-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(dir, 'utils.py'), 'def validate_token(t):\n    return t\n')
  writeFileSync(join(dir, 'session.py'), 'from utils import validate_token\n\ndef login(t):\n    return validate_token(t)\n')
  writeFileSync(join(dir, 'README.md'), 'not code\n')
  git('add', '.'); git('commit', '-qm', 'init'); base = git('rev-parse', 'HEAD').trim()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('GraphIndex', () => {
  it('reports a declined supported parser as uncovered and recovers when parsing succeeds', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    const log = vi.fn()
    const original = ParseWorker.prototype.parse
    const parse = vi.spyOn(ParseWorker.prototype, 'parse').mockImplementation(function(path, texts) {
      return path === 'declined.ts' ? Promise.resolve(texts.map(() => undefined)) : original.call(this, path, texts)
    })
    const gi = new GraphIndex(room, 'Rohan', dir, log, { minPublishMs: 0, random: () => 0 })
    try {
      publishFixture(room, 'Rohan', 'declined.ts', 'function Added(x: number){return x}', { base })
      gi.start(); await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready')
      expect(room.graphs.get('Rohan')?.uncoveredPaths).toEqual(['declined.ts'])
      expect(gi.isReady).toBe(true)
      expect(room.graphs.get('Rohan')?.observed).toEqual([])
      const warnings = () => log.mock.calls.filter(([line]) => line.includes('parser-unavailable'))
      expect(warnings()).toHaveLength(1)
      await gi.refresh('declined.ts'); await gi.whenIdle()
      expect(warnings()).toHaveLength(1)
      parse.mockRestore()
      await gi.refresh('declined.ts'); await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.observed?.some(change => change.symbol === 'Added') ?? false)
      expect(room.graphs.get('Rohan')?.uncoveredPaths).toEqual([])
      expect(gi.contractCoverageNote).toBe('')
    } finally { parse.mockRestore(); gi.stop(); room.doc.destroy(); rmSync(join(dir, 'declined.ts'), { force: true }) }
  })

  it('marks a certified shared entry with no local file unavailable instead of inventing additions', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
    const text = 'function existing(x){return x}\n'
    const read = vi.fn(async (_dir: string, _sha: string, path: string) => path === 'missing.js' ? text : gitModule.gitShow(_dir, _sha, path))
    const log = vi.fn()
    const gi = new GraphIndex(room, 'Rohan', dir, log, { minPublishMs: 0, random: () => 0, read })
    try {
      publishFixture(room, 'Rohan', 'missing.js', text, { base })
      expect(fs.existsSync(join(dir, 'missing.js'))).toBe(false)
      gi.start(); await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready')
      expect(room.graphs.get('Rohan')?.observed).toEqual([])
      expect(room.graphs.get('Rohan')?.uncoveredPaths).toEqual(['missing.js'])
      expect(log.mock.calls.some(([line]) => line.includes('local-text-unavailable'))).toBe(true)
      const fence = room.manifestHead.get('Rohan')!.fence
      room.clearOverlay(`Rohan\0${fence}`, 'missing.js')
      await gi.refresh('missing.js'); await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.uncoveredPaths?.includes('missing.js') ?? false)
      expect((gi as any).uncoveredPaths.has('missing.js')).toBe(true)
      expect(room.graphs.get('Rohan')?.observed).toEqual([])
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('keeps edges while bounding long uncovered paths by snapshot bytes', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
    const paths = Array.from({ length: 200 }, (_, i) => `${Array.from({ length: 7 }, () => 'x'.repeat(200)).join('/')}/${String(i).padStart(4, '0')}.js`)
    for (const path of paths) publishFixture(room, 'Rohan', path, 'function incomplete\n', { base })
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0 })
    try {
      Object.assign(gi, { base, uncoveredPaths: new Set(paths) })
      for (const [path, symbols] of [
        ['utils.py', { defs: ['validate_token'], refs: [] }],
        ['session.py', { defs: ['login'], refs: ['validate_token'] }],
      ] as const) {
        ;(gi as any).publishedCache.set(path, symbols)
        ;(gi as any).publishedSource.set(path, { kind: 'base', base })
        ;(gi as any).publishedGraph.set(path, '')
      }
      await (gi as any).publishSnapshot('ready', 0)
      const graph = room.graphs.get('Rohan')!
      expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThanOrEqual(200 * 1024)
      expect(graph.uncoveredPaths!.length).toBeLessThan(200)
      expect(graph.uncoveredTruncated).toBe(true)
      expect(graph.truncated).toBe(false)
      expect(graph.edges).toEqual([{ source: 'utils.py', target: 'session.py', symbols: ['validate_token'] }])
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('treats a byte-oversized own file as uncovered instead of inventing additions from an empty base', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    const text = '/*' + 'é'.repeat(140 * 1024) + '*/\nfunction existing(x){return x}\n'
    const read = vi.fn(async (_dir: string, _sha: string, path: string) => path === 'unicode.js' ? text : gitModule.gitShow(_dir, _sha, path))
    const log = vi.fn()
    const gi = new GraphIndex(room, 'Rohan', dir, log, { minPublishMs: 0, random: () => 0, read })
    try {
      publishFixture(room, 'Rohan', 'unicode.js', text.replace('return x', 'return x+1'), { base })
      gi.start(); await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready')
      expect(room.graphs.get('Rohan')?.observed).toEqual([])
      expect(room.graphs.get('Rohan')?.uncoveredPaths).toEqual(['unicode.js'])
      expect(gi.contractCoverageNote).toContain('unicode.js')
      expect(log.mock.calls.some(([line]) => line.includes('local-text-unavailable'))).toBe(true)
    } finally { gi.stop(); room.doc.destroy(); rmSync(join(dir, 'unicode.js'), { force: true }) }
  })

  it('withdraws uncovered path names and the coverage note synchronously when sharing becomes intent', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0, random: () => 0 })
    try {
      publishFixture(room, 'Rohan', 'large.js', '/*' + 'x'.repeat(257 * 1024) + '*/', { base })
      gi.start(); await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.uncoveredPaths?.length === 1)
      room.manifestHead.set('Rohan', { ...room.manifestHead.get('Rohan')!, level: 'intent' })
      expect(room.graphs.get('Rohan')?.uncoveredPaths).toEqual([])
      expect(gi.contractCoverageNote).toBe('')
    } finally { gi.stop(); room.doc.destroy(); rmSync(join(dir, 'large.js'), { force: true }) }
  })

  it('marks an existing unreadable own file uncovered without inventing an empty baseline', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    const log = vi.fn()
    const gi = new GraphIndex(room, 'Rohan', dir, log, { minPublishMs: 0, random: () => 0 })
    publishFixture(room, 'Rohan', 'unreadable.js', 'function existing(){}', { base })
    const realOpen = fs.openSync
    const open = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]).endsWith('/unreadable.js')) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
      return realOpen(...args)
    })
    try {
      gi.start(); await gi.whenIdle()
      expect((gi as any).uncoveredPaths.has('unreadable.js'), JSON.stringify(log.mock.calls)).toBe(true)
      expect((gi as any).observedByPath.has('unreadable.js')).toBe(false)
      expect(gi.isReady).toBe(true)
    } finally { open.mockRestore(); gi.stop(); room.doc.destroy(); rmSync(join(dir, 'unreadable.js'), { force: true }) }
  })

  it('bounds a sorted list of 1000 authorized long-named uncovered paths separately from graph truncation', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
    const paths = Array.from({ length: 1000 }, (_, i) => `generated/${'a'.repeat(120)}/${'b'.repeat(120)}/${String(i).padStart(4, '0')}.js`)
    for (const path of paths) publishFixture(room, 'Rohan', path, 'function incomplete\n', { base })
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0 })
    try {
      Object.assign(gi, { base, uncoveredPaths: new Set(paths.reverse()) })
      await (gi as any).publishSnapshot('ready', 0)
      const graph = room.graphs.get('Rohan')!
      expect(graph.uncoveredPaths).toEqual([...paths].sort().slice(0, 200))
      expect((graph as any).uncoveredTruncated).toBe(true)
      expect(graph.truncated).toBe(false)
      expect(graph.observedTruncated).toBe(false)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('reports oversized contract text as uncovered without blocking readiness, then recovers coverage', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    const log = vi.fn()
    const gi = new GraphIndex(room, 'Rohan', dir, log, { minPublishMs: 0, random: () => 0 })
    try {
      publishFixture(room, 'Rohan', 'large.js', '/*' + 'x'.repeat(257 * 1024) + '*/', { base })
      gi.start(); await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready')
      expect((gi as any).observedByPath.has('large.js')).toBe(false)
      expect((gi as any).uncoveredPaths.has('large.js')).toBe(true)
      expect((gi as any).degradedPaths.has('large.js')).toBe(false)
      expect(gi.isReady).toBe(true)
      expect(gi.indexingStatus).toContain('not covered')
      expect(gi.contractCoverageNote).toContain('not covered: large.js')
      const impact = fileHandlers({ S: () => ({ room, graph: gi }), describeUsers: (_s: unknown, users: string[]) => users.join(', ') } as unknown as HandlerState).room_impact!
      expect(await impact({ symbol: 'missing' })).toContain('not covered: large.js')
      const inbox = createInbox({ others: () => [], upgraded: new Set() } as unknown as Parameters<typeof createInbox>[0])
      const session = { room, graph: gi, me: { name: 'Rohan', kind: 'agent' } } as Session
      expect((await inbox.waitingOn(session)).join('\n')).toContain('not covered: large.js')
      expect((await inbox.upgrade(session, { type: 'changed' } as Msg, [], ['missing'])).join('\n')).toContain('not covered: large.js')
      expect((room.graphs.get('Rohan') as any)?.uncoveredPaths).toEqual(['large.js'])
      expect(room.graphs.get('Rohan')?.observedTruncated).toBe(false)
      const warnings = () => log.mock.calls.filter(([line]) => line.includes('over the 256 KB contract analysis cap'))
      expect(warnings()).toHaveLength(1)
      await gi.refresh('large.js'); await gi.whenIdle()
      expect(warnings()).toHaveLength(1)
      publishFixture(room, 'Rohan', 'large.js', '/*' + 'x'.repeat(100 * 1024) + '*/\nfunction Added(x){return x}\n', { base })
      await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.observed?.some(change => change.symbol === 'Added') ?? false)
      expect((gi as any).uncoveredPaths.has('large.js')).toBe(false)
      expect(gi.contractCoverageNote).toBe('')
      expect(room.graphs.get('Rohan')?.observed?.filter(change => change.path === 'large.js')).toEqual([
        { path: 'large.js', symbol: 'Added', kind: 'add', detail: 'now `function Added(x)`' },
      ])
    } finally { gi.stop(); room.doc.destroy(); rmSync(join(dir, 'large.js'), { force: true }) }
  })

  it('reports too many parsed definitions as uncovered rather than partial observed changes', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0, random: () => 0 })
    try {
      publishFixture(room, 'Rohan', 'many.js', Array.from({ length: 4001 }, (_, i) => `function f${i}(){}`).join('\n'), { base })
      gi.start(); await gi.whenIdle()
      expect((gi as any).uncoveredPaths.has('many.js')).toBe(true)
      expect((gi as any).observedByPath.has('many.js')).toBe(false)
      expect(gi.isReady).toBe(true)
    } finally { gi.stop(); room.doc.destroy(); rmSync(join(dir, 'many.js'), { force: true }) }
  })

  it('reuses immutable base facts in a fresh replica without rereading unchanged files', async () => {
    const old = new RoomDoc(); setParticipantBase(old, 'Rohan', base)
    const first = new GraphIndex(old, 'Rohan', dir, undefined, { random: () => 0 })
    const fresh = new RoomDoc(); setParticipantBase(fresh, 'Rohan', base)
    let next: GraphIndex | undefined
    try {
      first.start(); await first.whenIdle()
      const seed = first.baseSeed()
      expect(seed.files.size).toBe(2)
      first.stop(); old.doc.destroy()
      const read = vi.fn(async () => { throw new Error('unchanged base must not be reread') })
      next = new GraphIndex(fresh, 'Rohan', dir, undefined, { random: () => 0, seed, read })
      next.start(); await next.whenIdle()
      expect(read).not.toHaveBeenCalled()
      expect(next.graph.impact('validate_token').usedIn).toEqual(['session.py'])
      expect(next.isReady).toBe(true)
    } finally { first.stop(); next?.stop(); fresh.doc.destroy() }
  })

  it('rechecks changed paths and sharing after carrying base facts to another replica', async () => {
    const old = new RoomDoc(); setParticipantBase(old, 'Rohan', base)
    const first = new GraphIndex(old, 'Rohan', dir, undefined, { random: () => 0 })
    const fresh = new RoomDoc(); setParticipantBase(fresh, 'Rohan', base)
    let next: GraphIndex | undefined
    try {
      first.start(); await first.whenIdle()
      const seed = first.baseSeed()
      first.stop()
      publishFixture(fresh, 'Peer', 'utils.py', 'def replacement(t): return t\n', { base })
      // Establish an intent-only own head without changing either source file.
      publishFixture(fresh, 'Rohan', 'README.md', 'private\n', { base, level: 'intent' })
      next = new GraphIndex(fresh, 'Rohan', dir, undefined, { random: () => 0, seed })
      next.start(); await next.whenIdle()
      expect(next.graph.definersOf('validate_token')).toEqual([])
      expect(next.graph.definersOf('replacement')).toEqual(['utils.py'])
      expect(fresh.graphs.get('Rohan')?.paths ?? []).toEqual([])
    } finally { first.stop(); next?.stop(); old.doc.destroy(); fresh.doc.destroy() }
  })

  it('does not reuse base facts under a different base identity', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
    const read = vi.fn(gitModule.gitShow)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, read,
      seed: { dir, base: 'another-commit', files: new Map([['utils.py', { defs: ['stale'], refs: [] }]]) } })
    try {
      gi.start(); await gi.whenIdle()
      expect(read).toHaveBeenCalled()
      expect(gi.graph.definersOf('stale')).toEqual([])
      expect(gi.graph.definersOf('validate_token')).toEqual(['utils.py'])
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('answers an empty index without claiming that zero files are still indexing', async () => {
    const room = new RoomDoc()
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0 })
    const impact = fileHandlers({ S: () => ({ room, graph: gi }) } as unknown as HandlerState).room_impact!
    try {
      expect(gi.isReady).toBe(true)
      gi.start(); await gi.whenIdle()
      expect(gi.isReady).toBe(true)
      expect(gi.indexingStatus).not.toContain('still indexing')
      expect(await impact({ symbol: 'missing' })).toContain('defined in nowhere indexed')
    } finally { gi.stop(); room.doc.destroy() }
  })

  it.each(['initial', 'rebuild'] as const)('stays unready during %s discovery before files are queued', async mode => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0 })
    const impact = fileHandlers({ S: () => ({ room, graph: gi }) } as unknown as HandlerState).room_impact!
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const discovering = new Promise<void>(resolve => { entered = resolve })
    const realGit = gitModule.git
    let listing: ReturnType<typeof vi.spyOn> | undefined
    try {
      if (mode === 'rebuild') { gi.start(); await gi.whenIdle() }
      listing = vi.spyOn(gitModule, 'git').mockImplementation(async (dir, args) => {
        if (args[0] === 'ls-tree') { entered(); await gate }
        return realGit(dir, args)
      })
      if (mode === 'initial') gi.start()
      else setParticipantBase(room, 'Rohan', base + '~0')
      expect(gi.isReady).toBe(false)
      await discovering
      expect(gi.isReady).toBe(false)
      expect(await impact({ symbol: 'missing' })).toContain('still indexing')
      release(); await gi.whenIdle()
      expect(gi.isReady).toBe(true)
    } finally { release(); listing?.mockRestore(); gi.stop(); room.doc.destroy() }
  })

  it.each(['initial', 'rebuild'] as const)('reports unavailable coverage after failed %s discovery and recovers on rebuild', async mode => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0 })
    const impact = fileHandlers({ S: () => ({ room, graph: gi }) } as unknown as HandlerState).room_impact!
    const realGit = gitModule.git
    let listing: ReturnType<typeof vi.spyOn> | undefined
    try {
      if (mode === 'rebuild') { gi.start(); await gi.whenIdle() }
      listing = vi.spyOn(gitModule, 'git').mockImplementation(async (dir, args) => {
        if (args[0] === 'ls-tree') throw new Error('temporary listing failure')
        return realGit(dir, args)
      })
      if (mode === 'initial') gi.start()
      else setParticipantBase(room, 'Rohan', base + '~0')
      await gi.whenIdle()
      expect(gi.isReady).toBe(false)
      expect(gi.indexingStatus).toContain('unavailable')
      expect(gi.indexingStatus).not.toContain('no pending files')
      expect(await impact({ symbol: 'missing' })).toContain('unavailable')
      expect(await impact({ symbol: 'missing' })).not.toContain('nowhere indexed')
      listing.mockRestore()
      setParticipantBase(room, 'Rohan', mode === 'initial' ? base + '~0' : base)
      await gi.whenIdle()
      expect(gi.isReady).toBe(true)
      expect(await impact({ symbol: 'missing' })).toContain('defined in nowhere indexed')
    } finally { listing?.mockRestore(); gi.stop(); room.doc.destroy() }
  })

  it('labels available graph facts as degraded after a file read fails', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
    let fail = true
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, read: async (_dir, _base, path) => {
      if (path === 'utils.py' && fail) throw new Error('temporary read failure')
      return path === 'utils.py' ? 'def validate_token(t): return t\n' : 'def login(t): return t\n'
    } })
    const impact = fileHandlers({ S: () => ({ room, graph: gi }), describeUsers: (_s: unknown, users: string[]) => users.join(', ') } as unknown as HandlerState).room_impact!
    try {
      gi.start(); await gi.whenIdle()
      expect(gi.isReady).toBe(false)
      expect(gi.indexingStatus).toContain('degraded')
      const result = await impact({ symbol: 'login' })
      expect(result).toContain('partial: graph coverage degraded')
      expect(result).toContain('defined in session.py')
      fail = false; await gi.refresh('utils.py'); await gi.whenIdle()
      expect(gi.isReady).toBe(true)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('reports pending overlay work but answers from available base facts', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const read = async (_dir: string, _base: string, path: string) => {
      if (path === 'pending.py') await gate
      return path === 'utils.py' ? 'def validate_token(t): return t\n' : undefined
    }
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, read })
    const impact = fileHandlers({ S: () => ({ room, graph: gi }), describeUsers: (_s: unknown, users: string[]) => users.join(', ') } as unknown as HandlerState).room_impact!
    try {
      gi.start(); await gi.whenIdle()
      const refresh = gi.refresh('pending.py')
      expect(gi.isReady).toBe(false)
      expect(gi.indexingStatus).toBe('graph still indexing (2 of 3 files)')
      expect(await impact({ symbol: 'missing' })).toContain('still indexing')
      expect(await impact({ symbol: 'validate_token' })).toContain('defined in utils.py')
      expect(await impact({ symbol: 'validate_token' })).toContain('partial')
      expect(await impact({ path: 'utils.py' })).toContain('partial')
      release(); await refresh; await gi.whenIdle()
      expect(gi.isReady).toBe(true)
      expect(await impact({ symbol: 'validate_token' })).not.toContain('partial')
      expect(await impact({ path: 'utils.py' })).not.toContain('partial')
    } finally { release?.(); gi.stop(); room.doc.destroy() }
  })

  it('treats an oversized historical baseline as a coverage gap for a small new edit', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'room-graph-old-large-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim()
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
    writeFileSync(join(repo, 'big.py'), 'x'.repeat(2 * 1024 * 1024) + '\n')
    git('add', '.'); git('commit', '-qm', 'large baseline')
    const old = git('rev-parse', 'HEAD')
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', old); setFixtureLocalRoot(room, 'Rohan', repo)
    const logs: string[] = []
    const gi = new GraphIndex(room, 'Rohan', repo, line => logs.push(line), { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      expect(await (gi as unknown as { textFor(path: string): Promise<string | undefined> }).textFor('big.py')).toBeUndefined()
      writeFileSync(join(repo, 'big.py'), 'def small():\n    return 1\n')
      publishFixture(room, 'Rohan', 'big.py', 'def small():\n    return 1\n', { base: old })
      await gi.whenIdle()
      expect(logs.some(line => line.includes('baseline unavailable for big.py') && line.includes('exceeds Room'))).toBe(true)
      expect(room.graphs.get('Rohan')?.observed?.some(change => change.path === 'big.py')).toBe(false)
    } finally { gi.stop(); room.doc.destroy(); rmSync(repo, { recursive: true, force: true }) }
  })
  it('rejects oversized own text before reading file contents', () => {
    const room = new RoomDoc()
    const file = join(dir, 'oversized.py')
    writeFileSync(file, 'x'.repeat(256 * 1024 + 1))
    const read = vi.spyOn(fs, 'readFileSync')
    try {
      const gi = new GraphIndex(room, 'Rohan', dir)
      expect((gi as unknown as { ownText(path: string): string | undefined }).ownText('oversized.py')).toBeUndefined()
      expect(read).not.toHaveBeenCalled()
    } finally { read.mockRestore(); rmSync(file, { force: true }); room.doc.destroy() }
  })
  it('resolves initial readiness while a path is continually superseded', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
    let edits = 0
    const read = vi.fn(async (_dir: string, _sha: string, path: string): Promise<string | undefined> => {
      if (path === 'utils.py') publishFixture(room, 'Rohan', path, `def changing_${++edits}(): pass\n`)
      return path === 'utils.py' ? 'def original(): pass\n' : undefined
    })
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0, read })
    try {
      gi.start()
      await Promise.race([gi.ready, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ready waited for supersessions')), 2000))])
      expect(edits).toBeGreaterThan(1)
      expect(room.graphs.get('Rohan')?.status).toBe('ready')
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('waits for a read from the new base when rebuild supersedes an in-flight build', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
    let release!: () => void
    let first = true
    const read = vi.fn(async (_dir: string, _sha: string, path: string): Promise<string | undefined> => {
      if (path !== 'utils.py') return undefined
      if (first) { first = false; await new Promise<void>(resolve => { release = resolve }) }
      return 'def current(): pass\n'
    })
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0, read })
    try {
      gi.start()
      await eventually(() => typeof release === 'function')
      execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-qm', 'next'])
      setParticipantBase(room, 'Rohan', execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim())
      release()
      await gi.ready
      expect(gi.graph.has('utils.py')).toBe(true)
      expect(room.graphs.get('Rohan')?.status).toBe('ready')
    } finally { gi.stop(); if (release) release(); room.doc.destroy() }
  })

  it('keeps a captured ready waiter pending through a base change and the queued ninth read', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'room-graph-ready-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim()
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
    for (let i = 0; i < 9; i++) writeFileSync(join(repo, `file${i}.py`), `def old_${i}(): pass\n`)
    git('add', '.'); git('commit', '-qm', 'initial')
    const oldBase = git('rev-parse', 'HEAD')
    git('commit', '--allow-empty', '-qm', 'new base')
    const newBase = git('rev-parse', 'HEAD')
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', oldBase)
    const oldReads: (() => void)[] = []
    let releaseNinth: (() => void) | undefined
    let holdNinth = true
    const read = vi.fn(async (_dir: string, sha: string, path: string): Promise<string> => {
      if (sha === oldBase) await new Promise<void>(resolve => oldReads.push(resolve))
      if (sha === newBase && path === 'file8.py' && holdNinth) {
        await new Promise<void>(resolve => { releaseNinth = resolve })
      }
      return path === 'file8.py'
        ? 'from file0 import current_0\ndef consumer(): return current_0()\n'
        : `def current_${path.slice(4, -3)}(): pass\n`
    })
    const gi = new GraphIndex(room, 'Rohan', repo, undefined, { random: () => 0, minPublishMs: 0, read })
    let settled = false
    let outcome: 'resolved' | 'rejected' | undefined
    try {
      gi.start()
      const captured = gi.ready.then(() => { settled = true; outcome = 'resolved' }, () => { settled = true; outcome = 'rejected' })
      await eventually(() => oldReads.length === 8)
      setParticipantBase(room, 'Rohan', newBase)
      oldReads.splice(0).forEach(release => release())
      await eventually(() => releaseNinth !== undefined)
      await eventually(() => Array.from({ length: 8 }, (_, i) => gi.graph.definersOf(`current_${i}`).includes(`file${i}.py`)).every(Boolean))
      expect(settled).toBe(false)
      expect(gi.graph.has('file8.py')).toBe(false)
      holdNinth = false
      releaseNinth!()
      await captured
      expect(outcome).toBe('resolved')
      expect(gi.graph.definersOf('current_0')).toEqual(['file0.py'])
      expect(gi.graph.usersOf('current_0')).toEqual(['file8.py'])
      expect(room.graphs.get('Rohan')?.base).toBe(newBase)
    } finally {
      oldReads.splice(0).forEach(release => release())
      holdNinth = false
      releaseNinth?.()
      gi.stop(); room.doc.destroy(); rmSync(repo, { recursive: true, force: true })
    }
  })

  it('lets a ninth path finish while eight edited paths are superseded', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    const first: (() => void)[] = [], later: (() => void)[] = []
    let firstReads = 0
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    const target = gi as unknown as { textFor(path: string): Promise<string | undefined> }
    const original = target.textFor.bind(gi)
    vi.spyOn(target, 'textFor').mockImplementation(async path => {
      if (path.startsWith('hot-')) {
        const batch = firstReads++ < 8 ? first : later
        await new Promise<void>(resolve => batch.push(resolve))
      }
      return original(path)
    })
    try {
      gi.start(); await gi.ready
      for (let i = 0; i < 8; i++) publishFixture(room, 'Rohan', `hot-${i}.py`, `def old_${i}(): pass\n`)
      await eventually(() => first.length === 8)
      publishFixture(room, 'Rohan', 'waiting.py', 'def waiting(): pass\n')
      for (let i = 0; i < 8; i++) publishFixture(room, 'Rohan', `hot-${i}.py`, `def new_${i}(): pass\n`)
      first.splice(0).forEach(release => release())
      await eventually(() => gi.graph.has('waiting.py'))
      later.splice(0).forEach(release => release())
      await gi.whenIdle()
      expect(gi.graph.definersOf('waiting')).toEqual(['waiting.py'])
    } finally {
      gi.stop(); first.splice(0).forEach(release => release()); later.splice(0).forEach(release => release()); room.doc.destroy()
    }
  })

  it('indexes base source files, prefers overlays, and tracks overlay edits', async () => {
    const room = new RoomDoc()
    setParticipantBase(room, 'Rohan', base)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    gi.start(); await gi.ready
    expect(gi.graph.size).toBe(2)
    expect(gi.graph.usersOf('validate_token')).toEqual(['session.py'])
    publishFixture(room, 'Kieran', 'session.py', 'from utils import validate_token\n\ndef login(t):\n    return verify_token(t)\n')
    await gi.whenIdle()
    expect(gi.graph.usersOf('validate_token')).toEqual(['session.py']) // import still references it (ast ImportFrom)
    publishFixture(room, 'Kieran', 'session.py', 'def login(t):\n    return verify_token(t)\n')
    await gi.whenIdle()
    expect(gi.graph.usersOf('validate_token')).toEqual([])
    expect(gi.graph.usersOf('verify_token')).toEqual(['session.py'])
    gi.stop()
  })

  it('publishes provider-to-consumer edges and restores reverted overlays', async () => {
    const room = new RoomDoc()
    setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    publishFixture(room, 'Rohan', 'session.py', 'def login(t):\n    return verify_token(t)\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    expect(room.graphs.get('Rohan')?.edges).toEqual([])
    clearFixture(room, 'Rohan', 'session.py')
    await gi.whenIdle()
    expect(gi.graph.usersOf('validate_token')).toEqual(['session.py'])
    await eventually(() => room.graphs.get('Rohan')?.edges.length === 1)
    expect(room.graphs.get('Rohan')?.edges).toEqual([
      { source: 'utils.py', target: 'session.py', symbols: ['validate_token'] },
    ])
    gi.stop(); room.doc.destroy()
  })

  it('indexes the latest rapid edit and removes deleted definitions', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    publishFixture(room, 'Rohan', 'session.py', 'def login(t):\n    return first_token(t)\n')
    publishFixture(room, 'Rohan', 'session.py', 'def login(t):\n    return last_token(t)\n')
    await gi.whenIdle()
    expect(gi.graph.usersOf('last_token')).toEqual(['session.py'])
    expect(gi.graph.usersOf('first_token')).toEqual([])
    deleteFixture(room, 'Rohan', 'utils.py')
    await gi.whenIdle()
    expect(gi.graph.definersOf('validate_token')).toEqual([])
    gi.stop(); room.doc.destroy()
  })

  it('drops files removed from a new base and publishes the new revision', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim()
    git('rm', 'utils.py'); git('commit', '-qm', 'remove obsolete provider')
    const next = git('rev-parse', 'HEAD')
    setParticipantBase(room, 'Rohan', next)
    await gi.whenIdle()
    expect(gi.graph.has('utils.py')).toBe(false)
    expect(room.graphs.get('Rohan')?.base).toBe(next)
    expect(room.graphs.get('Rohan')?.paths).not.toContain('utils.py')
    gi.stop(); room.doc.destroy()
  })

  it('publishes observed contract changes from only its own overlay', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    publishFixture(room, 'Kieran', 'utils.py', 'def validate_token(token, strict=False):\n    return token\n')
    await gi.whenIdle()
    expect(room.graphs.get('Rohan')?.observed).toEqual([])
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(token, strict=False):\n    return token\n')
    await gi.whenIdle()
    await eventually(() => room.graphs.get('Rohan')?.observed?.length === 1)
    expect(room.graphs.get('Rohan')?.observed).toEqual([{
      path: 'utils.py', symbol: 'validate_token', kind: 'signature',
      detail: 'was `def validate_token(t):` now `def validate_token(token, strict=False):`',
    }])
    expect(room.graphs.get('Rohan')?.observedTruncated).toBe(false)
    gi.stop(); room.doc.destroy()
  })

  it('caps observed contract changes in a snapshot', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    publishFixture(room, 'Rohan', 'generated.py', Array.from({ length: 205 }, (_, i) => `def added_${i}():\n    pass\n`).join('\n'))
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    await eventually(() => room.graphs.get('Rohan')?.observed?.length === 200)
    expect(room.graphs.get('Rohan')?.observedTruncated).toBe(true)
    gi.stop(); room.doc.destroy()
  })

  it('observes a carried worker\'s changes against its own baseline, not the room base', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'room-graph-carried-')), wdir = join(repo, '.room', 'w')
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim()
    git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
    writeFileSync(join(repo, '.gitignore'), '.room/\n'); writeFileSync(join(repo, 'api.py'), 'def rate(x):\n    return x\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init')
    const head = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'worktree', 'add', '-q', '-b', 'room/w', wdir, head)
    writeFileSync(join(wdir, 'api.py'), 'def rate(x, year):\n    return x\n'); git(wdir, 'commit', '-qam', 'carried')
    const carried = git(wdir, 'rev-parse', 'HEAD')
    const room = new RoomDoc(); setParticipantBase(room, 'lead+w', carried); setFixtureLocalRoot(room, 'lead+w', wdir)
    // The carried baseline is a local fact of the lead's registry, which the worktree shares.
    await seedRegistryWorker(repo, 'w', { name: 'lead+w', dir: wdir, branch: 'room/w', base: carried, carriedBase: carried })
    publishFixture(room, 'lead+w', 'api.py', 'def rate(x, year):\n    return x * 2\n')
    const gi = new GraphIndex(room, 'lead+w', wdir, undefined, { random: () => 0, minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    await eventually(() => room.graphs.get('lead+w')?.status === 'ready')
    expect(room.graphs.get('lead+w')?.observed).toEqual([])
    publishFixture(room, 'lead+w', 'api.py', 'def rate(x, year, region):\n    return x * 2\n')
    await gi.whenIdle()
    await eventually(() => room.graphs.get('lead+w')?.observed?.length === 1)
    expect(room.graphs.get('lead+w')?.observed?.[0].detail).toBe('was `def rate(x, year):` now `def rate(x, year, region):`')
    gi.stop(); room.doc.destroy(); await closeRegistryForDir(repo); rmSync(repo, { recursive: true, force: true })
  })
})

describe('GraphIndex snapshot discipline', () => {
  let repo: string, largeBase: string
  const total = 2100
  const readLarge = async (_dir: string, _sha: string, path: string): Promise<string> => {
    const i = Number(path.slice(4, -3))
    return i < 4
      ? Array.from({ length: 8 }, (_, symbol) => `def shared_${symbol}(): pass`).join('\n')
      : `def use_${i}(): return ${Array.from({ length: 8 }, (_, symbol) => `shared_${symbol}()`).join(' + ')}\n`
  }
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'room-graph-large-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim()
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
    for (let i = 0; i < total; i++) writeFileSync(join(repo, `file${i}.py`), '')
    git('add', '.'); git('commit', '-qm', 'fixture'); largeBase = git('rev-parse', 'HEAD')
  }, 30_000)
  afterAll(() => rmSync(repo, { recursive: true, force: true }), 30_000)

  it('yields during indexing before starting edge publication', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', largeBase)
    const gi = new GraphIndex(room, 'Rohan', repo, undefined, { random: () => 0, minPublishMs: 0, read: readLarge })
    let probe = false, probeAt1000 = false
    const originalSet = gi.graph.set.bind(gi.graph)
    vi.spyOn(gi.graph, 'set').mockImplementation((path, text) => {
      if (gi.graph.size === 100) setImmediate(() => { probe = true })
      if (gi.graph.size === 1000) probeAt1000 = probe
      return originalSet(path, text)
    })
    try {
      gi.start(); await gi.ready
      expect(gi.graph.size).toBe(total)
      expect(probeAt1000).toBe(true)
    } finally { gi.stop(); room.doc.destroy() }
  }, 30_000)

  it('yields during edge publication before publishing ready', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', largeBase); setFixtureLocalRoot(room, 'Rohan', repo)
    const gi = new GraphIndex(room, 'Rohan', repo, undefined, { random: () => 0, minPublishMs: 0, read: readLarge })
    try {
      gi.start(); await gi.ready
      let probe = false, scheduled = false, probeAtReady: boolean | undefined
      const published = (gi as unknown as { publishedGraph: typeof gi.graph }).publishedGraph
      const originalDependencies = published.dependenciesOf.bind(published)
      vi.spyOn(published, 'dependenciesOf').mockImplementation(path => {
        if (!scheduled) { scheduled = true; setImmediate(() => { probe = true }) }
        return originalDependencies(path)
      })
      const originalPublish = room.graphs.set.bind(room.graphs)
      vi.spyOn(room.graphs, 'set').mockImplementation((name, snapshot) => {
        if (snapshot.status === 'ready') probeAtReady = probe
        return originalPublish(name, snapshot)
      })
      publishFixture(room, 'Rohan', 'file4.py', 'def changed(): pass\n')
      await eventually(() => probeAtReady !== undefined)
      expect(room.graphs.get('Rohan')?.status).toBe('ready')
      expect(probeAtReady).toBe(true)
      expect(room.graphs.get('Rohan')?.truncated).toBe(true)
    } finally { gi.stop(); room.doc.destroy() }
  }, 30_000)

  it('stops collecting edges once the snapshot byte budget is exceeded', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', largeBase); setFixtureLocalRoot(room, 'Rohan', repo)
    const gi = new GraphIndex(room, 'Rohan', repo, undefined, { random: () => 0, minPublishMs: 0, read: readLarge })
    const published = (gi as unknown as { publishedGraph: typeof gi.graph }).publishedGraph
    const dependencies = vi.spyOn(published, 'dependenciesOf')
    try {
      gi.start(); await gi.ready
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready', 10_000)
      expect(published.size).toBe(total)
      // Force one more publish and count the edge work it does: the body is far over the
      // 200 KiB budget, so construction must stop well before every path is visited.
      dependencies.mockClear()
      const internals = gi as unknown as { graphRevision: number; generation: number; publishSnapshot(status: 'ready', generation: number): Promise<void> }
      internals.graphRevision++
      await internals.publishSnapshot('ready', internals.generation)
      const graph = room.graphs.get('Rohan')!
      expect(graph.truncated).toBe(true)
      expect(graph.edges).toEqual([])
      expect(dependencies.mock.calls.length).toBeGreaterThan(0)
      expect(dependencies.mock.calls.length).toBeLessThan(total / 2)
    } finally { gi.stop(); room.doc.destroy() }
  }, 30_000)

  it('keeps a snapshot of many long path names within the byte budget', async () => {
    const wide = mkdtempSync(join(tmpdir(), 'room-graph-wide-'))
    const git = (...args: string[]) => execFileSync('git', ['-C', wide, ...args], { stdio: 'pipe' }).toString().trim()
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
    const names = Array.from({ length: 1200 }, (_, i) => `${'d'.repeat(180)}_${String(i).padStart(4, '0')}.py`)
    for (const name of names) writeFileSync(join(wide, name), '')
    git('add', '.'); git('commit', '-qm', 'wide'); const wideBase = git('rev-parse', 'HEAD')
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', wideBase); setFixtureLocalRoot(room, 'Rohan', wide)
    const read = async (): Promise<string> => 'def shared(): pass\n'
    const gi = new GraphIndex(room, 'Rohan', wide, undefined, { random: () => 0, minPublishMs: 0, read })
    try {
      gi.start(); await gi.ready
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready', 20_000)
      const graph = room.graphs.get('Rohan')!
      expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThanOrEqual(200 * 1024)
      expect(graph.truncated).toBe(true)
      expect(graph.paths.length).toBeGreaterThan(0)
      expect(graph.paths.length).toBeLessThan(names.length)
    } finally { gi.stop(); room.doc.destroy(); rmSync(wide, { recursive: true, force: true }) }
  }, 60_000)

  it('forgets per-path revisions once their refreshes settle', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    const internals = gi as unknown as { revisions: Map<string, number> }
    try {
      gi.start(); await gi.whenIdle()
      for (let i = 0; i < 500; i++) void gi.refresh(`gone/${i}.py`)
      expect(internals.revisions.size).toBe(500)
      await gi.whenIdle()
      expect(gi.graph.has('gone/0.py')).toBe(false)
      expect(internals.revisions.size).toBe(0)
    } finally { gi.stop(); room.doc.destroy() }
  }, 30_000)

  it('skips edge construction when the queued publish finds no graph changes', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'Rohan', base)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    const published = (gi as unknown as { publishedGraph: typeof gi.graph }).publishedGraph
    const dependencies = vi.spyOn(published, 'dependenciesOf')
    try {
      gi.start(); await gi.ready
      const calls = dependencies.mock.calls.length
      expect(calls).toBe(published.size)
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(dependencies).toHaveBeenCalledTimes(calls)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('stamps a new manifest revision for equal symbols, avoids duplicate writes, and waits out the publish window', async () => {
    const room = new RoomDoc()
    setParticipantBase(room, 'Rohan', base); setFixtureLocalRoot(room, 'Rohan', dir)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 400 })
    gi.start(); await gi.ready
    await eventually(() => room.graphs.get('Rohan')?.status === 'ready')
    expect(room.graphs.get('Rohan')!.edges.length).toBe(1)
    let writes = 0
    room.graphs.observe(() => { if (room.graphs.get('Rohan')?.status === 'ready') writes++ })
    publishFixture(room, 'Rohan', 'session.py', 'from utils import validate_token\n\ndef login(t):\n    return validate_token(t)  # same edge\n')
    await gi.whenIdle()
    await eventually(() => writes === 1)
    expect(room.graphs.get('Rohan')?.sourceRev).toBe(room.manifestHead.get('Rohan')?.rev)
    await gi.refresh('session.py'); await gi.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 450))
    expect(writes).toBe(1) // unchanged revision and content do not rewrite
    const firstAt = room.graphs.get('Rohan')!.at
    publishFixture(room, 'Rohan', 'session.py', 'def login(t):\n    return t\n')
    for (let i = 0; i < 60 && writes < 2; i++) await new Promise(r => setTimeout(r, 50)) // changed: written once the window has passed
    expect(writes).toBe(2)
    expect(room.graphs.get('Rohan')!.at - firstAt).toBeGreaterThanOrEqual(400)
    expect(room.graphs.get('Rohan')!.edges).toEqual([])
    gi.stop()
  })
})

describe('shared graph startup', () => {
  it('jitters startup with an injectable random source and cancels cleanly', async () => {
    vi.useFakeTimers()
    const room = new RoomDoc(); setParticipantBase(room, 'New', base)
    const gi = new GraphIndex(room, 'New', dir, undefined, { random: () => 0.5 })
    try {
      gi.start()
      const ready = gi.ready
      await vi.advanceTimersByTimeAsync(1999)
      expect(room.graphs.has('New')).toBe(false)
      gi.stop(); await expect(ready).rejects.toThrow('graph index is closed')
      await vi.advanceTimersByTimeAsync(4000)
      expect(room.graphs.has('New')).toBe(false)
    } finally { gi.stop(); room.doc.destroy(); vi.useRealTimers() }
  })

  it('builds when the room gets its first base after the startup wait', async () => {
    const room = new RoomDoc()
    const gi = new GraphIndex(room, 'New', dir, undefined, { random: () => 0 })
    try {
      gi.start(); await gi.whenIdle()
      expect(gi.graph.size).toBe(0)
      setParticipantBase(room, 'New', base); await gi.whenIdle()
      expect(gi.graph.has('utils.py')).toBe(true)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('builds locally despite a present peer snapshot and computes its own contract changes', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'New', base); setFixtureLocalRoot(room, 'New', dir)
    room.graphs.set('Peer', {
      version: 1, base, at: Date.now(), status: 'ready', truncated: false,
      paths: ['utils.py', 'session.py'],
      edges: [{ source: 'utils.py', target: 'session.py', symbols: ['validate_token'] }],
      observed: [{ path: 'utils.py', symbol: 'other', kind: 'add', detail: 'peer only' }],
    })
    publishFixture(room, 'New', 'utils.py', 'def validate_token(token, strict=False):\n    return token\n')
    const logs: string[] = []
    const gi = new GraphIndex(room, 'New', dir, s => logs.push(s), { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      expect(logs.some(s => s.includes('reused'))).toBe(false)
      expect(gi.graph.usersOf('validate_token')).toEqual(['session.py'])
      expect(room.graphs.get('New')?.edges).toEqual(room.graphs.get('Peer')?.edges)
      expect(room.graphs.get('New')?.observed?.map(c => c.symbol)).toEqual(['validate_token'])
      clearFixture(room, 'New', 'utils.py')
      await gi.whenIdle()
      await eventually(() => room.graphs.get('New')?.observed?.length === 0)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('ignores narrowed snapshot edges and refreshes another participant\'s import change', async () => {
    const room = new RoomDoc(); setParticipantBase(room, 'New', base)
    room.graphs.set('Peer', {
      version: 1, base, at: Date.now(), status: 'ready', truncated: false,
      paths: ['a.py', 'b.py', 'use-a.py', 'use-b.py'],
      edges: [
        { source: 'a.py', target: 'use-a.py', symbols: ['Config'] },
        { source: 'b.py', target: 'use-b.py', symbols: ['Config'] },
      ],
    })
    const gi = new GraphIndex(room, 'New', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      expect(gi.graph.dependenciesOf('use-a.py')).toEqual([])
      expect(gi.graph.dependenciesOf('use-b.py')).toEqual([])
      publishFixture(room, 'Other', 'use-a.py', 'class Local:\n    pass\n')
      await gi.whenIdle()
      expect(gi.graph.dependenciesOf('use-a.py')).toEqual([])
      expect(gi.graph.dependenciesOf('use-b.py')).toEqual([])
      await eventually(() => room.graphs.get('New')?.edges.length === 1)
      expect(room.graphs.get('New')?.edges).not.toContainEqual({ source: 'b.py', target: 'use-a.py', symbols: ['Config'] })
      expect(room.graphs.get('New')?.edges).not.toContainEqual({ source: 'a.py', target: 'use-a.py', symbols: ['Config'] })
    } finally { gi.stop(); room.doc.destroy() }
  })

})


it('resolves consumers without loading tree-sitter in the main isolate', async () => {
  expect(languageLoadAttemptsForTest('javascript')).toBe(0)
  const text = 'import { sample } from "./provider.js"; sample();'
  expect(await consumesSymbol('consumer.js', text, 'provider.js', 'sample')).toBe(true)
  expect(await consumesSymbol('consumer.js', text, 'provider.js', 'unused')).toBe(false)
  expect(await consumesSymbol('provider.js', 'function sample() { sample(); }', 'provider.js', 'sample')).toBe(true)
  expect(languageLoadAttemptsForTest('javascript')).toBe(0)
})
