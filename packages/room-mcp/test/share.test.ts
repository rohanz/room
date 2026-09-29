import { clearFixture, publishFixture } from './fixtures/manifest.js'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, manifestPaths } from '@room/shared'
import type { Identity } from '@room/shared'
import type { ShareLevel } from '@room/roomd'
import { createTools } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { GraphIndex } from '../src/graph-index.js'
import { testPolicyStore } from './policy-fixture.js'
import { hubSeam } from './fixtures/hub.js'

const COMMITTED = 'def validate(x):\n    return x\n\ndef b():\n    return 2\n'
const MINE = COMMITTED.replace('return 2', 'return 22')
const me: Identity = { name: 'Rohan', kind: 'agent' }
let dir: string
let base: string

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}

/** A daemon stand-in whose policy callback mimics synchronous withdrawal. */
function fakeDaemon(room: RoomDoc, share: ShareLevel) {
  const d = {
    share, touch() {}, async stop() {}, dir, name: 'Rohan', roomDoc: room, provider: null as never, branch: 'main', base,
    skipped: () => ({ size: [], budget: [], ignore: [] }),
    applyInputs({ policy }: { policy: { level: ShareLevel } }) {
      const level = policy.level
      d.share = level
      if (level === 'intent') clearFixture(room, 'Rohan', 'app.py')
      else publishFixture(room, 'Rohan', 'app.py', MINE, { level })
    },
  }
  return d
}

function setup(opts: { share?: ShareLevel; shareMax?: ShareLevel; requested?: ShareLevel } = {}) {
  const { a, b } = pair()
  a.setMeta({ repo: 'demo', branch: 'main', base })
  publishFixture(a, 'Rohan', 'app.py', MINE, { level: opts.share ?? 'full' })
  const awareness = new Awareness(a.doc)
  awareness.setLocalState({ user: { name: 'Rohan', kind: 'agent', color: '#000' }, status: 'idle', share: opts.share ?? 'full' })
  const daemon = fakeDaemon(a, opts.share ?? 'full')
  const policyStore = testPolicyStore(opts.requested ?? opts.share ?? 'full', policy => daemon.applyInputs({ policy }))
  policyStore.setCeiling(opts.shareMax ?? 'full')
  const graph = new GraphIndex(a, 'Rohan', dir); graph.start()
  const session: Session = {
    policyStore,
    graph, room: a, awareness, me, dir, roomUrl: 'ws://x/r', roomName: 'r', browserUrl: 'http://x',
    ...hubSeam(a), provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: daemon as unknown as Session['daemon'],
    shareMax: opts.shareMax ?? 'full',
    local: { url: 'ws://x' } as Session['local'],
    shareRequested: opts.requested ?? opts.share ?? 'full',
  }
  const tools = createTools({ getSession: () => session, setSession: () => {}, cwd: dir })
  /** Kieran's presence (with a share level) as the server would relay it. */
  const kieran = (share: ShareLevel | undefined, scopePaths?: string[]) => {
    const aw = new Awareness(b.doc)
    aw.setLocalState({ user: { name: 'Kieran', kind: 'agent', color: '#111' }, status: 'idle', lastActive: Date.now(), ...(share ? { share } : {}) })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(aw, [b.doc.clientID]), 'test')
    if (scopePaths) b.setScope({ by: 'Kieran', byKind: 'agent', area: 'k', summary: 's', paths: scopePaths })
    if (share === 'intent') {
      publishFixture(b, 'Kieran', 'session.py', 'temporary\n', { level: 'intent' })
      clearFixture(b, 'Kieran', 'session.py')
      const head = b.manifestHead.get('Kieran')!
      b.manifestHead.set('Kieran', { ...head, coverage: { kind: 'none', reason: 'intent' } })
    }
  }
  const body = (out: string) => out.includes('\n\n') && out.startsWith('[inbox') ? out.slice(out.indexOf('\n\n') + 2) : out
  return { room: a, other: b, tools, session, daemon, kieran, body }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-share-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(dir, 'app.py'), COMMITTED)
  writeFileSync(join(dir, 'session.py'), 'from app import validate\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('room_share', () => {
  it('reports the current level without arguments', async () => {
    const t = setup()
    expect(t.body(await t.tools.call('room_share', {}))).toBe('sharing: the full text of files you change')
  })

  it('changes the level live through policy inputs and posts a note', async () => {
    const t = setup()
    t.room.setScope({ by: 'Rohan', byKind: 'agent', area: 'api', summary: 's', paths: ['app.py'] })
    const out = t.body(await t.tools.call('room_share', { level: 'intent' }))
    expect(out).toContain('changed sharing full -> sharing: only your plans, no file text')
    expect(manifestPaths(t.room, 'Rohan')).toEqual([])
    expect(t.room.lastMessages(1)[0]).toMatchObject({ type: 'note', text: 'now sharing only your plans, no file text' })
    expect(t.body(await t.tools.call('room_share', { level: 'full' }))).toBe('changed sharing intent -> sharing: the full text of files you change')
    expect(manifestPaths(t.room, 'Rohan')).toEqual(['app.py'])
  })

  it('stores an explicit narrower level in the policy store', async () => {
    const t = setup()
    await t.tools.call('room_share', { level: 'intent' })
    expect(t.session.policyStore.requested).toBe('intent')
  })

  it('narrows unknown levels and warns when declared has no scope yet', async () => {
    const t = setup()
    expect(t.body(await t.tools.call('room_share', { level: 'everything' }))).toContain("level='everything' is not a level; sharing plans only")
    expect(t.daemon.share).toBe('intent')
    expect(manifestPaths(t.room, 'Rohan')).toEqual([])
    expect(t.body(await t.tools.call('room_share', { level: 'declared' }))).toContain('no scope declared yet')
  })

  it('clamps to the server ceiling and says so', async () => {
    const t = setup({ share: 'declared', shareMax: 'declared', requested: 'full' })
    expect(t.body(await t.tools.call('room_share', {}))).toBe('sharing: files in your declared area and changed files declared earlier (asked for full; the server caps sharing at declared, ROOM_SHARE_MAX)')
    const out = t.body(await t.tools.call('room_share', { level: 'full' }))
    expect(out).toContain('sharing level unchanged: sharing: files in your declared area and changed files declared earlier (asked for full; the server caps sharing at declared, ROOM_SHARE_MAX)')
    expect(t.session.policyStore.requested).toBe('full')
    expect(t.body(await t.tools.call('room_share', { level: 'intent' }))).toContain('changed sharing declared -> sharing: only your plans, no file text')
  })
})

describe('reading someone who shares less than full', () => {
  it('intent: room_read, room_diff and room_preview_merge return one clear line', async () => {
    const t = setup()
    t.kieran('intent')
    expect(t.body(await t.tools.call('room_read', { path: 'app.py', person: 'Kieran' }))).toContain('intent')
    expect(t.body(await t.tools.call('room_read', { diff: true, person: 'Kieran' }))).toContain('intent')
    expect(t.body(await t.tools.call('room_read', { diff: true, path: 'app.py', person: 'Kieran' }))).toContain('intent')
    expect(t.body(await t.tools.call('room_preview_merge', { person: 'Kieran' }))).toContain('PARTIAL')
  })

  it('declared: an unchanged path resolves to base and a shared path reads normally', async () => {
    const t = setup()
    t.kieran('declared', ['session.py'])
    publishFixture(t.other, 'Kieran', 'session.py', 'from app import validate\n# k\n', { level: 'declared' })
    expect(t.body(await t.tools.call('room_read', { path: 'app.py', person: 'Kieran' }))).toContain('unchanged on their base')
    expect(t.body(await t.tools.call('room_read', { diff: true, path: 'app.py', person: 'Kieran' }))).toContain('no difference')
    expect(t.body(await t.tools.call('room_read', { path: 'session.py', person: 'Kieran' }))).toContain('2| # k')
    const all = t.body(await t.tools.call('room_read', { diff: true,  person: 'Kieran' }))
    expect(all).toContain('+# k')
    expect(all).toContain('Kieran coverage: all')
    expect(t.body(await t.tools.call('room_preview_merge', { person: 'Kieran' }))).toContain('only Kieran changed this file since its start')
  })

  it('full or an older client without the field reads as before', async () => {
    const t = setup()
    t.kieran(undefined)
    publishFixture(t.other, 'Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
    expect(t.body(await t.tools.call('room_read', { path: 'app.py', person: 'Kieran' }))).toContain('return x + 1')
  })

  it('room_state shows each person\'s level', async () => {
    const t = setup({ share: 'declared' })
    t.kieran('intent')
    const state = t.body(await t.tools.call('room_state', { all: true })) // all: for the area-filtered room_state; ignored otherwise
    expect(state).toMatch(/Kieran.*shares intent \(no file text\)/)
    expect(state).toMatch(/Rohan.*\(you\).*shares declared \(file text only in their declared area\)/)
  })
})
