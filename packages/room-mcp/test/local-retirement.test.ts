import { stopTestDaemon } from './daemon-fixture.js'
import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import { joinSession, leaveSession, type Session } from '../src/session.js'
import { closeRegistryForDir, WorkerRegistry } from '../src/worker-registry.js'
import { createSessionBinding } from '../src/binding.js'
import { disposePreviewFixture } from './fixtures/preview-disposal.js'

const roots: string[] = [], sessions: Session[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await leaveSession(session)
  for (const dir of roots.splice(0)) {
    await closeRegistryForDir(dir)
    await stopTestDaemon(path.join(dir, '.git'))
    await disposePreviewFixture(dir)
  }
})
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'room-local-retirement-'))); roots.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.com')
  fs.writeFileSync(path.join(dir, 'app.py'), 'x = 1\n'); git('add', '.'); git('commit', '-qm', 'fixture')
  return dir
}

it.each(['complete-leftovers', 'session-only', 'snapshots-only', 'incomplete-import', 'old-room-file', 'old-choice', 'schema2-choice', 'custom-choice'])('joins a 0.17 local room with %s and leaves old sources byte-identical', async scenario => {
  const dir = repo(), common = path.join(dir, '.git'), defaultRoom = `local/${path.basename(dir)}`
  const saved = new Map<string, Buffer>()
  const old = (name: string, bytes: string | Uint8Array) => {
    const file = path.join(common, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes)
    saved.set(file, fs.readFileSync(file))
  }
  if (['complete-leftovers', 'session-only'].includes(scenario)) old('room-session.json', JSON.stringify({ session_id: 'previous-session', host: 'claude', hostPid: process.pid }))
  if (['complete-leftovers', 'snapshots-only'].includes(scenario)) {
    old('room-local.json', JSON.stringify({ pid: process.pid })) // Alive, unrelated to the old relay owner.
    const source = new Y.Doc(); source.getMap('scopes').set('old', { by: 'old', area: 'historical' })
    old(`room-local/${encodeURIComponent(defaultRoom + '/main')}.ydoc`, Y.encodeStateAsUpdate(source)); source.destroy()
    old('room-carry/previous.json', '{"base":"historical"}\n')
  }
  if (scenario === 'complete-leftovers') {
    old(`room/relay/migrated-${createHash('sha256').update(defaultRoom).digest('hex').slice(0, 16)}.json`, '{"complete":true}\n')
    old('room/registry/migration.json', '{"v":1,"sources":{},"done":true}\n')
  }
  if (scenario === 'incomplete-import') {
    old('room/registry/migration.json', '{"v":1,"sources":{"worktree:pending":{"id":"w_pending","state":"assigned"}},"done":false}\n')
    old('room/registry/migration.lock', 'historical lock\n')
    old('room-local/old.ydoc', 'not a current snapshot')
    old('room-carry/pending.json', 'not a current carry record')
  }
  const alias = { room: `ws://127.0.0.1:1/${encodeURIComponent(defaultRoom + '/main')}`, name: 'previous' }
  if (scenario === 'old-room-file') old('room.json', JSON.stringify({ room: alias.room, name: 'previous', legacy: alias }))
  if (scenario.endsWith('-choice')) old('room-choice.json', JSON.stringify({ where: 'local', at: 1, room: scenario === 'custom-choice' ? 'local/experiments' : `${defaultRoom}/scratch`, ...(scenario === 'schema2-choice' ? { schema: 2 } : {}) }))
  const binding = createSessionBinding(dir, { ROOM_HOST: 'claude', CLAUDE_CODE_SESSION_ID: 'current-session' })
  expect(binding.dir()).toContain(path.join('room', 'sessions'))
  const session = await joinSession({ dir, name: 'Fixture', tag: scenario === 'old-choice' ? undefined : 'current', log: () => {} }); sessions.push(session)
  // joinSession without a room joins the repository's default local room, as at v0.17.47; a remembered
  // room reaches it through resolveConfig in the callers (legacy-local-choice.test.ts covers that).
  const expected = defaultRoom
  expect(session.roomName).toBe(expected)
  expect(session.room.scope('old')).toBeUndefined()
  const registry = await WorkerRegistry.open(common, { watch: false }); registry.close()
  for (const [file, before] of saved) {
    if (scenario === 'old-room-file' && file.endsWith('/room.json')) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'))
      expect(current.legacy).toBeUndefined()
      expect(current.room).toBe(session.roomUrl)
    } else expect(fs.readFileSync(file)).toEqual(before)
  }
}, 20_000)
