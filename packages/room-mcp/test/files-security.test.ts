import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type Identity } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'

const roots: string[] = []
afterEach(() => {
  delete process.env.ROOM_SECURITY_MARKER
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('merge preview materialization', () => {
  it('treats shell metacharacters in the clone path as ordinary filename characters', async () => {
    const root = join(tmpdir(), `room-preview-security-${process.pid}-${Date.now()}`)
    roots.push(root)
    mkdirSync(root)
    const marker = join(root, 'injected')
    process.env.ROOM_SECURITY_MARKER = marker
    const dir = join(root, 'clone $(touch${IFS}${ROOM_SECURITY_MARKER}) `true` " space')
    mkdirSync(dir)
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@room'); git('config', 'user.name', 'test')
    writeFileSync(join(dir, 'app.txt'), 'base\n')
    git('add', '.'); git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')

    const doc = new Y.Doc(), room = new RoomDoc(doc)
    room.setMeta({ repo: 'demo', branch: 'main', base })
    room.setBaseOf('Rohan', base); room.setBaseOf('Kieran', base)
    room.setOverlay('Kieran', 'app.txt', 'peer change\n')
    const me: Identity = { name: 'Rohan', kind: 'agent' }
    const awareness = new Awareness(doc)
    awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
    const session = {
      room, awareness, me, dir, roomName: 'local/demo/main', roomUrl: 'ws://local/local%2Fdemo%2Fmain', browserUrl: '',
      provider: { synced: true, awareness }, shareMax: 'full', shareRequested: 'full',
      daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null, branch: 'main', base },
    } as unknown as Session
    const tools = createTools({ cwd: dir, getSession: () => session, setSession: () => {} })
    try {
      const result = await tools.call('room_preview_merge', { person: 'Kieran', run: 'cat app.txt' })
      expect(result).toContain('peer change')
      expect(result).toContain('exit 0')
      expect(existsSync(marker)).toBe(false)
    } finally {
      await tools.shutdown(); awareness.destroy(); doc.destroy()
    }
  })
})
