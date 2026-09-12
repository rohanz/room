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
    const gi = new GraphIndex(room, 'Rohan', dir)
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
})
