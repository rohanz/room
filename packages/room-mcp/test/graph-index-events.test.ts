import { clearFixture, deleteFixture, publishFixture, setFixtureLocalRoot } from './fixtures/manifest.js'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc, digestPath, manifestKey } from '@room/shared'
import { setParticipantBase } from '@room/shared/testing'
import { GraphIndex } from '../src/graph-index.js'
import { gitShow } from '@room/roomd/git'
import * as Y from 'yjs'

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition not met before timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

let dir: string, base: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-graph-events-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(dir, 'utils.py'), 'def validate_token(t):\n    return t\n')
  git('add', '.'); git('commit', '-qm', 'init'); base = git('rev-parse', 'HEAD').trim()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
  execFileSync('git', ['-C', dir, 'reset', '--hard', 'HEAD'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'clean', '-fd'], { stdio: 'pipe' })
})

describe('GraphIndex overlay events', () => {
  it('N1 republishes provenance after a body-only edit and a non-source revision, including recovery from incomplete coverage', async () => {
    const room = new RoomDoc()
    room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
    writeFileSync(join(dir, 'utils.py'), 'def validate_token(t):\n    return t\n')
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t):\n    return t\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready' && room.graphs.get('Rohan')?.sourceRev === room.manifestHead.get('Rohan')?.rev)
      const original = room.graphs.get('Rohan')!
      writeFileSync(join(dir, 'utils.py'), 'def validate_token(t):\n    return t + 1\n')
      publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t):\n    return t + 1\n')
      await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready' && room.graphs.get('Rohan')?.sourceRev === room.manifestHead.get('Rohan')?.rev)
      expect(room.graphs.get('Rohan')?.edges).toEqual(original.edges)
      publishFixture(room, 'Rohan', 'README.md', 'documentation changed\n')
      await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready' && room.graphs.get('Rohan')?.sourceRev === room.manifestHead.get('Rohan')?.rev)
      expect(room.graphs.get('Rohan')?.paths).toEqual(original.paths)
      const head = room.manifestHead.get('Rohan')!
      room.manifestHead.set('Rohan', { ...head, rev: head.rev + 1, complete: false })
      await gi.whenIdle()
      const restored = room.manifestHead.get('Rohan')!
      room.manifestHead.set('Rohan', { ...restored, rev: restored.rev + 1, complete: true })
      await gi.whenIdle()
      await eventually(() => room.graphs.get('Rohan')?.status === 'ready' && room.graphs.get('Rohan')?.sourceRev === room.manifestHead.get('Rohan')?.rev)
      expect(room.graphs.get('Rohan')?.paths).toEqual(original.paths)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('M2 withdraws a signature synchronously when its path becomes excluded', async () => {
    const room = new RoomDoc()
    room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
    writeFileSync(join(dir, 'utils.py'), 'def validate_token(t, secret_customer):\n    return t\n')
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t, secret_customer):\n    return t\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0 })
    try {
      gi.start(); await gi.whenIdle()
      await eventually(() => JSON.stringify(room.graphs.get('Rohan')).includes('secret_customer'))
      const head = room.manifestHead.get('Rohan')!, key = manifestKey('Rohan', head.fence)
      room.doc.transact(() => {
        room.manifest.get(key)!.delete('utils.py')
        room.clearOverlay(key, 'utils.py')
        room.manifestHead.set('Rohan', { ...head, excluded: [digestPath(room.ensureRoomSalt(), 'utils.py')], rev: head.rev + 1, semRev: head.semRev + 1 })
      })
      expect(JSON.stringify(room.graphs.get('Rohan'))).not.toContain('secret_customer')
      expect(room.graphs.get('Rohan')?.paths).not.toContain('utils.py')
      await gi.whenIdle()
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(room.graphs.get('Rohan')?.paths).not.toContain('utils.py')
    } finally { gi.stop(); room.doc.destroy() }
  })
  it('M1 rejects a published signature when its holder epoch changes during the base read', async () => {
    const room = new RoomDoc()
    room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t):\n    return t\n')
    let block = false, entered!: () => void, release!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const read: typeof gitShow = async (root, sha, file) => {
      if (block && file === 'utils.py') { block = false; entered(); await gate }
      return gitShow(root, sha, file)
    }
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0, read })
    try {
      gi.start(); await gi.whenIdle()
      block = true
      publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t, secret_customer):\n    return t\n')
      await inside
      const holder = room.participants.get('Rohan\u0000holder')!
      room.participants.set('Rohan\u0000holder', { ...holder, epoch: 2, sessionId: 'replacement' })
      release()
      await gi.whenIdle()
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(JSON.stringify(room.graphs.get('Rohan'))).not.toContain('secret_customer')
    } finally { release(); gi.stop(); room.doc.destroy() }
  })
  it('keeps held own contracts out of the replicated graph and withdraws them when sharing narrows', async () => {
    const room = new RoomDoc()
    room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
    writeFileSync(join(dir, 'utils.py'), 'def validate_token(t, secret_customer):\n    return t\n')
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t, secret_customer):\n    return t\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      await eventually(() => JSON.stringify(room.graphs.get('Rohan')).includes('secret_customer'))
      const head = room.manifestHead.get('Rohan')!
      const key = manifestKey('Rohan', head.fence)
      room.doc.transact(() => {
        room.manifest.get(key)!.set('utils.py', { change: 'M', state: 'held', held: 'scope', at: Date.now(), fence: head.fence })
        room.clearOverlay(key, 'utils.py')
        room.manifestHead.set('Rohan', { ...head, level: 'declared', textPrefixes: [], rev: head.rev + 1, semRev: head.semRev + 1 })
      })
      await gi.whenIdle()
      await eventually(() => !JSON.stringify(room.graphs.get('Rohan')).includes('secret_customer'))
      expect(gi.graph.definersOf('validate_token')).toEqual(['utils.py'])
    } finally { gi.stop(); room.doc.destroy() }
  })
  it('withdraws an out-of-area signature synchronously under the default publication throttle', async () => {
    const room = new RoomDoc()
    room.setMeta({ base }); setFixtureLocalRoot(room, 'Rohan', dir)
    writeFileSync(join(dir, 'utils.py'), 'def validate_token(t, secret_customer):\n    return t\n')
    publishFixture(room, 'Rohan', 'utils.py', 'def validate_token(t, secret_customer):\n    return t\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0 })
    try {
      gi.start(); await gi.whenIdle()
      await eventually(() => JSON.stringify(room.graphs.get('Rohan')).includes('secret_customer'))
      const head = room.manifestHead.get('Rohan')!, key = manifestKey('Rohan', head.fence)
      room.doc.transact(() => {
        room.manifest.get(key)!.set('utils.py', { change: 'M', state: 'held', held: 'scope', at: Date.now(), fence: head.fence })
        room.clearOverlay(key, 'utils.py')
        room.manifestHead.set('Rohan', { ...head, level: 'declared', textPrefixes: [], rev: head.rev + 1, semRev: head.semRev + 1 })
      })
      expect(JSON.stringify(room.graphs.get('Rohan'))).not.toContain('secret_customer')
      const lateReader = new RoomDoc()
      Y.applyUpdate(lateReader.doc, Y.encodeStateAsUpdate(room.doc))
      expect(JSON.stringify(lateReader.graphs.get('Rohan'))).not.toContain('secret_customer')
      lateReader.doc.destroy()
    } finally { gi.stop(); room.doc.destroy() }
  })
  it('marks held remote changes as contract coverage gaps', async () => {
    const room = graphRoom()
    publishFixture(room, 'Kieran', 'hidden.py', 'def secret(x):\n    return x\n')
    const head = room.manifestHead.get('Kieran')!
    const key = manifestKey('Kieran', head.fence)
    room.doc.transact(() => {
      room.manifest.get(key)!.set('hidden.py', { change: 'A', state: 'held', held: 'scope', at: Date.now(), fence: head.fence })
      room.clearOverlay(key, 'hidden.py')
      room.manifestHead.set('Kieran', { ...head, rev: head.rev + 1, semRev: head.semRev + 1 })
    })
    const logs: string[] = []
    const gi = new GraphIndex(room, 'Rohan', dir, line => logs.push(line), { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      expect(gi.graph.has('hidden.py')).toBe(false)
      expect(room.graphs.get('Rohan')?.status).toBe('error')
      expect(logs.join('\n')).toContain('hidden.py changed by Kieran; contract not visible')
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('continues past an unchanged participant to a later changed version', async () => {
    const room = graphRoom()
    publishFixture(room, 'Ada', 'other.py', 'def other():\n    pass\n')
    publishFixture(room, 'Kieran', 'utils.py', 'def replacement():\n    pass\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      expect(gi.graph.definersOf('replacement')).toEqual(['utils.py'])
      expect(gi.graph.definersOf('validate_token')).toEqual([])
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('replacing one person map refreshes only its changed overlay, not 40 unrelated changed files', async () => {
    const room = graphRoom()
    for (let i = 0; i < 40; i++) publishFixture(room, 'Rohan', `mod${i}.py`, `def f${i}():\n    return ${i}\n`)
    publishFixture(room, 'Kieran', 'utils.py', 'def old_name():\n    pass\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      const refresh = vi.spyOn(gi, 'refresh')
      publishFixture(room, 'Kieran', 'utils.py', 'def new_name():\n    pass\n')
      await gi.whenIdle()
      expect(refresh.mock.calls.map(call => call[0])).toEqual(['utils.py'])
      expect(gi.graph.definersOf('new_name')).toEqual(['utils.py'])
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('initial refresh covers every changed source file', async () => {
    const room = graphRoom()
    for (let i = 0; i < 16; i++) publishFixture(room, 'Rohan', `mod${i}.py`, `def f${i}():\n    pass\n`)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      const refresh = vi.spyOn(gi, 'refresh')
      gi.start(); await gi.whenIdle()
      expect(new Set(refresh.mock.calls.map(call => call[0]))).toEqual(new Set(['utils.py', ...Array.from({ length: 16 }, (_, i) => `mod${i}.py`)]))
      expect(gi.graph.size).toBe(17)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('limits initial refresh to eight active file reads', async () => {
    const room = graphRoom()
    for (let i = 0; i < 16; i++) publishFixture(room, 'Rohan', `mod${i}.py`, `def f${i}():\n    pass\n`)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    const target = gi as unknown as { textFor(path: string): Promise<string | undefined> }
    const original = target.textFor.bind(gi)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let active = 0, peak = 0, started = 0
    vi.spyOn(target, 'textFor').mockImplementation(async path => {
      started++; active++; peak = Math.max(peak, active)
      await gate
      active--
      return original(path)
    })
    try {
      gi.start()
      await eventually(() => started === 8)
      expect(peak).toBe(8)
      expect(started).toBe(8)
      release(); await gi.whenIdle()
      expect(started).toBe(17)
    } finally { release(); gi.stop(); room.doc.destroy() }
  })

  it('limits incremental refresh to eight active file reads', async () => {
    const room = graphRoom()
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    const target = gi as unknown as { textFor(path: string): Promise<string | undefined> }
    const original = target.textFor.bind(gi)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let active = 0, peak = 0, started = 0
    vi.spyOn(target, 'textFor').mockImplementation(async path => {
      started++; active++; peak = Math.max(peak, active)
      await gate
      active--
      return original(path)
    })
    try {
      room.doc.transact(() => {
        for (let i = 0; i < 16; i++) publishFixture(room, 'Rohan', `mod${i}.py`, `def f${i}():\n    pass\n`)
      })
      await eventually(() => started >= 8)
      expect(peak).toBeLessThanOrEqual(8)
      release(); await gi.whenIdle()
      expect(started).toBe(16)
    } finally { release(); gi.stop(); room.doc.destroy() }
  })

  // A lead with hundreds of changed files sat near 100% CPU while workers edited: every overlay
  // event re-parsed (and git-showed) every changed path of every participant.
  it('an edit refreshes only the path it touched, and a path leaving the changed set is refreshed', async () => {
    const room = graphRoom()
    for (let i = 0; i < 40; i++) publishFixture(room, 'Rohan', `mod${i}.py`, `def f${i}():\n    return ${i}\n`)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    expect(gi.graph.size).toBe(41)
    const refresh = vi.spyOn(gi, 'refresh')

    publishFixture(room, 'Kieran', 'utils.py', 'def verify_token(t):\n    return t\n')
    await gi.whenIdle()
    expect(refresh.mock.calls.map(c => c[0])).toEqual(['utils.py'])

    refresh.mockClear()
    publishFixture(room, 'Rohan', 'mod3.py', 'def g3():\n    return 3\n')
    await gi.whenIdle()
    expect(refresh.mock.calls.map(c => c[0])).toEqual(['mod3.py'])

    refresh.mockClear()
    clearFixture(room, 'Rohan', 'mod7.py')
    await gi.whenIdle()
    expect(refresh.mock.calls.map(c => c[0])).toEqual(['mod7.py'])
    expect(gi.graph.size).toBe(40) // mod7.py was only an overlay: gone, not stale

    refresh.mockClear()
    deleteFixture(room, 'Kieran', 'mod9.py')
    await gi.whenIdle()
    expect(refresh.mock.calls.map(c => c[0])).toEqual(['mod9.py'])
    gi.stop(); room.doc.destroy()
  })

  it('a participant dropping all their work still refreshes each of their paths', async () => {
    const room = graphRoom()
    publishFixture(room, 'Kieran', 'utils.py', 'def verify_token(t):\n    return t\n')
    publishFixture(room, 'Kieran', 'extra.py', 'def extra():\n    return 1\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    expect(gi.graph.usersOf('validate_token')).toEqual([])
    expect(gi.graph.size).toBe(2)
    room.doc.transact(() => {
      const fence = room.manifestHead.get('Kieran')?.fence
      if (fence) room.manifest.delete(`Kieran\u0000${fence}`)
      room.manifestHead.delete('Kieran')
    })
    await gi.whenIdle()
    expect(gi.graph.size).toBe(1)
    const text = await (gi as unknown as { textFor(p: string): Promise<string | undefined> }).textFor('utils.py')
    expect(text).toContain('validate_token')
    gi.stop(); room.doc.destroy()
  })
})

function graphRoom(): RoomDoc {
  const room = new RoomDoc()
  room.setMeta({ repo: 'github.com/example/graph' })
  setParticipantBase(room, 'Rohan', base)
  setFixtureLocalRoot(room, 'Rohan', dir)
  return room
}
