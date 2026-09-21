import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity, ClaimMsg, QuestionMsg, AnswerMsg, ScopeMsg, NoteMsg, ReleaseMsg } from '@room/shared'
import { createTools } from '../src/tools.js'
import { GraphIndex } from '../src/graph-index.js'
import type { Session } from '../src/session.js'
import { branchOf, isPrName, openPrs, prArea, prIdentity, prLeader, renderPrNote, syncPrs, type PrInfo } from '../src/prs.js'

let dir: string
let base: string
const ROOM = 'github.com/o/r/main'

/** Two docs synced by update exchange, as the in-memory transport in tools.test.ts. */
function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
const PR7: PrInfo = { number: 7, title: 'Add login', author: 'kieran', head: 'feat/login', files: ['src/auth.py', 'src/session.py'], updatedAt: '2026-09-15T10:00:00Z', url: 'https://github.com/o/r/pull/7' }
const PR9: PrInfo = { number: 9, title: 'Fix orders', author: 'sam', head: 'main', files: ['orders.py'], updatedAt: '2026-09-15T09:00:00Z', url: 'https://github.com/o/r/pull/9' }

function session(room: RoomDoc, me: Identity, roomName = ROOM): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle', lastActive: Date.now() })
  return {
    room, awareness, me, dir, roomUrl: `ws://x/${encodeURIComponent(roomName)}`, roomName, browserUrl: 'http://x',
    provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base },
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-prs-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't') // branch main: the room is github.com/o/r/main
  writeFileSync(join(dir, 'app.py'), 'def base_symbol():\n    return 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('PR mirror in the doc', () => {
  it('syncPrs adds a bot scope per PR, updates on change, removes closed ones', () => {
    const { a, b } = pair()
    expect(syncPrs(a, [PR7, PR9])).toEqual({ added: [7, 9], updated: [], removed: [] })
    expect(openPrs(b).map(p => p.number)).toEqual([7, 9])
    const sc = b.scope('pr#7')!
    expect(sc).toMatchObject({ by: 'pr#7', byKind: 'bot', area: 'src', summary: 'PR #7: Add login', paths: ['src/auth.py', 'src/session.py'] })
    expect(b.scope('pr#9')).toMatchObject({ area: 'root', paths: ['orders.py'] })
    // unchanged PRs are not rewritten; a retitled one is
    expect(syncPrs(a, [PR7, PR9])).toEqual({ added: [], updated: [], removed: [] })
    expect(syncPrs(a, [{ ...PR7, title: 'Add login (v2)', updatedAt: '2026-09-15T11:00:00Z' }, PR9])).toEqual({ added: [], updated: [7], removed: [] })
    expect(b.scope('pr#7')!.summary).toBe('PR #7: Add login (v2)')
    // PR 9 closed
    expect(syncPrs(a, [PR7])).toMatchObject({ removed: [9] })
    expect(b.scope('pr#9')).toBeUndefined()
    expect(openPrs(b).map(p => p.number)).toEqual([7])
  })

  it('identity, area and leader helpers', () => {
    expect(prIdentity(PR7)).toEqual({ name: 'pr#7', kind: 'bot', owner: 'kieran', label: 'PR #7' })
    expect(isPrName('pr#7')).toBe(true); expect(isPrName('rohanz+prs')).toBe(false)
    expect(prArea(['a/x.py', 'b/y.py', 'a/z.py'])).toBe('a')
    expect(prArea([])).toBe('root')
    expect(prLeader(['rohanz+share', 'rohanz+areas', 'pr#7', 'kieran'])).toBe('kieran')
    expect(prLeader([])).toBeUndefined()
    expect(branchOf('github.com/o/r/feature/x')).toBe('feature/x')
    expect(branchOf('local/dir/main')).toBe('main')
  })

  it('only the lowest present participant maintains the mirror; PRs show in room_state and impact, never as people', async () => {
    const { a, b } = pair()
    a.setMeta({ repo: 'o/r', branch: 'main', base })
    const alice = session(a, { name: 'alice', kind: 'agent', owner: 'alice' })
    const bob = session(b, { name: 'bob', kind: 'agent', owner: 'bob' })
    // each sees the other's presence, as the server would relay it
    applyAwarenessUpdate(alice.awareness, encodeAwarenessUpdate(bob.awareness, [b.doc.clientID]), 'test')
    applyAwarenessUpdate(bob.awareness, encodeAwarenessUpdate(alice.awareness, [a.doc.clientID]), 'test')
    const fetches: string[] = []
    const mk = (s: Session) => createTools({ getSession: () => s, setSession: () => {}, cwd: dir, prs: { intervalMs: 0, fetch: async x => { fetches.push(x.me.name); return [PR7, PR9] } } })
    const ta = mk(alice), tb = mk(bob)
    ta.attachHooks(alice); tb.attachHooks(bob)
    await new Promise(r => setTimeout(r, 20))
    expect(fetches).toEqual(['alice']) // bob is not the leader
    const state = await tb.call('room_state', {})
    expect(state).toContain('open pull requests (2):')
    expect(state).toContain('  - PR #7 "Add login" by kieran (feat/login → main): src/auth.py, src/session.py · https://github.com/o/r/pull/7')
    expect(state).toContain('  - PR #9 "Fix orders" by sam (main → main): orders.py')
    // PR mirrors are never people: they get no routed copies (others() skips them)
    await tb.call('room_send', { type: 'changed', paths: ['src/auth.py'], text: 'touched auth', symbols: ['login'] })
    expect(b.messages().some(m => m.to === 'pr#7')).toBe(false)
    // PR paths are visible to impact/ownership queries through the scope
    expect(await tb.call('room_state', { path: 'src/auth.py' })).toContain('scope: pr#7 is on src: PR #7: Add login')
    // a claim on a PR's file mentions the PR but does not route a copy to it
    await tb.call('room_claim', { path: 'src/auth.py', from: 1, to: 1, intent: 'x', plans: [{ kind: 'rename', symbol: 'login' }] })
    expect(b.messages().some(m => m.to === 'pr#7')).toBe(false)
    await ta.shutdown(); await tb.shutdown()
  })

  it('attributes a base definition to base when a PR merely touches its file', async () => {
    const { a } = pair()
    a.setMeta({ repo: 'o/r', branch: 'main', base })
    syncPrs(a, [{ ...PR7, files: ['app.py'] }])
    const alice = session(a, { name: 'alice', kind: 'agent', owner: 'alice' })
    const graph = new GraphIndex(a, alice.me.name, dir); graph.start(); alice.graph = graph
    const tools = createTools({ getSession: () => alice, setSession: () => {}, cwd: dir })
    const out = await tools.call('room_impact', { symbol: 'base_symbol' })
    expect(out).toContain('defined in app.py (base, also touched by PR #7)')
    expect(out).not.toContain('(pr#7)')
    await tools.shutdown()
  })
})

describe('ledger to PR', () => {
  function story() {
    const { a } = pair()
    a.setMeta({ repo: 'o/r', branch: 'main', base })
    const alice: Identity = { name: 'alice', kind: 'agent', owner: 'alice' }
    const bob: Identity = { name: 'bob', kind: 'agent', owner: 'bob' }
    a.post<ScopeMsg>(alice, { type: 'scope', area: 'auth', summary: 'sessions', paths: ['src/auth.py'] })
    const c1 = a.addClaim({ path: 'src/auth.py', from: 1, to: 5, by: 'alice', byKind: 'agent', intent: 'rename login', plans: [{ kind: 'rename', symbol: 'login', detail: 'sign_in' }] })
    a.post<ClaimMsg>(alice, { type: 'claim', claimId: c1.id, path: 'src/auth.py', from_line: 1, to_line: 5, intent: 'rename login', plans: c1.plans })
    const q = a.post<QuestionMsg>(bob, { type: 'question', to: 'alice', text: 'keep the old name?' })
    a.post<AnswerMsg>(alice, { type: 'answer', to: 'bob', inReplyTo: q.id, text: 'no, sign_in only' })
    a.removeClaim(c1.id)
    a.post<ReleaseMsg>(alice, { type: 'release', claimId: c1.id, path: 'src/auth.py', summary: 'renamed login to sign_in' })
    const c2 = a.addClaim({ path: 'src/session.py', from: 1, to: 2, by: 'bob', byKind: 'agent', intent: 'drop cookie', plans: [{ kind: 'delete', symbol: 'cookie' }] })
    a.post<ClaimMsg>(bob, { type: 'claim', claimId: c2.id, path: 'src/session.py', from_line: 1, to_line: 2, intent: 'drop cookie', plans: c2.plans })
    a.removeClaim(c2.id)
    a.post<ReleaseMsg>(bob, { type: 'release', claimId: c2.id, path: 'src/session.py', summary: 'left it', unfulfilled: c2.plans })
    a.post<NoteMsg>(alice, { type: 'note', text: 'merge preview with bob: no conflicts across 2 path(s); "npm test" passed', priority: 'fyi' })
    a.post<NoteMsg>(alice, { type: 'note', text: 'evicted stale uncommitted work of carol', priority: 'fyi' }) // not part of the story
    a.post<NoteMsg>(alice, { type: 'note', text: 'hi', to: 'bob', copyOf: 'm_orig' }) // routed copy: skipped
    const c3 = a.addClaim({ path: 'src/auth.py', from: 9, to: 9, by: 'alice', byKind: 'agent', intent: 'still working' })
    a.post<ClaimMsg>(alice, { type: 'claim', claimId: c3.id, path: 'src/auth.py', from_line: 9, to_line: 9, intent: 'still working' })
    a.post<NoteMsg>(alice, { type: 'note', text: 'done (auth): sign_in landed, 12 tests pass' })
    return a
  }

  it('renderPrNote tells the story in bus order with plan outcomes and answers', () => {
    const md = renderPrNote(story(), { roomName: 'github.com/o/r/feat/login', now: Date.UTC(2026, 8, 15, 12) })
    const lines = md.split('\n')
    expect(lines[0]).toBe('### Room ledger for `feat/login`')
    expect(lines[1]).toContain('2026-09-15 12:00 UTC')
    const idx = (re: RegExp) => lines.findIndex(l => re.test(l))
    const iScope = idx(/alice's agent\*\* is on `auth`: sessions \(`src\/auth\.py`\)/)
    const iClaim = idx(/claimed `src\/auth\.py:1-5` — rename login; plans: rename login → sign_in → done: renamed login to sign_in/)
    const iQ = idx(/bob's agent\*\* asked alice's agent: keep the old name\?/)
    const iA = idx(/^  - .*alice's agent\*\* answered: no, sign_in only/)
    const iCancel = idx(/claimed `src\/session\.py:1-2` — drop cookie; plans: delete cookie → cancelled: delete cookie \(left it\)/)
    const iPreview = idx(/merge preview with bob: no conflicts across 2 path\(s\); "npm test" passed/)
    const iOpen = idx(/claimed `src\/auth\.py:9-9` — still working → still open/)
    const iDone = idx(/alice's agent\*\* done \(auth\): sign_in landed, 12 tests pass/)
    expect([iScope, iClaim, iQ, iA, iCancel, iPreview, iOpen, iDone].every(i => i >= 0)).toBe(true)
    expect(iScope).toBeLessThan(iClaim); expect(iClaim).toBeLessThan(iQ); expect(iQ + 1).toBe(iA)
    expect(iA).toBeLessThan(iCancel); expect(iCancel).toBeLessThan(iPreview); expect(iPreview).toBeLessThan(iOpen); expect(iOpen).toBeLessThan(iDone)
    expect(md).not.toContain('evicted')
    expect(md).not.toContain('hi')
    expect(md).toContain('**Still claimed:**')
    expect(md).toContain("- alice's agent: `src/auth.py:9-9` — still working")
  })

  it('an empty room renders a placeholder', () => {
    const { a } = pair()
    expect(renderPrNote(a, { roomName: ROOM })).toContain('- (nothing recorded on the bus yet)')
  })

  it('room_pr_note picks the PR whose head is this branch, or the given number; room_done pr_note does the same', async () => {
    const a = story()
    const posted: { number: number; body: string }[] = []
    const mkTools = (s: Session) => createTools({ getSession: () => s, setSession: () => {}, cwd: dir, prs: { intervalMs: 0, fetch: async () => [PR7, PR9], post: async (_s, number, body) => { posted.push({ number, body }); return { url: `https://github.com/o/r/pull/${number}#c`, updated: number === 9 } } } })
    // on branch main: PR 9's head is main
    const s1 = session(a, { name: 'alice', kind: 'agent', owner: 'alice' })
    const t1 = mkTools(s1)
    const out = await t1.call('room_pr_note', {})
    expect(out).toContain('updated the room ledger comment on PR #9 "Fix orders": https://github.com/o/r/pull/9#c')
    expect(posted.at(-1)!.number).toBe(9)
    expect(posted.at(-1)!.body).toContain('### Room ledger for `main`')
    expect(a.lastMessages(1)[0]).toMatchObject({ type: 'note', text: expect.stringContaining('updated the room ledger on PR #9') })
    // explicit number
    expect(await t1.call('room_pr_note', { number: 7 })).toContain('posted the room ledger comment on PR #7 "Add login"')
    expect(await t1.call('room_pr_note', { number: -1 })).toMatch(/^error: number/)
    // a branch nobody opened a PR for
    const s2 = session(a, { name: 'alice', kind: 'agent', owner: 'alice' }, 'github.com/o/r/wip')
    const t2 = mkTools(s2)
    expect(await t2.call('room_pr_note', {})).toContain('no open PR has wip as its head; open PRs targeting this branch: #7 (feat/login), #9 (main)')
    // room_done with pr_note
    const before = posted.length
    const done = await t1.call('room_done', { summary: 'all green', pr_note: true })
    expect(done).toContain('marked done')
    expect(done).toContain('updated the room ledger comment on PR #9')
    expect(posted.length).toBe(before + 1)
    expect(await t2.call('room_done', { summary: 'x', pr_note: true })).toContain('pr_note: no open PR has wip as its head')
    // non-GitHub rooms have no PRs
    const s3 = session(pair().a, { name: 'alice', kind: 'agent' }, 'local/dir/main')
    expect(await mkTools(s3).call('room_pr_note', {})).toMatch(/^error: this room is not a GitHub repo/)
    // the post failing is reported, not thrown
    const failing = createTools({ getSession: () => s1, setSession: () => {}, cwd: dir, prs: { intervalMs: 0, fetch: async () => [PR9], post: async () => { throw new Error('HTTP 403 no GitHub token') } } })
    expect(await failing.call('room_done', { summary: 'y', pr_note: true })).toContain('pr_note failed: HTTP 403 no GitHub token')
    expect(await failing.call('room_pr_note', {})).toBe('error: HTTP 403 no GitHub token')
  })
})

describe('PR selection by head (fix 13)', () => {
  it('room_pr_note and room_done pick the open PR whose head is this branch even when it targets another branch', async () => {
    const { a } = pair(); a.setMeta({ repo: 'x', branch: 'feat/login', base })
    const posted: number[] = []
    const asks: { head?: boolean }[] = []
    const featPr = { number: 21, title: 'Login', author: 'rohanz', head: 'feat/login', files: ['src/auth.py'], updatedAt: '', url: 'https://github.com/o/r/pull/21' }
    const s = session(a, { name: 'rohanz', kind: 'agent', owner: 'rohanz' })
    s.roomName = 'github.com/o/r/feat/login'
    const tools = createTools({ getSession: () => s, setSession: () => {}, cwd: dir, prs: { intervalMs: 0, fetch: async (_s, opts) => { asks.push(opts ?? {}); return opts?.head ? [featPr] : [] }, post: async (_s, number) => { posted.push(number); return { url: 'u', updated: false } } } })
    const out = await tools.call('room_pr_note', {})
    expect(out).toContain('PR #21')
    expect(posted).toEqual([21])
    expect(asks.some(x => x.head === true)).toBe(true)
  })
})

it('the PR-mirror leader is never a worker', () => {
  expect(prLeader(['aaron', 'a+z', 'pr#7'], ['a+z'])).toBe('aaron')
  expect(prLeader(['a+z'], ['a+z'])).toBe('a+z') // only workers present: someone still has to do it
})
