import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoomDoc } from '@room/shared'
import { GraphIndex } from '../src/graph-index.js'

let dir: string, base: string
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
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 0 })
    gi.start(); await gi.ready
    expect(gi.graph.size).toBe(2)
    expect(gi.graph.usersOf('validate_token')).toEqual(['session.py'])
    room.setOverlay('Kieran', 'session.py', 'from utils import validate_token\n\ndef login(t):\n    return verify_token(t)\n')
    await new Promise(r => setTimeout(r, 300))
    expect(gi.graph.usersOf('validate_token')).toEqual(['session.py']) // import still references it (ast ImportFrom)
    room.setOverlay('Kieran', 'session.py', 'def login(t):\n    return verify_token(t)\n')
    await new Promise(r => setTimeout(r, 300))
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
    await new Promise(r => setTimeout(r, 150))
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
})

describe('GraphIndex snapshot discipline', () => {
  it('does not rewrite an identical snapshot and waits out the publish window', async () => {
    const room = new RoomDoc()
    room.setMeta({ base })
    const gi = new GraphIndex(room, 'Rohan', dir, undefined, { minPublishMs: 400 })
    gi.start(); await gi.ready
    await new Promise(r => setTimeout(r, 300))
    expect(room.graphs.get('Rohan')!.edges.length).toBe(1)
    let writes = 0
    room.graphs.observe(() => { writes++ })
    room.setOverlay('Rohan', 'session.py', 'from utils import validate_token\n\ndef login(t):\n    return validate_token(t)  # same edge\n')
    await new Promise(r => setTimeout(r, 300))
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
