import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function flaskChanges() {
  const dir = mkdtempSync(join(tmpdir(), 'room-diff-base-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Ana')
  git('config', 'user.email', 'ana@example.test')
  const original = 'Changelog\n=========\n\nExisting release notes.\n'
  const anaEntry = 'Ana: fixed autoescaping.\n'
  const benEntry = 'Ben: fixed request validation.\n'
  writeFileSync(join(dir, 'CHANGES.rst'), original)
  git('add', 'CHANGES.rst')
  git('commit', '-qm', 'base')
  const oldBase = git('rev-parse', 'HEAD')
  writeFileSync(join(dir, 'CHANGES.rst'), original + anaEntry)
  git('commit', '-qam', 'Ana changelog entry')
  const readerBase = git('rev-parse', 'HEAD')

  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ repo: 'flask', branch: 'main', base: readerBase })
  room.setBaseOf('Ana', readerBase)
  room.setBaseOf('Ben', oldBase)
  room.setOverlay('Ben', 'CHANGES.rst', original + benEntry)
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { name: 'Ana', kind: 'agent', color: '#000' }, status: 'idle' })
  const session = {
    room, awareness, me: { name: 'Ana', kind: 'agent' }, dir,
    roomUrl: 'ws://x/r', roomName: 'r', browserUrl: 'http://x',
    provider: { synced: true, awareness },
    daemon: { touch() {}, async stop() {}, dir, name: 'Ana', roomDoc: room, base: readerBase },
  } as unknown as Session
  const tools = createTools({ getSession: () => session, setSession: () => {}, cwd: dir })
  return { tools, oldBase, readerBase, anaEntry, benEntry, awareness, room }
}

it.each([
  ['one file', { path: 'CHANGES.rst' }],
  ['all diffs', {}],
])('room_read diff of Ben after Ana commits shows only Ben’s change (%s)', async (_name, options) => {
  const t = flaskChanges()
  try {
    const diff = await t.tools.call('room_read', { person: 'Ben', diff: true, ...options })
    expect(diff).toContain(`+${t.benEntry}`)
    expect(diff).not.toContain(`-${t.anaEntry}`)
    expect(diff).toContain(`Ben's base ${t.oldBase.slice(0, 10)}`)
    expect(diff).toContain(`your base ${t.readerBase.slice(0, 10)}`)
  } finally {
    await t.tools.shutdown()
    t.awareness.destroy()
    t.room.doc.destroy()
  }
})

it('a teammate overlay still asks for fetch when its base is absent locally', async () => {
  const t = flaskChanges()
  try {
    t.room.setBaseOf('Ben', 'c0ffee0000000000000000000000000000000000')
    const diff = await t.tools.call('room_read', { person: 'Ben', path: 'CHANGES.rst', diff: true })
    expect(diff).toMatch(/error: Ben's HEAD c0ffee0000 is not in this clone/)
    expect(diff).toContain('run git fetch, then retry')
  } finally {
    await t.tools.shutdown()
    t.awareness.destroy()
    t.room.doc.destroy()
  }
})
