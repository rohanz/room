import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity } from '@room/shared'
import { createTools, DEFS } from '../src/tools.js'
import type { Session } from '../src/session.js'
import { GraphIndex } from '../src/graph-index.js'

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

function fakeSession(room: RoomDoc, synced = true): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { name: 'Rohan', kind: 'agent', color: '#000' }, status: 'idle' })
  const graph = new GraphIndex(room, 'Rohan', dir); graph.start()
  return {
    graph,
    room, awareness, me, dir, roomUrl: 'ws://x/r', roomName: 'r', browserUrl: 'http://x',
    provider: { synced, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: 'Rohan', roomDoc: room, provider: null as never, branch: 'main', base },
  }
}

function setup(opts: { synced?: boolean; joined?: boolean } = {}) {
  const { a, b } = pair()
  a.setMeta({ repo: 'demo', branch: 'main', base })
  a.setOverlay('Rohan', 'app.py', MINE)
  let session: Session | null = opts.joined === false ? null : fakeSession(a, opts.synced)
  const joined: string[] = []
  const created: boolean[] = []
  const tools = createTools({
    getSession: () => session, setSession: s => { session = s }, cwd: dir,
    join: async o => { joined.push(o.dir); created.push(!!o.create); return fakeSession(a) },
    leave: async () => {},
  })
  return { room: a, other: b, tools, joined, created, get session() { return session } }
}

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
  it('refuses tools before join and gates until synced', async () => {
    const t = setup({ joined: false })
    expect(await t.tools.call('room_state', {})).toBe('error: not in a room. room_join if a teammate has opened this repo, room_create otherwise.')
    const u = setup({ synced: false })
    expect(await u.tools.call('room_state', {})).toBe('error: room not synced yet, retry')
  })

  it('join uses cwd, reports who is here, and leave releases claims', async () => {
    const t = setup({ joined: false })
    const out = await t.tools.call('room_join', {})
    expect(t.joined).toEqual([dir])
    expect(out).toContain("joined r as Rohan's agent")
    expect(out).toContain('browser view: http://x')
    expect(await t.tools.call('room_join', {})).toMatch(/^already in r/)
    await t.tools.call('room_claim', { path: 'app.py', from: 1, to: 2, intent: 'x' })
    expect(await t.tools.call('room_leave', {})).toBe('left r; released 1 claim(s)')
    expect(t.room.openClaims()).toEqual([])
    expect(t.session).toBeNull()
  })

  it('room_create opens the repo then joins; room_join never opens', async () => {
    const t = setup({ joined: false })
    expect(await t.tools.call('room_create', {})).toContain("opened and joined r as Rohan's agent")
    expect(t.created).toEqual([true])
    await t.tools.call('room_leave', {})
    await t.tools.call('room_join', {})
    expect(t.created).toEqual([true, false])
  })

  it('a fresh join clears stale claims and scope left under my name; shutdown leaves cleanly', async () => {
    const t = setup({ joined: false })
    t.room.setScope({ by: 'Rohan', byKind: 'agent', area: 'old', summary: 'from last time', paths: ['app.py'] })
    t.room.addClaim({ path: 'app.py', from: 1, to: 1, by: 'Rohan', byKind: 'agent', intent: 'ghost' })
    await t.tools.call('room_join', {})
    expect(t.room.scope('Rohan')).toBeUndefined()
    expect(t.room.openClaims()).toEqual([])
    expect(t.room.messages().some(m => m.type === 'release' && m.summary === 'stale from an earlier session')).toBe(true)
    await t.tools.call('room_scope', { area: 'x', summary: 'y', paths: ['app.py'] })
    await t.tools.call('room_claim', { path: 'app.py', from: 1, to: 1, intent: 'z' })
    await t.tools.shutdown()
    expect(t.session).toBeNull()
    expect(t.room.scope('Rohan')).toBeUndefined()
    expect(t.room.openClaims()).toEqual([])
  })

  it('room_done releases, clears scope, posts a done note, keeps the session', async () => {
    const t = setup()
    await t.tools.call('room_scope', { area: 'api', summary: 's', paths: ['app.py'] })
    await t.tools.call('room_claim', { path: 'app.py', from: 1, to: 1, intent: 'x' })
    const out = await t.tools.call('room_done', { summary: 'validation added, 4 tests pass' })
    expect(out).toContain('marked done (api); released 1 claim(s)')
    expect(t.room.scope('Rohan')).toBeUndefined()
    expect(t.room.lastMessages(1)[0]).toMatchObject({ type: 'note', text: 'done (api): validation added, 4 tests pass' })
    expect(t.session).not.toBeNull()
  })

  it('lists the twenty tools', () => {
    expect(DEFS.map(d => d.name)).toEqual(['room_login', 'room_logout', 'room_create', 'room_join', 'room_leave', 'room_close', 'room_scope', 'room_state', 'room_read', 'room_diff', 'room_who', 'room_claim', 'room_release', 'room_send', 'room_wait', 'room_done', 'room_pr_note', 'room_impact', 'room_preview_merge', 'room_share'])
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
    expect(state).toContain('rohanz+codex · agent of rohanz · codex')
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

  it('room_diff is against base, per person', async () => {
    const t = setup()
    const d = await t.tools.call('room_diff', { path: 'app.py' })
    expect(d).toContain('-    return 2\n')
    expect(d).toContain('+    return 22')
    expect(await t.tools.call('room_diff', { person: 'Kieran' })).toBe('Kieran has no uncommitted changes')
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
    const out = await t.tools.call('room_claim', { path: 'app.py', from: 5, to: 5, intent: 'also b' })
    expect(out).toContain('CONFLICT: overlaps')
    const c = t.room.messages().find(m => m.type === 'conflict')
    expect(c).toMatchObject({ priority: 'interrupt', to: 'Kieran' })
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
    const out = await t.tools.call('room_claim', { path: 'app.py', symbol: 'b', intent: 'fix' })
    expect(out).toMatch(/app\.py:4-5 · b: fix/)
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
    await t.tools.call('room_claim', { path: 'app.py', symbol: 'validate', intent: 'rename', plans: [{ kind: 'rename', symbol: 'validate', detail: 'verify' }] })
    const claim = t.room.openClaims()[0]
    expect(claim.msgId).toBeTruthy()
    expect(t.room.dependentsOf(claim.msgId!)).toEqual(['Kieran']) // routed copy
    // Rohan changes his mind: a new claim with a different plan on the same symbol supersedes the old one.
    const out = await t.tools.call('room_claim', { path: 'app.py', from: 1, to: 1, intent: 'rename differently', plans: [{ kind: 'rename', symbol: 'validate', detail: 'check' }] })
    expect(out).toContain("plan superseded: rename validate → verify — told Kieran's agent")
    const sup = t.room.messages().filter(m => m.type === 'plan' && m.status === 'superseded')
    expect(sup.length).toBe(2) // original + copy to Kieran
    expect(sup.find(m => m.to === 'Kieran')).toMatchObject({ priority: 'interrupt', replacedBy: { detail: 'check' } })
    // Then releases the new claim without doing it: cancelled, routed again.
    const c2 = t.room.openClaims().find(c => c.plans?.[0].detail === 'check')!
    const rel = await t.tools.call('room_release', { claimId: c2.id, summary: 'abandoned' })
    expect(rel).toContain("plan cancelled: rename validate → check — told Kieran's agent")
    // Kieran's view: both arrive as interrupts in the inbox.
    let ks: Session | null = { ...fakeSession(t.other), me: { name: 'Kieran', kind: 'agent' } }
    const ktools = createTools({ getSession: () => ks, setSession: s => { ks = s }, cwd: dir })
    const state = await ktools.call('room_state', {})
    expect(state.split('\n\n')[0]).toMatch(/interrupt.*superseded plan rename validate/)
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
    expect(out.startsWith('[inbox 2]\n  interrupt')).toBe(true)
    const block = out.split('\n\n')[0]
    expect(block).toContain('are you changing b?')
    expect(block).not.toContain('broadcast fyi')
    expect((await t.tools.call('room_state', {})).startsWith('[inbox')).toBe(false)
  })
})

describe('wait', () => {
  it('resolves on release, on answer, on interrupt, and on timeout', async () => {
    const t = setup()
    const k = { name: 'Kieran', kind: 'agent' as const }
    const c = t.other.addClaim({ path: 'app.py', from: 1, to: 1, by: 'Kieran', byKind: 'agent', intent: 'x' })
    const p1 = t.tools.call('room_wait', { claimId: c.id, timeoutMs: 2000 })
    setTimeout(() => t.other.removeClaim(c.id), 20)
    expect(await p1).toContain(`released: ${c.id}`)

    const q = await t.tools.call('room_send', { type: 'question', to: 'Kieran', text: 'ok?' })
    const qid = q.match(/\[(m_[^\]]+)\]/)![1]
    const p2 = t.tools.call('room_wait', { questionId: qid, timeoutMs: 2000 })
    setTimeout(() => t.other.post(k, { type: 'answer', inReplyTo: qid, to: 'Rohan', text: 'yes' } as never), 20)
    expect(await p2).toContain('answered:')

    const p3 = t.tools.call('room_wait', { timeoutMs: 2000 })
    setTimeout(() => t.other.post(k, { type: 'note', text: 'stop', to: 'Rohan', priority: 'interrupt' } as never), 20)
    expect(await p3).toContain('interrupt:')

    expect(await t.tools.call('room_wait', { timeoutMs: 30 })).toContain('timeout after 30ms')
  })
})

describe('preview merge', () => {
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
})
