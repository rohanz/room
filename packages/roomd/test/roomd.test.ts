import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { RoomDoc } from '@room/shared'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, defaultIgnoredPath, RoomdError, clampShare, parseShare, type Roomd, type RoomdOptions } from '../src/index.js'
import { normalizeGitOrigin, gitIgnored } from '../src/git.js'

vi.setConfig({ testTimeout: 30_000 })
// Use real chokidar polling consistently: native events can be lost in sandboxes.
// Each mutation below waits for its effect before a subsequent mutation.
beforeAll(() => { vi.stubEnv('CHOKIDAR_USEPOLLING', '1'); vi.stubEnv('ROOM_MACHINE_ID', 'test-machine') })
afterAll(() => { vi.unstubAllEnvs() })

function sh(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'roomd-'))
  sh(dir, ['init', '-q', '-b', 'main'])
  sh(dir, ['config', 'user.email', 'test@example.com'])
  sh(dir, ['config', 'user.name', 'Test'])
  for (const [relpath, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, relpath)), { recursive: true })
    await fsp.writeFile(path.join(dir, relpath), content)
  }
  sh(dir, ['add', '-A'])
  sh(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

async function cloneRepo(src: string): Promise<string> {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'roomd-clone-'))
  const dir = path.join(parent, 'B')
  sh(parent, ['clone', '-q', src, dir])
  sh(dir, ['config', 'user.email', 'test@example.com'])
  sh(dir, ['config', 'user.name', 'Test'])
  return dir
}

/**
 * Yjs-equivalent in-memory transport. The production transport remains
 * y-websocket; avoiding listen(2) keeps this suite runnable in network-denied
 * sandboxes while still exercising updates arriving from another daemon.
 */
class MemoryHub {
  private rooms = new Map<string, Set<Y.Doc>>()
  private presence = new Map<string, Map<number, Record<string, unknown>>>()

  connect(key: string, doc: Y.Doc): WebsocketProvider {
    const peers = this.rooms.get(key) ?? new Set<Y.Doc>()
    for (const peer of peers) Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
    peers.add(doc)
    this.rooms.set(key, peers)
    const relay = (update: Uint8Array) => {
      for (const peer of peers) if (peer !== doc) Y.applyUpdate(peer, update, doc)
    }
    doc.on('update', relay)
    const rooms = this.rooms

    let localState: Record<string, unknown> | null = null
    const states = this.presence.get(key) ?? new Map<number, Record<string, unknown>>()
    this.presence.set(key, states)
    const provider = {
      synced: true,
      awareness: {
        setLocalState(state: Record<string, unknown> | null) { localState = state; if (state) states.set(doc.clientID, state); else states.delete(doc.clientID) },
        getStates() { return states },
        getLocalState() { return localState },
      },
      on() { return provider },
      off() { return provider },
      destroy() {
        doc.off('update', relay)
        peers.delete(doc)
        if (peers.size === 0) rooms.delete(key)
      },
    }
    return provider as unknown as WebsocketProvider
  }
}

async function waitFor(pred: () => boolean, ms = 15_000, step = 25): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return
    await delay(step)
  }
  if (!pred()) throw new Error(`condition not met within ${ms}ms`)
}

const read = (dir: string, relpath: string) => fs.readFileSync(path.join(dir, relpath), 'utf8')
const silent = () => {}

describe('git origin normalisation', () => {
  it('normalises scp-like, HTTPS, and SSH origins to host/owner/repo', () => {
    expect(normalizeGitOrigin('git@github.com:openai/room.git')).toBe('github.com/openai/room')
    expect(normalizeGitOrigin('https://github.com/openai/room.git')).toBe('github.com/openai/room')
    expect(normalizeGitOrigin('ssh://git@github.com/openai/room.git')).toBe('github.com/openai/room')
    // self-hosted git servers: git/<host>/<owner>/<repo>; nested groups collapse into the owner
    expect(normalizeGitOrigin('https://gitlab.example.com/team/app.git')).toBe('git/gitlab.example.com/team/app')
    expect(normalizeGitOrigin('git@gitea.internal:team/app.git')).toBe('git/gitea.internal/team/app')
    expect(normalizeGitOrigin('ssh://git@GitLab.example.com:2222/grp/sub/app.git')).toBe('git/gitlab.example.com/grp.sub/app')
    expect(normalizeGitOrigin('https://git.example.com/app')).toBe('git/git.example.com/app')
  })
})

describe('roomd v2 push-only overlays', () => {
  const daemons: Roomd[] = []
  const hub = new MemoryHub()
  const room = () => `ws://memory/room-${Math.random().toString(36).slice(2, 8)}`
  const providerFactory: NonNullable<RoomdOptions['providerFactory']> = (server, name, doc) => hub.connect(`${server}/${name}`, doc)
  const start = async (options: Omit<RoomdOptions, 'providerFactory'>) => {
    const daemon = await startRoomd({ log: silent, debounceMs: 20, trackedRefreshMs: 100, providerFactory, ...options })
    daemons.push(daemon)
    return daemon
  }

  afterEach(async () => { await Promise.all(daemons.splice(0).map(daemon => daemon.stop())) })

  it('carries reported runtime metadata through subsequent status updates', async () => {
    const dir = await makeRepo({ 'app.py': 'x = 1\n' })
    const daemon = await start({ dir, room: room(), name: 'Ada', kind: 'agent', host: 'codex', model: 'gpt-6-astra', effort: 'medium' })
    daemon.touch()
    expect(daemon.provider.awareness.getLocalState()).toMatchObject({ host: 'codex', model: 'gpt-6-astra', effort: 'medium' })
  })

  it('never traverses or publishes symlinks, including linked ignored inputs', async () => {
    const dir = await makeRepo({ 'app.py': 'x = 1\n' })
    const outside = await makeRepo({ '.gitignore': 'data/\n', 'readme': 'inputs' })
    await fsp.mkdir(path.join(outside, 'data'))
    await fsp.writeFile(path.join(outside, 'data', 'results.csv'), 'private\n')
    await fsp.symlink(path.join(outside, 'data'), path.join(dir, 'data'))
    await fsp.symlink('app.py', path.join(dir, 'alias.py'))
    expect(await gitIgnored(dir, 'data/results.csv')).toBe(true)
    const daemon = await start({ room: room(), dir, name: 'Ann' })
    await fsp.writeFile(path.join(dir, 'app.py'), 'x = 2\n')
    await waitFor(() => daemon.roomDoc.text('app.py', 'Ann') === 'x = 2\n')
    expect(daemon.roomDoc.changedPaths('Ann')).toEqual(['app.py'])
    expect(daemon.skipped().ignore).toContain('data')
    expect(daemon.skipped().ignore).toContain('alias.py')
  })

  it('ignores bulky and temporary names without reading file contents and logs once', async () => {
    const names = ['.DS_Store', 'a.npy', 'a.npz', 'a.parquet', 'a.pkl', 'a.pt', 'a.bin', 'a.sqlite', 'a.zip', 'a.gz', 'a.tmp', 'a~', '.a.tmp-123', '.tmp.result']
    for (const name of names) expect(defaultIgnoredPath('nested/' + name), name).toBe(true)
    expect(defaultIgnoredPath('.env.example')).toBe(false)
    const dir = await makeRepo({ 'app.py': 'x = 1\n', 'a.npy': 'data' })
    const logs: string[] = []
    const reader = vi.spyOn(fs, 'readFileSync')
    try {
      const daemon = await start({ room: room(), dir, name: 'Ann', log: line => logs.push(line) })
      await daemon.setShare('full')
      expect(reader.mock.calls.some(([p]) => String(p) === path.join(dir, 'a.npy'))).toBe(false)
      expect(logs.filter(line => line.startsWith('skip'))).toEqual([])
      expect(logs.filter(line => line.startsWith('synced ') && line.includes('skipped 1 file(s) (1 ignore)'))).toHaveLength(1)
    } finally { reader.mockRestore() }
  })

  it('publishes only once for a shared real directory and logs its stop reason once', async () => {
    const dir = await makeRepo({ 'app.py': 'x = 1\n' }), url = room()
    const primary = await start({ room: url, dir, name: 'Zoe' })
    const logs: string[] = []
    const secondary = await start({ room: url, dir, name: 'Amy', log: line => logs.push(line) })
    const state = secondary.provider.awareness.getLocalState()!
    expect(state.watchedDirectory).toMatch(/^[a-f0-9]{64}$/)
    expect(state.watchedDirectory).toBe(primary.provider.awareness.getLocalState()!.watchedDirectory)
    expect(state.publishUnder).toBe('Zoe')
    await fsp.writeFile(path.join(dir, 'app.py'), 'x = 2\n')
    await waitFor(() => primary.roomDoc.text('app.py', 'Zoe') === 'x = 2\n')
    await secondary.setShare('full')
    expect(secondary.roomDoc.changedPaths('Amy')).toEqual([])
    await primary.stop('handoff')
    await waitFor(() => secondary.provider.awareness.getLocalState()!.publishUnder === undefined
      && secondary.roomDoc.text('app.py', 'Amy') === 'x = 2\n')
    await secondary.stop('test complete'); await secondary.stop('again')
    expect(logs.filter(line => line.startsWith('stopped:'))).toEqual(['stopped: test complete'])
  })

  it('distinguishes equal checkout paths on different machines', async () => {
    const dir = await makeRepo({ 'app.py': 'x = 1\n' }), url = room()
    const previous = process.env.ROOM_MACHINE_ID
    try {
      process.env.ROOM_MACHINE_ID = 'machine-a'
      const a = await start({ room: url, dir, name: 'Ada' })
      process.env.ROOM_MACHINE_ID = 'machine-b'
      const b = await start({ room: url, dir, name: 'Bea' })
      expect(a.provider.awareness.getLocalState()!.watchedDirectory)
        .not.toBe(b.provider.awareness.getLocalState()!.watchedDirectory)
      expect(b.provider.awareness.getLocalState()!.publishUnder).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.ROOM_MACHINE_ID
      else process.env.ROOM_MACHINE_ID = previous
    }
  })

  it('persists its machine id once in the XDG config directory with private permissions', async () => {
    const dir = await makeRepo({ 'app.py': 'x = 1\n' })
    const configDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'room-config-'))
    const oldConfig = process.env.XDG_CONFIG_HOME, oldId = process.env.ROOM_MACHINE_ID
    const link = vi.spyOn(fs, 'linkSync')
    try {
      process.env.XDG_CONFIG_HOME = configDir
      delete process.env.ROOM_MACHINE_ID
      const a = await start({ room: room(), dir, name: 'Ada' })
      const file = path.join(configDir, 'room', 'machine-id')
      const id = await fsp.readFile(file, 'utf8')
      expect(id.trim()).toMatch(/^[a-f0-9]{64}$/)
      expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
      const b = await start({ room: room(), dir, name: 'Bea' })
      expect(b.provider.awareness.getLocalState()!.watchedDirectory).toBe(a.provider.awareness.getLocalState()!.watchedDirectory)
      expect(await fsp.readFile(file, 'utf8')).toBe(id)
      expect(link).toHaveBeenCalledTimes(1)
    } finally {
      link.mockRestore()
      if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = oldConfig
      if (oldId === undefined) delete process.env.ROOM_MACHINE_ID
      else process.env.ROOM_MACHINE_ID = oldId
      await fsp.rm(configDir, { recursive: true, force: true })
    }
  })

  it('joins with a stable checkout id when XDG config storage is unavailable', async () => {
    const dir = await makeRepo({ 'app.py': 'x = 1\n' })
    const configDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'room-config-blocked-'))
    const blocker = path.join(configDir, 'not-a-directory')
    await fsp.writeFile(blocker, 'blocked')
    const oldConfig = process.env.XDG_CONFIG_HOME, oldId = process.env.ROOM_MACHINE_ID
    const logs: string[] = []
    try {
      process.env.XDG_CONFIG_HOME = blocker
      delete process.env.ROOM_MACHINE_ID
      const a = await start({ room: room(), dir, name: 'Ada', log: line => logs.push(line) })
      const b = await start({ room: room(), dir, name: 'Bea', log: line => logs.push(line) })
      expect(a.provider.awareness.getLocalState()!.watchedDirectory).toMatch(/^[a-f0-9]{64}$/)
      expect(b.provider.awareness.getLocalState()!.watchedDirectory).toBe(a.provider.awareness.getLocalState()!.watchedDirectory)
      expect(logs.filter(line => line.includes('machine id'))).toHaveLength(1)
    } finally {
      if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = oldConfig
      if (oldId === undefined) delete process.env.ROOM_MACHINE_ID
      else process.env.ROOM_MACHINE_ID = oldId
      await fsp.rm(configDir, { recursive: true, force: true })
    }
  })

  it('checks HEAD before publishing a watcher batch after a commit', async () => {
    const dir = await makeRepo({ 'app.py': 'x = 1\n' })
    const logs: string[] = []
    const daemon = await start({ room: room(), dir, name: 'Ann', debounceMs: 300, basePollMs: 60_000, log: line => logs.push(line) })
    await fsp.writeFile(path.join(dir, 'app.py'), 'x = 2\n')
    sh(dir, ['add', '.']); sh(dir, ['commit', '-qm', 'merge result'])
    await waitFor(() => daemon.base === sh(dir, ['rev-parse', 'HEAD']))
    expect(daemon.roomDoc.changedPaths('Ann')).toEqual([])
    expect(logs.some(line => line === 'published app.py overlay')).toBe(false)
  })

  it('drops an in-flight old-base publish when HEAD moves during the read', async () => {
    const dir = await makeRepo({ 'app.py': 'x = 1\n' })
    let armed = false, parked = false
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const logs: string[] = []
    const daemon = await start({ room: room(), dir, name: 'Ann', basePollMs: 60_000,
      log: line => logs.push(line), beforePublishWrite: async p => {
        if (armed && p === 'app.py' && !parked) { parked = true; await held }
      } })
    armed = true
    try {
      await fsp.writeFile(path.join(dir, 'app.py'), 'x = 2\n')
      await waitFor(() => parked)
      sh(dir, ['add', '.']); sh(dir, ['commit', '-qm', 'committed during publish'])
    } finally { release() }
    await waitFor(() => daemon.base === sh(dir, ['rev-parse', 'HEAD']))
    await daemon.settle()
    expect(daemon.roomDoc.changedPaths('Ann')).toEqual([])
    expect(logs.some(line => line === 'published app.py overlay')).toBe(false)
  })

  it('skips files matched by .roomignore and re-evaluates when it changes', async () => {
    const dir = await makeRepo({ 'app.py': 'x = 1\n', 'fixtures/big.json': '{}\n', '.roomignore': 'fixtures/\n' })
    let fixtureScans = 0
    const daemon = await start({ room: room(), dir, name: 'Ann', onScanned: p => { if (p === 'fixtures/big.json') fixtureScans++ } })
    await fsp.writeFile(path.join(dir, 'fixtures/big.json'), '{"changed":true}\n')
    await waitFor(() => fixtureScans > 0 && daemon.skipped().ignore.includes('fixtures/big.json'))
    await fsp.writeFile(path.join(dir, 'app.py'), 'x = 2\n')
    await waitFor(() => daemon.roomDoc.text('app.py', 'Ann') === 'x = 2\n')
    expect(daemon.roomDoc.changedPaths('Ann')).toEqual(['app.py'])
    expect(daemon.skipped().ignore).toEqual(['fixtures/big.json'])
    // Lifting the rule publishes the file; adding one back clears its overlay.
    const ignoredScans = fixtureScans
    await fsp.writeFile(path.join(dir, '.roomignore'), '')
    await waitFor(() => fixtureScans > ignoredScans && daemon.roomDoc.text('fixtures/big.json', 'Ann') === '{"changed":true}\n')
    await daemon.settle()
    await fsp.writeFile(path.join(dir, '.roomignore'), '*.json\n')
    await waitFor(() => daemon.roomDoc.changedPaths('Ann').join(',') === 'app.py'
      && daemon.skipped().ignore.includes('fixtures/big.json'))
    expect(daemon.roomDoc.changedPaths('Ann')).toEqual(['app.py'])
  })

  it('clears a deletion marker when .roomignore starts matching its path', async () => {
    const dir = await makeRepo({ 'deleted.py': 'base\n', '.roomignore': '' })
    const daemon = await start({ room: room(), dir, name: 'Ann' })
    await fsp.unlink(path.join(dir, 'deleted.py'))
    await waitFor(() => daemon.roomDoc.deletedFor('Ann').has('deleted.py'))

    await fsp.writeFile(path.join(dir, '.roomignore'), 'deleted.py\n')
    ;(daemon as unknown as { reloadRoomIgnore(): void }).reloadRoomIgnore()

    expect(daemon.roomDoc.deletedFor('Ann').has('deleted.py')).toBe(false)
    expect(daemon.roomDoc.changedPaths('Ann')).toEqual([])
  })

  it('a publish already in flight when sharing drops to intent writes nothing', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n' })
    let gate: (() => void) | null = null
    const held = new Promise<void>(resolve => { gate = resolve })
    let armed = false, parked = 0
    const daemon = await start({ room: room(), dir, name: 'Race', share: 'full', beforePublishWrite: async p => { if (armed && p === 'a.txt' && parked++ === 0) await held } })
    armed = true
    await fsp.writeFile(path.join(dir, 'a.txt'), 'changed\n')
    await waitFor(() => parked >= 1)
    // The level drops while the first publish is parked after reading the base text.
    await daemon.setShare('intent')
    gate!()
    await daemon.settle()
    await waitFor(() => daemon.roomDoc.changedPaths('Race').length === 0
      && daemon.skipped().share.includes('a.txt'))
    expect(daemon.roomDoc.changedPaths('Race')).toEqual([])
    expect(daemon.skipped().share).toContain('a.txt')
  })

  it('stops sharing once the total budget is reached and records what was skipped', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' })
    const daemon = await start({ room: room(), dir, name: 'Bud', totalBudget: 250 })
    await fsp.writeFile(path.join(dir, 'a.txt'), 'A'.repeat(100))
    await waitFor(() => daemon.roomDoc.text('a.txt', 'Bud') === 'A'.repeat(100))
    await fsp.writeFile(path.join(dir, 'b.txt'), 'B'.repeat(100))
    await waitFor(() => daemon.roomDoc.text('b.txt', 'Bud') === 'B'.repeat(100))
    await fsp.writeFile(path.join(dir, 'c.txt'), 'C'.repeat(100))
    await waitFor(() => daemon.skipped().budget.includes('c.txt')
      && daemon.roomDoc.changedPaths('Bud').join(',') === 'a.txt,b.txt')
    expect(daemon.roomDoc.changedPaths('Bud').sort()).toEqual(['a.txt', 'b.txt'])
    expect(daemon.skipped().budget).toEqual(['c.txt'])
    // Freeing room lets the skipped file in on its next change.
    await fsp.writeFile(path.join(dir, 'a.txt'), 'a\n')
    await waitFor(() => !daemon.roomDoc.changedPaths('Bud').includes('a.txt'))
    await fsp.writeFile(path.join(dir, 'c.txt'), 'C'.repeat(100) + '!')
    await waitFor(() => daemon.roomDoc.text('c.txt', 'Bud') === 'C'.repeat(100) + '!'
      && daemon.skipped().budget.length === 0)
    expect(daemon.skipped().budget).toEqual([])
  })

  it('sets base/branch/normalised repo but keeps a clean overlay empty', async () => {
    const dir = await makeRepo({ 'README.md': '# hello\n', 'src/app.py': 'line1\nline2\n' })
    sh(dir, ['remote', 'add', 'origin', 'git@github.com:openai/room.git'])
    const daemon = await start({ room: room(), dir, name: 'Alice' })

    expect(daemon.roomDoc.changedPaths('Alice')).toEqual([])
    expect(daemon.roomDoc.meta).toMatchObject({
      base: sh(dir, ['rev-parse', 'HEAD']),
      branch: 'main',
      repo: 'github.com/openai/room',
      seededBy: 'Alice',
    })
    expect(daemon.provider.awareness.getLocalState()).toMatchObject({
      status: 'synced',
      lastActive: expect.any(Number),
    })
  })

  it('allows a dirty clone and seeds modified, deleted, and untracked files', async () => {
    const source = await makeRepo({ 'keep.py': 'base\n', 'delete.py': 'gone soon\n' })
    const dir = await cloneRepo(source)
    await fsp.writeFile(path.join(dir, 'keep.py'), 'dirty\n')
    await fsp.unlink(path.join(dir, 'delete.py'))
    await fsp.writeFile(path.join(dir, 'new.py'), 'new\n')

    const daemon = await start({ room: room(), dir, name: 'Dirty' })

    expect(daemon.roomDoc.text('keep.py', 'Dirty')).toBe('dirty\n')
    expect(daemon.roomDoc.text('new.py', 'Dirty')).toBe('new\n')
    expect(daemon.roomDoc.deletedFor('Dirty').has('delete.py')).toBe(true)
    expect(daemon.roomDoc.changedPaths('Dirty')).toEqual(['delete.py', 'keep.py', 'new.py'])
  })

  it('drops stale overlay and deleted paths when the same person restarts on a clean clone', async () => {
    const dir = await makeRepo({ 'keep.py': 'base\n' })
    const roomUrl = room()
    const peer = await start({ room: roomUrl, dir: await cloneRepo(dir), name: 'Peer' })
    peer.roomDoc.setOverlay('Alice', 'ghost.py', 'stale\n')
    peer.roomDoc.markDeleted('Alice', 'phantom.py')
    const logs: string[] = []

    const alice = await start({ room: roomUrl, dir, name: 'Alice', log: line => logs.push(line) })
    await waitFor(() => alice.roomDoc.changedPaths('Alice').length === 0
      && alice.roomDoc.deletedFor('Alice').size === 0)

    expect(alice.roomDoc.overlayText('Alice', 'ghost.py')).toBeUndefined()
    expect(alice.roomDoc.deletedFor('Alice').has('phantom.py')).toBe(false)
    expect(logs.filter(line => line.startsWith('dropped stale overlay '))).toEqual([
      'dropped stale overlay ghost.py',
      'dropped stale overlay phantom.py',
    ])
  })

  it('keeps a persisted overlay for a base file deleted on disk reported as deleted', async () => {
    const dir = await makeRepo({ 'deleted.py': 'base\n' })
    const roomUrl = room()
    const peer = await start({ room: roomUrl, dir: await cloneRepo(dir), name: 'Peer' })
    peer.roomDoc.setOverlay('Alice', 'deleted.py', 'old edit\n')
    await fsp.unlink(path.join(dir, 'deleted.py'))

    const alice = await start({ room: roomUrl, dir, name: 'Alice' })
    await waitFor(() => alice.roomDoc.deletedFor('Alice').has('deleted.py'))

    expect(alice.roomDoc.overlayText('Alice', 'deleted.py')).toBeUndefined()
    expect(alice.roomDoc.deletedFor('Alice').has('deleted.py')).toBe(true)
  })

  it('pushes disk changes, clears files restored to base, and marks deletions', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n', 'gone.py': 'present\n' })
    const daemon = await start({ room: room(), dir, name: 'Alice' })

    await fsp.writeFile(path.join(dir, 'app.py'), 'edited\n')
    await waitFor(() => daemon.roomDoc.text('app.py', 'Alice') === 'edited\n')
    expect(daemon.provider.awareness.getLocalState()?.lastActive).toEqual(expect.any(Number))

    await fsp.writeFile(path.join(dir, 'app.py'), 'base\n')
    await waitFor(() => daemon.roomDoc.text('app.py', 'Alice') === undefined)

    await fsp.unlink(path.join(dir, 'gone.py'))
    await waitFor(() => daemon.roomDoc.deletedFor('Alice').has('gone.py'))
    expect(daemon.roomDoc.text('gone.py', 'Alice')).toBeUndefined()
  })

  it('includes untracked non-ignored files and clears them when deleted', async () => {
    const dir = await makeRepo({ '.gitignore': 'ignored.txt\n' })
    let ignoredScanned = false
    const daemon = await start({ room: room(), dir, name: 'Alice', onScanned: p => { if (p === 'ignored.txt') ignoredScanned = true } })

    await fsp.writeFile(path.join(dir, 'new.py'), 'new\n')
    await waitFor(() => daemon.roomDoc.text('new.py', 'Alice') === 'new\n')
    await fsp.writeFile(path.join(dir, 'ignored.txt'), 'secret\n')
    await waitFor(() => ignoredScanned && daemon.roomDoc.text('ignored.txt', 'Alice') === undefined)
    expect(daemon.roomDoc.text('ignored.txt', 'Alice')).toBeUndefined()

    await fsp.unlink(path.join(dir, 'new.py'))
    await waitFor(() => !daemon.roomDoc.changedPaths('Alice').includes('new.py'))
    expect(daemon.roomDoc.text('new.py', 'Alice')).toBeUndefined()
    expect(daemon.roomDoc.deletedFor('Alice').has('new.py')).toBe(false)
  })

  it('does not republish an existing overlay after git starts ignoring its path', async () => {
    const dir = await makeRepo({ '.gitignore': '' })
    const daemon = await start({ room: room(), dir, name: 'Alice', trackedRefreshMs: 60_000 })
    await fsp.writeFile(path.join(dir, 'secret.txt'), 'first\n')
    await waitFor(() => daemon.roomDoc.text('secret.txt', 'Alice') === 'first\n')

    await fsp.writeFile(path.join(dir, '.gitignore'), 'secret.txt\n')
    await fsp.writeFile(path.join(dir, 'secret.txt'), 'second\n')
    await (daemon as unknown as { onDiskChange(path: string, isNew: boolean): Promise<void> }).onDiskChange('secret.txt', false)

    expect(daemon.roomDoc.text('secret.txt', 'Alice')).toBeUndefined()
  })

  it('withdraws a published untracked file when a tracked refresh finds it newly git-ignored', async () => {
    const dir = await makeRepo({ '.gitignore': '' })
    const daemon = await start({ room: room(), dir, name: 'Alice', trackedRefreshMs: 60_000 })
    await fsp.writeFile(path.join(dir, 'secret.txt'), 'private\n')
    await waitFor(() => daemon.roomDoc.text('secret.txt', 'Alice') === 'private\n')

    await fsp.writeFile(path.join(dir, '.gitignore'), 'secret.txt\n')
    await (daemon as unknown as { refreshTracked(): Promise<void> }).refreshTracked()

    expect(daemon.roomDoc.text('secret.txt', 'Alice')).toBeUndefined()
  })

  it('never changes clone bytes when another person overlay arrives', async () => {
    const source = await makeRepo({ 'app.py': 'base\n' })
    const otherClone = await cloneRepo(source)
    const roomUrl = room()
    const alice = await start({ room: roomUrl, dir: source, name: 'Alice' })
    const bob = await start({ room: roomUrl, dir: otherClone, name: 'Bob' })
    const before = fs.readFileSync(path.join(otherClone, 'app.py'))

    await fsp.writeFile(path.join(source, 'app.py'), 'alice edit\n')
    await waitFor(() => bob.roomDoc.text('app.py', 'Alice') === 'alice edit\n')

    expect(fs.readFileSync(path.join(otherClone, 'app.py'))).toEqual(before)
    expect(read(otherClone, 'app.py')).toBe('base\n')
    expect(bob.roomDoc.text('app.py', 'Bob')).toBeUndefined()
    expect(alice.roomDoc.whoChanged('app.py')).toEqual(['Alice'])
  })

  it('writes private room metadata and excludes Room files once', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n' })
    const roomUrl = room()
    const daemon = await start({ room: roomUrl, dir, name: 'Alice' })

    expect(JSON.parse(read(dir, '.git/room.json'))).toMatchObject({ name: 'Alice', dir })
    expect(read(dir, '.git/info/exclude').split('\n').filter(line => line === '.room.json')).toHaveLength(1)
    expect(read(dir, '.git/info/exclude').split('\n').filter(line => line === '.room/')).toHaveLength(1)

    await daemon.stop()
    await start({ room: roomUrl, dir, name: 'Alice' })
    expect(read(dir, '.git/info/exclude').split('\n').filter(line => line === '.room.json')).toHaveLength(1)
  })

  it('writes linked-worktree room metadata privately but excludes Room files in the common gitdir', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n' })
    const worker = path.join(dir, '.room', 'workers', 'one')
    fs.mkdirSync(path.dirname(worker), { recursive: true })
    sh(dir, ['worktree', 'add', '-qb', 'room/one', worker])
    const daemon = await start({ room: room(), dir: worker, name: 'Worker' })
    const privateDir = sh(worker, ['rev-parse', '--absolute-git-dir'])
    expect(JSON.parse(fs.readFileSync(path.join(privateDir, 'room.json'), 'utf8'))).toMatchObject({ name: 'Worker', dir: worker })
    expect(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.room.json\n')
    expect(fs.existsSync(path.join(privateDir, 'info', 'exclude'))).toBe(false)
    await daemon.stop()
  })

  it('logs an unpushed HEAD/base pair once across repeated polls, and logs new pairs', async () => {
    const origin = await makeRepo({ 'app.py': 'base\n' })
    const dir = await cloneRepo(origin)
    const logs: string[] = []
    const daemon = await start({ room: room(), dir, name: 'Alice', basePollMs: 60_000, log: line => logs.push(line) })
    const base = daemon.roomDoc.meta.base!
    // Invoke the actual poll deterministically, without wall-clock timer races.
    const poll = () => (daemon as unknown as { pollHead(): Promise<void> }).pollHead()
    const warnings = () => logs.filter(line => line.includes('but not pushed; base stays'))
    sh(dir, ['commit', '--allow-empty', '-qm', 'first'])
    const first = sh(dir, ['rev-parse', 'HEAD'])
    for (let i = 0; i < 4; i++) await poll()
    expect(warnings()).toHaveLength(1)
    sh(dir, ['commit', '--allow-empty', '-qm', 'second'])
    for (let i = 0; i < 4; i++) await poll()
    expect(warnings()).toHaveLength(2)
    daemon.roomDoc.setMeta({ base: first })
    for (let i = 0; i < 4; i++) await poll()
    expect(warnings()).toHaveLength(3)
    daemon.roomDoc.setMeta({ base })
    for (let i = 0; i < 4; i++) await poll()
    expect(warnings()).toHaveLength(3) // returning to an already-seen pair stays quiet
  })

  it('receipts integrated base notices on pull and arrival, while pending and invalid commits stay unread', async () => {
    const origin = await makeRepo({ 'app.py': 'base\n' })
    const dir = await cloneRepo(origin)
    const daemon = await start({ room: room(), dir, name: 'Alice', basePollMs: 60_000 })
    const old = sh(dir, ['rev-parse', 'HEAD'])
    fs.writeFileSync(path.join(origin, 'app.py'), 'next\n')
    sh(origin, ['commit', '-qam', 'next'])
    const next = sh(origin, ['rev-parse', 'HEAD'])
    sh(dir, ['fetch', '-q', 'origin'])
    const post = (base: string) => daemon.roomDoc.post({ name: 'Bob', kind: 'agent' },
      { type: 'base', base, prev: old, commits: 1, paths: ['app.py'], summary: 'next' })

    const pending = post(next)
    expect(daemon.roomDoc.seen('Alice').has(pending.id)).toBe(false)
    sh(dir, ['merge', '--ff-only', 'origin/main'])
    await (daemon as unknown as { pollHead(): Promise<void> }).pollHead()
    expect(daemon.roomDoc.seen('Alice').has(pending.id)).toBe(true)

    const arrived = post(old)
    expect(daemon.roomDoc.seen('Alice').has(arrived.id)).toBe(true)
    const invalid = post('missing-commit')
    expect(daemon.roomDoc.seen('Alice').has(invalid.id)).toBe(false)
    expect(daemon.roomDoc.messages()).toContainEqual(pending)
  })

  it('receipts an integrated base notice during startup sync', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n' })
    const base = sh(dir, ['rev-parse', 'HEAD'])
    const roomUrl = room()
    const remote = new RoomDoc()
    const provider = hub.connect(roomUrl, remote.doc)
    remote.setMeta({ base, branch: 'main' })
    const notice = remote.post({ name: 'Bob', kind: 'agent' },
      { type: 'base', base, prev: base, commits: 1, paths: ['app.py'], summary: 'already here' })
    try {
      const daemon = await start({ room: roomUrl, dir, name: 'Alice' })
      expect(daemon.roomDoc.seen('Alice').has(notice.id)).toBe(true)
    } finally { provider.destroy(); remote.doc.destroy() }
  })

  it('a pushed commit by a member advances the room base and posts a base entry; an unpushed one does not', async () => {
    const origin = await makeRepo({ 'app.py': 'base\n' })
    const source = await cloneRepo(origin)
    const daemon = await start({ room: room(), dir: source, name: 'Alice', basePollMs: 30 })
    const before = sh(source, ['rev-parse', 'HEAD'])
    expect(daemon.roomDoc.baseOf('Alice')).toBe(before)
    await fsp.writeFile(path.join(source, 'app.py'), 'edited\n')
    await waitFor(() => daemon.roomDoc.changedPaths('Alice').includes('app.py'))
    sh(source, ['commit', '-qam', 'edit app'])
    const after = sh(source, ['rev-parse', 'HEAD'])
    await waitFor(() => daemon.roomDoc.baseOf('Alice') === after)
    await waitFor(() => /unpushed/.test((daemon.provider.awareness.getLocalState() as { status: string }).status))
    expect(daemon.roomDoc.meta.base).toBe(before)
    sh(origin, ['config', 'receive.denyCurrentBranch', 'updateInstead'])
    sh(source, ['push', '-q', 'origin', 'HEAD:main'])
    // HEAD did not move on push; the daemon must notice the commit is now on the remote.
    await waitFor(() => daemon.roomDoc.meta.base === after)
    await waitFor(() => (daemon.provider.awareness.getLocalState() as { status: string }).status === 'synced')
    expect(daemon.base).toBe(after)
    await waitFor(() => daemon.roomDoc.changedPaths('Alice').length === 0)
    const entry = daemon.roomDoc.messages().find(m => m.type === 'base')
    expect(entry).toMatchObject({ type: 'base', priority: 'notify', base: after, prev: before, commits: 1, paths: ['app.py'], summary: 'edit app' })
    expect(daemon.roomDoc.ledger({ path: 'app.py' }).some(m => m.type === 'base')).toBe(true)
  })

  it('does not tell a worker on a carried commit to push its branch', async () => {
    const source = await makeRepo({ 'app.py': 'base\n' })
    const roomUrl = room()
    const lead = await start({ room: roomUrl, dir: source, name: 'Alice' })
    const sharedBase = lead.roomDoc.meta.base
    const workerDir = path.join(source, '.room', 'workers', 'w')
    sh(source, ['worktree', 'add', '-qb', 'room/w', workerDir])
    await fsp.writeFile(path.join(workerDir, 'app.py'), 'lead WIP\n')
    sh(workerDir, ['-c', 'user.name=Room', '-c', 'user.email=room@localhost', 'commit', '-qam', 'room: carried-in uncommitted work from Alice'])
    const worker = await start({ room: roomUrl, dir: workerDir, name: 'Alice+w', owner: 'Alice', label: 'w' })
    await waitFor(() => (worker.provider.awareness.getLocalState() as { status: string }).status !== 'syncing')
    expect((worker.provider.awareness.getLocalState() as { status: string }).status).toBe('worker worktree ahead of room base')
    expect(worker.roomDoc.meta.base).toBe(sharedBase)
    await fsp.writeFile(path.join(workerDir, 'worker.txt'), 'worker change\n')
    sh(workerDir, ['add', 'worker.txt']); sh(workerDir, ['commit', '-qm', 'worker change'])
    await waitFor(() => worker.base === sh(workerDir, ['rev-parse', 'HEAD']))
    expect((worker.provider.awareness.getLocalState() as { status: string }).status).toBe('worker worktree ahead of room base')
    expect(worker.roomDoc.meta.base).toBe(sharedBase)
  })

  /** A lead with uncommitted work and a worker spawned from it: carried commit C on top of the lead's HEAD P, plus a copied untracked file. */
  const carriedWorker = async () => {
    const source = await makeRepo({ 'app.py': 'base\n', 'other.py': 'other\n' })
    const leadHead = sh(source, ['rev-parse', 'HEAD'])
    const workerDir = path.join(source, '.room', 'workers', 'w')
    sh(source, ['worktree', 'add', '-qb', 'room/w', workerDir])
    await fsp.writeFile(path.join(workerDir, 'app.py'), 'lead WIP\n')
    sh(workerDir, ['-c', 'user.name=Room', '-c', 'user.email=room@localhost', 'commit', '-qam', 'room: carried-in uncommitted work from Alice'])
    const carried = sh(workerDir, ['rev-parse', 'HEAD'])
    await fsp.writeFile(path.join(workerDir, 'notes.txt'), 'lead notes\n')
    const blob = execFileSync('git', ['hash-object', '-w', 'notes.txt'], { cwd: workerDir, encoding: 'utf8' }).trim()
    const record = { id: 'Alice/w#1', tag: 'w', name: 'Alice+w', host: 'codex' as const, task: 't', dir: workerDir, branch: 'room/w', base: carried, carriedBase: carried, carriedUntracked: [{ path: 'notes.txt', sha: blob }], pid: 1, startedAt: Date.now(), status: 'running' as const, lead: 'Alice' }
    return { source, leadHead, workerDir, carried, record }
  }

  it('a worker never publishes the lead\'s carried files as its own changes; an edited carried untracked file diffs against its carried text', async () => {
    const { source, workerDir, carried, record } = await carriedWorker()
    const roomUrl = room()
    const lead = await start({ room: roomUrl, dir: source, name: 'Alice', localKey: 'k' })
    lead.roomDoc.setWorker(record)
    const worker = await start({ room: roomUrl, dir: workerDir, name: 'Alice+w', owner: 'Alice', label: 'w', localKey: 'k' })
    expect(worker.roomDoc.baseOf('Alice+w')).toBe(carried)
    expect(worker.roomDoc.changedPaths('Alice+w')).toEqual([])
    await fsp.writeFile(path.join(workerDir, 'notes.txt'), 'lead notes\nworker line\n')
    await waitFor(() => worker.roomDoc.changedPaths('Alice+w').includes('notes.txt'))
    expect(worker.roomDoc.baseText(carried, 'notes.txt')).toBe('lead notes\n')
  })

  it('in a team room a carried worker publishes against the lead\'s base, which teammates have, without the carried files', async () => {
    const { source, leadHead, workerDir, record } = await carriedWorker()
    const roomUrl = room()
    const lead = await start({ room: roomUrl, dir: source, name: 'Alice' })
    lead.roomDoc.setWorker(record)
    const worker = await start({ room: roomUrl, dir: workerDir, name: 'Alice+w', owner: 'Alice', label: 'w' })
    expect(worker.roomDoc.baseOf('Alice+w')).toBe(leadHead)
    expect(worker.roomDoc.changedPaths('Alice+w')).toEqual([])
    // A worker edit on top of a carried file: the full text, with the base text a teammate's clone has.
    await fsp.writeFile(path.join(workerDir, 'app.py'), 'lead WIP\nworker line\n')
    await fsp.writeFile(path.join(workerDir, 'other.py'), 'other\nworker line\n')
    await waitFor(() => worker.roomDoc.changedPaths('Alice+w').length === 2)
    expect(worker.roomDoc.text('app.py', 'Alice+w')).toBe('lead WIP\nworker line\n')
    expect(worker.roomDoc.baseText(leadHead, 'app.py')).toBe('base\n')
    expect(worker.roomDoc.baseText(leadHead, 'other.py')).toBe('other\n')
    // Reverting to the carried text withdraws the overlay again.
    await fsp.writeFile(path.join(workerDir, 'app.py'), 'lead WIP\n')
    await waitFor(() => !worker.roomDoc.changedPaths('Alice+w').includes('app.py'))
  })

  it('a clone behind the room base may join, is marked behind, and syncs after pulling', async () => {
    const source = await makeRepo({ 'app.py': 'base\n' })
    const behind = await cloneRepo(source)
    await fsp.writeFile(path.join(source, 'extra.txt'), 'x\n')
    sh(source, ['add', '-A']); sh(source, ['commit', '-q', '-m', 'extra'])
    sh(behind, ['fetch', '-q'])
    const roomUrl = room()
    await start({ room: roomUrl, dir: source, name: 'Alice' })
    const bob = await start({ room: roomUrl, dir: behind, name: 'Bob', basePollMs: 30 })
    await waitFor(() => (bob.provider.awareness.getLocalState() as { status: string }).status.startsWith('behind base by 1 commit:'))
    expect((bob.provider.awareness.getLocalState() as { status: string }).status).toContain('git pull --ff-only --autostash')
    const expectedBase = sh(source, ['rev-parse', 'HEAD'])
    sh(behind, ['pull', '-q', '--ff-only'])
    // Git polling and presence publication finish asynchronously under suite load.
    await waitFor(() => bob.base === expectedBase && bob.roomDoc.baseOf('Bob') === expectedBase
      && (bob.provider.awareness.getLocalState() as { status: string }).status === 'synced')
    expect(bob.base).toBe(expectedBase)
  })

  it('a diverged clone is refused with a rebase hint', async () => {
    const source = await makeRepo({ 'app.py': 'base\n' })
    const other = await cloneRepo(source)
    await fsp.writeFile(path.join(source, 'a.txt'), 'a\n'); sh(source, ['add', '-A']); sh(source, ['commit', '-q', '-m', 'a'])
    await fsp.writeFile(path.join(other, 'b.txt'), 'b\n'); sh(other, ['add', '-A']); sh(other, ['commit', '-q', '-m', 'b'])
    sh(other, ['fetch', '-q'])
    const roomUrl = room()
    await start({ room: roomUrl, dir: source, name: 'Alice' })
    const error = await startRoomd({ room: roomUrl, dir: other, name: 'Bob', log: silent, providerFactory }).then(() => null, caught => caught)
    expect(error).toBeInstanceOf(RoomdError)
    expect(error.message).toContain('diverged')
    expect(error.message).toContain('stop and tell your human')
    expect(error.message).toContain('never merge another branch into this one')
  })

  it('a clone that has not fetched the room base is refused with both SHAs and the pull hint', async () => {
    const source = await makeRepo({ 'app.py': 'base\n' })
    const stale = await cloneRepo(source)
    await fsp.writeFile(path.join(source, 'extra.txt'), 'x\n')
    sh(source, ['add', '-A']); sh(source, ['commit', '-q', '-m', 'extra'])
    const roomUrl = room()
    await start({ room: roomUrl, dir: source, name: 'Alice' })
    const roomHead = sh(source, ['rev-parse', 'HEAD'])
    const localHead = sh(stale, ['rev-parse', 'HEAD'])
    const error = await startRoomd({ room: roomUrl, dir: stale, name: 'Bob', log: silent, providerFactory }).then(() => null, caught => caught)
    expect(error).toBeInstanceOf(RoomdError)
    expect(error.code).toBe(2)
    expect(error.message).toContain(roomHead)
    expect(error.message).toContain(localHead)
    expect(error.message).toContain('git pull --ff-only --autostash')
    expect(error.message).toContain('Then $room-join')
  })

  it('a clone ahead of the room base (pushed) joins and advances it for everyone', async () => {
    const origin = await makeRepo({ 'app.py': 'base\n' })
    sh(origin, ['config', 'receive.denyCurrentBranch', 'updateInstead'])
    const source = await cloneRepo(origin)
    const ahead = await cloneRepo(origin)
    const roomUrl = room()
    const alice = await start({ room: roomUrl, dir: source, name: 'Alice', basePollMs: 30 })
    await fsp.writeFile(path.join(ahead, 'extra.txt'), 'x\n')
    sh(ahead, ['add', '-A']); sh(ahead, ['commit', '-q', '-m', 'extra'])
    sh(ahead, ['push', '-q', 'origin', 'HEAD:main'])
    sh(source, ['fetch', '-q'])
    const newHead = sh(ahead, ['rev-parse', 'HEAD'])
    await start({ room: roomUrl, dir: ahead, name: 'Bob' })
    expect(alice.roomDoc.meta.base).toBe(newHead)
    await waitFor(() => /behind base/.test((alice.provider.awareness.getLocalState() as { status: string }).status))
  })
})

describe('sharing levels', () => {
  const daemons: Roomd[] = []
  const hub = new MemoryHub()
  const room = () => `ws://memory/share-${Math.random().toString(36).slice(2, 8)}`
  const providerFactory: NonNullable<RoomdOptions['providerFactory']> = (server, name, doc) => hub.connect(`${server}/${name}`, doc)
  const start = async (options: Omit<RoomdOptions, 'providerFactory'>) => {
    const daemon = await startRoomd({ log: silent, debounceMs: 20, trackedRefreshMs: 100, providerFactory, ...options })
    daemons.push(daemon)
    return daemon
  }
  const presence = (d: Roomd) => d.provider.awareness.getLocalState() as { share?: string; status?: string }
  afterEach(async () => { await Promise.all(daemons.splice(0).map(daemon => daemon.stop())) })

  it('withdraws an earlier full overlay and its base text when a ceiling narrows during a later publish', async () => {
    const dir = await makeRepo({ 'a.py': 'base a\n', 'b.py': 'base b\n' })
    let ceiling: 'full' | 'intent' = 'full'
    const daemon = await start({ room: room(), dir, name: 'Ceiling', share: 'full', shareCeiling: () => ceiling })
    await fsp.writeFile(path.join(dir, 'a.py'), 'private a\n')
    await waitFor(() => daemon.roomDoc.text('a.py', 'Ceiling') === 'private a\n')
    const base = daemon.roomDoc.baseOf('Ceiling')!
    expect(daemon.roomDoc.baseText(base, 'a.py')).toBe('base a\n')
    ceiling = 'intent'
    await fsp.writeFile(path.join(dir, 'b.py'), 'private b\n')
    await waitFor(() => daemon.share === 'intent')
    expect(daemon.roomDoc.changedPaths('Ceiling')).toEqual([])
    expect(daemon.roomDoc.baseText(base, 'a.py')).toBeUndefined()
  })

  it('narrows full to declared without withdrawing in-scope text, then widens only on reconciliation', async () => {
    const dir = await makeRepo({ 'a.py': 'base a\n', 'b.py': 'base b\n' })
    const daemon = await start({ room: room(), dir, name: 'Decline' })
    await fsp.writeFile(path.join(dir, 'a.py'), 'private a\n')
    await fsp.writeFile(path.join(dir, 'b.py'), 'private b\n')
    await waitFor(() => daemon.roomDoc.changedPaths('Decline').length === 2)
    const base = daemon.roomDoc.baseOf('Decline')!
    await daemon.setShare('declared', ['b.py'])
    expect(daemon.roomDoc.changedPaths('Decline')).toEqual(['b.py'])
    expect(daemon.roomDoc.baseText(base, 'a.py')).toBeUndefined()
    expect(daemon.roomDoc.baseText(base, 'b.py')).toBe('base b\n')
    const widening = daemon.setShare('full')
    expect(daemon.roomDoc.changedPaths('Decline')).toEqual(['b.py'])
    await widening
    expect(daemon.roomDoc.changedPaths('Decline')).toEqual(['a.py', 'b.py'])
  })

  it('withdraws a deletion mark and base text left after an overlay was reverted', async () => {
    const dir = await makeRepo({ 'deleted.py': 'old\n', 'reverted.py': 'old\n' })
    const daemon = await start({ room: room(), dir, name: 'Withdraw' })
    const base = daemon.roomDoc.baseOf('Withdraw')!
    await fsp.writeFile(path.join(dir, 'reverted.py'), 'changed\n')
    await waitFor(() => daemon.roomDoc.text('reverted.py', 'Withdraw') === 'changed\n')
    await fsp.writeFile(path.join(dir, 'reverted.py'), 'old\n')
    await waitFor(() => !daemon.roomDoc.changedPaths('Withdraw').includes('reverted.py'))
    expect(daemon.roomDoc.baseText(base, 'reverted.py')).toBe('old\n')
    await fsp.unlink(path.join(dir, 'deleted.py'))
    await waitFor(() => daemon.roomDoc.deletedFor('Withdraw').has('deleted.py'))
    await daemon.setShare('intent')
    expect(daemon.roomDoc.deletedFor('Withdraw').has('deleted.py')).toBe(false)
    expect(daemon.roomDoc.baseText(base, 'reverted.py')).toBeUndefined()
  })

  it('withdraws base text published before HEAD advanced', async () => {
    const dir = await makeRepo({ 'a.py': 'base a\n', 'b.py': 'base b\n' })
    const daemon = await start({ room: room(), dir, name: 'Advance', basePollMs: 20 })
    const oldBase = daemon.base
    await fsp.writeFile(path.join(dir, 'a.py'), 'changed a\n')
    await waitFor(() => daemon.roomDoc.baseText(oldBase, 'a.py') === 'base a\n')
    sh(dir, ['add', 'a.py']); sh(dir, ['commit', '-qm', 'advance'])
    await waitFor(() => daemon.base !== oldBase)
    await fsp.writeFile(path.join(dir, 'b.py'), 'changed b\n')
    await waitFor(() => daemon.roomDoc.text('b.py', 'Advance') === 'changed b\n')
    await daemon.setShare('intent')
    expect(daemon.roomDoc.changedPaths('Advance')).toEqual([])
    expect(daemon.roomDoc.baseText(oldBase, 'a.py')).toBeUndefined()
    expect(daemon.roomDoc.baseText(daemon.base, 'b.py')).toBeUndefined()
  })

  it('does not let an old withheld scan remove an overlay after sharing widens', async () => {
    const dir = await makeRepo({ 'a.py': 'base\n' })
    let release!: () => void
    let parked!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { parked = resolve })
    let holdNextRead = true
    const daemon = await start({ room: room(), dir, name: 'Widen', share: 'intent',
      beforeBaseRead: async relpath => {
        if (relpath !== 'a.py' || !holdNextRead) return
        holdNextRead = false
        parked()
        await held
      },
    })
    await fsp.writeFile(path.join(dir, 'a.py'), 'changed\n')
    await reached
    await daemon.setShare('declared', ['a.py'])
    expect(daemon.roomDoc.text('a.py', 'Widen')).toBe('changed\n')
    release()
    await daemon.settle()
    expect(daemon.roomDoc.text('a.py', 'Widen')).toBe('changed\n')
    expect(daemon.skipped().share).toEqual([])
  })

  it('does not let an old withheld scan remove an overlay after scope expands', async () => {
    const dir = await makeRepo({ 'a.py': 'base\n' })
    let release!: () => void
    let parked!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { parked = resolve })
    let holdNextRead = true
    const daemon = await start({ room: room(), dir, name: 'Scope', share: 'declared',
      beforeBaseRead: async relpath => {
        if (relpath !== 'a.py' || !holdNextRead) return
        holdNextRead = false
        parked()
        await held
      },
    })
    await fsp.writeFile(path.join(dir, 'a.py'), 'changed\n')
    await reached
    daemon.roomDoc.setScope({ by: 'Scope', byKind: 'agent', area: 'app', summary: 'edit app', paths: ['a.py'] })
    await waitFor(() => daemon.roomDoc.text('a.py', 'Scope') === 'changed\n')
    release()
    await daemon.settle()
    expect(daemon.roomDoc.text('a.py', 'Scope')).toBe('changed\n')
    expect(daemon.skipped().share).toEqual([])
  })

  it('checks a changed ceiling before the first overlay publish', async () => {
    const dir = await makeRepo({ 'a.txt': 'base\n' })
    await fsp.writeFile(path.join(dir, 'a.txt'), 'private edit\n')
    let ceiling: 'full' | 'intent' = 'full'
    let release!: () => void
    let parked!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { parked = resolve })
    const pending = start({ room: room(), dir, name: 'Late', share: 'full', shareCeiling: () => ceiling,
      beforePublishWrite: async () => { parked(); await held },
    })
    await reached
    ceiling = 'intent'
    release()
    const daemon = await pending
    expect(daemon.roomDoc.changedPaths('Late')).toEqual([])
    expect(daemon.share).toBe('intent')
  })

  it('parseShare and clampShare', () => {
    expect(parseShare('Declared ')).toBe('declared')
    expect(parseShare('everything')).toBeUndefined()
    expect(parseShare(undefined)).toBeUndefined()
    expect(clampShare('full', 'declared')).toBe('declared')
    expect(clampShare('intent', 'full')).toBe('intent')
    expect(clampShare('declared', 'declared')).toBe('declared')
  })

  it('full (default) publishes every changed file and says so in presence', async () => {
    const dir = await makeRepo({ 'a.py': 'a\n' })
    await fsp.writeFile(path.join(dir, 'a.py'), 'A\n')
    const daemon = await start({ room: room(), dir, name: 'Full' })
    expect(daemon.share).toBe('full')
    expect(presence(daemon).share).toBe('full')
    expect(daemon.roomDoc.changedPaths('Full')).toEqual(['a.py'])
    expect(daemon.skipped().share).toEqual([])
  })

  it('intent publishes no file text at all, not even deletions, but tracks what is withheld', async () => {
    const dir = await makeRepo({ 'a.py': 'a\n', 'gone.py': 'x\n' })
    await fsp.writeFile(path.join(dir, 'a.py'), 'A\n')
    await fsp.unlink(path.join(dir, 'gone.py'))
    const daemon = await start({ room: room(), dir, name: 'Quiet', share: 'intent' })
    expect(presence(daemon).share).toBe('intent')
    expect(daemon.roomDoc.changedPaths('Quiet')).toEqual([])
    expect(daemon.skipped().share).toEqual(['a.py', 'gone.py'])
    // later disk edits stay private too
    await fsp.writeFile(path.join(dir, 'new.py'), 'new\n')
    await waitFor(() => daemon.skipped().share.includes('new.py'))
    expect(daemon.roomDoc.changedPaths('Quiet')).toEqual([])
    // scope, claims and bus still work: the doc is untouched by the level
    daemon.roomDoc.setScope({ by: 'Quiet', byKind: 'agent', area: 'x', summary: 'y', paths: ['a.py'] })
    expect(daemon.roomDoc.scope('Quiet')?.area).toBe('x')
  })

  it('declared publishes only paths that entered the scope and follows scope additions', async () => {
    const dir = await makeRepo({ 'src/a.py': 'a\n', 'docs/b.md': 'b\n', 'misc/c.txt': 'c\n' })
    await fsp.writeFile(path.join(dir, 'src/a.py'), 'A\n')
    await fsp.writeFile(path.join(dir, 'docs/b.md'), 'B\n')
    await fsp.writeFile(path.join(dir, 'misc/c.txt'), 'C\n')
    const daemon = await start({ room: room(), dir, name: 'Decl', share: 'declared' })
    // no scope yet: nothing is shared
    expect(daemon.roomDoc.changedPaths('Decl')).toEqual([])
    expect(daemon.skipped().share).toEqual(['docs/b.md', 'misc/c.txt', 'src/a.py'])
    daemon.roomDoc.setScope({ by: 'Decl', byKind: 'agent', area: 'src', summary: 's', paths: ['src/'] })
    await waitFor(() => daemon.roomDoc.changedPaths('Decl').join(',') === 'src/a.py'
      && daemon.skipped().share.join(',') === 'docs/b.md,misc/c.txt')
    expect(daemon.roomDoc.changedPaths('Decl')).toEqual(['src/a.py'])
    expect(daemon.skipped().share).toEqual(['docs/b.md', 'misc/c.txt'])
    // Moving the active scope publishes docs but retains already-published finished output.
    daemon.roomDoc.setScope({ by: 'Decl', byKind: 'agent', area: 'docs', summary: 'd', paths: ['docs'] })
    await waitFor(() => daemon.roomDoc.changedPaths('Decl').join(',') === 'docs/b.md,src/a.py'
      && daemon.skipped().share.join(',') === 'misc/c.txt')
    expect(daemon.skipped().share).toEqual(['misc/c.txt'])
    // A real sharing-level change resets retention; explicit paths then win over the doc.
    await daemon.setShare('intent')
    await daemon.setShare('declared', ['src/'])
    expect(daemon.roomDoc.changedPaths('Decl')).toEqual(['src/a.py'])
    expect(daemon.skipped().share).toEqual(['docs/b.md', 'misc/c.txt'])
  })

  it('keeps declared output published after task scope clears until the sharing boundary changes', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n', 'private.py': 'base\n' })
    await fsp.writeFile(path.join(dir, 'app.py'), 'finished\n')
    await fsp.writeFile(path.join(dir, 'private.py'), 'never shared\n')
    const daemon = await start({ room: room(), dir, name: 'Decl', share: 'declared' })
    daemon.roomDoc.setScope({ by: 'Decl', byKind: 'agent', area: 'app', summary: 'finish app', paths: ['app.py'] })
    await waitFor(() => daemon.roomDoc.text('app.py', 'Decl') === 'finished\n')
    expect(daemon.roomDoc.text('private.py', 'Decl')).toBeUndefined()

    daemon.roomDoc.clearScope('Decl')
    await (daemon as unknown as { resharePaths(): Promise<void> }).resharePaths()
    expect(daemon.roomDoc.text('app.py', 'Decl')).toBe('finished\n')
    expect(daemon.roomDoc.text('private.py', 'Decl')).toBeUndefined()

    await daemon.setShare('intent')
    await daemon.setShare('declared')
    expect(daemon.roomDoc.changedPaths('Decl')).toEqual([])
  })

  it('restores finished declared output after the daemon restarts with an empty scope', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n', 'private.py': 'base\n' })
    await fsp.writeFile(path.join(dir, 'app.py'), 'finished\n')
    await fsp.writeFile(path.join(dir, 'private.py'), 'private\n')
    const url = room()
    const first = await start({ room: url, dir, name: 'Decl', share: 'declared' })
    first.roomDoc.setScope({ by: 'Decl', byKind: 'agent', area: 'app', summary: 'finish app', paths: ['app.py'] })
    await waitFor(() => first.roomDoc.text('app.py', 'Decl') === 'finished\n')
    first.roomDoc.clearScope('Decl')
    await first.stop()
    const restarted = await start({ room: url, dir, name: 'Decl', share: 'declared' })
    expect(restarted.roomDoc.text('app.py', 'Decl')).toBe('finished\n')
    expect(restarted.roomDoc.text('private.py', 'Decl')).toBeUndefined()
    const teammate = await start({ room: url, dir: await cloneRepo(dir), name: 'Peer', share: 'intent' })
    expect(teammate.roomDoc.text('app.py', 'Decl')).toBe('finished\n')
  })

  it('does not publish server A retained output when the same checkout joins server B', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n' })
    await fsp.writeFile(path.join(dir, 'app.py'), 'finished\n')
    const name = `same-${Math.random().toString(36).slice(2, 8)}`
    const first = await start({ room: `ws://server-a/${name}`, dir, name: 'Decl', share: 'declared' })
    first.roomDoc.setScope({ by: 'Decl', byKind: 'agent', area: 'app', summary: 'finish app', paths: ['app.py'] })
    await waitFor(() => first.roomDoc.text('app.py', 'Decl') === 'finished\n')
    first.roomDoc.clearScope('Decl')
    await first.stop()
    const second = await start({ room: `ws://server-b/${name}`, dir, name: 'Decl', share: 'declared' })
    expect(second.roomDoc.changedPaths('Decl')).toEqual([])
    expect(second.roomDoc.text('app.py', 'Decl')).toBeUndefined()
  })

  it('does not publish retained declared output into a different room from the same checkout', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n' })
    await fsp.writeFile(path.join(dir, 'app.py'), 'finished\n')
    const first = await start({ room: room(), dir, name: 'Decl', share: 'declared' })
    first.roomDoc.setScope({ by: 'Decl', byKind: 'agent', area: 'app', summary: 'finish', paths: ['app.py'] })
    await waitFor(() => first.roomDoc.text('app.py', 'Decl') === 'finished\n')
    first.roomDoc.clearScope('Decl')
    await first.stop()
    const second = await start({ room: room(), dir, name: 'Decl', share: 'declared' })
    expect(second.roomDoc.text('app.py', 'Decl')).toBeUndefined()
    expect(second.roomDoc.changedPaths('Decl')).toEqual([])
  })

  it('setShare withdraws overlays when the level drops and republishes when it rises', async () => {
    const dir = await makeRepo({ 'a.py': 'a\n', 'b.py': 'b\n' })
    const daemon = await start({ room: room(), dir, name: 'Dial' })
    await fsp.writeFile(path.join(dir, 'a.py'), 'A\n')
    await waitFor(() => daemon.roomDoc.text('a.py', 'Dial') === 'A\n')
    await fsp.writeFile(path.join(dir, 'b.py'), 'B\n')
    await waitFor(() => daemon.roomDoc.text('b.py', 'Dial') === 'B\n'
      && daemon.roomDoc.changedPaths('Dial').join(',') === 'a.py,b.py')
    await daemon.settle()
    await daemon.setShare('intent')
    expect(daemon.share).toBe('intent')
    expect(presence(daemon).share).toBe('intent')
    expect(daemon.roomDoc.changedPaths('Dial')).toEqual([])
    expect(daemon.skipped().share).toEqual(['a.py', 'b.py'])
    await daemon.setShare('declared', ['b.py'])
    expect(daemon.roomDoc.changedPaths('Dial')).toEqual(['b.py'])
    expect(daemon.roomDoc.text('b.py', 'Dial')).toBe('B\n')
    expect(daemon.skipped().share).toEqual(['a.py'])
    await daemon.setShare('full')
    expect(daemon.roomDoc.changedPaths('Dial')).toEqual(['a.py', 'b.py'])
    expect(daemon.skipped().share).toEqual([])
    // and a file restored to base drops out of the withheld list under intent
    await daemon.setShare('intent')
    await fsp.writeFile(path.join(dir, 'a.py'), 'a\n')
    await waitFor(() => !daemon.skipped().share.includes('a.py'))
    expect(daemon.skipped().share).toEqual(['b.py'])
  })
})
