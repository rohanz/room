import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity, NoteMsg } from '@room/shared'
import { createTools, DEFS, linkSharedDirs } from '../src/tools.js'
import { NoRoom, type Session } from '../src/session.js'
import { resolveConfig, type ResolvedConfig } from '../src/config.js'
import { GraphIndex } from '../src/graph-index.js'
import { sendChannelNotification } from '../src/channel.js'
import { SocketWakeRouter } from '../src/wake-path.js'
import { shouldWake } from '../src/wake.js'

const COMMITTED = 'def validate(x):\n    return x\n\ndef b():\n    return 2\n'
const MINE = 'def validate(x):\n    return x\n\ndef b():\n    return 22\n'
const me: Identity = { name: 'Rohan', kind: 'agent' }
let dir: string
let base: string

/** Two docs synced by update exchange: Rohan's session doc and Kieran's view. */
function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}

function fakeSession(room: RoomDoc, synced = true, wsconnected?: boolean): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { name: 'Rohan', kind: 'agent', color: '#000' }, status: 'idle' })
  const graph = new GraphIndex(room, 'Rohan', dir); graph.start()
  return {
    graph,
    room, awareness, me, dir, roomUrl: 'ws://x/r', roomName: 'r', browserUrl: 'http://x',
    provider: { synced, awareness, ...(wsconnected === undefined ? {} : { wsconnected }) } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: 'Rohan', roomDoc: room, provider: null as never, branch: 'main', base },
  }
}

function setup(opts: { synced?: boolean; joined?: boolean; config?: ResolvedConfig } = {}) {
  const { a, b } = pair()
  a.setMeta({ repo: 'demo', branch: 'main', base })
  a.setOverlay('Rohan', 'app.py', MINE)
  let session: Session | null = opts.joined === false ? null : fakeSession(a, opts.synced)
  const joined: string[] = []
  const created: boolean[] = []
  const tools = createTools({
    config: opts.config, getSession: () => session, setSession: s => { session = s }, cwd: dir,
    join: async o => { joined.push(o.dir); created.push(!!o.create); return fakeSession(a) },
    leave: async () => {},
  })
  return { room: a, other: b, tools, joined, created, get session() { return session } }
}

function addPresence(target: Awareness, name: string): Awareness {
  const doc = new Y.Doc()
  const peer = new Awareness(doc)
  peer.setLocalState({ user: { name, kind: 'agent', color: '#000' }, status: 'idle' })
  applyAwarenessUpdate(target, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
  return peer
}

it.each(['room_wait', 'room_state'])('a successful Claude push leaves the message for %s delivery', async tool => {
  const t = setup()
  const s = t.session!
  const peer = addPresence(s.awareness, 'Kieran')
  try {
    const msg = t.other.post<NoteMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'note', to: me.name, priority: 'interrupt', text: 'channel delivery regression' })
    const notify = vi.fn(async () => {})
    await sendChannelNotification(shouldWake(me, { kind: 'msg', msg }, [], false)!, notify)
    expect(notify).toHaveBeenCalledOnce()
    expect(s.room.seen(me.name).has(msg.id)).toBe(false)
    const result = await t.tools.call(tool, { timeoutMs: 1 })
    expect(result).toContain('channel delivery regression')
    if (tool === 'room_state') expect(result).toContain('[inbox')
    expect(s.room.seen(me.name).has(msg.id)).toBe(true)
  } finally {
    peer.destroy(); peer.doc.destroy()
    await t.tools.shutdown()
    s.graph?.stop(); s.awareness.destroy(); t.room.doc.destroy(); t.other.doc.destroy()
  }
})

it('a socket wake leaves the message unread until a Room tool delivers it', async () => {
  const t = setup()
  const s = t.session!
  const peer = addPresence(s.awareness, 'Kieran')
  const post = vi.fn(async () => {})
  const router = new SocketWakeRouter({ host: 'claude', env: { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/test.sock', CLAUDE_CODE_MESSAGING_TOKEN: 't' }, parentArgs: 'claude', notify: vi.fn(async () => {}), post, windowMs: 1 })
  try {
    const msg = t.other.post<NoteMsg>({ name: 'Kieran', kind: 'agent' }, { type: 'note', to: me.name, priority: 'interrupt', text: 'socket delivery regression' })
    router.push(shouldWake(me, { kind: 'msg', msg }, [], false))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(post).toHaveBeenCalledOnce()
    expect(s.room.seen(me.name).has(msg.id)).toBe(false)
    expect(await t.tools.call('room_state', {})).toContain('socket delivery regression')
    expect(s.room.seen(me.name).has(msg.id)).toBe(true)
  } finally {
    router.close(); peer.destroy(); peer.doc.destroy()
    await t.tools.shutdown()
    s.graph?.stop(); s.awareness.destroy(); t.room.doc.destroy(); t.other.doc.destroy()
  }
})

it('room_send warns only when the recipient presence says wake is unavailable', async () => {
  const t = setup()
  const s = t.session!
  const peer = addPresence(s.awareness, 'Kieran')
  try {
    peer.setLocalStateField('wakeUnavailable', false)
    applyAwarenessUpdate(s.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    expect(await t.tools.call('room_send', { type: 'question', to: 'Kieran', text: 'first' })).not.toContain('cannot be woken')
    peer.setLocalStateField('wakeUnavailable', true)
    applyAwarenessUpdate(s.awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'test')
    expect(await t.tools.call('room_send', { type: 'question', to: 'Kieran', text: 'second' })).toContain('cannot be woken in this session')
  } finally {
    peer.destroy(); peer.doc.destroy()
    await t.tools.shutdown()
    s.graph?.stop(); s.awareness.destroy(); t.room.doc.destroy(); t.other.doc.destroy()
  }
})

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-mcp-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(dir, 'app.py'), COMMITTED)
  writeFileSync(join(dir, 'session.py'), 'from app import validate\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('session gating', () => {
  it('summarizes six or more changed paths but preserves short lists and path lookup', async () => {
    const t = setup()
    for (let i = 0; i < 6; i++) t.room.setOverlay('Kieran', `art/main-street/scene-${i}.md`, 'changed')
    t.room.setOverlay('Kieran', 'README.md', 'changed')
    try {
      const compact = await t.tools.call('room_state', { all: true })
      expect(compact).toContain('  - Kieran: 7 files, mostly art/main-street/ (6): README.md, scene-0.md, scene-1.md ...')
      expect(await t.tools.call('room_state', { path: 'README.md' })).toContain('uncommitted changes by: Kieran')
      for (let i = 1; i < 6; i++) t.room.clearOverlay('Kieran', `art/main-street/scene-${i}.md`)
      const short = await t.tools.call('room_state', { all: true })
      expect(short).toContain('  - Kieran: README.md, art/main-street/scene-0.md')
      expect(short).not.toContain('Kieran: 2 files')
    } finally { await t.tools.shutdown(); t.session?.awareness.destroy() }
  })
  it('touches before dispatch, including failed calls, and reports recent actions', async () => {
    const t = setup()
    const touch = vi.spyOn(t.session!.daemon, 'touch')
    try {
      const call = t.tools.call('room_scope', {})
      expect(touch).toHaveBeenCalledTimes(1)
      expect(await call).toContain('error:')
      t.session!.awareness.setLocalState({ user: me, status: 'idle', lastActive: Date.now() - 240_000 })
      const out = await t.tools.call('room_state', {})
      expect(out).toContain('last action 4m ago')
      expect(out).not.toContain('idle')
      expect(touch).toHaveBeenCalledTimes(2)
    } finally { await t.tools.shutdown(); t.session?.awareness.destroy() }
  })

  it('keeps worker history compact until all=true and excludes retired participants', async () => {
    const t = setup()
    t.room.clearOverlays('Rohan') // No scope or edits: default area view expands, history still stays compact.
    const worker = { name: 'Rohan+failed', tag: 'failed', lead: 'Rohan', host: 'codex' as const, task: 'failed task', dir, branch: 'main', pid: 0, startedAt: 1, status: 'failed' as const }
    t.room.setWorker(worker)
    t.room.setWorker({ ...worker, name: 'Rohan+old', tag: 'old', status: 'done' })
    t.room.retireParticipant('Rohan+old', { name: 'Rohan+old', tag: 'old', lead: 'Rohan', host: 'codex', model: 'actual-model', task: 'old task', summary: 'archived summary', files: ['app.py'], fileCount: 60, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'merged' })
    t.room.setOverlay('Teammate', 'app.py', 'offline work')
    const peer = addPresence(t.session!.awareness, 'Rohan+old')
    try {
      const compact = await t.tools.call('room_state', {})
      expect(compact).toContain('participants (2 active, 1 offline teammate):')
      expect(compact).toContain('failed (codex, failed')
      expect(compact).toContain('finished: 1 (all=true lists them)')
      expect(compact).not.toContain('Rohan+old ·')
      expect(compact).not.toContain('archived summary')
      const expanded = await t.tools.call('room_state', { all: true })
      expect(expanded).toContain('old (merged, actual-model): archived summary · 60 files')
      expect(expanded).not.toContain('Rohan+old ·')
    } finally { peer.destroy(); await t.tools.shutdown(); t.session?.awareness.destroy() }
  })

  it('renders stale claims using the resolved staleDays argument', async () => {
    const config = await resolveConfig({ dir, env: { ROOM_STALE_DAYS: '7' }, args: { staleDays: 1 } })
    const t = setup({ config })
    const c = t.other.addClaim({ by: 'Kieran', byKind: 'agent', path: 'app.py', from: 1, to: 2, intent: 'old work' })
    t.other.claims.set(c.id, { ...c, at: Date.now() - 2 * 86400000 })
    expect(await t.tools.call('room_state', {})).toContain('stale')
  })
  it('refuses tools before join and gates until synced', async () => {
    const t = setup({ joined: false })
    expect(await t.tools.call('room_state', {})).toBe('error: not in a room. room_join if a teammate has opened this repo, room_create otherwise.')
    const u = setup({ synced: false })
    expect(await u.tools.call('room_state', {})).toBe('error: room not synced yet, retry')
  })

  it('shows last-known state and reports queued sends and unavailable waits while offline', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'demo', branch: 'main', base })
    const session = fakeSession(a, true, true)
    let clock = 1000
    const tools = createTools({ getSession: () => session, setSession: () => {}, cwd: dir, now: () => clock })
    session.provider.wsconnected = false
    expect(await tools.call('room_state', {})).not.toContain('OFFLINE')
    clock += 2001
    expect(await tools.call('room_state', {})).toMatch(/OFFLINE: not connected to ws:\/\/x since .*; showing the last known state in r\nroom:/)
    expect(await tools.call('room_send', { type: 'note', text: 'queued' })).toContain('offline: queued/not delivered')
    expect(await tools.call('room_wait', { timeoutMs: 100 })).toContain('offline: queued/not delivered')
  })

  it('join uses cwd, reports who is here, and leave releases claims', async () => {
    const t = setup({ joined: false })
    const out = await t.tools.call('room_join', {})
    expect(t.joined).toEqual([dir])
    expect(out).toContain("joined r as Rohan's agent")
    expect(out).not.toContain('browser view:')
    expect(await t.tools.call('room_state', { link: true })).toContain('browser view: http://x')
    expect(await t.tools.call('room_join', {})).not.toContain('browser view:')
    expect(out).toContain('alone here; the room stays quiet until someone joins')
    expect(out).not.toContain('next: room_scope')
    expect(await t.tools.call('room_join', {})).toContain('room: r —')
    t.other.setScope({ by: 'Nearby', byKind: 'agent', area: 'near', summary: 'nearby work', paths: ['app.py', 'src/'] })
    await t.tools.call('room_claim', { path: 'app.py', from: 1, to: 2, intent: 'x' })
    expect(await t.tools.call('room_leave', {})).toBe('left r; released 1 claim(s)')
    expect(t.room.openClaims()).toEqual([])
    expect(t.session).toBeNull()
  })

  it('joins and rejoins with company retain the browser link', async () => {
    const t = setup()
    const peer = addPresence(t.session!.awareness, 'Kieran')
    try {
      expect(await t.tools.call('room_join', {})).toContain('browser view: http://x')
      const session = t.session!
      const fresh = createTools({ getSession: () => null, setSession: () => {}, cwd: dir, join: async () => session, leave: async () => {} })
      expect(await fresh.call('room_join', {})).toContain('browser view: http://x')
      await fresh.shutdown()
    } finally { peer.destroy(); await t.tools.shutdown() }
  })

  it('room_create opens the repo then joins; room_join never opens', async () => {
    const t = setup({ joined: false })
    expect(await t.tools.call('room_create', {})).toContain("opened and joined r as Rohan's agent")
    expect(t.created).toEqual([true])
    await t.tools.call('room_leave', {})
    await t.tools.call('room_join', {})
    expect(t.created).toEqual([true, false])
  })

  it('keeps the join reply quiet when only a foreign overlay is present', async () => {
    const t = setup({ joined: false })
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
    const out = await t.tools.call('room_join', {})
    expect(out).toContain('alone here; the room stays quiet until someone joins')
    expect(out).not.toContain('next: room_scope')
  })

  it('a fresh join clears stale claims and scope left under my name; shutdown leaves cleanly', async () => {
    const t = setup({ joined: false })
    t.room.setScope({ by: 'Rohan', byKind: 'agent', area: 'old', summary: 'from last time', paths: ['app.py'] })
    t.room.addClaim({ path: 'app.py', from: 1, to: 1, by: 'Rohan', byKind: 'agent', intent: 'ghost' })
    await t.tools.call('room_join', {})
    expect(t.room.scope('Rohan')).toBeUndefined()
    expect(t.room.openClaims()).toEqual([])
    expect(t.room.messages().filter(m => m.type === 'note')).toMatchObject([{ priority: 'fyi', text: 'Rohan released 1 claim(s)' }])
    await t.tools.call('room_scope', { area: 'x', summary: 'y', paths: ['app.py'] })
    t.other.setScope({ by: 'Nearby', byKind: 'agent', area: 'near', summary: 'nearby work', paths: ['app.py', 'src/'] })
    await t.tools.call('room_claim', { path: 'app.py', from: 1, to: 1, intent: 'z' })
    await t.tools.shutdown()
    expect(t.session).toBeNull()
    expect(t.room.scope('Rohan')).toBeUndefined()
    expect(t.room.openClaims()).toEqual([])
  })

  it('room_done releases, clears scope, posts a done note, keeps the session', async () => {
    const t = setup()
    await t.tools.call('room_scope', { area: 'api', summary: 's', paths: ['app.py'] })
    t.other.setScope({ by: 'Nearby', byKind: 'agent', area: 'near', summary: 'nearby work', paths: ['app.py', 'src/'] })
    await t.tools.call('room_claim', { path: 'app.py', from: 1, to: 1, intent: 'x' })
    const out = await t.tools.call('room_done', { summary: 'validation added, 4 tests pass' })
    expect(out).toContain('marked done (api); released 1 claim(s)')
    expect(t.room.scope('Rohan')).toBeUndefined()
    expect(t.room.lastMessages(1)[0]).toMatchObject({ type: 'note', text: 'done (api): validation added, 4 tests pass' })
    expect(t.session).not.toBeNull()
  })

  it('reports the exact command only when the last clean combined preview tests passed', async () => {
    const t = setup()
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
    const passing = "printf '=== 1 passed in 0.1s ===\\n'"
    expect(await t.tools.call('room_preview_merge', { person: 'Kieran', run: passing })).toContain('tests: PASSED')
    const out = await t.tools.call('room_done', { summary: 'implementation done; local tests are failing on teammate files' })
    expect(out).toContain(`The combined preview passed \`${passing}\`.`)
    expect(out).not.toContain('caused by')

    const failed = setup()
    failed.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
    expect(await failed.tools.call('room_preview_merge', { person: 'Kieran', run: 'false' })).toContain('exit 1')
    expect(await failed.tools.call('room_done', { summary: 'local tests failing' })).not.toContain('combined preview passed')
  })

  it('offers the repo rather than part of a slash-containing branch', async () => {
    const tools = createTools({ cwd: dir, getSession: () => null, setSession: () => {}, join: async () => { throw new NoRoom('github.com/o/r/feature/fix', 'missing') } })
    expect(await tools.call('room_join', { where: 'team' })).toContain('No room for o/r on wss://room-rohanz.fly.dev yet.')
  })

  it.each(['room_state', 'room_join', 'room_done'])('shows an auto-join tag once in the first %s reply', async tool => {
    const t = setup()
    const note = 'joined as rohanz+codex (rohanz was already here from another session)'
    t.session!.autoTagNote = note
    expect(await t.tools.call(tool, {})).toContain(note)
    expect(await t.tools.call('room_state', {})).not.toContain(note)
  })

  it('omits Claude wake guidance when channels were explicitly disabled', async () => {
    vi.stubEnv('ROOM_HOST', 'claude'); vi.stubEnv('ROOM_CLAUDE_CHANNEL', '')
    try {
      const t = setup({ joined: false })
      expect(await t.tools.call('room_join', { where: 'local' })).not.toContain('Wake-ups')
    } finally { vi.unstubAllEnvs() }
  })

  it.each(['claude', 'codex', undefined])('keeps quiet joins free of wake-up guidance (%s)', async host => {
    const file = join(dir, '.git', 'room-session.json')
    writeFileSync(file, JSON.stringify({ session_id: 'test-session', at: Date.now(), cwd: dir, host }))
    try {
      const t = setup({ joined: false })
      for (const tool of ['room_join', 'room_create']) {
        const reply = await t.tools.call(tool, { where: 'local' })
        expect(reply.includes('Wake-ups on Claude Code')).toBe(false)
        const again = await t.tools.call(tool, {})
        expect(again.includes('Wake-ups on Claude Code')).toBe(false)
        const done = await t.tools.call('room_done', { summary: 'tested' })
        expect(done).not.toContain('Wake-ups')
        expect(done).not.toContain('only see new room messages')
        await t.tools.call('room_leave', {})
      }
    } finally { rmSync(file, { force: true }) }
  })

  it('lists the twenty advertised tools', () => {
    expect(DEFS.map(d => d.name)).toEqual(['room_login', 'room_create', 'room_join', 'room_leave', 'room_close', 'room_export', 'room_scope', 'room_state', 'room_read', 'room_claim', 'room_release', 'room_send', 'room_wait', 'room_done', 'room_pr_note', 'room_impact', 'room_preview_merge', 'room_share', 'room_spawn', 'room_collect'])
  })
})

describe('one login, two agents', () => {
  it('rohanz and rohanz+codex are distinct participants with their own overlays and inboxes', async () => {
    const { a, b } = pair()
    a.setMeta({ repo: 'demo', branch: 'main', base })
    const me1: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
    const me2: Identity = { name: 'rohanz+codex', kind: 'agent', owner: 'rohanz', label: 'codex' }
    a.setOverlay('rohanz', 'app.py', MINE)
    b.setOverlay('rohanz+codex', 'session.py', 'from app import validate\n# codex\n')
    const mk = (room: RoomDoc, id: Identity, awareness: Awareness) => {
      awareness.setLocalState({ user: { ...id, color: '#000' }, status: 'idle', lastActive: Date.now() })
      const graph = new GraphIndex(room, id.name, dir); graph.start()
      const s: Session = { graph, room, awareness, me: id, dir, roomUrl: 'ws://x/r', roomName: 'r', browserUrl: 'http://x',
        provider: { synced: true, awareness } as unknown as Session['provider'],
        daemon: { touch() {}, async stop() {}, dir, name: id.name, roomDoc: room, provider: null as never, branch: 'main', base } }
      return createTools({ getSession: () => s, setSession: () => {}, cwd: dir })
    }
    const aw1 = new Awareness(a.doc), aw2 = new Awareness(b.doc)
    const t1 = mk(a, me1, aw1), t2 = mk(b, me2, aw2)
    // awareness is not carried by doc updates; hand the codex agent's presence to the first agent as a server would
    applyAwarenessUpdate(aw1, encodeAwarenessUpdate(aw2, [b.doc.clientID]), 'test')
    expect(a.changedPaths('rohanz')).toEqual(['app.py'])
    expect(a.changedPaths('rohanz+codex')).toEqual(['session.py'])
    const state = await t1.call('room_state', {})
    expect(state).toContain("you: rohanz's agent in r")
    expect(state).toContain('1 others: rohanz+codex (all:true for detail)')
    // a question to the codex agent reaches it, not the first agent
    await t1.call('room_send', { type: 'question', text: 'which lines?', to: 'rohanz+codex' })
    // the inbox is the prefix before the body ("you: ..."); the body's recent-bus section lists every message
    const inboxOf = (out: string) => out.slice(0, out.indexOf('you: '))
    expect(inboxOf(await t2.call('room_state', {}))).toContain('which lines?')
    expect(inboxOf(await t1.call('room_state', {}))).not.toContain('which lines?')
    await t1.shutdown(); await t2.shutdown()
  })
})

describe('reading', () => {
  it('room_read shows my overlay, base for untouched files, and others\' versions', async () => {
    const t = setup()
    const mine = await t.tools.call('room_read', { path: 'app.py' })
    expect(mine).toContain('5|     return 22')
    expect(mine).toContain('uncommitted edits')
    const untouched = await t.tools.call('room_read', { path: 'session.py' })
    expect(untouched).toContain('unchanged on their HEAD')
    expect(untouched).toContain('1| from app import validate')
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
    const theirs = await t.tools.call('room_read', { path: 'app.py', person: 'Kieran' })
    expect(theirs).toContain('return x + 1')
    expect(await t.tools.call('room_read', { path: 'app.py' })).toContain('also changed (uncommitted) by: Kieran')
    expect(await t.tools.call('room_read', { path: 'nope.py' })).toMatch(/^error:/)
  })

  it('room_read(diff) is against base, per person', async () => {
    const t = setup()
    const d = await t.tools.call('room_read', { diff: true, path: 'app.py' })
    expect(d).toContain('-    return 2\n')
    expect(d).toContain('+    return 22')
    expect(await t.tools.call('room_read', { diff: true, person: 'Kieran' })).toBe('Kieran has no uncommitted changes')
  })
})

describe('scope, claims, plans, ledger', () => {
  it('scope posts a notify and returns the area ledger', async () => {
    const t = setup()
    t.other.post({ name: 'Kieran', kind: 'agent' }, { type: 'changed', paths: ['app.py'], summary: 'tweaked b', symbols: ['b'] } as never)
    const out = await t.tools.call('room_scope', { area: 'API', summary: 'harden app', paths: ['app.py'] })
    expect(out).toContain('scope set: api: harden app (app.py)')
    expect(out).toContain('api ledger (2):')
    expect(out).toContain('tweaked b')
    expect(t.room.scope('Rohan')?.area).toBe('api')
    expect(t.room.lastMessages(1)[0]).toMatchObject({ type: 'scope', priority: 'notify' })
  })

  it('a claim with plans notifies whoever uses the symbol; release reports unfulfilled plans', async () => {
    const t = setup()
    t.other.setScope({ by: 'Kieran', byKind: 'agent', area: 'auth', summary: 'sessions', paths: ['session.py'] })
    t.other.setScope({ by: 'Nearby', byKind: 'agent', area: 'near', summary: 'nearby work', paths: ['app.py', 'src/'] })
    const out = await t.tools.call('room_claim', { path: 'app.py', from: 1, to: 2, intent: 'rename validate', plans: [{ kind: 'rename', symbol: 'validate', detail: 'verify' }] })
    expect(out).toMatch(/claimed c_/)
    expect(out).toContain("notified Kieran's agent (session.py uses validate)")
    const copy = t.room.messages().find(m => m.to === 'Kieran')
    expect(copy).toMatchObject({ type: 'claim', priority: 'notify' })
    const id = t.room.openClaims()[0].id
    const rel = await t.tools.call('room_release', { claimId: id, summary: 'renamed nothing yet' })
    expect(rel).toContain('not done (declared but not in summary): rename validate → verify')
    expect(t.room.messages().find(m => m.type === 'release')).toMatchObject({ type: 'release', unfulfilled: [{ symbol: 'validate' }] })
  })

  it('overlapping claim posts a conflict addressed to the other party, which shows in their inbox logic', async () => {
    const t = setup()
    t.other.addClaim({ path: 'app.py', from: 4, to: 5, by: 'Kieran', byKind: 'agent', intent: 'fix b' })
    t.other.setScope({ by: 'Nearby', byKind: 'agent', area: 'near', summary: 'nearby work', paths: ['app.py', 'src/'] })
    const out = await t.tools.call('room_claim', { path: 'app.py', from: 5, to: 5, intent: 'also b' })
    expect(out).toContain('CONFLICT: overlaps')
    const c = t.room.messages().find(m => m.type === 'conflict')
    expect(c).toMatchObject({ priority: 'interrupt', to: 'Kieran' })
  })

  it('refuses a directory claim that would cover another participant\'s declared file or claim', async () => {
    const t = setup()
    t.other.setScope({ by: 'Kieran', byKind: 'agent', area: 'tests', summary: 'test utils', paths: ['tests/test_utils.py'] })
    let out = await t.tools.call('room_claim', { path: 'tests/', intent: 'neighboring tests' })
    expect(out).toContain('cannot claim tests/')
    expect(out).toContain("Kieran's scope includes tests/test_utils.py")
    expect(out).toContain('Claim narrower files')
    expect(t.room.openClaims()).toEqual([])

    t.other.clearScope('Kieran')
    t.other.addClaim({ path: 'tests/test_api.py', from: 1, to: 4, by: 'Kieran', byKind: 'agent', intent: 'API tests' })
    out = await t.tools.call('room_claim', { path: 'tests/', intent: 'neighboring tests' })
    expect(out).toContain("Kieran's claim includes tests/test_api.py")
    expect(t.room.openClaims()).toHaveLength(1)
    expect(t.room.openClaims()[0].by).toBe('Kieran')
  })

  it('changed with symbols upgrades to scope owners via base grep', async () => {
    const t = setup()
    t.other.setScope({ by: 'Kieran', byKind: 'agent', area: 'auth', summary: 'sessions', paths: ['session.py'] })
    const out = await t.tools.call('room_send', { type: 'changed', text: 'renamed validate to verify', paths: ['app.py'], symbols: ['validate'] })
    expect(out).toContain("notified Kieran's agent")
    expect(t.room.messages().filter(m => m.type === 'changed').length).toBe(2)
  })
})

describe('graph', () => {
  it('room_impact answers by symbol and by path with owners; claim plans show impact; state shows waiting-on', async () => {
    const t = setup()
    t.other.setScope({ by: 'Kieran', byKind: 'agent', area: 'auth', summary: 'sessions', paths: ['session.py'] })
    const sym = await t.tools.call('room_impact', { symbol: 'validate' })
    expect(sym).toContain('validate: defined in app.py')
    expect(sym).toContain('used in 1 file(s): session.py (Kieran)')
    const byPath = await t.tools.call('room_impact', { path: 'session.py' })
    expect(byPath).toContain('validate from app.py')
    t.other.setScope({ by: 'Nearby', byKind: 'agent', area: 'near', summary: 'nearby work', paths: ['app.py', 'src/'] })
    const claim = await t.tools.call('room_claim', { path: 'app.py', from: 1, to: 2, intent: 'rename', plans: [{ kind: 'rename', symbol: 'validate', detail: 'verify' }] })
    expect(claim).toContain('impact: validate is used in 1 file(s): session.py (Kieran)')
    // Kieran's view: he is waiting on Rohan's rename because session.py uses validate.
    const k = { name: 'Kieran', kind: 'agent' as const }
    let ks: Session | null = { ...fakeSession(t.other), me: k }
    const ktools = createTools({ getSession: () => ks, setSession: s => { ks = s }, cwd: dir })
    await t.tools.call('room_scope', { area: 'api', summary: 'x', paths: ['app.py'] })
    const state = await ktools.call('room_state', {})
    expect(state).toContain("waiting on")
    expect(state).toContain("Rohan's agent plans rename validate → verify in app.py")
  })
})

describe('concurrency', () => {
  it('two claims that raced past the pre-check get exactly one conflict when the remote one arrives', async () => {
    const t = setup()
    await t.tools.call('room_state', {}) // attaches the claims observer
    // Kieran's claim arrives from the other doc after Rohan's was made (neither saw the other pre-insert).
    t.other.setScope({ by: 'Nearby', byKind: 'agent', area: 'near', summary: 'nearby work', paths: ['app.py', 'src/'] })
    await t.tools.call('room_claim', { path: 'app.py', from: 1, to: 3, intent: 'mine' })
    await new Promise(r => setTimeout(r, 5)) // ids are time-ordered; the earlier (smaller) id is the one that reports
    t.other.addClaim({ path: 'app.py', from: 2, to: 2, by: 'Kieran', byKind: 'agent', intent: 'theirs' })
    await new Promise(r => setTimeout(r, 150))
    const conflicts = t.room.messages().filter(m => m.type === 'conflict')
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]).toMatchObject({ priority: 'interrupt', to: 'Kieran' })
  })

  it('inbox tracks message ids, so a message inserted before an already-seen one is still delivered', async () => {
    const t = setup()
    const k = { name: 'Kieran', kind: 'agent' as const }
    await t.tools.call('room_send', { type: 'note', text: 'mine' })
    await t.tools.call('room_state', {}) // marks everything so far seen
    // Insert a remote message at index 0 (before everything seen) by building it on a detached doc and merging.
    t.other.bus.insert(0, [{ id: 'm_early', type: 'question', priority: 'notify', from: 'Kieran', fromKind: 'agent', to: 'Rohan', at: 1, text: 'inserted early' } as never])
    t.other.post(k, { type: 'question', to: 'Rohan', text: 'appended late' } as never)
    const out = await t.tools.call('room_state', {})
    const block = out.split('\n\n')[0]
    expect(block).toContain('[inbox 2]')
    expect(block).toContain('inserted early')
    expect(block).toContain('appended late')
    expect((await t.tools.call('room_state', {})).startsWith('[inbox')).toBe(false)
  })
})

describe('claim by symbol and read receipts', () => {
  it('claims a function by name, resolving its range from my live text', async () => {
    const t = setup()
    t.other.setScope({ by: 'Nearby', byKind: 'agent', area: 'near', summary: 'nearby work', paths: ['app.py', 'src/'] })
    const out = await t.tools.call('room_claim', { path: 'app.py', symbol: 'b', intent: 'fix' })
    expect(out).toMatch(/app\.py:4-5 · b: fix/)
    t.other.setScope({ by: 'Nearby', byKind: 'agent', area: 'near', summary: 'nearby work', paths: ['app.py', 'src/'] })
    expect(await t.tools.call('room_claim', { path: 'app.py', symbol: 'zzz', intent: 'x' })).toMatch(/could not find a definition of zzz/)
  })
  it('records which messages an agent was shown, and marks copies with copyOf', async () => {
    const t = setup()
    const k = { name: 'Kieran', kind: 'agent' as const }
    const q = t.other.post(k, { type: 'question', to: 'Rohan', text: 'hi' } as never)
    await t.tools.call('room_state', {})
    expect(t.room.seenBy(q.id)).toEqual(['Rohan'])
    t.other.setScope({ by: 'Kieran', byKind: 'agent', area: 'auth', summary: 's', paths: ['session.py'] })
    await t.tools.call('room_send', { type: 'changed', text: 'renamed', paths: ['app.py'], symbols: ['validate'] })
    const [orig, copy] = t.room.messages().filter(m => m.type === 'changed')
    expect(copy.copyOf).toBe(orig.id)
  })
})

describe('plan changes', () => {
  it('a released-undone plan is cancelled and routed to whoever was shown it; a re-declared plan is superseded', async () => {
    const t = setup()
    t.other.setScope({ by: 'Kieran', byKind: 'agent', area: 'auth', summary: 's', paths: ['session.py'] })
    t.other.setScope({ by: 'Nearby', byKind: 'agent', area: 'near', summary: 'nearby work', paths: ['app.py', 'src/'] })
    await t.tools.call('room_claim', { path: 'app.py', symbol: 'validate', intent: 'rename', plans: [{ kind: 'rename', symbol: 'validate', detail: 'verify' }] })
    const claim = t.room.openClaims()[0]
    expect(claim.msgId).toBeTruthy()
    expect(t.room.dependentsOf(claim.msgId!)).toEqual(['Kieran', 'Nearby']) // routed copies
    // Rohan changes his mind: a new claim with a different plan on the same symbol supersedes the old one.
    t.other.setScope({ by: 'Nearby', byKind: 'agent', area: 'near', summary: 'nearby work', paths: ['app.py', 'src/'] })
    const out = await t.tools.call('room_claim', { path: 'app.py', from: 1, to: 1, intent: 'rename differently', plans: [{ kind: 'rename', symbol: 'validate', detail: 'check' }] })
    expect(out).not.toContain('plan superseded:')
    const sup = t.room.messages().filter(m => m.type === 'plan' && m.status === 'superseded')
    expect(sup).toHaveLength(0)
    expect(t.room.messages().filter(m => m.type === 'note' && m.text.includes('superseded'))).toMatchObject([{ priority: 'fyi', text: 'Rohan superseded 1 plan(s)' }])
    // Then releases the new claim without doing it: cancelled, routed again.
    const c2 = t.room.openClaims().find(c => c.plans?.[0]?.detail === 'check')!
    const rel = await t.tools.call('room_release', { claimId: c2.id, summary: 'abandoned' })
    expect(rel).toContain("plan cancelled: rename validate → check — told Kieran's agent")
    // Only the explicit cancellation enters Kieran's inbox.
    let ks: Session | null = { ...fakeSession(t.other), me: { name: 'Kieran', kind: 'agent' } }
    const ktools = createTools({ getSession: () => ks, setSession: s => { ks = s }, cwd: dir })
    const state = await ktools.call('room_state', {})
    expect(state.split('\n\n')[0]).not.toMatch(/superseded plan/)
    expect(state.split('\n\n')[0]).toMatch(/interrupt.*cancelled plan rename validate → check/)
  })
})

describe('branch follow', () => {
  it('moves to the new branch room when the clone switches branches', async () => {
    const t = setup({ joined: false })
    await t.tools.call('room_join', {})
    ;(t.session as Session).roomName = 'github.com/x/y/main'
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'feature'])
    const out = await t.tools.call('room_state', {})
    expect(out).toContain('left main, joined github.com/x/y/feature')
    expect(t.joined.length).toBe(2)
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-'])
  })
})

describe('inbox', () => {
  it('prefixes tool replies with unread messages for me, once, highest priority first', async () => {
    const t = setup()
    const k = { name: 'Kieran', kind: 'agent' as const }
    t.other.post(k, { type: 'note', text: 'broadcast fyi' } as never)
    t.other.post(k, { type: 'question', text: 'are you changing b?', to: 'Rohan' } as never)
    t.other.post(k, { type: 'note', text: 'urgent', to: 'Rohan', priority: 'interrupt' } as never)
    const out = await t.tools.call('room_state', {})
    expect(out).toMatch(/\[inbox 2\]\n  \[.*?\] \[interrupt\]/)
    const block = out.slice(out.indexOf('[inbox 2]')).split('\n\n')[0]
    expect(block).toContain('are you changing b?')
    expect(block).not.toContain('broadcast fyi')
    expect((await t.tools.call('room_state', {})).startsWith('[inbox')).toBe(false)
  })
})

describe('wait', () => {
  it('returns immediately for a wait-ending unread message already in the inbox', async () => {
    const t = setup()
    const k = { name: 'Kieran', kind: 'agent' as const }
    t.other.post(k, { type: 'question', text: 'already here?', to: 'Rohan' } as never)
    const started = Date.now()
    const out = await t.tools.call('room_wait', { timeoutMs: 2000 })
    expect(Date.now() - started).toBeLessThan(500)
    expect(out).toContain('question for you')
    expect(out).toContain('already here?')
  })

  it('resolves on release, on answer, on interrupt, and on timeout', async () => {
    const t = setup()
    const peer = addPresence(t.session!.awareness, 'Kieran')
    try {
      const k = { name: 'Kieran', kind: 'agent' as const }
      const c = t.other.addClaim({ path: 'app.py', from: 1, to: 1, by: 'Kieran', byKind: 'agent', intent: 'x' })
      const p1 = t.tools.call('room_wait', { claimId: c.id, timeoutMs: 2000 })
      await vi.waitFor(() => expect(t.session!.awareness.getLocalState()?.status).toBe(`waiting for ${c.id}`))
      t.other.removeClaim(c.id)
      expect(await p1).toContain(`released: ${c.id}`)

      const q = await t.tools.call('room_send', { type: 'question', to: 'Kieran', text: 'ok?' })
      const qid = q.match(/\[(m_[^\]]+)\]/)![1]
      const p2 = t.tools.call('room_wait', { questionId: qid, timeoutMs: 2000 })
      await vi.waitFor(() => expect(t.session!.awareness.getLocalState()?.status).toBe(`waiting for answer to ${qid}`))
      t.other.post(k, { type: 'answer', inReplyTo: qid, to: 'Rohan', text: 'yes' } as never)
      expect(await p2).toContain('answered:')

      const p3 = t.tools.call('room_wait', { timeoutMs: 2000 })
      await vi.waitFor(() => expect(t.session!.awareness.getLocalState()?.status).toBe('waiting'))
      t.other.post(k, { type: 'note', text: 'stop', to: 'Rohan', priority: 'interrupt' } as never)
      expect(await p3).toContain('[interrupt]')

      expect(await t.tools.call('room_wait', { timeoutMs: 30 })).toContain('timeout after 30ms')
    } finally { peer.destroy(); await t.tools.shutdown(); t.session?.awareness.destroy() }
  })
})

describe('preview merge', () => {
  it('defaults to present participants, reports offline overlays, and supports both opt-ins', async () => {
    const t = setup()
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
    t.other.setOverlay('Ada', 'session.py', 'from app import validate\n# offline Ada\n')
    const nobody = await t.tools.call('room_preview_merge', {})
    expect(nobody).toContain('no present participants to merge')
    expect(nobody).toContain('skipped 2 offline participants with overlays: Ada, Kieran')
    const kieran = addPresence(t.session!.awareness, 'Kieran')
    try {
      const current = await t.tools.call('room_preview_merge', {})
      expect(current).toContain("with Kieran's")
      expect(current).not.toContain("Ada's in order")
      expect(current).toContain('skipped 1 offline participant with overlays: Ada')
      expect(current).toContain('people: ["Ada"] or includeOffline: true')
      expect(current).toContain('merge algorithm: git')
      expect(await t.tools.call('room_preview_merge', { person: 'Ada', run: 'cat session.py' })).toContain('# offline Ada')
      const all = await t.tools.call('room_preview_merge', { includeOffline: true, run: 'cat session.py' })
      expect(all).toContain('step 1: merge Ada')
      expect(all).toContain('# offline Ada')
    } finally {
      kieran.destroy()
    }
  })

  it('merges multiple people in order into one combined scratch tree', async () => {
    const t = setup()
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
    t.other.setOverlay('Ada', 'session.py', 'from app import validate\n# Ada was here\n')
    const out = await t.tools.call('room_preview_merge', { people: ['Kieran', 'Ada'], run: 'cat app.py session.py' })
    expect(out).toContain('step 1: merge Kieran')
    expect(out).toContain('step 2: merge Ada')
    expect(out).toContain('return x + 1')
    expect(out).toContain('return 22')
    expect(out).toContain('# Ada was here')
    expect(out).toContain('final combined tree:')
    expect(out).toContain('exit 0')
  })

  it('names the two people whose overlapping changes conflict', async () => {
    const t = setup()
    t.room.setOverlay('Rohan', 'app.py', COMMITTED)
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return 2', 'return 3'))
    t.other.setOverlay('Ada', 'app.py', COMMITTED.replace('return 2', 'return 4'))
    const out = await t.tools.call('room_preview_merge', { people: ['Kieran', 'Ada'] })
    expect(out).toContain('step 2: merge Ada')
    expect(out).toContain('conflict between Kieran and Ada')
  })

  it('reports clean merges and conflicts against base', async () => {
    const t = setup()
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
    expect(await t.tools.call('room_preview_merge', { person: 'Kieran' })).toContain('both changed, merge cleanly: app.py')
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return 2', 'return 3'))
    const out = await t.tools.call('room_preview_merge', { person: 'Kieran' })
    expect(out).toContain('CONFLICTS:')
    expect(out).toContain('app.py')
  })

  it('a conflict where one side built on the other is reported as resolvable and can be resolved', async () => {
    const t = setup()
    // Kieran changes the return line; Rohan (me) inserts before it and copies Kieran's new return line.
    const kieran = COMMITTED.replace('    return 2\n', '    return result\n')
    const mine = COMMITTED.replace('    return 2\n', '    audit()\n    return result\n')
    t.room.setOverlay('Rohan', 'app.py', mine)
    t.other.setOverlay('Kieran', 'app.py', kieran)
    const out = await t.tools.call('room_preview_merge', { person: 'Kieran' })
    expect(out).toContain('app.py (resolvable)')
    expect(out).toContain("your version contains Kieran's change in order")
    expect(out).toContain('call again with resolve=true')
    const res = await t.tools.call('room_preview_merge', { person: 'Kieran', resolve: true, run: 'cat app.py' })
    expect(res).toContain('--- resolved app.py')
    expect(res).toContain('    audit()\n    return result')
    expect(res).toContain('exit 0')
    // A genuine disagreement stays a conflict.
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('    return 2\n', '    return other\n'))
    const hard = await t.tools.call('room_preview_merge', { person: 'Kieran', resolve: true })
    expect(hard).toContain('needs a human')
    expect(hard).not.toContain('--- resolved')
  })

  it('run= executes a command in the merged tree and never touches the clone', async () => {
    const t = setup()
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
    const out = await t.tools.call('room_preview_merge', { person: 'Kieran', run: 'cat app.py && ls' })
    expect(out).toContain('exit 0')
    expect(out).toContain('return x + 1') // Kieran's change
    expect(out).toContain('return 22')    // mine
    expect(out).toContain('session.py')   // rest of the base tree is there
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(`${dir}/app.py`, 'utf8')).toBe(COMMITTED) // clone untouched
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return 2', 'return 3'))
    expect(await t.tools.call('room_preview_merge', { person: 'Kieran', run: 'true' })).toContain('need a human first')
  })

  it('does not certify a zero-exit failure summary and uses the same result for room_done', async () => {
    const t = setup()
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
    const out = await t.tools.call('room_preview_merge', { person: 'Kieran', run: "printf '=== 1 failed, 2 passed in 0.1s ===\\n'" })
    expect(out).toContain('=== 1 failed, 2 passed in 0.1s ===')
    expect(out).toContain('tests: FAILED (exit 0)')
    const done = await t.tools.call('room_done', { summary: 'local tests failed' })
    expect(done).not.toContain('combined preview passed')
  })

  it('strips Room control variables but provides the merged-tree marker', async () => {
    vi.stubEnv('ROOM_PREVIEW_SECRET', 'must-not-leak')
    try {
      const t = setup()
      t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
      const out = await t.tools.call('room_preview_merge', {
        person: 'Kieran',
        run: 'test -z "$ROOM_PREVIEW_SECRET" && test -n "$ROOM_MERGED_TREE" && echo environment-clean',
      })
      expect(out).toContain('environment-clean')
      expect(out).toContain('exit 0')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('propagates a failing pipeline stage when bash is available', async () => {
    const t = setup()
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
    const out = await t.tools.call('room_preview_merge', { person: 'Kieran', run: 'false | cat' })
    expect(out).toContain('exit 1')
    expect(out).toContain('tests: FAILED (exit 1)')
  })
})

describe('merge preview scratch tree', () => {
  it('links third-party packages to my clone and workspace packages into the scratch tree', () => {
    const clone = mkdtempSync(join(tmpdir(), 'room-clone-')), scratch = mkdtempSync(join(tmpdir(), 'room-scratch-'))
    mkdirSync(join(clone, 'packages/shared'), { recursive: true })
    mkdirSync(join(clone, 'node_modules/@room'), { recursive: true })
    mkdirSync(join(clone, 'node_modules/vitest'), { recursive: true })
    symlinkSync('../../packages/shared', join(clone, 'node_modules/@room/shared'))
    mkdirSync(join(clone, 'packages/shared/node_modules/lib0'), { recursive: true })
    linkSharedDirs(clone, scratch)
    expect(readlinkSync(join(scratch, 'node_modules/vitest'))).toBe(join(clone, 'node_modules/vitest'))
    expect(readlinkSync(join(scratch, 'node_modules/@room/shared'))).toBe(join(scratch, 'packages/shared'))
    expect(readlinkSync(join(scratch, 'packages/shared/node_modules/lib0'))).toBe(join(clone, 'packages/shared/node_modules/lib0'))
  })
})

 describe('quiet room state and directory claims', () => {
   it('claims a whole directory without a range and refuses one that covers another claim', async () => {
     const t = setup()
     try {
       t.other.setOverlay('Nearby', 'src/a.ts', 'export const a = 1\n')
       const out = await t.tools.call('room_claim', { path: 'src/', intent: 'own source' })
       expect(out).toContain('claimed')
       expect(out).not.toContain('error:')
       expect(await t.tools.call('room_state', { path: 'src/a.ts' })).toContain('own source')
       t.other.addClaim({ by: 'Ada', byKind: 'agent', path: 'src/nested/b.ts', from: 10, to: 20, intent: 'other work' })
       expect(await t.tools.call('room_claim', { path: 'src/', intent: 'overlap' })).toContain("cannot claim src/: it would cover another participant's declared work (Ada's claim includes src/nested/b.ts)")
     } finally { await t.tools.shutdown(); t.session?.awareness.destroy() }
   })

   it('groups unrelated claims, expands all=true, and caps default state', async () => {
     const t = setup()
     try {
       await t.tools.call('room_scope', { area: 'mine', summary: 'my work', paths: ['mine/'] })
       t.room.addClaim({ by: 'Rohan', byKind: 'agent', path: 'mine/a.ts', from: 1, to: 1, intent: 'my unique claim' })
       t.other.addClaim({ by: 'Ada', byKind: 'agent', path: 'mine/b.ts', from: 1, to: 1, intent: 'overlapping unique claim' })
       for (let i = 0; i < 100; i++) t.other.addClaim({ by: 'Other', byKind: 'agent', path: 'unrelated/' + i + '.ts', from: 1, to: 2, intent: 'unrelated claim detail ' + 'long'.repeat(40) })
       const compact = await t.tools.call('room_state', {})
       expect(compact).toContain('my unique claim')
       expect(compact).toContain('overlapping unique claim')
       expect(compact).toContain('Other: 100 claim(s) · unrelated/')
       expect(compact).not.toContain('unrelated claim detail long')
       expect(compact).toContain('room_state path=')
       expect(compact.length).toBeLessThan(8100)
       for (let i = 0; i < 10; i++) t.room.post<NoteMsg>({ name: 'Rohan', kind: 'agent' }, { type: 'note', text: 'long history '.repeat(200) })
       const bounded = await t.tools.call('room_state', {})
       expect(bounded.length).toBeLessThan(8100)
       expect(bounded).toContain('state lines; room_state all=true')
       const full = await t.tools.call('room_state', { all: true })
       expect(full).toContain('unrelated/99.ts')
       expect(full).toContain('unrelated claim detail')
     } finally { await t.tools.shutdown(); t.session?.awareness.destroy() }
   })
 })

 it('does not replay a channel or hook receipt into the next tool inbox', async () => {
   const t = setup()
   try {
     await t.tools.call('room_state', {})
     const msg = t.other.post({ name: 'Ada', kind: 'agent' }, { type: 'question', to: 'Rohan', text: 'already delivered by channel' })
     t.room.markSeen('Rohan', [msg.id])
     const state = await t.tools.call('room_state', {})
     expect(state.startsWith('[inbox')).toBe(false)
   } finally { await t.tools.shutdown(); t.session?.awareness.destroy() }
 })

it('does not record a claim for a path nobody else is near', async () => {
  const t = setup()
  try {
    const before = t.room.messages().length
    expect(await t.tools.call('room_claim', { path: 'alone.py', intent: 'edit', from: 1, to: 1 })).toBe('alone.py: no claim needed; nobody else is near this path')
    expect(t.room.openClaims()).toHaveLength(0)
    expect(t.room.messages()).toHaveLength(before)
  } finally { await t.tools.shutdown(); t.session?.awareness.destroy() }
})

it('states local sharing first and exposes the browser link only on request', async () => {
  const t = setup()
  const s = t.session!
  s.local = {} as Session['local']
  try {
    expect(await t.tools.call('room_state', {})).toMatch(/^local: nothing leaves this machine\n/)
    expect(await t.tools.call('room_state', {})).not.toContain('browser view:')
    expect(await t.tools.call('room_state', { path: 'app.py', link: true })).toContain('browser view:')
  } finally { delete s.local; await t.tools.shutdown(); s.awareness.destroy() }
})

it('returns a wait-ending answer once and marks it read', async () => {
  const t = setup()
  try {
    const question = t.room.post({ name: 'Rohan', kind: 'agent' }, { type: 'question', to: 'Kieran', text: 'ready?' })
    const answer = t.other.post({ name: 'Kieran', kind: 'agent' }, { type: 'answer', to: 'Rohan', inReplyTo: question.id, text: 'uniquely ready' })
    const out = await t.tools.call('room_wait', { questionId: question.id })
    expect(out.match(/uniquely ready/g)).toHaveLength(1)
    expect(out.match(/\[notify\]/g)).toHaveLength(1)
    expect(out).not.toContain('call room_state')
    expect(t.room.seen('Rohan').has(answer.id)).toBe(true)
  } finally { await t.tools.shutdown(); t.session?.awareness.destroy() }
})

it('omits caches and Room files from preview omissions but keeps requested-artifact candidates', async () => {
  const t = setup()
  const ignored = ['.venv', '__pycache__', '.room']
  try {
    writeFileSync(join(dir, '.gitignore'), '.venv/\n__pycache__/\n.room/\n.room.json\nartifact.bin\n')
    for (const name of ignored) { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, 'cache'), 'cached') }
    writeFileSync(join(dir, '.room.json'), '{}')
    writeFileSync(join(dir, 'artifact.bin'), 'artifact')
    t.other.setOverlay('Kieran', 'app.py', COMMITTED)
    const result = await t.tools.call('room_preview_merge', { person: 'Kieran' })
    expect(result).toContain('NOT previewed (gitignored, Rohan): artifact.bin')
    for (const name of [...ignored, '.room.json']) expect(result).not.toContain(name)
  } finally {
    for (const name of [...ignored, '.room.json', 'artifact.bin', '.gitignore']) rmSync(join(dir, name), { recursive: true, force: true })
    await t.tools.shutdown(); t.session?.awareness.destroy()
  }
})
