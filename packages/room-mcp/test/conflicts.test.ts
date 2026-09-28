import { publishFixture, setFixtureLocalRoot } from './fixtures/manifest.js'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, manifestPaths, shouldWakeOnMsg } from '@room/shared'
import type { Identity } from '@room/shared'
import { createTools, type Tools } from '../src/tools.js'
import { changedRanges } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import { hubAppend } from '@room/shared/testing'
import { hubSeam } from './fixtures/hub.js'
import { testPolicyStore } from './policy-fixture.js'

const COMMITTED = 'def validate(x):\n    return x\n\ndef b():\n    return 2\n'
const me: Identity = { name: 'Rohan', kind: 'agent' }
let dir: string, base: string
const activeTools = new Set<Tools>()

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
function fakeSession(room: RoomDoc, extra: Partial<Session> = {}): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { name: 'Rohan', kind: 'agent', color: '#000' }, status: 'idle' })
  return {
    policyStore: testPolicyStore(),
    room, awareness, me, dir, roomUrl: 'ws://x/github.com%2Fo%2Fr%2Fmain', roomName: 'github.com/o/r/main', browserUrl: 'http://x',
    ...hubSeam(room), provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: 'Rohan', roomDoc: room, provider: null as never, branch: 'main', base },
    ...extra,
  }
}
function addPresence(target: Awareness, name: string): Awareness {
  const doc = new Y.Doc(), peer = new Awareness(doc)
  peer.setLocalState({ user: { name, kind: 'agent', color: '#000' }, status: 'idle' })
  applyAwarenessUpdate(target, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
  return peer
}
function setup(opts: { now?: () => number; joined?: boolean; session?: Partial<Session> } = {}) {
  const { a, b } = pair()
  a.setMeta({ repo: 'r', branch: 'main', base })
  setFixtureLocalRoot(a, 'Rohan', dir)
  let session: Session | null = opts.joined === false ? null : fakeSession(a, opts.session)
  const closed: string[] = []
  const tools = createTools({
    getSession: () => session, setSession: s => { session = s }, cwd: dir, now: opts.now, conflictDebounceMs: 5,
    join: async () => fakeSession(a), leave: async () => {}, close: async s => { closed.push(s.roomName); return ['github.com/o/r/main', 'github.com/o/r/dev'] },
    log: () => {},
  })
  activeTools.add(tools)
  if (session) tools.attachHooks(session)
  return { room: a, other: b, tools, closed, get session() { return session } }
}
const kieran: Identity = { name: 'Kieran', kind: 'agent' }

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-conf-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(dir, 'app.py'), COMMITTED)
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})
afterAll(async () => {
  for (const tools of activeTools) await tools.shutdown()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => { writeFileSync(join(dir, 'app.py'), COMMITTED) })

describe('changedRanges', () => {
  it('reports live line ranges that differ from the base', () => {
    expect(changedRanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ from: 2, to: 2 }])
    expect(changedRanges('a\nb\nc\n', 'a\nb\nc\nd\ne\n')).toEqual([{ from: 4, to: 5 }])
    expect(changedRanges('a\nb\n', 'a\nb\n')).toEqual([])
  })
})

describe('room lifecycle', () => {
  it('shows another session in this checkout once without attributing its file changes to a peer', async () => {
    const room = new RoomDoc()
    room.setMeta({ repo: 'r', branch: 'main', base })
    const joined = fakeSession(room)
    joined.awareness.setLocalStateField('publishUnder', 'Kieran')
    joined.awareness.setLocalStateField('watchedDirectory', dir)
    const peer = addPresence(joined.awareness, 'Kieran')
    peer.setLocalStateField('watchedDirectory', dir)
    applyAwarenessUpdate(joined.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    let current: Session | null = null
    const tools = createTools({ getSession: () => current, setSession: s => { current = s }, cwd: dir, join: async () => joined, log: () => {} })
    activeTools.add(tools)
    const reply = await tools.call('room_join', {})
    expect(reply.match(/another session in this checkout/g)).toHaveLength(1)
    expect(reply).not.toContain('Your file changes are published under')
    peer.destroy()
  })

  it('shows a live same-checkout session’s explicit declarations on join even without company', async () => {
    const room = new RoomDoc()
    room.setMeta({ repo: 'r', branch: 'main', base })
    const joined = fakeSession(room)
    joined.awareness.setLocalStateField('watchedDirectory', dir)
    const peer = addPresence(joined.awareness, 'Kieran')
    peer.setLocalStateField('watchedDirectory', dir)
    applyAwarenessUpdate(joined.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    room.setScope({ by: 'Kieran', byKind: 'agent', area: 'api', summary: 'editing app', paths: ['app.py'] })
    room.addClaim({ by: 'Kieran', byKind: 'agent', path: 'app.py', from: 1, to: 1, intent: 'change parser' })
    let current: Session | null = null
    const tools = createTools({ getSession: () => current, setSession: s => { current = s }, cwd: dir, join: async () => joined, log: () => {} })
    activeTools.add(tools)
    const reply = await tools.call('room_join', {})
    expect(reply).toContain('alone here')
    expect(reply).toContain("scope: Kieran's agent")
    expect(reply).toContain('claim')
    expect(reply).toContain('change parser')
    peer.destroy()
  })

  it('room_close needs confirm=true, then closes for everyone and leaves', async () => {
    const clock = Date.UTC(2026, 8, 15, 8, 30)
    const t = setup({ now: () => clock })
    hubAppend(t.other, kieran, { type: 'note', text: 'done (api): shipped', priority: 'fyi' })
    expect(await t.tools.call('room_close', {})).toContain('confirm=true')
    expect(t.closed).toEqual([])
    const out = await t.tools.call('room_close', { confirm: true })
    expect(t.closed).toEqual(['github.com/o/r/main'])
    expect(out).toContain('closed github.com/o/r for everyone: removed github.com/o/r/main, github.com/o/r/dev')
    const ledger = join(dir, '.room', 'ledger', 'github.com_o_r_main-2026-09-15T08-30-00-000Z.md')
    expect(out).toContain(ledger)
    expect(existsSync(ledger)).toBe(true)
    expect(readFileSync(ledger, 'utf8')).toContain('done (api): shipped')
    expect(t.session).toBeNull()
    expect(t.room.messages().some(m => m.type === 'note' && m.priority === 'interrupt' && m.text.includes('closing the room'))).toBe(true)
  })

  it('room_export writes the current ledger to a requested path and reports its line count', async () => {
    const t = setup({ now: () => Date.UTC(2026, 8, 15, 9) })
    hubAppend(t.other, kieran, { type: 'note', text: 'done (tests): 12 pass', priority: 'fyi' })
    const out = await t.tools.call('room_export', { path: '.room/custom-story.md' })
    const ledger = join(dir, '.room', 'custom-story.md')
    expect(out).toBe(`exported room ledger to ${ledger} (4 lines)`)
    expect(readFileSync(ledger, 'utf8')).toContain('done (tests): 12 pass')
    expect(t.session).not.toBeNull()
  })

  it('a session whose room the server closed refuses tools until leave + create', async () => {
    let clock = 1000
    const t = setup({ session: { provider: { synced: true, wsconnected: true } as Session['provider'] }, now: () => clock })
    t.session!.closed = { reason: 'room closed' }
    await t.tools.call('room_state', {})
    clock += 2001
    const state = await t.tools.call('room_state', {})
    expect(state).toContain('OFFLINE: not connected to ')
    expect(state).toContain('showing the last known state')
    expect(await t.tools.call('room_leave', {})).toContain('left')
  })

  it('join preserves stale manifests so absent participants remain visible', async () => {
    const DAY = 86_400_000
    let clock = 1_000_000_000_000
    const t = setup({ joined: false, now: () => clock })
    publishFixture(t.other, 'Kieran', 'app.py', 'old\n')
    publishFixture(t.other, 'Hrishi', 'app.py', 'recent\n')
    for (const [person, age] of [['Kieran', 9], ['Hrishi', 2]] as const) {
      const head = t.other.manifestHead.get(person)!
      t.other.manifestHead.set(person, { ...head, scannedAt: clock - age * DAY })
    }
    await t.tools.call('room_join', {})
    expect(manifestPaths(t.room, 'Kieran')).toEqual(['app.py'])
    expect(manifestPaths(t.room, 'Hrishi')).toEqual(['app.py'])
    const note = t.room.messages().find(m => m.type === 'note' && m.text.includes('evicted'))
    expect(note).toBeUndefined()
  })
})
