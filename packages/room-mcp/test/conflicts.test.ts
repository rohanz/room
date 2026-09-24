import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { RoomDoc, shouldWakeOnMsg } from '@room/shared'
import type { Identity } from '@room/shared'
import { createTools, type Tools } from '../src/tools.js'
import { changedRanges, ConflictWatcher, type ConflictDeps } from '../src/conflicts.js'
import type { Session } from '../src/session.js'

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
    room, awareness, me, dir, roomUrl: 'ws://x/github.com%2Fo%2Fr%2Fmain', roomName: 'github.com/o/r/main', browserUrl: 'http://x',
    provider: { synced: true, awareness } as unknown as Session['provider'],
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

describe('changedRanges', () => {
  it('reports live line ranges that differ from the base', () => {
    expect(changedRanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ from: 2, to: 2 }])
    expect(changedRanges('a\nb\nc\n', 'a\nb\nc\nd\ne\n')).toEqual([{ from: 4, to: 5 }])
    expect(changedRanges('a\nb\n', 'a\nb\n')).toEqual([])
  })
})

describe('automatic conflict notices', () => {
  it('logs a rejected debounced conflict check instead of leaving it unhandled', async () => {
    const log = vi.fn()
    const room = new RoomDoc()
    const watcher = new ConflictWatcher({ room, me, debounceMs: 1, log,
      liveText: async () => undefined, baseText: async () => undefined,
      baseFor: () => base, mergeBase: async () => base })
    const internal = watcher as unknown as { schedule(person: string, path: string): void; check(person: string, path: string): Promise<void> }
    vi.spyOn(internal, 'check').mockRejectedValue(new Error('ENOENT: repo disappeared'))
    vi.useFakeTimers()
    try {
      internal.schedule('Kieran', 'app.py')
      await vi.advanceTimersByTimeAsync(1)
      expect(log).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOENT: repo disappeared'))
    } finally {
      watcher.stop()
      vi.useRealTimers()
    }
  })

  function watcherFor(room: RoomDoc, extra: Partial<ConflictDeps> = {}) {
    const watcher = new ConflictWatcher({ room, me, debounceMs: 10_000,
      liveText: async (p, person) => room.text(p, person), baseText: async () => 'base\n',
      baseFor: () => base, mergeBase: async () => base, ...extra })
    watcher.start()
    return watcher
  }

  it.each([false, true])('groups byte-identical integration into one fyi per holder (local resolver: %s)', async local => {
    const room = new RoomDoc()
    const paths = ['a.txt', 'b.txt', 'c.txt', 'd.txt']
    for (const path of paths) {
      room.addClaim({ path, from: 1, to: 1, by: 'Kieran', byKind: 'agent', intent: 'implement' })
      if (!local) room.setOverlay('Kieran', path, `worker ${path}\n`)
    }
    const watcher = watcherFor(room, { liveText: async (p, person) => person === 'Kieran' ? `worker ${p}\n` : room.text(p, person) })
    for (const path of paths) room.setOverlay(me.name, path, `worker ${path}\n`)
    await watcher.flush()
    expect(room.messages().filter(m => m.type === 'conflict')).toEqual([])
    expect(room.messages().filter(m => m.type === 'note')).toMatchObject([{ priority: 'fyi', text: 'Rohan integrated 4 files of Kieran' }])
    room.setOverlay(me.name, paths[0], 'temporary\n')
    room.setOverlay(me.name, paths[0], `worker ${paths[0]}\n`)
    await watcher.flush()
    expect(room.messages().filter(m => m.type === 'note')).toHaveLength(1)
    // An actual divergence still alarms after an earlier integration.
    room.setOverlay(me.name, paths[0], 'independent edit\n')
    await watcher.flush()
    expect(room.messages().filter(m => m.type === 'conflict')).toHaveLength(2)
    watcher.stop()
  })

  it('reports external writes only as a throttled fyi, then alarms on a session-intended write', async () => {
    const room = new RoomDoc()
    let now = 1000, intended = false
    room.addClaim({ path: 'a.txt', from: 1, to: 1, by: 'Kieran', byKind: 'agent', intent: 'implement' })
    const watcher = watcherFor(room, { writeIntent: () => intended, now: () => now })
    for (const text of ['external 1\n', 'external 2\n']) { room.setOverlay(me.name, 'a.txt', text); await watcher.flush() }
    expect(room.messages()).toMatchObject([{ type: 'note', priority: 'fyi' }])
    now += 600_000
    room.setOverlay(me.name, 'a.txt', 'external 3\n'); await watcher.flush()
    expect(room.messages()).toHaveLength(2)
    intended = true
    room.setOverlay(me.name, 'a.txt', 'mine\n'); await watcher.flush()
    expect(room.messages().filter(m => m.type === 'conflict')).toHaveLength(2)
    watcher.stop()
  })

  it('keeps alarms without hook evidence and skips colocated claim/merge checks', async () => {
    for (const colocated of [false, true]) {
      const room = new RoomDoc()
      room.addClaim({ path: 'a.txt', from: 1, to: 1, by: 'Kieran', byKind: 'agent', intent: 'implement' })
      room.setOverlay('Kieran', 'a.txt', 'theirs\n')
      const watcher = watcherFor(room, { coLocated: () => colocated, writeIntent: () => undefined })
      room.setOverlay(me.name, 'a.txt', 'mine\n'); await watcher.flush()
      expect(room.messages().filter(m => m.type === 'conflict')).toHaveLength(colocated ? 0 : 2)
      expect(room.messages().filter(m => m.type === 'merge-conflict')).toHaveLength(colocated ? 0 : 1)
      watcher.stop()
    }
  })

  it('uses directory claim semantics for foreign claims and my covering claim', async () => {
    const room = new RoomDoc()
    room.addClaim({ path: 'src/', from: 1, to: 1, by: 'Kieran', byKind: 'agent', intent: 'implement' })
    const watcher = watcherFor(room)
    room.setOverlay(me.name, 'src/a.txt', 'mine\n'); await watcher.flush()
    expect(room.messages().filter(m => m.type === 'conflict')).toHaveLength(2)
    room.addClaim({ path: 'src/owned/', from: 1, to: 1, by: me.name, byKind: 'agent', intent: 'mine' })
    room.setOverlay(me.name, 'src/owned/b.txt', 'mine\n'); await watcher.flush()
    room.setOverlay(me.name, 'src-other/c.txt', 'mine\n'); await watcher.flush()
    expect(room.messages().filter(m => m.type === 'conflict')).toHaveLength(2)
    watcher.stop()
  })

  it('notifies once when a foreign observed contract change reaches my referenced work', async () => {
    const room = new RoomDoc()
    room.setOverlay('Rohan', 'api/handlers.py', 'from api.pricing import total\n')
    const watcher = new ConflictWatcher({
      room, me, debounceMs: 0,
      liveText: async (p, person) => room.text(p, person),
      baseText: async () => '', baseFor: () => base, mergeBase: async () => base,
    })
    watcher.start()
    const snapshot = {
      version: 1 as const, base, at: 1, status: 'ready' as const, truncated: false,
      paths: ['api/pricing.py', 'api/handlers.py'],
      edges: [{ source: 'api/pricing.py', target: 'api/handlers.py', symbols: ['total'] }],
      observed: [{ path: 'api/pricing.py', symbol: 'total', kind: 'signature' as const, detail: 'was `def total(x):` now `def total(x, tax):`' }],
    }
    room.graphs.set('rohanz+codex', snapshot)
    await watcher.flush()
    room.graphs.set('rohanz+codex', { ...snapshot, at: 2 })
    await watcher.flush()
    room.graphs.set('rohanz+codex', { ...snapshot, at: 3, observed: [...snapshot.observed, { path: 'api/pricing.py', symbol: 'discount', kind: 'add' as const, detail: 'now `def discount():`' }] })
    await watcher.flush()
    const notices = room.messages().filter(message => message.type === 'contract')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ to: 'Rohan', priority: 'notify', path: 'api/pricing.py', symbol: 'total' })
    expect(shouldWakeOnMsg(me, notices[0]).wake).toBe(true)
    expect(notices[0].type === 'contract' && notices[0].text).toBe('rohanz+codex changed the signature of total() in api/pricing.py (was `def total(x):` now `def total(x, tax):`); api/handlers.py uses it')
    watcher.stop()
  })

  it('my edit inside a teammate\'s claim raises one interrupt to me and a notify to them, once', async () => {
    const t = setup()
    t.other.addClaim({ path: 'app.py', from: 4, to: 5, by: 'Kieran', byKind: 'agent', intent: 'rewrite b' })
    t.room.setOverlay('Rohan', 'app.py', COMMITTED.replace('return 2', 'return 22'))
    await t.tools.flushConflicts()
    t.room.setOverlay('Rohan', 'app.py', COMMITTED.replace('return 2', 'return 222'))
    await t.tools.flushConflicts()
    const msgs = t.room.messages().filter(m => m.type === 'conflict')
    expect(msgs).toHaveLength(2)
    expect(msgs[0].to).toBe('Rohan'); expect(msgs[0].priority).toBe('interrupt')
    expect(msgs[0].type === 'conflict' && msgs[0].text).toContain("you edited app.py:5-5 inside Kieran's claim")
    expect(msgs[1].to).toBe('Kieran'); expect(msgs[1].priority).toBe('notify')
    // and it reaches my inbox on the next call
    expect(await t.tools.call('room_state', {})).toContain('CONFLICT on app.py: you edited')
  })

  it('an edit I have claimed myself is not a conflict', async () => {
    const t = setup()
    t.other.addClaim({ path: 'app.py', from: 1, to: 2, by: 'Kieran', byKind: 'agent', intent: 'validate' })
    t.other.setScope({ by: 'Kieran', byKind: 'agent', area: 'app', summary: 'near app', paths: ['app.py'] })
    await t.tools.call('room_claim', { path: 'app.py', from: 4, to: 5, intent: 'b' })
    t.room.setOverlay('Rohan', 'app.py', COMMITTED.replace('return 2', 'return 22'))
    await t.tools.flushConflicts()
    expect(t.room.messages().filter(m => m.type === 'conflict')).toHaveLength(0)
  })

  it('both changing the same lines posts a notify when the preview conflicts and an fyi when it clears', async () => {
    const t = setup()
    const peer = addPresence(t.session!.awareness, 'Kieran')
    t.room.setOverlay('Rohan', 'app.py', COMMITTED.replace('return 2', 'return 22'))
    await t.tools.flushConflicts()
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return 2', 'return 33'))
    await t.tools.flushConflicts()
    const notes = () => t.room.messages().filter(m => (m.type === 'note' || m.type === 'merge-conflict') && m.from === 'room')
    expect(notes()).toHaveLength(1)
    expect(shouldWakeOnMsg(me, notes()[0])).toMatchObject({ wake: true, mustAnswer: true })
    expect(notes()[0].type === 'merge-conflict' && notes()[0].text).toContain("your app.py and Kieran's now conflict around line 5; room_preview_merge(Kieran)")
    // a further change while still conflicting says nothing new
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return 2', 'return 34'))
    await t.tools.flushConflicts()
    expect(notes()).toHaveLength(1)
    // Kieran moves to a different line: clean again
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return x', 'return x + 1'))
    await t.tools.flushConflicts()
    expect(notes()).toHaveLength(2)
    expect(notes()[1].priority).toBe('fyi')
    expect(notes()[1].type === 'note' && notes()[1].text).toContain('merge cleanly again')
    peer.destroy()
  })

  it('does not preview an offline participant until they are present', async () => {
    const room = new RoomDoc()
    room.setOverlay('Rohan', 'app.py', COMMITTED.replace('return 2', 'return 22'))
    room.setOverlay('Kieran', 'app.py', COMMITTED.replace('return 2', 'return 33'))
    let present = false
    let mergeReads = 0
    const watcher = new ConflictWatcher({
      room, me, debounceMs: 0, isPresent: () => present,
      liveText: async (p, person) => room.text(p, person),
      baseText: async () => { mergeReads++; return COMMITTED },
      baseFor: () => base,
      mergeBase: async () => base,
    })
    watcher.start()
    room.setOverlay('Kieran', 'app.py', COMMITTED.replace('return 2', 'return 34'))
    await watcher.flush()
    expect(mergeReads).toBe(0)
    expect(room.messages()).toEqual([])
    present = true
    room.setOverlay('Kieran', 'app.py', COMMITTED.replace('return 2', 'return 35'))
    await watcher.flush()
    expect(mergeReads).toBe(1)
    expect(room.messages().some(m => m.type === 'merge-conflict' && m.text.includes('now conflict'))).toBe(true)
    watcher.stop()
  })

  it('budgets merge previews globally, coalesces pairs, and skips unchanged text hashes', async () => {
    const room = new RoomDoc()
    let clock = 0, mergeReads = 0
    const paths = Array.from({ length: 6 }, (_, i) => `f${i}.txt`)
    for (const p of paths) {
      room.setOverlay('Rohan', p, 'mine\n')
      room.setOverlay('Kieran', p, 'theirs\n')
    }
    const watcher = new ConflictWatcher({
      room, me, debounceMs: 0, mergeBudget: 4, mergeWindowMs: 10_000, now: () => clock,
      liveText: async (p, person) => room.text(p, person),
      baseText: async () => { mergeReads++; return 'base\n' },
      baseFor: () => base,
      mergeBase: async () => base,
    })
    watcher.start()
    // Re-touch all pairs; the queue holds one entry per person/path and only four may start.
    for (const p of paths) room.setOverlay('Kieran', p, `theirs ${p}\n`)
    await watcher.flush()
    expect(mergeReads).toBe(4)
    clock = 10_001
    await watcher.flush()
    expect(mergeReads).toBe(6)
    // Multiple changes coalesce; returning to the last merged text skips the merge by hash.
    room.setOverlay('Kieran', paths[0], 'temporary\n')
    room.setOverlay('Kieran', paths[0], `theirs ${paths[0]}\n`)
    clock = 20_002
    await watcher.flush()
    expect(mergeReads).toBe(6)
    watcher.stop()
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

  it('room_close needs confirm=true, then closes for everyone and leaves', async () => {
    const clock = Date.UTC(2026, 8, 15, 8, 30)
    const t = setup({ now: () => clock })
    t.other.post(kieran, { type: 'note', text: 'done (api): shipped', priority: 'fyi' })
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
    t.other.post(kieran, { type: 'note', text: 'done (tests): 12 pass', priority: 'fyi' })
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

  it('join evicts overlays of absent people older than 7 days, keeps recent and present ones', async () => {
    const DAY = 86_400_000
    let clock = 1_000_000_000_000
    const t = setup({ joined: false, now: () => clock })
    t.other.setOverlay('Kieran', 'app.py', 'old\n')
    t.other.setOverlay('Hrishi', 'app.py', 'recent\n')
    // timestamps are wall-clock; age them explicitly
    t.other.overlayAt.set('Kieran', clock - 9 * DAY)
    t.other.overlayAt.set('Hrishi', clock - 2 * DAY)
    await t.tools.call('room_join', {})
    expect(t.room.changedPaths('Kieran')).toEqual([])
    expect(t.room.changedPaths('Hrishi')).toEqual(['app.py'])
    const note = t.room.messages().find(m => m.type === 'note' && m.text.includes('evicted'))
    expect(note && note.type === 'note' && note.text).toContain('evicted stale uncommitted work of Kieran (1 file; last seen 9 days ago)')
  })
})
