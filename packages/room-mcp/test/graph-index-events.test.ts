import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc } from '@room/shared'
import { GraphIndex } from '../src/graph-index.js'

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
