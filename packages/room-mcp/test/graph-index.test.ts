import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc, type Worker } from '@room/shared'
import { GraphIndex } from '../src/graph-index.js'

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
  it('indexes base source files, prefers overlays, and tracks overlay edits', async () => {
    const room = new RoomDoc()
    room.setMeta({ base })
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    gi.start(); await gi.ready
    expect(gi.graph.size).toBe(2)
    expect(gi.graph.usersOf('validate_token')).toEqual(['session.py'])
    room.setOverlay('Kieran', 'session.py', 'from utils import validate_token\n\ndef login(t):\n    return verify_token(t)\n')
    await gi.whenIdle()
    expect(gi.graph.usersOf('validate_token')).toEqual(['session.py']) // import still references it (ast ImportFrom)
    room.setOverlay('Kieran', 'session.py', 'def login(t):\n    return verify_token(t)\n')
    await gi.whenIdle()
    expect(gi.graph.usersOf('validate_token')).toEqual([])
    expect(gi.graph.usersOf('verify_token')).toEqual(['session.py'])
    gi.stop()
  })

  it('publishes provider-to-consumer edges and restores reverted overlays', async () => {
    const room = new RoomDoc()
    room.setMeta({ base })
    room.setOverlay('Rohan', 'session.py', 'def login(t):\n    return verify_token(t)\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    expect(room.graphs.get('Rohan')?.edges).toEqual([])
    room.clearOverlay('Rohan', 'session.py')
    await gi.whenIdle()
    expect(gi.graph.usersOf('validate_token')).toEqual(['session.py'])
    await eventually(() => room.graphs.get('Rohan')?.edges.length === 1)
    expect(room.graphs.get('Rohan')?.edges).toEqual([
      { source: 'utils.py', target: 'session.py', symbols: ['validate_token'] },
    ])
    gi.stop(); room.doc.destroy()
  })

  it('indexes the latest rapid edit and removes deleted definitions', async () => {
    const room = new RoomDoc(); room.setMeta({ base })
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    room.setOverlay('Rohan', 'session.py', 'def login(t):\n    return first_token(t)\n')
    room.setOverlay('Rohan', 'session.py', 'def login(t):\n    return last_token(t)\n')
    await gi.whenIdle()
    expect(gi.graph.usersOf('last_token')).toEqual(['session.py'])
    expect(gi.graph.usersOf('first_token')).toEqual([])
    room.markDeleted('Rohan', 'utils.py')
    await gi.whenIdle()
    expect(gi.graph.definersOf('validate_token')).toEqual([])
    gi.stop(); room.doc.destroy()
  })

  it('drops files removed from a new base and publishes the new revision', async () => {
    const room = new RoomDoc(); room.setMeta({ base })
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim()
    git('rm', 'utils.py'); git('commit', '-qm', 'remove obsolete provider')
    const next = git('rev-parse', 'HEAD')
    room.setMeta({ base: next })
    await gi.whenIdle()
    expect(gi.graph.has('utils.py')).toBe(false)
    expect(room.graphs.get('Rohan')?.base).toBe(next)
    expect(room.graphs.get('Rohan')?.paths).not.toContain('utils.py')
    gi.stop(); room.doc.destroy()
  })

  it('publishes observed contract changes from only its own overlay', async () => {
    const room = new RoomDoc(); room.setMeta({ base })
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    room.setOverlay('Kieran', 'utils.py', 'def validate_token(token, strict=False):\n    return token\n')
    await gi.whenIdle()
    expect(room.graphs.get('Rohan')?.observed).toEqual([])
    room.setOverlay('Rohan', 'utils.py', 'def validate_token(token, strict=False):\n    return token\n')
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
    const room = new RoomDoc(); room.setMeta({ base })
    room.setOverlay('Rohan', 'generated.py', Array.from({ length: 205 }, (_, i) => `def added_${i}():\n    pass\n`).join('\n'))
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
    const room = new RoomDoc(); room.setMeta({ base: head })
    room.setWorker({ id: 'lead/w#1', tag: 'w', name: 'lead+w', host: 'codex', task: 't', dir: wdir, branch: 'room/w', base: carried, carriedBase: carried, pid: 1, startedAt: 1, status: 'running', lead: 'lead' } as Worker)
    room.setOverlay('lead+w', 'api.py', 'def rate(x, year):\n    return x * 2\n')
    const gi = new GraphIndex(room, 'lead+w', wdir, undefined, { random: () => 0, minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    await eventually(() => room.graphs.get('lead+w')?.status === 'ready')
    expect(room.graphs.get('lead+w')?.observed).toEqual([])
    room.setOverlay('lead+w', 'api.py', 'def rate(x, year, region):\n    return x * 2\n')
    await gi.whenIdle()
    await eventually(() => room.graphs.get('lead+w')?.observed?.length === 1)
    expect(room.graphs.get('lead+w')?.observed?.[0].detail).toBe('was `def rate(x, year):` now `def rate(x, year, region):`')
    gi.stop(); room.doc.destroy(); rmSync(repo, { recursive: true, force: true })
  })
})

describe('GraphIndex snapshot discipline', () => {
  it('does not rewrite an identical snapshot and waits out the publish window', async () => {
    const room = new RoomDoc()
    room.setMeta({ base })
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 400 })
    gi.start(); await gi.ready
    await eventually(() => room.graphs.get('Rohan')?.status === 'ready')
    expect(room.graphs.get('Rohan')!.edges.length).toBe(1)
    let writes = 0
    room.graphs.observe(() => { writes++ })
    room.setOverlay('Rohan', 'session.py', 'from utils import validate_token\n\ndef login(t):\n    return validate_token(t)  # same edge\n')
    await gi.whenIdle()
    expect(writes).toBe(0) // identical snapshot: nothing written
    const firstAt = room.graphs.get('Rohan')!.at
    room.setOverlay('Rohan', 'session.py', 'def login(t):\n    return t\n')
    for (let i = 0; i < 60 && writes === 0; i++) await new Promise(r => setTimeout(r, 50)) // changed: written once the window has passed
    expect(writes).toBe(1)
    expect(room.graphs.get('Rohan')!.at - firstAt).toBeGreaterThanOrEqual(400)
    expect(room.graphs.get('Rohan')!.edges).toEqual([])
    gi.stop()
  })
})

describe('shared graph startup', () => {
  it('jitters startup with an injectable random source and cancels cleanly', async () => {
    vi.useFakeTimers()
    const room = new RoomDoc(); room.setMeta({ base })
    const gi = new GraphIndex(room, 'New', dir, undefined, { random: () => 0.5 })
    try {
      gi.start()
      await vi.advanceTimersByTimeAsync(1999)
      expect(room.graphs.has('New')).toBe(false)
      gi.stop(); await gi.ready
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
      room.setMeta({ base }); await gi.whenIdle()
      expect(gi.graph.has('utils.py')).toBe(true)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('does not reuse a three-edge peer snapshot that would invent a dependency', async () => {
    const room = new RoomDoc(); room.setMeta({ base })
    room.graphs.set('Peer', {
      version: 1, base, at: Date.now(), status: 'ready', truncated: false,
      paths: ['a.py', 'b.py', 'c.py', 'd.py'],
      edges: [
        { source: 'a.py', target: 'c.py', symbols: ['Config'] },
        { source: 'b.py', target: 'c.py', symbols: ['Token'] },
        { source: 'b.py', target: 'd.py', symbols: ['Config'] },
      ],
    })
    const logs: string[] = []
    const gi = new GraphIndex(room, 'New', dir, s => logs.push(s), { random: () => 0, minPublishMs: 0, present: () => ['Peer'] })
    try {
      gi.start(); await gi.whenIdle()
      expect(logs.some(s => s.includes('reused'))).toBe(false)
      expect(gi.graph.dependenciesOf('c.py')).toEqual([])
      expect(gi.graph.has('utils.py')).toBe(true)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('builds locally despite a present peer snapshot and computes its own contract changes', async () => {
    const room = new RoomDoc(); room.setMeta({ base })
    room.graphs.set('Peer', {
      version: 1, base, at: Date.now(), status: 'ready', truncated: false,
      paths: ['utils.py', 'session.py'],
      edges: [{ source: 'utils.py', target: 'session.py', symbols: ['validate_token'] }],
      observed: [{ path: 'utils.py', symbol: 'other', kind: 'add', detail: 'peer only' }],
    })
    room.setOverlay('New', 'utils.py', 'def validate_token(token, strict=False):\n    return token\n')
    const logs: string[] = []
    const gi = new GraphIndex(room, 'New', dir, s => logs.push(s), { random: () => 0, minPublishMs: 0, present: () => ['Peer'] })
    try {
      gi.start(); await gi.whenIdle()
      expect(logs.some(s => s.includes('reused'))).toBe(false)
      expect(gi.graph.usersOf('validate_token')).toEqual(['session.py'])
      expect(room.graphs.get('New')?.edges).toEqual(room.graphs.get('Peer')?.edges)
      expect(room.graphs.get('New')?.observed?.map(c => c.symbol)).toEqual(['validate_token'])
      room.clearOverlay('New', 'utils.py')
      await gi.whenIdle()
      await eventually(() => room.graphs.get('New')?.observed?.length === 0)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('ignores narrowed snapshot edges and refreshes another participant\'s import change', async () => {
    const room = new RoomDoc(); room.setMeta({ base })
    room.graphs.set('Peer', {
      version: 1, base, at: Date.now(), status: 'ready', truncated: false,
      paths: ['a.py', 'b.py', 'use-a.py', 'use-b.py'],
      edges: [
        { source: 'a.py', target: 'use-a.py', symbols: ['Config'] },
        { source: 'b.py', target: 'use-b.py', symbols: ['Config'] },
      ],
    })
    const gi = new GraphIndex(room, 'New', dir, undefined, { random: () => 0, minPublishMs: 0, present: () => ['Peer'] })
    try {
      gi.start(); await gi.whenIdle()
      expect(gi.graph.dependenciesOf('use-a.py')).toEqual([])
      expect(gi.graph.dependenciesOf('use-b.py')).toEqual([])
      room.setOverlay('Other', 'use-a.py', 'class Local:\n    pass\n')
      await gi.whenIdle()
      expect(gi.graph.dependenciesOf('use-a.py')).toEqual([])
      expect(gi.graph.dependenciesOf('use-b.py')).toEqual([])
      await eventually(() => room.graphs.get('New')?.edges.length === 1)
      expect(room.graphs.get('New')?.edges).not.toContainEqual({ source: 'b.py', target: 'use-a.py', symbols: ['Config'] })
      expect(room.graphs.get('New')?.edges).not.toContainEqual({ source: 'a.py', target: 'use-a.py', symbols: ['Config'] })
    } finally { gi.stop(); room.doc.destroy() }
  })

  it.each(['offline', 'stale', 'wrong base', 'indexing'])('does not reuse a %s snapshot', async reason => {
    const room = new RoomDoc(); room.setMeta({ base })
    room.graphs.set('Peer', {
      version: 1, base: reason === 'wrong base' ? 'old' : base,
      at: Date.now() - (reason === 'stale' ? 60_001 : 0),
      status: reason === 'indexing' ? 'indexing' : 'ready', truncated: false,
      paths: ['fake.py'], edges: [],
    })
    const logs: string[] = []
    const gi = new GraphIndex(room, 'New', dir, s => logs.push(s), { random: () => 0, present: () => reason === 'offline' ? [] : ['Peer'] })
    try {
      gi.start(); await gi.whenIdle()
      expect(gi.graph.has('fake.py')).toBe(false)
      expect(gi.graph.has('utils.py')).toBe(true)
      expect(logs.some(s => s.includes('reused'))).toBe(false)
    } finally { gi.stop(); room.doc.destroy() }
  })
})
