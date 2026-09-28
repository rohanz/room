import { describe, expect, it, vi } from 'vitest'
import { RoomDoc } from '@room/shared'
import { gitBlobHash, manifestKey } from '@room/shared'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConflictSet, ConflictSlots, reconcileProjectedConflicts, slotKey, noticeId } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'

describe('ConflictSlots', () => {
  it('reconciles a pre-existing conflict once and replays the same id after a hub outage', async () => {
    const room = new RoomDoc()
    const post = vi.fn().mockResolvedValueOnce({ ok: false, text: 'unreachable' }).mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, 'lease')
    const key = slotKey('a', 'merge', 'b', 'x')
    await slots.settle(key, { status: 'conflict', inputs: 'i', factId: 'f', path: 'x', owner: 'a', other: 'b', kind: 'merge' })
    expect(room.doc.getMap('conflicts').get(key)).toMatchObject({ status: 'conflict', epoch: 1 })
    expect(post).toHaveBeenCalledWith(expect.anything(), expect.anything(), { id: noticeId(key, 1), auto: true })
    await slots.replay('a')
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1][2].id).toBe(noticeId(key, 1))
  })

  it('keeps a conflict through unknown and advances its epoch only after clean', async () => {
    const room = new RoomDoc()
    const post = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, 'lease')
    const key = slotKey('a', 'merge', 'b', 'x')
    const evaluation = { inputs: 'i', factId: 'f', path: 'x', owner: 'a', other: 'b', kind: 'merge' } as const
    await slots.settle(key, { ...evaluation, status: 'conflict' })
    await slots.settle(key, { ...evaluation, status: 'unknown', why: 'missing base' })
    await slots.settle(key, { ...evaluation, status: 'conflict' })
    expect(post).toHaveBeenCalledTimes(1)
    await slots.settle(key, { ...evaluation, status: 'clean' })
    await slots.settle(key, { ...evaluation, status: 'conflict' })
    expect(room.doc.getMap('conflicts').get(key)).toMatchObject({ epoch: 2, status: 'conflict' })
    expect(post.mock.calls.map(c => c[2].id)).toEqual([noticeId(key, 1), `${noticeId(key, 1)}:clean`, noticeId(key, 2)])
  })

  it('keeps hashless possible inputs stable when only edit time changes', async () => {
    const room = new RoomDoc()
    const post = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, 'lease')
    const key = slotKey('a', 'merge', 'b', 'x')
    await slots.settle(key, { status: 'possible', inputs: 'stable', factId: 'possible', path: 'x', owner: 'a', other: 'b', kind: 'merge' })
    await slots.settle(key, { status: 'possible', inputs: 'stable', factId: 'possible', path: 'x', owner: 'a', other: 'b', kind: 'merge' })
    expect(post).toHaveBeenCalledTimes(1)
    expect(room.doc.getMap('conflicts').get(key)).toMatchObject({ status: 'possible', epoch: 1 })
  })

  it('does not renotify unchanged conflicting hunks after an input edit', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, 'lease')
    const key = slotKey('a', 'merge', 'b', 'x')
    const base = { status: 'conflict' as const, factId: 'same-hunks', path: 'x', owner: 'a', other: 'b', kind: 'merge' as const }
    await slots.settle(key, { ...base, inputs: 'before' })
    await slots.settle(key, { ...base, inputs: 'after' })
    expect(post).toHaveBeenCalledTimes(1)
    expect(slots.get(key)?.epoch).toBe(1)
  })

  it('advances after clean then unknown then conflict', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, 'lease')
    const key = slotKey('a', 'merge', 'b', 'x')
    const base = { factId: 'hunks', path: 'x', owner: 'a', other: 'b', kind: 'merge' as const }
    await slots.settle(key, { ...base, status: 'conflict', inputs: '1' })
    await slots.settle(key, { ...base, status: 'clean', inputs: '2' })
    await slots.settle(key, { ...base, status: 'unknown', inputs: '3' })
    await slots.settle(key, { ...base, status: 'conflict', inputs: '4' })
    expect(slots.get(key)?.epoch).toBe(2)
    expect(post.mock.calls.map(c => c[2].id)).toEqual([noticeId(key, 1), `${noticeId(key, 1)}:clean`, noticeId(key, 2)])
  })
})

describe('derived pair slots', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'room-slot-'))
    const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
    run('init', '-q'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't')
    writeFileSync(join(dir, 'x'), 'old\n')
    run('add', '.'); run('commit', '-qm', 'init')
    const base = run('rev-parse', 'HEAD')
    const room = new RoomDoc()
    room.ensureRoomSalt()
    const awareness = new Awareness(room.doc)
    const states = new Map<number, unknown>()
    let next = 1
    const holder = (name: string, projectedBy?: string) => {
      const fence = projectedBy ? 'lease-L' : `lease-${name}`
      room.participants.set(`${name}\0id`, { name, kind: 'agent' })
      room.participants.set(`${name}\0holder`, { sessionId: fence })
      room.participants.set(`${name}\0git`, { branch: 'main', head: base, base, anchored: true, rev: 1, fence })
      if (projectedBy) room.participants.set(`${name}\0proj`, { projectedBy, projectedFrom: 'w' })
      states.set(next++, { user: { name, kind: 'agent' }, sessionId: fence })
      return fence
    }
    const entry = (name: string, text: string | undefined, held = false, projectedBy?: string) => {
      const fence = projectedBy ? 'lease-L' : `lease-${name}`
      room.manifestHead.set(name, { base, fence, coverage: { kind: 'all' }, level: 'declared', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true, ...(projectedBy ? { projectedBy, projectedFrom: 'w' } : {}) })
      const values = new Y.Map<{ change: 'M'; state: 'shared' | 'held'; hash?: string; held?: 'scope'; at: number; fence: string }>()
      if (text !== undefined || held) values.set('x', { change: 'M', state: held ? 'held' : 'shared', ...(text ? { hash: gitBlobHash(text) } : {}), ...(held ? { held: 'scope' as const } : {}), at: 1, fence })
      room.manifest.set(manifestKey(name, fence), values)
      if (text !== undefined) room.setOverlay(manifestKey(name, fence), 'x', text)
    }
    const post = vi.fn().mockImplementation((from, body, opts) => Promise.resolve({ ok: true, msg: { ...body, ...opts } }))
    const session = (name: string, posting = post) => ({ room, awareness: { getStates: () => states } as unknown as Awareness,
      provider: { synced: true, on() {}, off() {} }, me: { name, kind: 'agent' }, dir, post: posting }) as unknown as Session
    return { room, base, dir, holder, entry, post, session, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it('records a possible conflict for a hashless held side, then certifies after sharing', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B')
      f.entry('A', 'A\n')
      f.entry('B', undefined, true)
      await new ConflictSet(f.session('A')).reconcile('test')
      const key = slotKey('A', 'merge', 'B', 'x')
      expect(f.room.doc.getMap<{ status: string }>('conflicts').get(key)?.status).toBe('possible')
      const firstInputs = f.room.doc.getMap<{ inputs: string }>('conflicts').get(key)!.inputs
      const firstId = f.post.mock.calls.find(c => c[2]?.id?.startsWith('cf:'))?.[2].id
      f.entry('B', undefined, true) // a new scan with the same hidden fact
      const held = f.room.manifest.get(manifestKey('B', 'lease-B'))!.get('x')!
      f.room.manifest.get(manifestKey('B', 'lease-B'))!.set('x', { ...held, at: 4 })
      await new ConflictSet(f.session('A')).reconcile('test')
      expect(f.room.doc.getMap<{ status: string }>('conflicts').get(key)?.status).toBe('possible')
      expect(f.room.doc.getMap<{ inputs: string }>('conflicts').get(key)?.inputs).toBe(firstInputs)
      f.entry('A', 'AA\n')
      await new ConflictSet(f.session('A')).reconcile('test')
      expect(f.room.doc.getMap<{ epoch: number }>('conflicts').get(key)?.epoch).toBe(1)
      f.entry('B', 'B\n')
      await new ConflictSet(f.session('A')).reconcile('test')
      expect(f.room.doc.getMap<{ status: string }>('conflicts').get(key)?.status).toBe('conflict')
      expect(f.post.mock.calls.some(c => c[2]?.id !== firstId && c[1]?.type === 'merge-conflict')).toBe(true)
    } finally { f.cleanup() }
  })

  it('writes a projected worker edit-in-claim slot in team and posts to workers room', async () => {
    const f = fixture()
    try {
      f.holder('L'); f.holder('W', 'L'); f.holder('B')
      f.entry('L', undefined)
      f.entry('W', 'worker\n', false, 'L')
      f.entry('B', undefined)
      f.room.addClaim({ by: 'B', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'edit' }, { name: 'B', kind: 'agent' })
      const team = f.session('L'), workersPost = vi.fn().mockResolvedValue({ ok: true })
      await reconcileProjectedConflicts({ team, workers: f.session('L', workersPost), owner: 'W' })
      const slots = [...f.room.doc.getMap<{ owner: string; kind: string; status: string }>('conflicts').values()]
      expect(slots).toContainEqual(expect.objectContaining({ owner: 'W', kind: 'edit-in-claim', status: 'conflict' }))
      expect(workersPost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: 'W', type: 'conflict' }), expect.objectContaining({ id: expect.stringMatching(/^cf:/), auto: true }))
    } finally { f.cleanup() }
  })

  it('maps two claims through different file texts before testing overlap', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B')
      f.entry('A', 'inserted\nold\n')
      f.entry('B', undefined)
      const a = f.room.addClaim({ by: 'A', byKind: 'agent', path: 'x', from: 2, to: 2, intent: 'old line' })
      const b = f.room.addClaim({ by: 'B', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'old line' })
      await new ConflictSet(f.session('A')).reconcile('claims')
      expect(f.room.doc.getMap<{ status: string }>('conflicts').get(slotKey('A', 'claims', 'B', 'x', `${a.id}\0${b.id}`))?.status).toBe('conflict')
    } finally { f.cleanup() }
  })

  it('treats a directory claim as covering a changed file beneath it', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B')
      f.entry('A', 'changed\n'); f.entry('B', undefined)
      f.room.addClaim({ by: 'B', byKind: 'agent', path: './', from: 1, to: Number.MAX_SAFE_INTEGER, intent: 'whole tree' })
      await new ConflictSet(f.session('A')).reconcile('directory claim')
      expect([...f.room.doc.getMap<{ kind: string; status: string }>('conflicts').values()]).toContainEqual(
        expect.objectContaining({ kind: 'edit-in-claim', status: 'conflict' }))
    } finally { f.cleanup() }
  })

  it('notifies again when a conflicting contract changes signature a second time', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B')
      f.entry('A', 'call()\n')
      f.entry('B', undefined)
      const graph = (detail: string) => ({ version: 1 as const, base: f.base, at: 1, status: 'ready' as const,
        paths: ['x', 'api.py'], edges: [{ source: 'api.py', target: 'x', symbols: ['call'] }],
        observed: [{ path: 'api.py', symbol: 'call', kind: 'signature' as const, detail }], truncated: false })
      f.room.graphs.set('B', graph('call(a) → call(a, b)'))
      await new ConflictSet(f.session('A')).reconcile('graph')
      const key = slotKey('A', 'contract', 'B', 'api.py', 'call')
      expect(f.room.doc.getMap<{ epoch: number }>('conflicts').get(key)?.epoch).toBe(1)
      f.room.graphs.set('B', graph('call(a) → call(a, b, c)'))
      await new ConflictSet(f.session('A')).reconcile('graph')
      expect(f.room.doc.getMap<{ epoch: number }>('conflicts').get(key)?.epoch).toBe(2)
    } finally { f.cleanup() }
  })

  it('checks a worker against its carried baseline when the lead changes a definition', async () => {
    const f = fixture()
    try {
      f.holder('W'); f.holder('B')
      f.entry('W', undefined); f.entry('B', undefined)
      const oldText = 'def call(a):\n    return a\n'
      const newText = 'def call(a, b):\n    return a + b\n'
      const consumer = 'from api import call\ncall(1)\n'
      const blob = execFileSync('git', ['-C', f.dir, 'hash-object', '-w', '--stdin'], { input: oldText, encoding: 'utf8' }).trim()
      const add = (name: string, path: string, text: string) => {
        f.room.manifest.get(manifestKey(name, `lease-${name}`))!.set(path, { change: 'A', state: 'shared', hash: gitBlobHash(text), at: 1, fence: `lease-${name}` })
        f.room.setOverlay(manifestKey(name, `lease-${name}`), path, text)
      }
      add('W', 'consumer.py', consumer)
      add('B', 'api.py', newText)
      const baseline = { worker: 'W', sha: f.base, dir: f.dir, carriedCommit: false,
        untracked: new Map([['api.py', { sha: blob }]]) }
      await new ConflictSet(f.session('W'), 'W', f.session('W'), () => {}, 0,
        person => person === 'W' ? { baseline, lead: 'B' } : undefined).reconcile('carried')
      const key = slotKey('W', 'contract', 'B', 'api.py', 'call')
      expect(f.room.doc.getMap<{ status: string }>('conflicts').get(key)?.status).toBe('conflict')
      expect(f.post.mock.calls.some(c => c[1]?.type === 'contract' && c[1]?.to === 'W')).toBe(true)
    } finally { f.cleanup() }
  })

  it('reports degraded carried contract coverage by deterministic id', async () => {
    const f = fixture()
    try {
      f.holder('W'); f.holder('B')
      f.entry('W', undefined); f.entry('B', undefined)
      const text = 'def call(a, b):\n    return a + b\n'
      f.room.manifest.get(manifestKey('B', 'lease-B'))!.set('api.py', { change: 'A', state: 'shared', hash: gitBlobHash(text), at: 1, fence: 'lease-B' })
      f.room.setOverlay(manifestKey('B', 'lease-B'), 'api.py', text)
      const baseline = { worker: 'W', sha: f.base, dir: f.dir, carriedCommit: false,
        untracked: new Map([['api.py', { sha: '0000000000000000000000000000000000000000' }]]) }
      const check = () => new ConflictSet(f.session('W'), 'W', f.session('W'), () => {}, 0,
        person => person === 'W' ? { baseline, lead: 'B' } : undefined).reconcile('carried')
      await check(); await check()
      const degraded = f.post.mock.calls.filter(c => c[1]?.type === 'note' && c[1]?.text?.includes('contract coverage degraded'))
      expect(degraded.length).toBe(2)
      expect(degraded[0][2].id).toBe(degraded[1][2].id)
    } finally { f.cleanup() }
  })
})
