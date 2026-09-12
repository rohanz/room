import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, RoomdError, type Roomd, type RoomdOptions } from '../src/index.js'
import { normalizeGitOrigin } from '../src/git.js'

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
    const provider = {
      synced: true,
      awareness: {
        setLocalState(state: Record<string, unknown> | null) { localState = state },
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

async function waitFor(pred: () => boolean, ms = 4000, step = 25): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return
    await new Promise(resolve => setTimeout(resolve, step))
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

  afterAll(async () => { await Promise.all(daemons.map(daemon => daemon.stop())) })

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

  it('includes untracked non-ignored files and records their deletion', async () => {
    const dir = await makeRepo({ '.gitignore': 'ignored.txt\n' })
    const daemon = await start({ room: room(), dir, name: 'Alice' })

    await fsp.writeFile(path.join(dir, 'new.py'), 'new\n')
    await waitFor(() => daemon.roomDoc.text('new.py', 'Alice') === 'new\n')
    await fsp.writeFile(path.join(dir, 'ignored.txt'), 'secret\n')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(daemon.roomDoc.text('ignored.txt', 'Alice')).toBeUndefined()

    await fsp.unlink(path.join(dir, 'new.py'))
    await waitFor(() => daemon.roomDoc.deletedFor('Alice').has('new.py'))
    expect(daemon.roomDoc.text('new.py', 'Alice')).toBeUndefined()
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

  it('writes .room.json and appends it once to .git/info/exclude', async () => {
    const dir = await makeRepo({ 'app.py': 'base\n' })
    const roomUrl = room()
    const daemon = await start({ room: roomUrl, dir, name: 'Alice' })

    expect(JSON.parse(read(dir, '.room.json'))).toMatchObject({ name: 'Alice', dir })
    expect(read(dir, '.git/info/exclude').split('\n').filter(line => line === '.room.json')).toHaveLength(1)

    await daemon.stop()
    await start({ room: roomUrl, dir, name: 'Alice' })
    expect(read(dir, '.git/info/exclude').split('\n').filter(line => line === '.room.json')).toHaveLength(1)
  })

  it('refuses a different HEAD with both SHAs and the join recovery command', async () => {
    const source = await makeRepo({ 'app.py': 'base\n' })
    const ahead = await cloneRepo(source)
    const roomUrl = room()
    await start({ room: roomUrl, dir: source, name: 'Alice' })

    await fsp.writeFile(path.join(ahead, 'extra.txt'), 'x\n')
    sh(ahead, ['add', '-A'])
    sh(ahead, ['commit', '-q', '-m', 'extra'])
    const roomHead = sh(source, ['rev-parse', 'HEAD'])
    const localHead = sh(ahead, ['rev-parse', 'HEAD'])
    const error = await startRoomd({
      room: roomUrl, dir: ahead, name: 'Bob', log: silent, providerFactory,
    }).then(() => null, caught => caught)

    expect(error).toBeInstanceOf(RoomdError)
    expect(error.code).toBe(2)
    expect(error.message).toContain(roomHead)
    expect(error.message).toContain(localHead)
    expect(error.message).toContain('git pull, then $room-join')
  })
})
