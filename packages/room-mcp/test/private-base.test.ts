import { it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc, type Worker } from '@room/shared'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'

/** A teammate's clone, which never has a commit that exists only on the lead's machine. */
function teammate(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'room-private-base-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString().trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'Bob')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  return { dir, base: git('rev-parse', 'HEAD') }
}

function session(dir: string, base: string, person: string, sha: string, record?: Partial<Worker>): Session {
  const room = new RoomDoc(new Y.Doc())
  room.setMeta({ repo: 'demo', branch: 'main', base })
  room.setBaseOf(person, sha)
  if (record) room.setWorker({ id: 'Alice/w#1', tag: 'w', name: person, host: 'codex', task: 't', dir: '/elsewhere', branch: 'room/w', pid: 1, startedAt: 0, status: 'running', lead: 'Alice', ...record } as Worker)
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { name: 'Bob', kind: 'agent', color: '#000' }, status: 'idle' })
  return {
    room, awareness, me: { name: 'Bob', kind: 'agent' }, dir, roomUrl: 'ws://x/r', roomName: 'r', browserUrl: 'http://x', shareMax: 'full', shareRequested: 'full',
    provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: 'Bob', roomDoc: room, provider: null as never, branch: 'main', base } as unknown as Session['daemon'],
  }
}

const PRIVATE = 'c0ffee0000000000000000000000000000000000'

it('a base that is a worker\'s carried commit is named as local to the lead, not something to fetch', async () => {
  const { dir, base } = teammate()
  const s = session(dir, base, 'Alice+w', PRIVATE, { base: PRIVATE, carriedBase: PRIVATE } as Partial<Worker>)
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
  const reply = await tools.call('room_read', { path: 'app.py', person: 'Alice+w' })
  expect(reply).toMatch(/error: Alice\+w's base c0ffee0000 is Alice's carried uncommitted work, which exists only on Alice's machine/)
  expect(reply).not.toMatch(/git fetch/)
})

it('any other missing base still says to fetch, and what it means if that does not help', async () => {
  const { dir, base } = teammate()
  const s = session(dir, base, 'Carol', PRIVATE)
  const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
  const reply = await tools.call('room_read', { path: 'app.py', person: 'Carol' })
  expect(reply).toMatch(/error: Carol's HEAD c0ffee0000 is not in this clone \(.*\); run git fetch, then retry; if it is still missing, Carol has not pushed it yet$/)
})

it('in the lead\'s clone a team-room carried worker\'s unchanged files read from its carried commit; a teammate reads the published base', async () => {
  const { dir, base } = teammate()
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString().trim()
  git('checkout', '-qb', 'room/w'); writeFileSync(join(dir, 'app.py'), 'lead WIP\n'); git('commit', '-qam', 'carried'); const carried = git('rev-parse', 'HEAD'); git('checkout', '-q', 'main')
  const record = { base: carried, carriedBase: carried } as Partial<Worker>
  const lead = session(dir, base, 'Alice+w', base, record)
  lead.me = { name: 'Alice', kind: 'agent' }
  const leadTools = createTools({ getSession: () => lead, setSession: () => {}, cwd: dir })
  expect(await leadTools.call('room_read', { path: 'app.py', person: 'Alice+w' })).toContain('lead WIP')
  const bob = session(dir, base, 'Alice+w', base, record)
  const bobTools = createTools({ getSession: () => bob, setSession: () => {}, cwd: dir })
  const theirs = await bobTools.call('room_read', { path: 'app.py', person: 'Alice+w' })
  expect(theirs).toContain('x = 1')
  expect(theirs).not.toContain('lead WIP')
})
