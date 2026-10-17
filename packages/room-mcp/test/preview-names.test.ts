import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { afterEach, expect, it } from 'vitest'
import { RoomDoc, digestPath, gitBlobHash, manifestKey, snapshot, versionOf } from '@room/shared'
import { gitShow } from '@room/roomd/git'
import { handlers } from '../src/tools/files.js'
import type { HandlerState } from '../src/tools/context.js'
import type { Session } from '../src/session.js'
import { hubSeam } from './fixtures/hub.js'
import { createHandlerState } from '../src/tools/state.js'
import type { WorkerView } from '@room/shared'
import { seedRegistryWorker } from './registry-fixture.js'
import { closeRegistryForDir, registryForDir } from '../src/worker-registry.js'

let root: string | undefined
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined })

function fixture(baseContent = 'base\n') {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-names-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', root!, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Ana'); git('config', 'user.email', 'ana@example.test')
  fs.writeFileSync(path.join(root, 'app.py'), baseContent)
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const room = new RoomDoc(); room.ensureRoomSalt(); room.setMeta({ base, branch: 'main', repo: 'demo' })
  const add = (person: string, state: 'shared' | 'held', content = '', pathname = 'app.py') => {
    room.participants.set(`${person}\0holder`, { sessionId: `${person}-1`, epoch: 1 })
    room.participants.set(`${person}\0git`, { base, head: base, fence: '1', rev: 1 })
    room.manifestHead.set(person, { base, fence: '1', coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: Date.now(), complete: true })
    const entries = new Y.Map<any>(), texts = new Y.Map<Y.Text>()
    entries.set(pathname, state === 'shared'
      ? { change: 'M', state, hash: gitBlobHash(content), size: Buffer.byteLength(content), at: 1, fence: '1' }
      : { change: 'M', state, held: 'scope', at: 1, fence: '1' })
    if (state === 'shared') texts.set(pathname, new Y.Text(content))
    room.manifest.set(manifestKey(person, '1'), entries)
    room.overlays.set(manifestKey(person, '1'), texts)
  }
  const session = { dir: root, room, me: { name: 'ana', kind: 'agent' }, roomName: 'local/demo/main',
    awareness: { getStates: () => new Map([[1, { user: { name: 'ben', kind: 'agent' }, sessionId: 'ben-1', at: Date.now() }]]) }, ...hubSeam(room) } as unknown as Session
  const state = { S: () => session, rooms: { all: () => [session], holding: () => session },
    others: () => ['ben', 'chris'], presences: () => [{ user: { name: 'ben', kind: 'agent' } }],
    myWorkers: () => [], baseFor: () => base, now: () => Date.now(),
    readVersion: (_s: Session, pathname: string, person: string) => versionOf(snapshot(room, person, []), pathname,
      { gitAt: (sha, relpath) => gitShow(root!, sha, relpath) }),
  } as unknown as HandlerState
  return { room, session, state, add }
}

/** Each worker MCP holds only its own session; remote joins arrive through awareness. */
function workerFixture(overlap: boolean) {
  const f = fixture('base\nmiddle\nend\n')
  const lead = 'ana', caller = 'ana+one', sibling = 'ana+two'
  f.session.me = { name: caller, kind: 'agent', owner: lead }
  f.session.local = true
  f.add(caller, 'shared', 'caller change\nmiddle\nend\n')
  fs.writeFileSync(path.join(root!, 'app.py'), 'caller change\nmiddle\nend\n')
  f.add(lead, 'shared', 'lead change\n', 'lead.py')
  f.add(sibling, 'shared', overlap ? 'base\nmiddle\nsibling change\n' : 'sibling change\n', overlap ? 'app.py' : 'peer.py')
  for (const [tag, name] of [['one', caller], ['two', sibling]]) {
    const view: WorkerView = { id: tag, tag, name, lead, mode: 'local', host: 'codex', task: 'work', branch: tag,
      status: 'running', run: 1, startedAt: Date.now(), fence: '1' }
    f.room.workerViews.set(tag, view)
  }
  const awareness = new Awareness(f.room.doc)
  awareness.setLocalState({ user: f.session.me, sessionId: `${caller}-1` })
  f.session.awareness = awareness
  cleanups.push(() => awareness.destroy())
  const peers = new Map<string, Awareness>()
  for (const name of [lead, sibling]) {
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(f.room.doc))
    const peer = new Awareness(remote)
    peer.setLocalState({ user: { name, kind: 'agent' }, sessionId: `${name}-1` })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'remote join')
    peers.set(name, peer)
    cleanups.push(() => { peer.destroy(); remote.destroy() })
  }
  // Use the production registry and presence/name readers, not a list of local peer sessions.
  const state = createHandlerState({ cwd: root!, getSession: () => f.session, setSession: () => {}, log: () => {} })
  expect(state.rooms.all()).toEqual([f.session])
  expect(state.presences(f.session).map(p => p.user.name).sort()).toEqual([lead, caller, sibling].sort())
  const disconnect = (name: string) => {
    const peer = peers.get(name)!
    peer.setLocalState(null)
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'remote leave')
  }
  return { ...f, state, lead, caller, sibling, disconnect }
}

it('a worker sees present siblings and the lead but names non-overlapping peers instead of merging them', async () => {
  const { state, session } = workerFixture(false)
  session.lastPreview = { clean: true, complete: true, testsPassed: true }
  const result = await handlers(state).room_preview_merge({})
  expect(result).toContain('no overlapping present participants to merge')
  expect(result).toContain('skipped 2 present participants without overlapping paths: ana, ana+two; include with people: ["ana", "ana+two"]')
  expect(result).not.toContain('offline')
  expect(session.lastPreview).toEqual({ clean: false, complete: false, testsPassed: false })
})

it('a worker includes an overlapping present sibling from awareness with only its own session registered', async () => {
  const { state, session } = workerFixture(true)
  const result = await handlers(state).room_preview_merge({})
  expect(result).toContain('step 1: merge ana+two')
  expect(result).toContain('final combined tree:')
  expect(result).toContain('skipped 1 present participant without overlapping paths: ana; include with people: ["ana"]')
  expect(result).not.toContain('offline')
  expect(session.lastPreview).toMatchObject({ clean: true, complete: true, testsPassed: false })
})

it('keeps finished sibling workers offline by default and retains the manifest-facts opt-in', async () => {
  const { state, session, room, sibling, disconnect } = workerFixture(true)
  room.workerViews.set('two', { ...room.workerViews.get('two')!, status: 'done' })
  disconnect(sibling)
  const result = await handlers(state).room_preview_merge({})
  expect(result).toContain('no overlapping present participants to merge')
  expect(result).toContain('skipped 1 present participant without overlapping paths: ana')
  expect(result).toContain('skipped 1 offline participant with manifest facts: ana+two; include with people: ["ana+two"] or includeOffline: true')
  expect(result).not.toContain('final combined tree:')
  expect(session.lastPreview).toEqual({ clean: false, complete: false, testsPassed: false })
  expect(await handlers(state).room_preview_merge({ person: sibling })).toContain('step 1: merge ana+two')
})

it('distinguishes offline peers from an empty room', async () => {
  const { state, session, room, disconnect, lead, sibling } = workerFixture(false)
  disconnect(lead); disconnect(sibling)
  const offline = await handlers(state).room_preview_merge({})
  expect(offline).toContain('no other participants are present in the room')
  expect(offline).toContain('skipped 2 offline participants with manifest facts: ana, ana+two')
  expect(offline).not.toContain('nobody else is in the room')
  room.participants.clear(); room.workerViews.clear(); room.manifestHead.clear(); room.manifest.clear(); room.overlays.clear()
  expect(await handlers(state).room_preview_merge({})).toBe('nobody else is in the room')
  expect(session.lastPreview).toEqual({ clean: false, complete: false, testsPassed: false })
})

it('includes the caller\'s own running worker even without overlapping paths', async () => {
  const { state, session, sibling, caller } = workerFixture(false)
  const directory = root!
  cleanups.push(() => closeRegistryForDir(directory))
  const instance = (await registryForDir(directory)).instance
  const { registry } = await seedRegistryWorker(directory, 'two', { name: sibling, room: session.roomName,
    lead: { participant: caller, room: session.roomName, instance }, base: state.baseFor(session, caller) })
  expect(registry.list()).toHaveLength(1)
  expect(state.myWorkers(session).map(w => w.name)).toEqual([sibling])
  const result = await handlers(state).room_preview_merge({})
  expect(result).toContain('step 1: merge ana+two')
  expect(result).toContain('skipped 1 present participant without overlapping paths: ana; include with people: ["ana"]')
})

it('distinguishes an unknown overlap from a confirmed lack of overlap', async () => {
  const { state, session, sibling } = workerFixture(false)
  const baseFor = state.baseFor
  state.baseFor = (s, person) => person === sibling ? 'missing-commit' : baseFor(s, person)
  const result = await handlers(state).room_preview_merge({})
  expect(result).toContain('no participants selected by default; overlap could not be fully determined')
  expect(result).toContain('select peers with people: ["ana+two"]')
  expect(result).toContain('skipped 1 present participant without overlapping paths: ana')
  expect(result).not.toContain('without overlapping paths: ana, ana+two')
  expect(result).toContain('PARTIAL preview: skipped ana+two: committed changes unavailable')
  expect(session.lastPreview).toEqual({ clean: false, complete: false, testsPassed: false })
})

it('an explicit empty selection does not suggest that connected peers are absent or run tests', async () => {
  const { state, session } = workerFixture(false)
  const marker = path.join(root!, 'check-ran')
  const result = await handlers(state).room_preview_merge({ people: [], run: `touch '${marker}'` })
  expect(result).toBe('no other participants selected; you are always included')
  expect(fs.existsSync(marker)).toBe(false)
  expect(session.lastPreview).toEqual({ clean: false, complete: false, testsPassed: false })
})

it('drops the caller display name and resolves a peer display name before building', async () => {
  const { session, state, add } = fixture()
  add('ben', 'shared', 'ben changed\n')
  const result = await handlers(state).room_preview_merge({ people: ['ANA’S AGENT', 'BEN’S AGENT'], run: 'test "$(cat app.py)" = "ben changed" && echo "1 passed"' })
  expect(result).toContain('you are always included; dropped ANA’S AGENT')
  expect(result).toContain('final combined tree: 1 path(s) applied')
  expect(result).not.toContain('ana\'s agent: no manifest record')
  expect(session.lastPreview).toMatchObject({ complete: true, testsPassed: true })
})

it('refuses an unknown explicit name before running a check', async () => {
  const { room, session, state, add } = fixture()
  add('ben', 'shared', 'ben changed\n')
  const marker = path.join(root!, 'check-ran')
  const result = await handlers(state).room_preview_merge({ people: ['ben', 'ghost'], run: `touch '${marker}'; echo '1 passed'` })
  expect(result).toContain('error: nobody called ghost is or was in this room; known names:')
  expect(fs.existsSync(marker)).toBe(false)
  expect(session.lastPreview?.testsPassed).not.toBe(true)
  expect(room.messages().some(m => m.type === 'note' && m.text.includes('merge preview'))).toBe(false)
})

it('clears a previous passing preview when a later name is refused or only names the caller', async () => {
  const { session, state, add } = fixture()
  add('ben', 'shared', 'ben changed\n')
  const preview = handlers(state).room_preview_merge
  const passed = await preview({ person: 'ben', run: 'test "$(cat app.py)" = "ben changed" && echo "1 passed"' })
  expect(passed).toContain('tests: PASSED')
  expect(session.lastPreview?.testsPassed).toBe(true)

  const refused = await preview({ people: ['ben', 'ghost'], run: 'echo "1 passed"' })
  expect(refused).toContain('error: nobody called ghost')
  expect(session.lastPreview).toMatchObject({ clean: false, complete: false, testsPassed: false })

  await preview({ person: 'ben', run: 'echo "1 passed"' })
  expect(session.lastPreview?.testsPassed).toBe(true)
  const ownOnly = await preview({ people: ['ana'] })
  expect(ownOnly).toContain('no other participants selected; you are always included')
  expect(session.lastPreview).toMatchObject({ clean: false, complete: false, testsPassed: false })
})

it('refuses an ambiguous display name and lists the candidates', async () => {
  const { room, state, add } = fixture()
  add('Ben', 'shared', 'upper\n')
  add('ben', 'shared', 'lower\n')
  room.setScope('Ben', { area: 'test', summary: 'upper', paths: ['app.py'], byKind: 'agent' })
  room.setScope('ben', { area: 'test', summary: 'lower', paths: ['app.py'], byKind: 'agent' })
  const result = await handlers(state).room_preview_merge({ person: 'BEN’S AGENT', run: 'echo "1 passed"' })
  expect(result).toContain('error: BEN’S AGENT is ambiguous; use a full name: Ben, ben')
  expect(result).not.toContain('final combined tree')
})

it('keeps another participant version when one version is held', async () => {
  const { session, state, add } = fixture()
  add('ben', 'held')
  add('chris', 'shared', 'chris changed\n')
  const result = await handlers(state).room_preview_merge({ people: ['ben', 'chris'], run: 'test "$(cat app.py)" = "chris changed" && echo "1 passed"' })
  expect(result).toContain('final combined tree: 1 path(s) applied')
  expect(result).toContain("app.py: ben's version not included")
  expect(result).toContain('passed on a PARTIAL tree')
  expect(session.lastPreview).toMatchObject({ complete: false, testsPassed: false, partialPassed: true })
})

it('keeps a shared version when another participant excluded the path', async () => {
  const { room, session, state, add } = fixture()
  add('ben', 'held')
  add('chris', 'shared', 'chris changed\n')
  room.manifest.get(manifestKey('ben', '1'))?.delete('app.py')
  room.manifestHead.set('ben', { ...room.manifestHead.get('ben')!, excluded: [digestPath(room.ensureRoomSalt(), 'app.py')], semRev: 2 })
  const result = await handlers(state).room_preview_merge({ people: ['ben', 'chris'], run: 'test "$(cat app.py)" = "chris changed" && echo "1 passed"' })
  expect(result).toContain('final combined tree: 1 path(s) applied')
  expect(result).toContain("app.py: ben's version not included")
  expect(result).toContain('passed on a PARTIAL tree')
  expect(session.lastPreview).toMatchObject({ complete: false, testsPassed: false, partialPassed: true })
})

it('does not endorse a passing check on the caller tree when no peer path was applied', async () => {
  const { room, session, state, add } = fixture()
  add('ben', 'held')
  const result = await handlers(state).room_preview_merge({ person: 'ben', run: 'echo "1 passed"' })
  expect(result).toContain('no changes from ben to apply; ran the check on your own tree only')
  expect(result).not.toContain('merge preview with ben:')
  expect(session.lastPreview).toMatchObject({ testsPassed: false })
  expect(room.messages().some(m => m.type === 'note' && m.text.startsWith('merge preview with ben'))).toBe(false)
})

it('keeps a newer refusal after an older preview succeeds', async () => {
  const { session, state, add } = fixture()
  add('ben', 'shared', 'ben changed\n')
  const marker = path.join(root!, 'entered'), release = path.join(root!, 'release')
  const preview = handlers(state).room_preview_merge
  const older = preview({ person: 'ben', run: `touch '${marker}'; while ! test -e '${release}'; do sleep 0.05; done; echo "1 passed"` })
  try {
    for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(fs.existsSync(marker)).toBe(true)
    expect(await preview({ people: ['ghost'] })).toContain('error: nobody called ghost')
  } finally { fs.writeFileSync(release, 'go') }
  expect(await older).toContain('tests: PASSED')
  expect(session.lastPreview).toMatchObject({ clean: false, complete: false, testsPassed: false })
}, 30_000)

it('keeps a newer success after an older preview fails late', async () => {
  const { session, state, add } = fixture()
  add('ben', 'shared', 'ben changed\n')
  const marker = path.join(root!, 'entered'), release = path.join(root!, 'release')
  const preview = handlers(state).room_preview_merge
  const older = preview({ person: 'ben', run: `touch '${marker}'; while ! test -e '${release}'; do sleep 0.05; done; echo "1 failed"; exit 1` })
  try {
    for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(fs.existsSync(marker)).toBe(true)
    const newer = await preview({ person: 'ben', run: 'echo "1 passed"' })
    expect(newer).toContain('tests: PASSED')
  } finally { fs.writeFileSync(release, 'go') }
  expect(await older).toContain('tests: FAILED')
  expect(session.lastPreview).toMatchObject({ complete: true, testsPassed: true, testsCommand: 'echo "1 passed"' })
}, 30_000)
