import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { afterEach, expect, it } from 'vitest'
import { RoomDoc, digestPath, gitBlobHash, manifestKey, snapshot, versionOf } from '@room/shared'
import { gitShow } from '@room/roomd/git'
import { handlers } from '../src/tools/files.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'

let root: string | undefined
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined })

function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-manifest-preview-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root!, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Alice')
  git('config', 'user.email', 'alice@example.test')
  fs.writeFileSync(path.join(root, 'app.py'), 'base\n')
  fs.writeFileSync(path.join(root, 'tests.txt'), 'base tests\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const room = new RoomDoc()
  room.setMeta({ base, branch: 'main', repo: 'demo' })
  room.participants.set('ben\0holder', { sessionId: 'ben-1', epoch: 1 })
  room.participants.set('ben\0git', { base, head: base, fence: '1', rev: 1 })
  const head = { base, fence: '1', coverage: { kind: 'all' as const }, level: 'declared' as const,
    excluded: [] as string[], rev: 1, semRev: 1, scannedAt: Date.now(), complete: true }
  room.manifestHead.set('ben', head)
  const entries = new Y.Map<any>(), texts = new Y.Map<Y.Text>()
  room.manifest.set(manifestKey('ben', '1'), entries)
  room.overlays.set(manifestKey('ben', '1'), texts)
  const session = { dir: root, room, me: { name: 'alice', kind: 'agent' }, roomName: 'local/demo/main',
    awareness: { getStates: () => new Map([[1, { user: { name: 'ben', kind: 'agent' }, sessionId: 'ben-1', at: Date.now() }]]) }, ...hubSeam(room) } as unknown as Session
  const state = { S: () => session, rooms: { all: () => [session], holding: () => session },
    others: () => ['ben'], presences: () => [], myWorkers: () => [], baseFor: () => base, now: () => Date.now(),
    readVersion: (_s: Session, pathname: string, person: string) => versionOf(snapshot(room, person, []), pathname,
      { gitAt: (sha, relpath) => gitShow(root!, sha, relpath) }),
  } as unknown as HandlerState
  return { room, head, entries, texts, session, state }
}

it('keeps a hashless held file out of the combined tree and records a partial passing run', async () => {
  const { room, entries, texts, session, state } = fixture()
  entries.set('app.py', { change: 'M', state: 'held', held: 'scope', at: Date.now(), fence: '1' })
  entries.set('tests.txt', { change: 'M', state: 'shared', hash: gitBlobHash('tests pass\n'), size: 11, at: Date.now(), fence: '1' })
  texts.set('tests.txt', new Y.Text('tests pass\n'))
  const heldRead = await handlers(state).room_read({ person: 'ben', path: 'app.py' })
  expect(heldRead).toContain('outside their declared area')
  expect(heldRead).not.toContain('base\n')
  expect(heldRead).not.toContain('bytes')
  const result = await handlers(state).room_preview_merge({ person: 'ben', run: 'test "$(cat tests.txt)" = "tests pass" && echo "1 passed"' })
  expect(result).toContain('PARTIAL preview')
  expect(result).toContain('app.py')
  expect(result).toContain('outside ben\'s declared area')
  expect(result).toContain('ran on a partial tree')
  expect(session.lastPreview).toMatchObject({ complete: false, testsPassed: false, partialPassed: true })
  const notes = room.messages().filter(message => message.type === 'note' && message.text.includes('partial preview'))
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toContain('app.py')
  expect(notes[0].text).toContain('test "$(cat tests.txt)"')
  expect(notes[0].text).toContain('partial tree')
})

it('reports anonymous exclusion and intent gaps even with no mergeable paths', async () => {
  const { room, head, session, state } = fixture()
  room.manifestHead.set('ben', { ...head, excluded: [digestPath(room.ensureRoomSalt(), 'app.py')], semRev: 2 })
  const excluded = await handlers(state).room_preview_merge({ person: 'ben' })
  expect(excluded).toContain('PARTIAL preview')
  expect(excluded).toContain('names not shared')
  expect(session.lastPreview?.complete).toBe(false)
  room.manifestHead.set('ben', { ...head, coverage: { kind: 'none', reason: 'intent' }, semRev: 3 })
  const intent = await handlers(state).room_preview_merge({ person: 'ben' })
  expect(intent).toContain('PARTIAL preview')
  expect(intent).toContain('coverage intent')
})
