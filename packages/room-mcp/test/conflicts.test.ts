import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity } from '@room/shared'
import { createTools } from '../src/tools.js'
import { changedRanges, ConflictWatcher } from '../src/conflicts.js'
import type { Session } from '../src/session.js'

const COMMITTED = 'def validate(x):\n    return x\n\ndef b():\n    return 2\n'
const me: Identity = { name: 'Rohan', kind: 'agent' }
let dir: string, base: string

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
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('changedRanges', () => {
  it('reports live line ranges that differ from the base', () => {
    expect(changedRanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ from: 2, to: 2 }])
    expect(changedRanges('a\nb\nc\n', 'a\nb\nc\nd\ne\n')).toEqual([{ from: 4, to: 5 }])
    expect(changedRanges('a\nb\n', 'a\nb\n')).toEqual([])
  })
})

describe('automatic conflict notices', () => {
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
    expect(msgs[0].type === 'conflict' && msgs[0].text).toContain("you edited app.py:5-5 inside Kieran's agent's claim")
    expect(msgs[1].to).toBe('Kieran'); expect(msgs[1].priority).toBe('notify')
    // and it reaches my inbox on the next call
    expect(await t.tools.call('room_state', {})).toContain('CONFLICT on app.py: you edited')
  })

  it('an edit I have claimed myself is not a conflict', async () => {
    const t = setup()
    t.other.addClaim({ path: 'app.py', from: 1, to: 2, by: 'Kieran', byKind: 'agent', intent: 'validate' })
    await t.tools.call('room_claim', { path: 'app.py', from: 4, to: 5, intent: 'b' })
    t.room.setOverlay('Rohan', 'app.py', COMMITTED.replace('return 2', 'return 22'))
    await t.tools.flushConflicts()
    expect(t.room.messages().filter(m => m.type === 'conflict')).toHaveLength(0)
  })

  it('both changing the same lines posts a notify when the preview conflicts and an fyi when it clears', async () => {
    const t = setup()
    t.room.setOverlay('Rohan', 'app.py', COMMITTED.replace('return 2', 'return 22'))
    await t.tools.flushConflicts()
    t.other.setOverlay('Kieran', 'app.py', COMMITTED.replace('return 2', 'return 33'))
    await t.tools.flushConflicts()
    const notes = () => t.room.messages().filter(m => m.type === 'note' && m.from === 'room')
    expect(notes()).toHaveLength(1)
    expect(notes()[0].type === 'note' && notes()[0].text).toContain("your app.py and Kieran's now conflict around line 5; room_preview_merge(Kieran)")
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
    const t = setup({ session: { closed: { reason: 'room closed' } } })
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
