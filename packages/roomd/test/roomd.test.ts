import { manifestText, manifestPaths, incarnationText, manifestDeleted } from './manifest-assert.js'
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { RoomDoc, manifestChangers, manifestKey, participantRecord } from '@room/shared'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, defaultIgnoredPath, clampShare, parseShare, policyFromLevel, type ShareLevel, type Roomd, type RoomdOptions } from '../src/index.js'
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
  const start = async (options: Omit<RoomdOptions, 'providerFactory' | 'policy'> & { share?: ShareLevel; scopePaths?: string[]; shareCeiling?: () => ShareLevel }) => {
    const { share, scopePaths, shareCeiling, ...rest } = options
    const daemon = await startRoomd({ log: silent, debounceMs: 20, trackedRefreshMs: 100, providerFactory, ...rest, policy: policyFromLevel(share ?? 'full', scopePaths, shareCeiling?.() ?? 'full') })
    daemons.push(daemon)
    return daemon
  }

  afterEach(async () => { await Promise.all(daemons.splice(0).map(daemon => daemon.stop())) })

  const setPolicy = async (daemon: Roomd, level: ShareLevel, paths: string[] = []) => {
    const old = daemon.inputs.policy
    daemon.applyInputs({ ...daemon.inputs, policy: { ...policyFromLevel(level, paths, old.ceiling, old.publisher), ...(old.publisherName ? { publisherName: old.publisherName } : {}) } })
    await daemon.reconcileGitChanges()
  }


  it('reconciles edited, restored, and deleted disk paths against HEAD', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n' })
    await fsp.writeFile(path.join(dir, 'app.py'), 'edit\n')
    const daemon = await start({ room: room(), dir, name: 'Writer' })
    expect(manifestText(daemon.roomDoc, 'app.py', 'Writer')).toBe('edit\n')
    await fsp.writeFile(path.join(dir, 'app.py'), 'base\n')
    await waitFor(() => manifestPaths(daemon.roomDoc, 'Writer').length === 0)
    await fsp.unlink(path.join(dir, 'app.py'))
    await waitFor(() => manifestDeleted(daemon.roomDoc, 'Writer', 'app.py'))
    expect(manifestText(daemon.roomDoc, 'app.py', 'Writer')).toBeUndefined()
    await fsp.writeFile(path.join(dir, 'app.py'), 'base\n')
    await waitFor(() => !manifestDeleted(daemon.roomDoc, 'Writer', 'app.py'))
    expect(manifestPaths(daemon.roomDoc, 'Writer')).toEqual([])
  })

  it('logs a distinct failed publication once and succeeds on a fresh reconciliation', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n' })
    const logs: string[] = []
    let fail = true
    const daemon = await start({ room: room(), dir, name: 'Retry', log: line => logs.push(line),
      beforePublishWrite: async () => { if (fail) { fail = false; throw new Error('injected publish failure') } },
    })
    await fsp.writeFile(path.join(dir, 'app.py'), 'edit\n')
    await daemon.reconcileGitChanges()
    expect(logs.filter(line => line.includes('injected publish failure'))).toHaveLength(1)
    await daemon.reconcileGitChanges()
    expect(manifestText(daemon.roomDoc, 'app.py', 'Retry')).toBe('edit\n')
  })

  it('leaves a retired participant\'s base key to its owner during remote repair', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n' }), url = room()
    const scheduled: Array<() => Promise<void>> = []
    const owner = await start({ dir, room: url, name: 'Keeper', remoteRepairSchedule: run => { scheduled.push(run); return () => {} } })
    const peer = new RoomDoc(), connection = hub.connect(url, peer.doc)
    try {
      peer.setOverlay('Gone', 'old.py', 'edit')
      peer.clearOverlays('Gone')
      peer.setBaseText('Gone', 'sha', 'old.py', 'late base')
      expect(owner.roomDoc.baseText('Gone', 'sha', 'old.py')).toBe('late base')
      expect(scheduled).toHaveLength(1)
      await scheduled.shift()!()
      expect(peer.baseText('Gone', 'sha', 'old.py')).toBe('late base')
    } finally { connection.destroy(); peer.doc.destroy() }
  })

  it('repairs a remote replacement of its own flat base text from the real base', async () => {
    const dir = await makeRepo({ 'edit.py': 'real base\n' }), url = room()
    fs.writeFileSync(path.join(dir, 'edit.py'), 'edited\n')
    const scheduled: Array<() => Promise<void>> = []
    const owner = await start({ dir, room: url, name: 'Owner', remoteRepairSchedule: run => { scheduled.push(run); return () => {} } })
    const peer = new RoomDoc(), connection = hub.connect(url, peer.doc)
    try {
      peer.ownedBaseTexts.set(`Owner\u0000${owner.inputs.head}:edit.py`, 'forged')
      expect(owner.roomDoc.baseText('Owner', owner.inputs.head, 'edit.py')).toBe('forged')
      expect(scheduled).toHaveLength(1)
      await scheduled.shift()!()
      expect(peer.baseText('Owner', owner.inputs.head, 'edit.py')).toBe('real base\n')
    } finally { connection.destroy(); peer.doc.destroy() }
  })

  it('reconciles remotely cleared own overlays, deletion marks and base texts without a disk event', async () => {
    const dir = await makeRepo({ 'edit.py': 'base\n', 'gone.py': 'old\n' })
    fs.writeFileSync(path.join(dir, 'edit.py'), 'changed\n')
    fs.unlinkSync(path.join(dir, 'gone.py'))
    const url = room()
    const owner = await start({ dir, room: url, name: 'Owner', basePollMs: 60_000, trackedRefreshMs: 60_000 })
    const peer = new RoomDoc()
    const connection = hub.connect(url, peer.doc)
    try {
      const base = owner.inputs.head
      await waitFor(() => incarnationText(peer, 'Owner', 'edit.py')?.toString() === 'changed\n' && manifestDeleted(peer, 'Owner', 'gone.py'))
      peer.clearOverlays('Owner')
      await waitFor(() => incarnationText(peer, 'Owner', 'edit.py')?.toString() === 'changed\n'
        && manifestDeleted(peer, 'Owner', 'gone.py')
        && peer.baseText('Owner', base, 'edit.py') === 'base\n'
        && peer.baseText('Owner', base, 'gone.py') === 'old\n')
    } finally { connection.destroy(); peer.doc.destroy() }
  })

  it('restores a racing live publisher after a peer sweeps its late base key', async () => {
    const dir = await makeRepo({ 'edit.py': 'base\n' })
    fs.writeFileSync(path.join(dir, 'edit.py'), 'changed\n')
    const url = room()
    const owner = await start({ dir, room: url, name: 'Owner', basePollMs: 60_000, trackedRefreshMs: 60_000 })
    const peer = new RoomDoc()
    const connection = hub.connect(url, peer.doc)
    try {
      await waitFor(() => incarnationText(peer, 'Owner', 'edit.py')?.toString() === 'changed\n')
      peer.clearOverlays('Owner')
      owner.roomDoc.setBaseText('Owner', owner.inputs.head, 'edit.py', 'late base', owner)
      peer.reconcileBaseTexts('Peer')
      await waitFor(() => incarnationText(peer, 'Owner', 'edit.py')?.toString() === 'changed\n'
        && peer.baseText('Owner', owner.inputs.head, 'edit.py') === 'base\n')
    } finally { connection.destroy(); peer.doc.destroy() }
  })

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
    await waitFor(() => manifestText(daemon.roomDoc, 'app.py', 'Ann') === 'x = 2\n')
    expect(manifestPaths(daemon.roomDoc, 'Ann')).toEqual(['app.py'])
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
      await setPolicy(daemon, 'full')
      expect(reader.mock.calls.some(([p]) => String(p) === path.join(dir, 'a.npy'))).toBe(false)
      expect(logs.filter(line => line.startsWith('skip'))).toEqual([])
      expect(logs.filter(line => line.startsWith('synced ') && line.includes('skipped'))).toEqual([])
    } finally { reader.mockRestore() }
  })

  it('publishes a shared real directory only from the publisher lease holder, and logs its stop reason once', async () => {
    const dir = await makeRepo({ 'app.py': 'x = 1\n' }), url = room()
    const primary = await start({ room: url, dir, name: 'Zoe' })
    const logs: string[] = []
    const secondary = await startRoomd({ log: line => logs.push(line), debounceMs: 20, trackedRefreshMs: 100, providerFactory, room: url, dir, name: 'Amy',
      policy: Object.freeze({ ...policyFromLevel('full', [], 'full', false), publisherName: 'Zoe' }) })
    daemons.push(secondary)
    const state = secondary.provider.awareness.getLocalState()!
    expect(state.watchedDirectory).toMatch(/^[a-f0-9]{64}$/)
    expect(state.watchedDirectory).toBe(primary.provider.awareness.getLocalState()!.watchedDirectory)
    await fsp.writeFile(path.join(dir, 'app.py'), 'x = 2\n')
    await waitFor(() => manifestText(primary.roomDoc, 'app.py', 'Zoe') === 'x = 2\n')
    await secondary.reconcileGitChanges()
    expect(manifestPaths(secondary.roomDoc, 'Amy')).toEqual([])
    expect(secondary.roomDoc.manifestHead.get('Amy')).toMatchObject({ coverage: { kind: 'none', reason: 'not-publisher' }, publisher: 'Zoe' })
    // Zoe's process releases the lease on leaving; Amy's next tick takes it and her store says so.
    await primary.stop('handoff')
    secondary.applyInputs({ ...secondary.inputs, policy: policyFromLevel('full') })
    await secondary.reconcileGitChanges()
    await waitFor(() => manifestText(secondary.roomDoc, 'app.py', 'Amy') === 'x = 2\n')
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
    expect(manifestPaths(daemon.roomDoc, 'Ann')).toEqual([])
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
    expect(manifestPaths(daemon.roomDoc, 'Ann')).toEqual([])
    expect(logs.some(line => line === 'published app.py overlay')).toBe(false)
  })

  it('skips files matched by .roomignore and re-evaluates when it changes', async () => {
    const dir = await makeRepo({ 'app.py': 'x = 1\n', 'fixtures/big.json': '{}\n', '.roomignore': 'fixtures/\n' })
    const daemon = await start({ room: room(), dir, name: 'Ann' })
    await fsp.writeFile(path.join(dir, 'fixtures/big.json'), '{"changed":true}\n')
    await daemon.reconcileGitChanges()
    expect(daemon.skipped().ignore).toContain('fixtures/big.json')
    await fsp.writeFile(path.join(dir, 'app.py'), 'x = 2\n')
    await waitFor(() => manifestText(daemon.roomDoc, 'app.py', 'Ann') === 'x = 2\n')
    expect(manifestPaths(daemon.roomDoc, 'Ann')).toEqual(['app.py'])
    expect(daemon.skipped().ignore).toEqual(['fixtures/big.json'])
    // Lifting the rule publishes the file; adding one back clears its overlay.
    await fsp.writeFile(path.join(dir, '.roomignore'), '')
    ;(daemon as unknown as { reloadRoomIgnore(): void }).reloadRoomIgnore()
    await daemon.reconcileGitChanges()
    expect(manifestText(daemon.roomDoc, 'fixtures/big.json', 'Ann')).toBe('{"changed":true}\n')
    await daemon.settle()
    await fsp.writeFile(path.join(dir, '.roomignore'), '*.json\n')
    ;(daemon as unknown as { reloadRoomIgnore(): void }).reloadRoomIgnore()
    await daemon.reconcileGitChanges()
    await waitFor(() => !manifestPaths(daemon.roomDoc, 'Ann').includes('fixtures/big.json')
      && daemon.skipped().ignore.includes('fixtures/big.json'))
    expect(manifestPaths(daemon.roomDoc, 'Ann')).toContain('app.py')
  })

  it('clears a deletion marker when .roomignore starts matching its path', async () => {
    const dir = await makeRepo({ 'deleted.py': 'base\n', '.roomignore': '' })
    const daemon = await start({ room: room(), dir, name: 'Ann' })
    await fsp.unlink(path.join(dir, 'deleted.py'))
    await waitFor(() => manifestDeleted(daemon.roomDoc, 'Ann', 'deleted.py'))

    await fsp.writeFile(path.join(dir, '.roomignore'), 'deleted.py\n')
    ;(daemon as unknown as { reloadRoomIgnore(): void }).reloadRoomIgnore()

    expect(manifestDeleted(daemon.roomDoc, 'Ann', 'deleted.py')).toBe(false)
    expect(manifestPaths(daemon.roomDoc, 'Ann')).toEqual([])
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
    daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('intent') })
    gate!()
    await daemon.reconcileGitChanges()
    await waitFor(() => manifestPaths(daemon.roomDoc, 'Race').length === 0)
    expect(manifestPaths(daemon.roomDoc, 'Race')).toEqual([])
    expect(daemon.roomDoc.manifestHead.get('Race')?.coverage).toEqual({ kind: 'none', reason: 'intent' })
  })

  it('stops sharing once the total budget is reached and records what was skipped', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' })
    const daemon = await start({ room: room(), dir, name: 'Bud', totalBudget: 250 })
    await fsp.writeFile(path.join(dir, 'a.txt'), 'A'.repeat(100))
    await waitFor(() => manifestText(daemon.roomDoc, 'a.txt', 'Bud') === 'A'.repeat(100))
    await fsp.writeFile(path.join(dir, 'b.txt'), 'B'.repeat(100))
    await waitFor(() => manifestText(daemon.roomDoc, 'b.txt', 'Bud') === 'B'.repeat(100))
    await fsp.writeFile(path.join(dir, 'c.txt'), 'C'.repeat(100))
    await waitFor(() => daemon.skipped().budget.includes('c.txt')
      && manifestPaths(daemon.roomDoc, 'Bud').join(',') === 'a.txt,b.txt')
    expect(manifestPaths(daemon.roomDoc, 'Bud').sort()).toEqual(['a.txt', 'b.txt'])
    expect(daemon.skipped().budget).toEqual(['c.txt'])
    // Freeing room lets the skipped file in on its next change.
    await fsp.writeFile(path.join(dir, 'a.txt'), 'a\n')
    await waitFor(() => !manifestPaths(daemon.roomDoc, 'Bud').includes('a.txt'))
    await fsp.writeFile(path.join(dir, 'c.txt'), 'C'.repeat(100) + '!')
    await waitFor(() => manifestText(daemon.roomDoc, 'c.txt', 'Bud') === 'C'.repeat(100) + '!'
      && daemon.skipped().budget.length === 0)
    expect(daemon.skipped().budget).toEqual([])
  })

  it('keeps branch and base on its participant record while a clean overlay stays empty', async () => {
    const dir = await makeRepo({ 'README.md': '# hello\n', 'src/app.py': 'line1\nline2\n' })
    sh(dir, ['remote', 'add', 'origin', 'git@github.com:openai/room.git'])
    const daemon = await start({ room: room(), dir, name: 'Alice' })

    expect(manifestPaths(daemon.roomDoc, 'Alice')).toEqual([])
    expect(participantRecord(daemon.roomDoc, 'Alice')?.git).toMatchObject({
      head: sh(dir, ['rev-parse', 'HEAD']), branch: 'main',
    })
    expect(daemon.roomDoc.meta.base).toBeUndefined()
    // No ref of the room's remote has been fetched: nothing a teammate could resolve.
    expect(daemon.provider.awareness.getLocalState()).toMatchObject({
      status: 'no anchor on origin: teammates cannot compare with you',
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

    expect(manifestText(daemon.roomDoc, 'keep.py', 'Dirty')).toBe('dirty\n')
    expect(manifestText(daemon.roomDoc, 'new.py', 'Dirty')).toBe('new\n')
    expect(manifestDeleted(daemon.roomDoc, 'Dirty', 'delete.py')).toBe(true)
    expect(manifestPaths(daemon.roomDoc, 'Dirty')).toEqual(['delete.py', 'keep.py', 'new.py'])
  })

  it('drops stale overlay paths when the same person restarts on a clean clone', async () => {
    const dir = await makeRepo({ 'keep.py': 'base\n' })
    const roomUrl = room()
    const peer = await start({ room: roomUrl, dir: await cloneRepo(dir), name: 'Peer' })
    peer.roomDoc.setOverlay('Alice', 'ghost.py', 'stale\n')
    const logs: string[] = []

    const alice = await start({ room: roomUrl, dir, name: 'Alice', log: line => logs.push(line) })
    await waitFor(() => manifestPaths(alice.roomDoc, 'Alice').length === 0)

    expect(incarnationText(alice.roomDoc, 'Alice', 'ghost.py')).toBeUndefined()
    expect(manifestDeleted(alice.roomDoc, 'Alice', 'phantom.py')).toBe(false)
    expect(logs.filter(line => line.startsWith('dropped stale overlay '))).toEqual([])
  })

  it('keeps a persisted overlay for a base file deleted on disk reported as deleted', async () => {
    const dir = await makeRepo({ 'deleted.py': 'base\n' })
    const roomUrl = room()
    const peer = await start({ room: roomUrl, dir: await cloneRepo(dir), name: 'Peer' })
    peer.roomDoc.setOverlay('Alice', 'deleted.py', 'old edit\n')
    await fsp.unlink(path.join(dir, 'deleted.py'))

    const alice = await start({ room: roomUrl, dir, name: 'Alice' })
    await waitFor(() => manifestDeleted(alice.roomDoc, 'Alice', 'deleted.py'))

    expect(incarnationText(alice.roomDoc, 'Alice', 'deleted.py')).toBeUndefined()
    expect(manifestDeleted(alice.roomDoc, 'Alice', 'deleted.py')).toBe(true)
  })

  it('pushes disk changes, clears files restored to base, and marks deletions', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n', 'gone.py': 'present\n' })
    const daemon = await start({ room: room(), dir, name: 'Alice' })

    await fsp.writeFile(path.join(dir, 'app.py'), 'edited\n')
    await waitFor(() => manifestText(daemon.roomDoc, 'app.py', 'Alice') === 'edited\n')
    expect(daemon.provider.awareness.getLocalState()?.lastActive).toEqual(expect.any(Number))

    await fsp.writeFile(path.join(dir, 'app.py'), 'base\n')
    await waitFor(() => manifestText(daemon.roomDoc, 'app.py', 'Alice') === undefined)

    await fsp.unlink(path.join(dir, 'gone.py'))
    await waitFor(() => manifestDeleted(daemon.roomDoc, 'Alice', 'gone.py'))
    expect(manifestText(daemon.roomDoc, 'gone.py', 'Alice')).toBeUndefined()
  })

  it('includes untracked non-ignored files and clears them when deleted', async () => {
    const dir = await makeRepo({ '.gitignore': 'ignored.txt\n' })
    let ignoredScanned = false
    const daemon = await start({ room: room(), dir, name: 'Alice', onScanned: p => { if (p === 'ignored.txt') ignoredScanned = true } })

    await fsp.writeFile(path.join(dir, 'new.py'), 'new\n')
    await waitFor(() => manifestText(daemon.roomDoc, 'new.py', 'Alice') === 'new\n')
    await fsp.writeFile(path.join(dir, 'ignored.txt'), 'secret\n')
    await waitFor(() => ignoredScanned && manifestText(daemon.roomDoc, 'ignored.txt', 'Alice') === undefined)
    expect(manifestText(daemon.roomDoc, 'ignored.txt', 'Alice')).toBeUndefined()

    await fsp.unlink(path.join(dir, 'new.py'))
    await waitFor(() => !manifestPaths(daemon.roomDoc, 'Alice').includes('new.py'))
    expect(manifestText(daemon.roomDoc, 'new.py', 'Alice')).toBeUndefined()
    expect(manifestDeleted(daemon.roomDoc, 'Alice', 'new.py')).toBe(false)
  })

  it('does not republish an existing overlay after git starts ignoring its path', async () => {
    const dir = await makeRepo({ '.gitignore': '' })
    const daemon = await start({ room: room(), dir, name: 'Alice', trackedRefreshMs: 60_000 })
    await fsp.writeFile(path.join(dir, 'secret.txt'), 'first\n')
    await waitFor(() => manifestText(daemon.roomDoc, 'secret.txt', 'Alice') === 'first\n')

    await fsp.writeFile(path.join(dir, '.gitignore'), 'secret.txt\n')
    await fsp.writeFile(path.join(dir, 'secret.txt'), 'second\n')
    await (daemon as unknown as { onDiskChange(path: string, isNew: boolean): Promise<void> }).onDiskChange('secret.txt', false)

    expect(manifestText(daemon.roomDoc, 'secret.txt', 'Alice')).toBeUndefined()
  })

  it('withdraws a published untracked file when a tracked refresh finds it newly git-ignored', async () => {
    const dir = await makeRepo({ '.gitignore': '' })
    const daemon = await start({ room: room(), dir, name: 'Alice', trackedRefreshMs: 60_000 })
    await fsp.writeFile(path.join(dir, 'secret.txt'), 'private\n')
    await waitFor(() => manifestText(daemon.roomDoc, 'secret.txt', 'Alice') === 'private\n')

    await fsp.writeFile(path.join(dir, '.gitignore'), 'secret.txt\n')
    await (daemon as unknown as { refreshTracked(): Promise<void> }).refreshTracked()
    await daemon.reconcileGitChanges()

    expect(manifestText(daemon.roomDoc, 'secret.txt', 'Alice')).toBeUndefined()
  })

  it('never changes clone bytes when another person overlay arrives', async () => {
    const source = await makeRepo({ 'app.py': 'base\n' })
    const otherClone = await cloneRepo(source)
    const roomUrl = room()
    const alice = await start({ room: roomUrl, dir: source, name: 'Alice' })
    const bob = await start({ room: roomUrl, dir: otherClone, name: 'Bob' })
    const before = fs.readFileSync(path.join(otherClone, 'app.py'))

    await fsp.writeFile(path.join(source, 'app.py'), 'alice edit\n')
    await waitFor(() => manifestText(bob.roomDoc, 'app.py', 'Alice') === 'alice edit\n')

    expect(fs.readFileSync(path.join(otherClone, 'app.py'))).toEqual(before)
    expect(read(otherClone, 'app.py')).toBe('base\n')
    expect(manifestText(bob.roomDoc, 'app.py', 'Bob')).toBeUndefined()
    expect(manifestChangers(alice.roomDoc, 'app.py')).toEqual(['Alice'])
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

  it('does not tell a worker on a carried commit to push its branch', async () => {
    const source = await makeRepo({ 'app.py': 'base\n' })
    const roomUrl = room()
    await start({ room: roomUrl, dir: source, name: 'Alice' })
    const workerDir = path.join(source, '.room', 'workers', 'w')
    sh(source, ['worktree', 'add', '-qb', 'room/w', workerDir])
    await fsp.writeFile(path.join(workerDir, 'app.py'), 'lead WIP\n')
    sh(workerDir, ['-c', 'user.name=Room', '-c', 'user.email=room@localhost', 'commit', '-qam', 'room: carried-in uncommitted work from Alice'])
    const worker = await start({ room: roomUrl, dir: workerDir, name: 'Alice+w', owner: 'Alice', label: 'w' })
    await waitFor(() => (worker.provider.awareness.getLocalState() as { status: string }).status !== 'syncing')
    expect((worker.provider.awareness.getLocalState() as { status: string }).status).not.toMatch(/push/)
    expect(worker.roomDoc.manifestHead.get('Alice+w')?.base).toBe(sh(workerDir, ['rev-parse', 'HEAD']))
    await fsp.writeFile(path.join(workerDir, 'worker.txt'), 'worker change\n')
    sh(workerDir, ['add', 'worker.txt']); sh(workerDir, ['commit', '-qm', 'worker change'])
    await waitFor(() => worker.base === sh(workerDir, ['rev-parse', 'HEAD']))
    expect((worker.provider.awareness.getLocalState() as { status: string }).status).not.toMatch(/push/)
    await waitFor(() => worker.roomDoc.manifestHead.get('Alice+w')?.base === sh(workerDir, ['rev-parse', 'HEAD']))
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
    // The lead's registry record, as the worker's daemon receives it (never from the room).
    const record = { name: 'Alice+w', dir: workerDir, base: carried, carriedBase: carried, carriedUntracked: [{ path: 'notes.txt', sha: blob }] }
    return { source, leadHead, workerDir, carried, record }
  }

  it('a worker never publishes the lead\'s carried files as its own changes; an edited carried untracked file diffs against its carried text', async () => {
    const { source, workerDir, carried, record } = await carriedWorker()
    const roomUrl = room()
    await start({ room: roomUrl, dir: source, name: 'Alice', localKey: 'k' })
    const worker = await start({ room: roomUrl, dir: workerDir, name: 'Alice+w', owner: 'Alice', label: 'w', localKey: 'k', carried: record })
    expect(worker.roomDoc.manifestHead.get('Alice+w')?.base).toBe(carried)
    expect(manifestPaths(worker.roomDoc, 'Alice+w')).toEqual([])
    await fsp.writeFile(path.join(workerDir, 'notes.txt'), 'lead notes\nworker line\n')
    await waitFor(() => manifestPaths(worker.roomDoc, 'Alice+w').includes('notes.txt'))
    expect(worker.roomDoc.baseText(worker.name, carried, 'notes.txt')).toBe('lead notes\n')
  })

  it('pins a worker base across commit, branch rename and restart while retaining carried-untracked deletion', async () => {
    const { workerDir, carried, record } = await carriedWorker()
    const roomUrl = room()
    let worker = await start({ room: roomUrl, dir: workerDir, name: 'Alice+w', owner: 'Alice', label: 'w', localKey: 'k', carried: record })
    await fsp.writeFile(path.join(workerDir, 'app.py'), 'worker committed\n')
    sh(workerDir, ['add', '-A']); sh(workerDir, ['commit', '-qm', 'worker change'])
    sh(workerDir, ['branch', '-m', 'feature'])
    await waitFor(() => worker.roomDoc.manifestHead.get('Alice+w')?.base === carried && manifestPaths(worker.roomDoc, 'Alice+w').includes('app.py'))
    expect(worker.roomDoc.manifestHead.get('Alice+w')?.base).toBe(carried)
    expect(manifestPaths(worker.roomDoc, 'Alice+w')).toContain('app.py')
    sh(workerDir, ['checkout', '-qb', 'alternate'])
    await waitFor(() => participantRecord(worker.roomDoc, 'Alice+w')?.git?.branch === 'alternate')
    expect(worker.roomDoc.manifestHead.get('Alice+w')?.base).toBe(carried)
    await worker.stop()
    worker = await start({ room: roomUrl, dir: workerDir, name: 'Alice+w', owner: 'Alice', label: 'w', localKey: 'k', carried: record })
    expect(worker.roomDoc.manifestHead.get('Alice+w')?.base).toBe(carried)
    expect(manifestPaths(worker.roomDoc, 'Alice+w')).toContain('app.py')
    await fsp.rm(path.join(workerDir, 'notes.txt'))
    await (worker as any).publisher.reconcile('all')
    await waitFor(() => manifestPaths(worker.roomDoc, 'Alice+w').includes('notes.txt'))
    expect(worker.roomDoc.manifest.get(manifestKey('Alice+w', worker.roomDoc.manifestHead.get('Alice+w')!.fence))?.get('notes.txt')?.change).toBe('D')
  })

  it('in a team room a carried worker publishes base text under its manifest anchor', async () => {
    const { source, workerDir, record } = await carriedWorker()
    const roomUrl = room()
    await start({ room: roomUrl, dir: source, name: 'Alice' })
    const worker = await start({ room: roomUrl, dir: workerDir, name: 'Alice+w', owner: 'Alice', label: 'w', carried: record })
    expect(worker.roomDoc.manifestHead.get('Alice+w')?.base).toBe(sh(workerDir, ['rev-parse', 'HEAD']))
    expect(manifestPaths(worker.roomDoc, 'Alice+w')).toEqual([])
    // A worker edit on top of a carried file uses the captured manifest anchor.
    await fsp.writeFile(path.join(workerDir, 'app.py'), 'lead WIP\nworker line\n')
    await fsp.writeFile(path.join(workerDir, 'other.py'), 'other\nworker line\n')
    await waitFor(() => manifestPaths(worker.roomDoc, 'Alice+w').length === 2)
    expect(manifestText(worker.roomDoc, 'app.py', 'Alice+w')).toBe('lead WIP\nworker line\n')
    const anchor = worker.roomDoc.manifestHead.get('Alice+w')!.base
    expect(worker.roomDoc.baseText(worker.name, anchor, 'app.py')).toBe('lead WIP\n')
    expect(worker.roomDoc.baseText(worker.name, anchor, 'other.py')).toBe('other\n')
    // Reverting to the carried text withdraws the overlay again.
    await fsp.writeFile(path.join(workerDir, 'app.py'), 'lead WIP\n')
    await waitFor(() => !manifestPaths(worker.roomDoc, 'Alice+w').includes('app.py'))
  })

  it('a clone behind its upstream joins, is marked behind, and syncs after pulling', async () => {
    const source = await makeRepo({ 'app.py': 'base\n' })
    const behind = await cloneRepo(source)
    await fsp.writeFile(path.join(source, 'extra.txt'), 'x\n')
    sh(source, ['add', '-A']); sh(source, ['commit', '-q', '-m', 'extra'])
    sh(behind, ['fetch', '-q'])
    const roomUrl = room()
    await start({ room: roomUrl, dir: source, name: 'Alice' })
    const bob = await start({ room: roomUrl, dir: behind, name: 'Bob', basePollMs: 30 })
    expect((bob.provider.awareness.getLocalState() as { status: string }).status).toMatch(/^behind origin\/main by 1: .*git pull --ff-only --autostash/)
    const expectedBase = sh(source, ['rev-parse', 'HEAD'])
    sh(behind, ['pull', '-q', '--ff-only'])
    // Git polling and presence publication finish asynchronously under suite load.
    await waitFor(() => bob.base === expectedBase && bob.anchor.base === expectedBase
      && (bob.provider.awareness.getLocalState() as { status: string }).status === 'synced with origin/main')
  })

  it('a diverged clone joins and keeps running; its status says to stop and tell the human', async () => {
    const source = await makeRepo({ 'app.py': 'base\n' })
    const first = sh(source, ['rev-parse', 'HEAD'])
    const other = await cloneRepo(source)
    await fsp.writeFile(path.join(source, 'a.txt'), 'a\n'); sh(source, ['add', '-A']); sh(source, ['commit', '-q', '-m', 'a'])
    await fsp.writeFile(path.join(other, 'b.txt'), 'b\n'); sh(other, ['add', '-A']); sh(other, ['commit', '-q', '-m', 'b'])
    sh(other, ['fetch', '-q'])
    const roomUrl = room()
    await start({ room: roomUrl, dir: source, name: 'Alice' })
    const bob = await start({ room: roomUrl, dir: other, name: 'Bob' })
    expect(bob.anchor).toEqual({ base: first, anchored: true })
    expect((bob.provider.awareness.getLocalState() as { status: string }).status).toBe('diverged from origin/main: stop and tell your human')
  })

  it('a clone that has not fetched joins at the anchor it has; a newer teammate never moves anyone else\'s base', async () => {
    const origin = await makeRepo({ 'app.py': 'base\n' })
    sh(origin, ['config', 'receive.denyCurrentBranch', 'updateInstead'])
    const source = await cloneRepo(origin)
    const ahead = await cloneRepo(origin)
    const start0 = sh(source, ['rev-parse', 'HEAD'])
    const roomUrl = room()
    const alice = await start({ room: roomUrl, dir: source, name: 'Alice', basePollMs: 30 })
    await fsp.writeFile(path.join(ahead, 'extra.txt'), 'x\n')
    sh(ahead, ['add', '-A']); sh(ahead, ['commit', '-q', '-m', 'extra'])
    sh(ahead, ['push', '-q', 'origin', 'HEAD:main'])
    const newHead = sh(ahead, ['rev-parse', 'HEAD'])
    const bob = await start({ room: roomUrl, dir: ahead, name: 'Bob' })
    expect(bob.anchor.base).toBe(newHead)
    expect(alice.anchor.base).toBe(start0)
    expect(participantRecord(alice.roomDoc, 'Alice')?.git?.base).toBe(start0)
    sh(source, ['fetch', '-q'])
    await waitFor(() => /^behind origin\/main by 1/.test((alice.provider.awareness.getLocalState() as { status: string }).status))
  })
})

describe('sharing levels', () => {
  const daemons: Roomd[] = []
  const hub = new MemoryHub()
  const room = () => `ws://memory/share-${Math.random().toString(36).slice(2, 8)}`
  const providerFactory: NonNullable<RoomdOptions['providerFactory']> = (server, name, doc) => hub.connect(`${server}/${name}`, doc)
  const start = async (options: Omit<RoomdOptions, 'providerFactory' | 'policy'> & { share?: ShareLevel; scopePaths?: string[]; shareCeiling?: () => ShareLevel }) => {
    const { share, scopePaths, shareCeiling, ...rest } = options
    const daemon = await startRoomd({ log: silent, debounceMs: 20, trackedRefreshMs: 100, providerFactory, ...rest, policy: policyFromLevel(share ?? 'full', scopePaths, shareCeiling?.() ?? 'full') })
    daemons.push(daemon)
    return daemon
  }
  const presence = (d: Roomd) => d.provider.awareness.getLocalState() as { share?: string; status?: string }
  afterEach(async () => { await Promise.all(daemons.splice(0).map(daemon => daemon.stop())) })

  const setPolicy = async (daemon: Roomd, level: ShareLevel, paths: string[] = []) => {
    daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel(level, paths) })
    await daemon.reconcileGitChanges()
  }


  it('withdraws an earlier full overlay and its base text when a ceiling narrows during a later publish', async () => {
    const dir = await makeRepo({ 'a.py': 'base a\n', 'b.py': 'base b\n' })
    let ceiling: 'full' | 'intent' = 'full'
    const daemon = await start({ room: room(), dir, name: 'Ceiling', share: 'full', shareCeiling: () => ceiling })
    await fsp.writeFile(path.join(dir, 'a.py'), 'private a\n')
    await waitFor(() => manifestText(daemon.roomDoc, 'a.py', 'Ceiling') === 'private a\n')
    const base = participantRecord(daemon.roomDoc, 'Ceiling')?.git?.base!
    expect(daemon.roomDoc.baseText('Ceiling', base, 'a.py')).toBe('base a\n')
    ceiling = 'intent'
    daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full', [], ceiling) })
    await fsp.writeFile(path.join(dir, 'b.py'), 'private b\n')
    await daemon.reconcileGitChanges()
    expect(daemon.share).toBe('intent')
    expect(manifestPaths(daemon.roomDoc, 'Ceiling')).toEqual([])
    expect(daemon.roomDoc.baseText('Ceiling', base, 'a.py')).toBeUndefined()
  })

  it('narrows full to declared without withdrawing in-scope text, then widens only on reconciliation', async () => {
    const dir = await makeRepo({ 'a.py': 'base a\n', 'b.py': 'base b\n' })
    const daemon = await start({ room: room(), dir, name: 'Decline' })
    await fsp.writeFile(path.join(dir, 'a.py'), 'private a\n')
    await fsp.writeFile(path.join(dir, 'b.py'), 'private b\n')
    await waitFor(() => manifestPaths(daemon.roomDoc, 'Decline').length === 2)
    const base = participantRecord(daemon.roomDoc, 'Decline')?.git?.base!
    await setPolicy(daemon, 'declared', ['b.py'])
    expect(manifestPaths(daemon.roomDoc, 'Decline')).toEqual(['a.py', 'b.py'])
    expect(daemon.roomDoc.manifest.get(manifestKey('Decline', daemon.roomDoc.manifestHead.get('Decline')!.fence))?.get('a.py'))
      .toMatchObject({ state: 'held', held: 'scope', change: 'M' })
    expect(daemon.roomDoc.baseText('Decline', base, 'a.py')).toBeUndefined()
    expect(daemon.roomDoc.baseText('Decline', base, 'b.py')).toBe('base b\n')
    const widening = setPolicy(daemon, 'full')
    expect(manifestPaths(daemon.roomDoc, 'Decline')).toEqual(['a.py', 'b.py'])
    await widening
    expect(manifestPaths(daemon.roomDoc, 'Decline')).toEqual(['a.py', 'b.py'])
  })

  it('withdraws a deletion mark and collects base text when an overlay is reverted', async () => {
    const dir = await makeRepo({ 'deleted.py': 'old\n', 'reverted.py': 'old\n' })
    const daemon = await start({ room: room(), dir, name: 'Withdraw' })
    const base = participantRecord(daemon.roomDoc, 'Withdraw')?.git?.base!
    await fsp.writeFile(path.join(dir, 'reverted.py'), 'changed\n')
    await waitFor(() => manifestText(daemon.roomDoc, 'reverted.py', 'Withdraw') === 'changed\n')
    await fsp.writeFile(path.join(dir, 'reverted.py'), 'old\n')
    await waitFor(() => !manifestPaths(daemon.roomDoc, 'Withdraw').includes('reverted.py'))
    expect(daemon.roomDoc.baseText('Withdraw', base, 'reverted.py')).toBeUndefined()
    await fsp.unlink(path.join(dir, 'deleted.py'))
    await waitFor(() => manifestDeleted(daemon.roomDoc, 'Withdraw', 'deleted.py'))
    expect(daemon.roomDoc.baseText('Withdraw', base, 'deleted.py')).toBe('old\n')
    await setPolicy(daemon, 'intent')
    expect(manifestDeleted(daemon.roomDoc, 'Withdraw', 'deleted.py')).toBe(false)
    expect(daemon.roomDoc.baseText('Withdraw', base, 'reverted.py')).toBeUndefined()
  })

  it('withdraws base text published before HEAD advanced', async () => {
    const dir = await makeRepo({ 'a.py': 'base a\n', 'b.py': 'base b\n' })
    const daemon = await start({ room: room(), dir, name: 'Advance', basePollMs: 20 })
    const oldBase = daemon.base
    await fsp.writeFile(path.join(dir, 'a.py'), 'changed a\n')
    await waitFor(() => daemon.roomDoc.baseText('Advance', oldBase, 'a.py') === 'base a\n')
    sh(dir, ['add', 'a.py']); sh(dir, ['commit', '-qm', 'advance'])
    await waitFor(() => daemon.base !== oldBase)
    await fsp.writeFile(path.join(dir, 'b.py'), 'changed b\n')
    await waitFor(() => manifestText(daemon.roomDoc, 'b.py', 'Advance') === 'changed b\n')
    await setPolicy(daemon, 'intent')
    expect(manifestPaths(daemon.roomDoc, 'Advance')).toEqual([])
    expect(daemon.roomDoc.baseText('Advance', oldBase, 'a.py')).toBeUndefined()
    expect(daemon.roomDoc.baseText('Advance', daemon.base, 'b.py')).toBeUndefined()
  })

  it('collects a previous process’s base text after restart and narrowing', async () => {
    const dir = await makeRepo({ 'a.py': 'base\n' })
    const url = room()
    const keeper = await start({ room: url, dir: await cloneRepo(dir), name: 'Keeper', share: 'intent' })
    const first = await start({ room: url, dir, name: 'Restart' })
    await fsp.writeFile(path.join(dir, 'a.py'), 'edit\n')
    await waitFor(() => manifestText(keeper.roomDoc, 'a.py', 'Restart') === 'edit\n')
    const base = first.base
    await first.stop()
    const second = await start({ room: url, dir, name: 'Restart', share: 'intent' })
    expect(manifestPaths(second.roomDoc, 'Restart')).toEqual([])
    expect(keeper.roomDoc.baseText('Restart', base, 'a.py')).toBeUndefined()
  })

  it('keeps each participant’s base text when another withdraws', async () => {
    const origin = await makeRepo({ 'a.py': 'base\n' })
    const url = room()
    const alice = await start({ room: url, dir: await cloneRepo(origin), name: 'Alice' })
    const bob = await start({ room: url, dir: await cloneRepo(origin), name: 'Bob' })
    await fsp.writeFile(path.join(alice.dir, 'a.py'), 'alice\n')
    await fsp.writeFile(path.join(bob.dir, 'a.py'), 'bob\n')
    await waitFor(() => manifestText(alice.roomDoc, 'a.py', 'Alice') === 'alice\n' && manifestText(alice.roomDoc, 'a.py', 'Bob') === 'bob\n')
    const base = alice.base
    expect(alice.roomDoc.baseText('Alice', base, 'a.py')).toBe('base\n')
    expect(alice.roomDoc.baseText('Bob', base, 'a.py')).toBe('base\n')
    await setPolicy(alice, 'intent')
    expect(bob.roomDoc.baseText('Alice', base, 'a.py')).toBeUndefined()
    expect(bob.roomDoc.baseText('Bob', base, 'a.py')).toBe('base\n')
  })

  it('bounds owned base texts through repeated edit and commit cycles', async () => {
    const dir = await makeRepo({ 'a.py': 'base\n' })
    const daemon = await start({ room: room(), dir, name: 'Cycles', basePollMs: 20 })
    for (let i = 0; i < 3; i++) {
      const base = daemon.base
      await fsp.writeFile(path.join(dir, 'a.py'), `edit ${i}\n`)
      await waitFor(() => manifestText(daemon.roomDoc, 'a.py', 'Cycles') === `edit ${i}\n`)
      expect(daemon.roomDoc.baseText('Cycles', base, 'a.py')).toBeDefined()
      sh(dir, ['add', 'a.py']); sh(dir, ['commit', '-qm', `edit ${i}`])
      await waitFor(() => daemon.base !== base && !manifestPaths(daemon.roomDoc, 'Cycles').includes('a.py'))
      expect(daemon.roomDoc.ownedBaseTexts.size).toBe(0)
    }
  })

  it('ignores a legacy base entry with no live overlay during startup', async () => {
    const dir = await makeRepo({ 'a.py': 'base\n' })
    const url = room()
    const keeper = await start({ room: url, dir: await cloneRepo(dir), name: 'Keeper', share: 'intent' })
    const base = keeper.base
    keeper.roomDoc.doc.getMap<string>('basetext').set(`${base}:a.py`, 'base\n')
    await start({ room: url, dir, name: 'Collector', share: 'intent' })
    expect(keeper.roomDoc.doc.getMap<string>('basetext').get(`${base}:a.py`)).toBe('base\n')
    expect(keeper.roomDoc.baseText('Collector', base, 'a.py')).toBeUndefined()
  })

  it('does not adopt a legacy base entry for a surviving overlay during startup', async () => {
    const origin = await makeRepo({ 'a.py': 'base\n' })
    const url = room()
    const keeper = await start({ room: url, dir: await cloneRepo(origin), name: 'Keeper', share: 'intent' })
    const base = keeper.base
    keeper.roomDoc.setOverlay('Legacy', 'a.py', 'legacy edit\n')
    keeper.roomDoc.doc.getMap<string>('basetext').set(`${base}:a.py`, 'base\n')
    await start({ room: url, dir: origin, name: 'Collector', share: 'intent' })
    expect(keeper.roomDoc.baseText('Legacy', base, 'a.py')).toBeUndefined()
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
    expect(manifestPaths(daemon.roomDoc, 'Full')).toEqual(['a.py'])
    expect(daemon.roomDoc.manifest.get(manifestKey('Full', daemon.fence))?.get('a.py')?.state).toBe('shared')
  })

  it('intent publishes no file facts, deletion marks or exclusion digests', async () => {
    const dir = await makeRepo({ 'a.py': 'a\n', 'gone.py': 'x\n' })
    await fsp.writeFile(path.join(dir, 'a.py'), 'A\n')
    await fsp.unlink(path.join(dir, 'gone.py'))
    const daemon = await start({ room: room(), dir, name: 'Quiet', share: 'intent' })
    expect(presence(daemon).share).toBe('intent')
    expect(manifestPaths(daemon.roomDoc, 'Quiet')).toEqual([])
    expect(daemon.roomDoc.manifestHead.get('Quiet')?.coverage).toEqual({ kind: 'none', reason: 'intent' })
    expect(daemon.roomDoc.manifestHead.get('Quiet')?.excluded).toEqual([])
  })

  it('declared publishes text inside its area and hashless held facts outside', async () => {
    const dir = await makeRepo({ 'src/a.py': 'a\n', 'docs/b.md': 'b\n', 'gone.py': 'x\n' })
    await fsp.writeFile(path.join(dir, 'src/a.py'), 'A\n')
    await fsp.writeFile(path.join(dir, 'docs/b.md'), 'B\n')
    await fsp.unlink(path.join(dir, 'gone.py'))
    const daemon = await start({ room: room(), dir, name: 'Decl', share: 'declared', scopePaths: ['src/'] })
    const entries = daemon.roomDoc.manifest.get(manifestKey(daemon.name, daemon.fence))!
    expect(manifestText(daemon.roomDoc, 'src/a.py', 'Decl')).toBe('A\n')
    expect(entries.get('src/a.py')).toMatchObject({ state: 'shared' })
    expect(entries.get('docs/b.md')).toMatchObject({ state: 'held', held: 'scope' })
    expect(entries.get('docs/b.md')).not.toHaveProperty('hash')
    expect(entries.get('docs/b.md')).not.toHaveProperty('size')
    expect(entries.get('gone.py')).toMatchObject({ change: 'D', state: 'shared' })
    expect(entries.get('gone.py')).not.toHaveProperty('baseHash')
  })

  it('applyInputs withdraws shared text and hashes synchronously, then widening scans it back', async () => {
    const dir = await makeRepo({ 'a.py': 'base\n' })
    await fsp.writeFile(path.join(dir, 'a.py'), 'edit\n')
    const daemon = await start({ room: room(), dir, name: 'Dial' })
    const key = manifestKey(daemon.name, daemon.fence)
    expect(daemon.roomDoc.manifest.get(key)?.get('a.py')?.hash).toBeDefined()
    daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('declared') })
    expect(manifestText(daemon.roomDoc, 'a.py', 'Dial')).toBeUndefined()
    expect(daemon.roomDoc.manifest.get(key)?.get('a.py')).toMatchObject({ state: 'held', held: 'scope' })
    expect(daemon.roomDoc.manifest.get(key)?.get('a.py')).not.toHaveProperty('hash')
    daemon.applyInputs({ ...daemon.inputs, policy: policyFromLevel('full') })
    await daemon.reconcileGitChanges()
    expect(manifestText(daemon.roomDoc, 'a.py', 'Dial')).toBe('edit\n')
    expect(daemon.roomDoc.manifest.get(key)?.get('a.py')?.hash).toBeDefined()
  })
})
