import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import type { WebsocketProvider } from 'y-websocket'
import { startRoomd, RoomdError, clampShare, parseShare, type Roomd, type RoomdOptions } from '../src/index.js'
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

  afterAll(async () => { await Promise.all(daemons.map(daemon => daemon.stop())) })

  it('a committed symlink is not reported as changed, and a retargeted one is', async () => {
    const dir = await makeRepo({ 'AGENTS.md': '# rules\n', 'app.py': 'x = 1\n' })
    await fsp.symlink('AGENTS.md', path.join(dir, 'CLAUDE.md'))
    execFileSync('git', ['-C', dir, 'add', 'CLAUDE.md'], { stdio: 'pipe' })
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'link'], { stdio: 'pipe' })
    const daemon = await start({ room: room(), dir, name: 'Ann' })
    await fsp.writeFile(path.join(dir, 'app.py'), 'x = 2\n')
    await waitFor(() => daemon.roomDoc.changedPaths('Ann').includes('app.py'))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(daemon.roomDoc.changedPaths('Ann')).toEqual(['app.py'])
    await fsp.unlink(path.join(dir, 'CLAUDE.md'))
    await fsp.symlink('app.py', path.join(dir, 'CLAUDE.md'))
    await waitFor(() => daemon.roomDoc.changedPaths('Ann').includes('CLAUDE.md'))
    expect(daemon.roomDoc.overlayText('Ann', 'CLAUDE.md')?.toString()).toBe('app.py')
  })

  it('skips files matched by .roomignore and re-evaluates when it changes', async () => {
    const dir = await makeRepo({ 'app.py': 'x = 1\n', 'fixtures/big.json': '{}\n', '.roomignore': 'fixtures/\n' })
    const daemon = await start({ room: room(), dir, name: 'Ann' })
    await fsp.writeFile(path.join(dir, 'fixtures/big.json'), '{"changed":true}\n')
    await fsp.writeFile(path.join(dir, 'app.py'), 'x = 2\n')
    await waitFor(() => daemon.roomDoc.changedPaths('Ann').includes('app.py'))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(daemon.roomDoc.changedPaths('Ann')).toEqual(['app.py'])
    expect(daemon.skipped().ignore).toEqual(['fixtures/big.json'])
    // Lifting the rule publishes the file; adding one back clears its overlay.
    await fsp.writeFile(path.join(dir, '.roomignore'), '')
    await waitFor(() => daemon.roomDoc.changedPaths('Ann').includes('fixtures/big.json'))
    await fsp.writeFile(path.join(dir, '.roomignore'), '*.json\n')
    await waitFor(() => !daemon.roomDoc.changedPaths('Ann').includes('fixtures/big.json'))
    expect(daemon.roomDoc.changedPaths('Ann')).toEqual(['app.py'])
  })

  it('stops sharing once the total budget is reached and records what was skipped', async () => {
    const dir = await makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' })
    const daemon = await start({ room: room(), dir, name: 'Bud', totalBudget: 250 })
    await fsp.writeFile(path.join(dir, 'a.txt'), 'A'.repeat(100))
    await waitFor(() => daemon.roomDoc.changedPaths('Bud').includes('a.txt'))
    await fsp.writeFile(path.join(dir, 'b.txt'), 'B'.repeat(100))
    await waitFor(() => daemon.roomDoc.changedPaths('Bud').includes('b.txt'))
    await fsp.writeFile(path.join(dir, 'c.txt'), 'C'.repeat(100))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(daemon.roomDoc.changedPaths('Bud').sort()).toEqual(['a.txt', 'b.txt'])
    expect(daemon.skipped().budget).toEqual(['c.txt'])
    // Freeing room lets the skipped file in on its next change.
    await fsp.writeFile(path.join(dir, 'a.txt'), 'a\n')
    await waitFor(() => !daemon.roomDoc.changedPaths('Bud').includes('a.txt'))
    await fsp.writeFile(path.join(dir, 'c.txt'), 'C'.repeat(100) + '!')
    await waitFor(() => daemon.roomDoc.changedPaths('Bud').includes('c.txt'))
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

  it('a clone behind the room base may join, is marked behind, and syncs after pulling', async () => {
    const source = await makeRepo({ 'app.py': 'base\n' })
    const behind = await cloneRepo(source)
    await fsp.writeFile(path.join(source, 'extra.txt'), 'x\n')
    sh(source, ['add', '-A']); sh(source, ['commit', '-q', '-m', 'extra'])
    sh(behind, ['fetch', '-q'])
    const roomUrl = room()
    await start({ room: roomUrl, dir: source, name: 'Alice' })
    const bob = await start({ room: roomUrl, dir: behind, name: 'Bob', basePollMs: 30 })
    expect(bob.provider.awareness.getLocalState()).toMatchObject({ status: 'behind base by 1 commit: git pull' })
    sh(behind, ['pull', '-q', '--ff-only'])
    await waitFor(() => (bob.provider.awareness.getLocalState() as { status: string }).status === 'synced')
    expect(bob.base).toBe(sh(source, ['rev-parse', 'HEAD']))
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
    expect(error.message).toContain('rebase or merge')
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
    expect(error.message).toContain('git pull, then $room-join')
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
  afterAll(async () => { await Promise.all(daemons.map(daemon => daemon.stop())) })

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

  it('declared publishes only paths under the scope in the doc, and follows scope changes', async () => {
    const dir = await makeRepo({ 'src/a.py': 'a\n', 'docs/b.md': 'b\n' })
    await fsp.writeFile(path.join(dir, 'src/a.py'), 'A\n')
    await fsp.writeFile(path.join(dir, 'docs/b.md'), 'B\n')
    const daemon = await start({ room: room(), dir, name: 'Decl', share: 'declared' })
    // no scope yet: nothing is shared
    expect(daemon.roomDoc.changedPaths('Decl')).toEqual([])
    expect(daemon.skipped().share).toEqual(['docs/b.md', 'src/a.py'])
    daemon.roomDoc.setScope({ by: 'Decl', byKind: 'agent', area: 'src', summary: 's', paths: ['src/'] })
    await waitFor(() => daemon.roomDoc.changedPaths('Decl').includes('src/a.py'))
    expect(daemon.roomDoc.changedPaths('Decl')).toEqual(['src/a.py'])
    expect(daemon.skipped().share).toEqual(['docs/b.md'])
    // moving the scope withdraws src and publishes docs
    daemon.roomDoc.setScope({ by: 'Decl', byKind: 'agent', area: 'docs', summary: 'd', paths: ['docs'] })
    await waitFor(() => daemon.roomDoc.changedPaths('Decl').includes('docs/b.md') && !daemon.roomDoc.changedPaths('Decl').includes('src/a.py'))
    expect(daemon.skipped().share).toEqual(['src/a.py'])
    // explicit scopePaths win over the doc
    await daemon.setShare('declared', ['src/'])
    expect(daemon.roomDoc.changedPaths('Decl')).toEqual(['src/a.py'])
  })

  it('setShare withdraws overlays when the level drops and republishes when it rises', async () => {
    const dir = await makeRepo({ 'a.py': 'a\n', 'b.py': 'b\n' })
    const daemon = await start({ room: room(), dir, name: 'Dial' })
    await fsp.writeFile(path.join(dir, 'a.py'), 'A\n')
    await fsp.writeFile(path.join(dir, 'b.py'), 'B\n')
    await waitFor(() => daemon.roomDoc.changedPaths('Dial').length === 2)
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
