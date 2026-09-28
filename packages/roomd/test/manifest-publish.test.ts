import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { RoomDoc, digestPath, manifestKey } from '@room/shared'
import { publishManifest, type ManifestFact } from '../src/manifest-publish.js'
import { startRoomd } from '../src/index.js'
import { plan, policyFromLevel, rulesFromText } from '../src/policy.js'
import { readDisk } from '../src/disk-scan.js'

async function scanPlan(input: { room: RoomDoc; name: string; fence: string; base: string; level: 'intent' | 'declared' | 'full'; prefixes: readonly string[]; dir: string; sizeCap: number; totalBudget: number; safe: (p: string) => boolean }): Promise<ManifestFact[]> {
  const policy = policyFromLevel(input.level, input.prefixes)
  const inputs = { policy, rules: rulesFromText('', input.sizeCap, input.totalBudget), head: input.base }
  const old = input.room.manifest.get(manifestKey(input.name, input.fence))
  const desired = plan(inputs, await readDisk(input.dir, inputs, old?.keys() ?? [], input.safe), input.room.ensureRoomSalt())
  return [...desired.entries].map(([p, e]) => ({ path: p, change: e.change, hash: e.hash, size: e.size, baseHash: e.baseHash, text: e.text, binary: e.held === 'binary', at: e.at }))
    .concat(desired.excludedPaths.map(p => ({ path: p, change: 'M' as const, excluded: true })))
}

function provider(doc: Y.Doc): WebsocketProvider {
  let state: unknown = null
  return { synced: true, awareness: {
    getLocalState: () => state, setLocalState: (next: unknown) => { state = next }, getStates: () => new Map([[doc.clientID, state]]),
  }, on() {}, off() {}, destroy() {} } as unknown as WebsocketProvider
}

describe('dual manifest publication', () => {
  it('publishes hashless out-of-area changes, exact deletes and digest-only exclusions', () => {
    const room = new RoomDoc()
    room.ensureRoomSalt()
    const input = { room, name: 'ben', fence: 's1', base: 'abc', level: 'declared' as const, prefixes: ['src/'], complete: true }
    publishManifest(input, [
      { path: 'src/app.ts', change: 'M', hash: 'a', size: 4, baseHash: 'b', text: 'test' },
      { path: 'private/x', change: 'M', hash: 'fivebytes', size: 5, baseHash: 'old' },
      { path: 'private/y', change: 'D', baseHash: 'old' },
      { path: 'secret', change: 'M', excluded: true, hash: 'secret-hash', size: 12 },
    ])
    const entries = room.manifest.get(manifestKey('ben', 's1'))!
    expect(entries.get('private/x')).toMatchObject({ change: 'M', state: 'held', held: 'scope', fence: 's1' })
    expect(entries.get('private/x')).not.toHaveProperty('hash')
    expect(entries.get('private/x')).not.toHaveProperty('size')
    expect(entries.get('private/y')).toMatchObject({ change: 'D', state: 'shared' })
    expect(entries.get('private/y')).not.toHaveProperty('baseHash')
    expect(entries.has('secret')).toBe(false)
    expect(room.manifestHead.get('ben')!.excluded).toEqual([digestPath(room.roomSalt!, 'secret')])
    expect(JSON.stringify(room.manifestHead.get('ben'))).not.toContain('secret')
    expect(room.overlays.get('ben')).toBeUndefined() // step 1 leaves legacy publication to the old writer
  })

  it('keeps revisions stable when only the display timestamp changes', () => {
    const room = new RoomDoc()
    room.ensureRoomSalt()
    const input = { room, name: 'ben', fence: 's1', base: 'abc', level: 'declared' as const, prefixes: [], complete: true }
    publishManifest(input, [{ path: 'x', change: 'M', hash: 'a', size: 1, at: 1 }])
    const first = room.manifestHead.get('ben')!
    publishManifest(input, [{ path: 'x', change: 'M', hash: 'b', size: 1, at: 2 }])
    const second = room.manifestHead.get('ben')!
    expect(second.rev).toBe(first.rev)
    expect(second.semRev).toBe(first.semRev)
    expect(room.manifest.get(manifestKey('ben', 's1'))!.get('x')?.at).toBe(2)
  })

  it('gates intent and non-publisher before deletion or exclusion rules', () => {
    const room = new RoomDoc()
    const common = { room, name: 'ben', fence: 's1', base: 'abc', prefixes: [], complete: true }
    const facts = [{ path: 'gone', change: 'D' as const, baseHash: 'old' }, { path: 'secret', change: 'M' as const, excluded: true }]
    const intent = publishManifest({ ...common, level: 'intent' }, facts)
    expect(intent.coverage).toEqual({ kind: 'none', reason: 'intent' })
    expect(intent.excluded).toEqual([])
    expect(room.manifest.get(manifestKey('ben', 's1'))?.size).toBe(0)
    const secondary = publishManifest({ ...common, level: 'full', publisher: 'alice' }, facts)
    expect(secondary.coverage).toEqual({ kind: 'none', reason: 'not-publisher' })
    expect(secondary.excluded).toEqual([])
    expect(room.manifest.get(manifestKey('ben', 's1'))?.size).toBe(0)
  })

  it('keeps the winner incarnation map when a losing writer publishes its own key', () => {
    const room = new RoomDoc()
    const common = { room, name: 'ben', base: 'abc', level: 'full' as const, prefixes: [], complete: true }
    publishManifest({ ...common, fence: 'winner' }, [{ path: 'x', change: 'D' }])
    publishManifest({ ...common, fence: 'loser' }, [{ path: 'y', change: 'D' }])
    expect(room.manifest.get(manifestKey('ben', 'winner'))?.has('x')).toBe(true)
    expect(room.manifest.get(manifestKey('ben', 'winner'))?.has('y')).toBe(false)
    expect(room.manifest.get(manifestKey('ben', 'loser'))?.has('x')).toBe(false)
  })

  it('recomputes excluded digests when a competing room salt wins', () => {
    const a = new RoomDoc(), b = new RoomDoc()
    a.ensureRoomSalt(); b.ensureRoomSalt()
    const input = { room: a, name: 'ben', fence: 's1', base: 'abc', level: 'full' as const, prefixes: [], complete: true }
    publishManifest(input, [{ path: 'secret', change: 'M', excluded: true }])
    const initialSalt = a.roomSalt!
    const before = a.manifestHead.get('ben')!.excluded[0]
    const au = Y.encodeStateAsUpdate(a.doc), bu = Y.encodeStateAsUpdate(b.doc)
    Y.applyUpdate(a.doc, bu); Y.applyUpdate(b.doc, au)
    publishManifest(input, [{ path: 'secret', change: 'M', excluded: true }])
    expect(a.manifestHead.get('ben')!.excluded).toEqual([digestPath(a.roomSalt!, 'secret')])
    if (a.roomSalt !== initialSalt) expect(a.manifestHead.get('ben')!.excluded[0]).not.toBe(before)
  })

  it('scans a real checkout relative to its base without replicating held content facts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-manifest-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    try {
      git('init', '-q')
      fs.mkdirSync(path.join(dir, 'src'))
      fs.writeFileSync(path.join(dir, 'src/app'), 'base')
      fs.writeFileSync(path.join(dir, 'private'), 'old')
      fs.writeFileSync(path.join(dir, 'gone'), 'gone')
      git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base')
      const base = git('rev-parse', 'HEAD')
      fs.writeFileSync(path.join(dir, 'src/app'), 'shared')
      fs.writeFileSync(path.join(dir, 'private'), 'five!')
      fs.rmSync(path.join(dir, 'gone'))
      const room = new RoomDoc()
      const input = { room, name: 'ben', fence: 's1', base, level: 'declared' as const, prefixes: ['src/'], complete: true }
      const facts = await scanPlan({ ...input, dir, sizeCap: 1024, totalBudget: 1024, safe: () => true })
      publishManifest(input, facts)
      const entries = room.manifest.get(manifestKey('ben', 's1'))!
      expect(entries.get('private')).toMatchObject({ change: 'M', state: 'held', held: 'scope' })
      expect(entries.get('private')).not.toHaveProperty('hash')
      expect(entries.get('private')).not.toHaveProperty('size')
      expect(entries.get('gone')).toMatchObject({ change: 'D', state: 'shared' })
      expect(entries.get('gone')).not.toHaveProperty('baseHash')
      expect(entries.get('src/app')?.hash).toMatch(/^[a-f0-9]{40}$/)
      expect(room.overlays.get(manifestKey('ben', 's1'))).toBeUndefined()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it.each(['staged', 'committed'] as const)('keeps both sides of a %s rename, including a prior source entry', async mode => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-manifest-rename-'))
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    try {
      sh('init', '-q')
      sh('config', 'user.email', 'test@example.com'); sh('config', 'user.name', 'Test')
      fs.writeFileSync(path.join(dir, 'old'), 'content')
      sh('add', '-A'); sh('commit', '-qm', 'base')
      const base = sh('rev-parse', 'HEAD')
      const room = new RoomDoc()
      const input = { room, name: 'ben', fence: 's1', base, level: 'full' as const, prefixes: [], complete: true }
      publishManifest(input, [{ path: 'old', change: 'M', hash: 'earlier', size: 7, text: 'earlier' }])
      sh('mv', 'old', 'new')
      if (mode === 'committed') sh('commit', '-qm', 'rename')
      const facts = await scanPlan({ ...input, dir, sizeCap: 1024, totalBudget: 1024, safe: () => true })
      expect(facts.map(f => [f.path, f.change])).toEqual([['new', 'A'], ['old', 'D']])
      publishManifest(input, facts)
      expect(room.manifest.get(manifestKey('ben', 's1'))?.get('old')?.change).toBe('D')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('holds out-of-area and binary files after shared text fills the budget', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-manifest-budget-'))
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    try {
      sh('init', '-q')
      sh('config', 'user.email', 'test@example.com'); sh('config', 'user.name', 'Test')
      fs.writeFileSync(path.join(dir, 'a'), 'old')
      fs.writeFileSync(path.join(dir, 'z'), 'old')
      sh('add', '-A'); sh('commit', '-qm', 'base')
      const base = sh('rev-parse', 'HEAD'), room = new RoomDoc()
      fs.writeFileSync(path.join(dir, 'a'), '1234')
      fs.writeFileSync(path.join(dir, 'z'), '12345')
      const common = { room, name: 'ben', fence: 's1', base, prefixes: ['a'], complete: true, dir, sizeCap: 1024, totalBudget: 4, safe: () => true }
      const scoped = await scanPlan({ ...common, level: 'declared' })
      expect(scoped.find(f => f.path === 'z')).toMatchObject({ change: 'M' })
      expect(scoped.find(f => f.path === 'z')?.excluded).toBeUndefined()
      publishManifest({ ...common, level: 'declared' }, scoped)
      expect(room.manifest.get(manifestKey('ben', 's1'))?.get('z')).toMatchObject({ state: 'held', held: 'scope' })
      fs.writeFileSync(path.join(dir, 'z'), Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb]))
      const binary = await scanPlan({ ...common, level: 'full' })
      expect(binary.find(f => f.path === 'z')).toMatchObject({ binary: true })
      expect(binary.find(f => f.path === 'z')?.excluded).toBeUndefined()
      publishManifest({ ...common, level: 'full' }, binary)
      expect(room.manifest.get(manifestKey('ben', 's1'))?.get('z')).toMatchObject({ state: 'held', held: 'binary' })
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('uses the resolved anchor for committed-but-unpushed changes', async () => {
    vi.stubEnv('CHOKIDAR_USEPOLLING', '1')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-manifest-anchor-'))
    const origin = path.join(root, 'origin.git'), dir = path.join(root, 'checkout')
    const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    let daemon: Awaited<ReturnType<typeof startRoomd>> | undefined
    try {
      sh(root, 'init', '--bare', '-q', '-b', 'main', origin)
      sh(root, 'init', '-q', '-b', 'main', dir)
      sh(dir, 'config', 'user.email', 'test@example.com'); sh(dir, 'config', 'user.name', 'Test')
      fs.writeFileSync(path.join(dir, 'x'), 'base')
      sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'base')
      sh(dir, 'remote', 'add', 'origin', origin); sh(dir, 'push', '-q', '-u', 'origin', 'main')
      const anchor = sh(dir, 'rev-parse', 'HEAD')
      fs.writeFileSync(path.join(dir, 'x'), 'committed')
      sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'local')
      daemon = await startRoomd({ dir, room: 'ws://memory/github.com/owner/repo/main', name: 'Ben', sessionId: 's1', policy: policyFromLevel('full'), providerFactory: (_s, _n, doc) => provider(doc), basePollMs: 0, trackedRefreshMs: 60_000, log: () => {} })
      expect(daemon.anchor).toEqual({ base: anchor, anchored: true })
      expect(daemon.roomDoc.manifestHead.get('Ben')).toMatchObject({ base: anchor, complete: true })
      expect(daemon.roomDoc.manifest.get(manifestKey('Ben', 's1'))?.get('x')?.change).toBe('M')
      sh(dir, 'update-ref', '-d', 'refs/remotes/origin/main')
      await (daemon as unknown as { pollHead(): Promise<void> }).pollHead()
      expect(daemon.anchor.anchored).toBe(false)
      expect(daemon.roomDoc.manifestHead.get('Ben')?.complete).toBe(false)
    } finally { await daemon?.stop(); fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs() }
  })

  it('keeps observed entries non-certifying when no remote anchor can be resolved', async () => {
    vi.stubEnv('CHOKIDAR_USEPOLLING', '1')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-manifest-no-anchor-'))
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
    let daemon: Awaited<ReturnType<typeof startRoomd>> | undefined
    try {
      sh('init', '-q', '-b', 'main')
      sh('config', 'user.email', 'test@example.com'); sh('config', 'user.name', 'Test')
      fs.writeFileSync(path.join(dir, 'x'), 'base')
      sh('add', '-A'); sh('commit', '-qm', 'base')
      fs.writeFileSync(path.join(dir, 'x'), 'changed')
      daemon = await startRoomd({ dir, room: 'ws://memory/github.com/owner/repo/main', name: 'Ben', sessionId: 's1', policy: policyFromLevel('full'), providerFactory: (_s, _n, doc) => provider(doc), basePollMs: 0, trackedRefreshMs: 60_000, log: () => {} })
      expect(daemon.anchor.anchored).toBe(false)
      expect(daemon.roomDoc.manifestHead.get('Ben')?.complete).toBe(false)
      expect(daemon.roomDoc.manifest.get(manifestKey('Ben', 's1'))?.get('x')?.change).toBe('M')
      expect(daemon.roomDoc.manifestHead.get('Ben')?.coverage).toEqual({ kind: 'none', reason: 'starting' })
    } finally { await daemon?.stop(); fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs() }
  })
})
