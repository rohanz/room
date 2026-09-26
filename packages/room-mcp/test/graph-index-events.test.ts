import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc } from '@room/shared'
import { GraphIndex } from '../src/graph-index.js'
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

describe('GraphIndex overlay events', () => {
  it('replacing one person map refreshes only its changed overlay, not 40 unrelated changed files', async () => {
    const room = new RoomDoc()
    room.setMeta({ base })
    for (let i = 0; i < 40; i++) room.setOverlay('Rohan', `mod${i}.py`, `def f${i}():\n    return ${i}\n`)
    room.setOverlay('Kieran', 'utils.py', 'def old_name():\n    pass\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      gi.start(); await gi.whenIdle()
      const refresh = vi.spyOn(gi, 'refresh')
      const replacement = new Y.Map<Y.Text>()
      const text = new Y.Text(); text.insert(0, 'def new_name():\n    pass\n')
      replacement.set('utils.py', text)
      room.overlays.set('Kieran', replacement)
      await gi.whenIdle()
      expect(refresh.mock.calls.map(call => call[0])).toEqual(['utils.py'])
      expect(gi.graph.definersOf('new_name')).toEqual(['utils.py'])
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('initial refresh covers every changed source file', async () => {
    const room = new RoomDoc()
    room.setMeta({ base })
    for (let i = 0; i < 16; i++) room.setOverlay('Rohan', `mod${i}.py`, `def f${i}():\n    pass\n`)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    try {
      const refresh = vi.spyOn(gi, 'refresh')
      gi.start(); await gi.whenIdle()
      expect(new Set(refresh.mock.calls.map(call => call[0]))).toEqual(new Set(['utils.py', ...Array.from({ length: 16 }, (_, i) => `mod${i}.py`)]))
      expect(gi.graph.size).toBe(17)
    } finally { gi.stop(); room.doc.destroy() }
  })

  it('limits initial refresh to eight active file reads', async () => {
    const room = new RoomDoc()
    room.setMeta({ base })
    for (let i = 0; i < 16; i++) room.setOverlay('Rohan', `mod${i}.py`, `def f${i}():\n    pass\n`)
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
    const room = new RoomDoc()
    room.setMeta({ base })
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
        for (let i = 0; i < 16; i++) room.setOverlay('Rohan', `mod${i}.py`, `def f${i}():\n    pass\n`)
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
    const room = new RoomDoc()
    room.setMeta({ base })
    for (let i = 0; i < 40; i++) room.setOverlay('Rohan', `mod${i}.py`, `def f${i}():\n    return ${i}\n`)
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    expect(gi.graph.size).toBe(41)
    const refresh = vi.spyOn(gi, 'refresh')

    room.setOverlay('Kieran', 'utils.py', 'def verify_token(t):\n    return t\n')
    await gi.whenIdle()
    expect(refresh.mock.calls.map(c => c[0])).toEqual(['utils.py'])

    refresh.mockClear()
    room.setOverlay('Rohan', 'mod3.py', 'def g3():\n    return 3\n')
    await gi.whenIdle()
    expect(refresh.mock.calls.map(c => c[0])).toEqual(['mod3.py'])

    refresh.mockClear()
    room.clearOverlay('Rohan', 'mod7.py')
    await gi.whenIdle()
    expect(refresh.mock.calls.map(c => c[0])).toEqual(['mod7.py'])
    expect(gi.graph.size).toBe(40) // mod7.py was only an overlay: gone, not stale

    refresh.mockClear()
    room.markDeleted('Kieran', 'mod9.py')
    await gi.whenIdle()
    expect(refresh.mock.calls.map(c => c[0])).toEqual(['mod9.py'])
    gi.stop(); room.doc.destroy()
  })

  it('a participant dropping all their work still refreshes each of their paths', async () => {
    const room = new RoomDoc()
    room.setMeta({ base })
    room.setOverlay('Kieran', 'utils.py', 'def verify_token(t):\n    return t\n')
    room.setOverlay('Kieran', 'extra.py', 'def extra():\n    return 1\n')
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { random: () => 0, minPublishMs: 0 })
    gi.start(); await gi.whenIdle()
    expect(gi.graph.usersOf('validate_token')).toEqual([])
    expect(gi.graph.size).toBe(2)
    room.doc.transact(() => { room.overlays.delete('Kieran') })
    await gi.whenIdle()
    expect(gi.graph.size).toBe(1)
    const text = await (gi as unknown as { textFor(p: string): Promise<string | undefined> }).textFor('utils.py')
    expect(text).toContain('validate_token')
    gi.stop(); room.doc.destroy()
  })
})
