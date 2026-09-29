import { describe, expect, it, vi } from 'vitest'
import { RoomDoc, formatMsg } from '@room/shared'
import { digestPath, gitBlobHash, manifestKey } from '@room/shared'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConflictSet, ConflictSlots, reconcileProjectedConflicts, slotKey, noticeId } from '../src/conflict-set.js'
import { epochPublication } from '@room/shared/testing'
import type { Session } from '../src/session.js'

describe('ConflictSlots', () => {
  it('reconciles a pre-existing conflict once and replays the same id after a hub outage', async () => {
    const room = new RoomDoc()
    const post = vi.fn().mockResolvedValueOnce({ ok: false, text: 'unreachable' }).mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, '1')
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
    const slots = new ConflictSlots(room, post, '1')
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
    const slots = new ConflictSlots(room, post, '1')
    const key = slotKey('a', 'merge', 'b', 'x')
    await slots.settle(key, { status: 'possible', inputs: 'stable', factId: 'possible', path: 'x', owner: 'a', other: 'b', kind: 'merge' })
    await slots.settle(key, { status: 'possible', inputs: 'stable', factId: 'possible', path: 'x', owner: 'a', other: 'b', kind: 'merge' })
    expect(post).toHaveBeenCalledTimes(1)
    expect(room.doc.getMap('conflicts').get(key)).toMatchObject({ status: 'possible', epoch: 1 })
  })

  it('does not renotify unchanged conflicting hunks after an input edit', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, '1')
    const key = slotKey('a', 'merge', 'b', 'x')
    const base = { status: 'conflict' as const, factId: 'same-hunks', path: 'x', owner: 'a', other: 'b', kind: 'merge' as const }
    await slots.settle(key, { ...base, inputs: 'before' })
    await slots.settle(key, { ...base, inputs: 'after' })
    expect(post).toHaveBeenCalledTimes(1)
    expect(slots.get(key)?.epoch).toBe(1)
  })

  it('advances after clean then unknown then conflict', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, '1')
    const key = slotKey('a', 'merge', 'b', 'x')
    const base = { factId: 'hunks', path: 'x', owner: 'a', other: 'b', kind: 'merge' as const }
    await slots.settle(key, { ...base, status: 'conflict', inputs: '1' })
    await slots.settle(key, { ...base, status: 'clean', inputs: '2' })
    await slots.settle(key, { ...base, status: 'unknown', inputs: '3' })
    await slots.settle(key, { ...base, status: 'conflict', inputs: '4' })
    expect(slots.get(key)?.epoch).toBe(2)
    expect(post.mock.calls.map(c => c[2].id)).toEqual([noticeId(key, 1), `${noticeId(key, 1)}:clean`, noticeId(key, 2)])
  })

  it('describes the held owner instead of blaming the other participant', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, '1')
    await slots.settle(slotKey('A', 'merge', 'B', 'x'), { owner: 'A', other: 'B', kind: 'merge', path: 'x', status: 'possible', inputs: 'i', factId: 'f', why: 'A' })
    expect(post.mock.calls[0][1].text).toContain('A changed x too, outside their declared area')
  })

  it('routes a claim holder notice to the holder room with the holder perspective', async () => {
    const room = new RoomDoc(), ownerPost = vi.fn().mockResolvedValue({ ok: true }), holderPost = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, ownerPost, '1', Date.now, () => {}, holderPost)
    const key = slotKey('W', 'edit-in-claim', 'B', 'x', 'claim')
    await slots.settle(key, { owner: 'W', other: 'B', kind: 'edit-in-claim', path: 'x', subject: 'claim', status: 'conflict', inputs: 'i', factId: 'f' })
    await slots.replay('W')
    expect(ownerPost.mock.calls.every(c => c[1].to === 'W')).toBe(true)
    expect(holderPost.mock.calls.every(c => c[1].to === 'B' && c[1].text.includes('W edited x inside your claim'))).toBe(true)
  })

  it('re-fences an unchanged slot for a new owner epoch without sending a duplicate fact', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    let fence = '1'
    const slots = new ConflictSlots(room, post, () => fence)
    const key = slotKey('A', 'contract', 'B', 'api.py', 'call')
    const result = { owner: 'A', other: 'B', kind: 'contract' as const, path: 'api.py', subject: 'call', status: 'conflict' as const, inputs: 'same', factId: 'same' }
    await slots.settle(key, result)
    fence = '2'
    await slots.settle(key, result)
    expect(slots.get(key)).toMatchObject({ fence: '2', epoch: 1 })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('R5 repairs a legacy empty-fence slot on the first valid owner evaluation', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    const key = slotKey('A', 'contract', 'B', 'api.py', 'call')
    const result = { owner: 'A', other: 'B', kind: 'contract' as const, path: 'api.py', subject: 'call', status: 'conflict' as const, inputs: 'same', factId: 'same' }
    await new ConflictSlots(room, post, '').settle(key, result)
    await new ConflictSlots(room, post, () => '42').settle(key, result)
    expect(room.doc.getMap<{ fence: string; epoch: number }>('conflicts').get(key)).toMatchObject({ fence: '42', epoch: 1 })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('revalidates each replay notice after an awaited post moves the lease', async () => {
    const room = new RoomDoc()
    let current = true, replaying = false
    const post = vi.fn().mockImplementation(async () => { if (replaying) current = false; return { ok: true } })
    const slots = new ConflictSlots(room, post, '1', Date.now, () => {}, post, () => current)
    for (const path of ['x', 'y']) await slots.settle(slotKey('A', 'merge', 'B', path),
      { owner: 'A', other: 'B', kind: 'merge', path, status: 'conflict', inputs: path, factId: path })
    post.mockClear(); replaying = true
    await slots.replay('A')
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('does not send the holder copy after the owner post invalidates the captured claim', async () => {
    const room = new RoomDoc(), holderPost = vi.fn().mockResolvedValue({ ok: true })
    let current = true
    const ownerPost = vi.fn().mockImplementation(async () => { current = false; return { ok: true } })
    const slots = new ConflictSlots(room, ownerPost, '1', Date.now, () => {}, holderPost, () => current)
    const key = slotKey('W', 'edit-in-claim', 'B', 'x', 'claim')
    await slots.settle(key, { owner: 'W', other: 'B', kind: 'edit-in-claim', path: 'x', subject: 'claim', status: 'conflict', inputs: 'i', factId: 'f' })
    expect(ownerPost).toHaveBeenCalledTimes(1)
    expect(holderPost).not.toHaveBeenCalled()
  })

  it('labels a cleared possibility without claiming a certified conflict existed', async () => {
    const room = new RoomDoc(), post = vi.fn().mockImplementation(async (_from, body) => ({ ok: true, msg: { ...body, id: 'm', from: 'room', fromKind: 'agent', at: 1 } }))
    const slots = new ConflictSlots(room, post, '1')
    const key = slotKey('A', 'merge', 'B', 'x')
    const base = { owner: 'A', other: 'B', kind: 'merge' as const, path: 'x' }
    await slots.settle(key, { ...base, status: 'possible', inputs: 'held', factId: 'f' })
    await slots.settle(key, { ...base, status: 'clean', inputs: 'readable', factId: '' })
    expect(post.mock.calls[1][1]).toMatchObject({ clearedFrom: 'possible' })
    expect(formatMsg(post.mock.calls[1][1] as any)).toContain('POSSIBLE conflict cleared')
    const certified = slotKey('A', 'merge', 'C', 'y')
    await slots.settle(certified, { owner: 'A', other: 'C', kind: 'merge', path: 'y', status: 'conflict', inputs: 'bad', factId: 'f' })
    await slots.settle(certified, { owner: 'A', other: 'C', kind: 'merge', path: 'y', status: 'clean', inputs: 'good', factId: '' })
    expect(formatMsg(post.mock.calls[3][1] as any)).toContain('CONFLICT cleared')
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
    const holder = (name: string, projectedBy?: string, epoch = 1) => {
      const fence = epochPublication(room, name, base, epoch)
      room.participants.set(`${name}\0id`, { name, kind: 'agent' })
      if (projectedBy) room.participants.set(`${name}\0proj`, { projectedBy, projectedFrom: 'w' })
      states.set(next++, { user: { name, kind: 'agent' }, sessionId: `session-${name}` })
      return fence
    }
    const entry = (name: string, text: string | undefined, held = false, projectedBy?: string, epoch = 1) => {
      const fence = String(epoch)
      room.manifestHead.set(name, { base, fence, coverage: { kind: 'all' }, level: 'declared', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true, ...(projectedBy ? { projectedBy, projectedFrom: 'w' } : {}) })
      const values = new Y.Map<{ change: 'M'; state: 'shared' | 'held'; hash?: string; held?: 'scope'; at: number; fence: string }>()
      if (text !== undefined || held) values.set('x', { change: 'M', state: held ? 'held' : 'shared', ...(text ? { hash: gitBlobHash(text) } : {}), ...(held ? { held: 'scope' as const } : {}), at: 1, fence })
      room.manifest.set(manifestKey(name, fence), values)
      if (text !== undefined) room.setOverlay(manifestKey(name, fence), 'x', text)
    }
    const post = vi.fn().mockImplementation((from, body, opts) => Promise.resolve({ ok: true, msg: { ...body, ...opts } }))
    const localFence = { value: '1' as string | undefined }
    const session = (name: string, posting = post) => ({ room, awareness: { getStates: () => states } as unknown as Awareness,
      provider: { synced: true, on() {}, off() {} }, me: { name, kind: 'agent' }, dir, post: posting,
      lease: { fence: () => localFence.value } }) as unknown as Session
    return { room, base, dir, holder, entry, post, session, localFence, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  }

  it('writes the current owner epoch into slots and stops while its local lease is paused', async () => {
    const f = fixture()
    try {
      f.holder('A', undefined, 101); f.holder('B', undefined, 102)
      f.entry('A', 'A\n', false, undefined, 101); f.entry('B', 'B\n', false, undefined, 102)
      f.localFence.value = '100'
      const set = new ConflictSet(f.session('A'))
      const key = slotKey('A', 'merge', 'B', 'x')
      await set.reconcile('old local lease')
      expect(f.room.doc.getMap('conflicts').has(key)).toBe(false)
      f.localFence.value = '101'
      await set.reconcile('initial')
      expect(f.room.doc.getMap<{ fence: string }>('conflicts').get(key)?.fence).toBe('101')
      f.localFence.value = undefined
      f.room.doc.getMap('conflicts').delete(key)
      await set.reconcile('paused')
      expect(f.room.doc.getMap('conflicts').has(key)).toBe(false)
    } finally { f.cleanup() }
  })

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
      const held = f.room.manifest.get(manifestKey('B', '1'))!.get('x')!
      f.room.manifest.get(manifestKey('B', '1'))!.set('x', { ...held, at: 4 })
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
      const slots = [...f.room.doc.getMap<{ owner: string; kind: string; status: string; fence: string }>('conflicts').values()]
      expect(slots).toContainEqual(expect.objectContaining({ owner: 'W', kind: 'edit-in-claim', status: 'conflict', fence: '1' }))
      expect(workersPost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: 'W', type: 'conflict' }), expect.objectContaining({ id: expect.stringMatching(/^cf:/), auto: true }))
    } finally { f.cleanup() }
  })

  it('reads a fresh projected held worker edit from its workers room without a stored Git blob', async () => {
    const f = fixture()
    try {
      f.holder('L'); f.holder('W', 'L'); f.holder('B')
      f.entry('L', undefined); f.entry('W', undefined, false, 'L'); f.entry('B', undefined)
      const projected = f.room.manifest.get(manifestKey('W', '1'))!
      projected.set('x', { change: 'M', state: 'held', hash: gitBlobHash('worker\n'), held: 'worker', at: 1, fence: '1' })
      f.room.addClaim({ by: 'B', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'edit' })
      const source = new RoomDoc(), sourcePost = vi.fn().mockResolvedValue({ ok: true })
      source.participants.set('W\0holder', { sessionId: 'session-W', epoch: 2, workerId: 'w' })
      source.participants.set('W\0git', { branch: 'main', head: f.base, base: f.base, anchored: true, rev: 1, fence: '2' })
      source.manifestHead.set('W', { base: f.base, fence: '2', coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })
      const sourceEntries = new Y.Map<any>()
      sourceEntries.set('x', { change: 'M', state: 'shared', hash: gitBlobHash('worker\n'), at: 1, fence: '2' })
      source.manifest.set(manifestKey('W', '2'), sourceEntries)
      source.setOverlay(manifestKey('W', '2'), 'x', 'worker\n')
      const workers = { ...f.session('L', sourcePost), room: source } as Session
      await reconcileProjectedConflicts({ team: f.session('L'), workers, owner: 'W' })
      expect(f.room.doc.getMap<any>('conflicts').get(slotKey('W', 'edit-in-claim', 'B', 'x', f.room.openClaims()[0]!.id))?.status).toBe('conflict')
      expect(sourcePost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: 'W' }), expect.anything())
      expect(f.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: 'B', text: expect.stringContaining('W edited x inside your claim') }), expect.anything())
    } finally { f.cleanup() }
  })

  it('does not clear a certified conflict after a changed path becomes excluded', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B'); f.entry('A', 'A\n'); f.entry('B', 'B\n')
      await new ConflictSet(f.session('A')).reconcile('initial')
      const key = slotKey('A', 'merge', 'B', 'x')
      expect(f.room.doc.getMap<any>('conflicts').get(key)?.status).toBe('conflict')
      f.room.manifest.get(manifestKey('B', '1'))!.delete('x')
      const head = f.room.manifestHead.get('B')!
      f.room.manifestHead.set('B', { ...head, semRev: 2, excluded: [digestPath(f.room.roomSalt!, 'x')] })
      await new ConflictSet(f.session('A')).reconcile('excluded')
      expect(f.room.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'unknown', settled: 'conflict' })
    } finally { f.cleanup() }
  })

  it('evaluates non-publisher claims using its publisher version', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B'); f.entry('A', 'changed\n'); f.entry('B', undefined)
      const head = f.room.manifestHead.get('B')!
      f.room.manifestHead.set('B', { ...head, coverage: { kind: 'none', reason: 'not-publisher' }, publisher: 'A' })
      f.room.participants.delete('B\0git') // a non-publisher need not publish a Git fact
      f.room.addClaim({ by: 'B', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'edit' })
      await new ConflictSet(f.session('A')).reconcile('non-publisher')
      expect([...f.room.doc.getMap<any>('conflicts').values()]).toContainEqual(expect.objectContaining({ owner: 'A', other: 'B', kind: 'edit-in-claim', status: 'conflict' }))
    } finally { f.cleanup() }
  })

  it('evaluates the owner non-publisher claims through its publisher without a Git fact', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B'); f.entry('A', 'changed\n'); f.entry('B', undefined)
      const head = f.room.manifestHead.get('B')!
      f.room.manifestHead.set('B', { ...head, coverage: { kind: 'none', reason: 'not-publisher' }, publisher: 'A' })
      f.room.participants.delete('B\0git')
      f.room.addClaim({ by: 'A', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'edit' })
      f.room.addClaim({ by: 'B', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'edit' })
      await new ConflictSet(f.session('B')).reconcile('owner non-publisher')
      expect([...f.room.doc.getMap<any>('conflicts').values()]).toContainEqual(expect.objectContaining({ owner: 'B', other: 'A', kind: 'claims', status: 'conflict' }))
    } finally { f.cleanup() }
  })

  it('keeps large-file claim mapping possible rather than certified', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B')
      const old = Array.from({ length: 1001 }, (_, i) => `line ${i}`).join('\n') + '\n'
      f.entry('A', `inserted\n${old}`); f.entry('B', old)
      f.room.addClaim({ by: 'B', byKind: 'agent', path: 'x', from: 500, to: 500, intent: 'middle' })
      await new ConflictSet(f.session('A')).reconcile('large claim')
      const slot = [...f.room.doc.getMap<any>('conflicts').values()].find(s => s.kind === 'edit-in-claim')
      expect(slot?.status).toBe('possible')
      expect(f.post.mock.calls.some(c => c[1].type === 'conflict' && c[1].text.includes('line mapping is approximate'))).toBe(true)
    } finally { f.cleanup() }
  })

  it('abandons a conflict if sharing narrows during the merge budget await', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B'); f.entry('A', 'A\n'); f.entry('B', 'B\n')
      const set = new ConflictSet(f.session('A'))
      ;(set as any).budget = async () => {
        const head = f.room.manifestHead.get('B')!
        f.room.manifestHead.set('B', { ...head, semRev: head.semRev + 1, coverage: { kind: 'none', reason: 'intent' } })
      }
      await set.reconcile('narrowed')
      expect(f.room.doc.getMap<any>('conflicts').get(slotKey('A', 'merge', 'B', 'x'))?.status).not.toBe('conflict')
      expect(f.post.mock.calls.some(c => c[1].type === 'merge-conflict' && c[1].priority === 'notify')).toBe(false)
    } finally { f.cleanup() }
  })

  it('honours the unknown retry deadline until inputs change', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B'); f.entry('A', 'A\n'); f.entry('B', 'B\n')
      const head = f.room.manifestHead.get('B')!
      f.room.manifestHead.set('B', { ...head, coverage: { kind: 'none', reason: 'intent' } })
      const set = new ConflictSet(f.session('A'))
      await set.reconcile('first')
      const key = slotKey('A', 'merge', 'B', '*'), before = f.room.doc.getMap<any>('conflicts').get(key)
      await set.reconcile('tick')
      expect(f.room.doc.getMap<any>('conflicts').get(key)).toBe(before)
      f.room.manifestHead.set('B', { ...head, semRev: 2 })
      await set.reconcile('changed')
      expect(f.room.doc.getMap<any>('conflicts').get(key)).not.toBe(before)
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
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', { change: 'A', state: 'shared', hash: gitBlobHash('from api import call\ncall()\n'), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', 'from api import call\ncall()\n')
      f.room.manifest.get(manifestKey('B', '1'))!.set('api.py', { change: 'A', state: 'shared', hash: gitBlobHash('def call(a, b):\n    pass\n'), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('B', '1'), 'api.py', 'def call(a, b):\n    pass\n')
      const graph = (detail: string) => ({ version: 1 as const, base: f.base, sourceFence: '1', sourceRev: 1, at: 1, status: 'ready' as const,
        paths: ['consumer.py', 'api.py'], edges: [{ source: 'api.py', target: 'consumer.py', symbols: ['call'] }],
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

  it('N2 preserves contract notice epochs through redaction without clearing a restored conflict', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B'); f.entry('A', undefined); f.entry('B', undefined)
      const consumer = 'from api import call\ncall(1)\n'
      const entriesA = f.room.manifest.get(manifestKey('A', '1'))!
      entriesA.set('consumer.py', { change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', consumer)
      const entriesB = f.room.manifest.get(manifestKey('B', '1'))!
      const provider = 'def call(a, b):\n    pass\n'
      entriesB.set('api.py', { change: 'A', state: 'shared', hash: gitBlobHash(provider), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('B', '1'), 'api.py', provider)
      const sent = new Set<string>(), accepted: string[] = []
      f.post.mockImplementation(async (_from, _body, opts) => {
        if (!sent.has(opts.id)) { sent.add(opts.id); accepted.push(opts.id) }
        return { ok: true }
      })
      const graph = (detail: string, rev: number) => ({ version: 1 as const, base: f.base, sourceFence: '1', sourceRev: rev, at: rev, status: 'ready' as const,
        paths: ['api.py', 'consumer.py'], edges: [{ source: 'api.py', target: 'consumer.py', symbols: ['call'] }],
        observed: [{ path: 'api.py', symbol: 'call', kind: 'signature' as const, detail }], truncated: false })
      f.room.graphs.set('B', graph('call(a) → call(a, b)', 1))
      await new ConflictSet(f.session('A')).reconcile('first')
      const key = slotKey('A', 'contract', 'B', 'api.py', 'call')
      expect(accepted).toContain(noticeId(key, 1))
      f.room.graphs.set('B', graph('call(a) → call(a, b, c)', 1))
      await new ConflictSet(f.session('A')).reconcile('second')
      expect(accepted).toContain(noticeId(key, 2))
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, rev: 2 })
      await new ConflictSet(f.session('A')).reconcile('redacted')
      expect(f.room.doc.getMap<any>('conflicts').get(key)).toBeUndefined()
      f.room.graphs.set('B', graph('call(a) → call(a, b, c, d)', 2))
      await new ConflictSet(f.session('A')).reconcile('restored')
      expect(f.room.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'conflict', epoch: 3 })
      expect(accepted).toContain(noticeId(key, 3))
      expect(f.post.mock.calls.filter(c => c[1]?.type === 'contract' && c[1]?.text?.includes('cleared'))).toEqual([])
      expect(f.room.doc.getMap<any>('conflicts').has(slotKey('A', 'contract', 'B', 'api.py', '*'))).toBe(false)
    } finally { f.cleanup() }
  })

  it.each([
    { name: 'untracked API removal', before: 'def call(a):\n    return a\n', after: undefined, tracked: false },
    { name: 'tracked signature revert', before: 'def call(a, b):\n    return a + b\n', after: 'def call(a):\n    return a\n', tracked: true },
  ])('N3 notifies a carried worker after the lead\'s $name', async ({ before, after, tracked }) => {
    const f = fixture()
    try {
      f.holder('W'); f.holder('B'); f.entry('W', undefined); f.entry('B', undefined)
      const consumer = 'from api import call\ncall(1)\n'
      f.room.manifest.get(manifestKey('W', '1'))!.set('consumer.py', { change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('W', '1'), 'consumer.py', consumer)
      let sha = f.base
      const untracked = new Map<string, { sha: string }>()
      if (tracked) {
        writeFileSync(join(f.dir, 'api.py'), after!)
        execFileSync('git', ['-C', f.dir, 'add', 'api.py'])
        execFileSync('git', ['-C', f.dir, 'commit', '-qm', 'base api'])
        sha = execFileSync('git', ['-C', f.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
        writeFileSync(join(f.dir, 'api.py'), before)
        execFileSync('git', ['-C', f.dir, 'add', 'api.py'])
        execFileSync('git', ['-C', f.dir, 'commit', '-qm', 'carried signature'])
        const carried = execFileSync('git', ['-C', f.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
        f.room.participants.set('W\0git', { ...f.room.participants.get('W\0git')!, base: carried, head: carried })
        f.room.manifestHead.set('W', { ...f.room.manifestHead.get('W')!, base: carried })
      } else {
        const blob = execFileSync('git', ['-C', f.dir, 'hash-object', '-w', '--stdin'], { input: before, encoding: 'utf8' }).trim()
        untracked.set('api.py', { sha: blob })
      }
      const baseline = { worker: 'W', sha: tracked ? execFileSync('git', ['-C', f.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() : sha,
        dir: f.dir, carriedCommit: tracked, untracked }
      f.room.participants.set('B\0git', { ...f.room.participants.get('B\0git')!, base: sha, head: sha })
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, base: sha, level: 'full' })
      await new ConflictSet(f.session('W'), 'W', f.session('W'), () => {}, 0,
        person => person === 'W' ? { baseline, lead: 'B' } : undefined).reconcile('reverted')
      const key = slotKey('W', 'contract', 'B', 'api.py', 'call')
      expect(f.room.doc.getMap<any>('conflicts').get(key)?.status).toBe('conflict')
      expect(f.post.mock.calls.some(c => c[1]?.type === 'contract' && c[1]?.to === 'W')).toBe(true)
    } finally { f.cleanup() }
  })

  it('does not certify a stale contract graph after the provider becomes hashless held', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B')
      f.entry('A', 'call()\n'); f.entry('B', undefined)
      f.room.manifest.get(manifestKey('B', '1'))!.set('api.py', { change: 'M', state: 'held', held: 'scope', at: 1, fence: '1' })
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, rev: 2, semRev: 2, textPrefixes: [] })
      f.room.graphs.set('B', { version: 1, base: f.base, sourceFence: '1', sourceRev: 1, at: 1, status: 'ready',
        paths: ['x', 'api.py'], edges: [{ source: 'api.py', target: 'x', symbols: ['call'] }],
        observed: [{ path: 'api.py', symbol: 'call', kind: 'signature', detail: 'now secret_customer' }], truncated: false })
      await new ConflictSet(f.session('A')).reconcile('narrowed')
      expect([...f.room.doc.getMap<any>('conflicts').values()].filter(slot => slot.kind === 'contract' && slot.status === 'conflict')).toEqual([])
      expect(f.post.mock.calls.some(call => call[1]?.type === 'contract')).toBe(false)
    } finally { f.cleanup() }
  })

  it('does not trust an old graph edge after the consumer stops using the symbol', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B')
      f.entry('A', undefined); f.entry('B', undefined)
      const consumer = 'print("done")\n'
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', { change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', consumer)
      const provider = 'def call(a, b):\n    pass\n'
      f.room.manifest.get(manifestKey('B', '1'))!.set('api.py', { change: 'A', state: 'shared', hash: gitBlobHash(provider), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('B', '1'), 'api.py', provider)
      f.room.graphs.set('B', { version: 1, base: f.base, sourceFence: '1', sourceRev: 1, at: 1, status: 'ready',
        paths: ['consumer.py', 'api.py'], edges: [{ source: 'api.py', target: 'consumer.py', symbols: ['call'] }],
        observed: [{ path: 'api.py', symbol: 'call', kind: 'signature', detail: 'call(a) → call(a, b)' }], truncated: false })
      await new ConflictSet(f.session('A')).reconcile('consumer changed')
      expect(f.room.doc.getMap('conflicts').get(slotKey('A', 'contract', 'B', 'api.py', 'call'))).toBeUndefined()
      expect(f.post.mock.calls.some(call => call[1]?.type === 'contract')).toBe(false)
    } finally { f.cleanup() }
  })

  it('retains settled contract evidence without restricted signature detail when observations disappear', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B')
      f.entry('A', 'call()\n'); f.entry('B', undefined)
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', { change: 'A', state: 'shared', hash: gitBlobHash('from api import call\ncall()\n'), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', 'from api import call\ncall()\n')
      const provider = f.room.manifest.get(manifestKey('B', '1'))!
      provider.set('api.py', { change: 'A', state: 'shared', hash: gitBlobHash('def call(a, b):\n    pass\n'), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('B', '1'), 'api.py', 'def call(a, b):\n    pass\n')
      f.room.graphs.set('B', { version: 1, base: f.base, sourceFence: '1', sourceRev: 1, at: 1, status: 'ready',
        paths: ['consumer.py', 'api.py'], edges: [{ source: 'api.py', target: 'consumer.py', symbols: ['call'] }],
        observed: [{ path: 'api.py', symbol: 'call', kind: 'signature', detail: 'now secret_customer' }], truncated: false })
      const live = new ConflictSet(f.session('A'))
      await live.reconcile('visible')
      expect(f.room.doc.getMap<any>('conflicts').get(slotKey('A', 'contract', 'B', 'api.py', 'call'))?.status).toBe('conflict')
      const beforeNotices = f.post.mock.calls.filter(call => call[1]?.type === 'contract').length
      live.start()
      provider.set('api.py', { change: 'M', state: 'held', held: 'scope', at: 2, fence: '1' })
      f.room.clearOverlay(manifestKey('B', '1'), 'api.py')
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, rev: 2, semRev: 2, textPrefixes: [] })
      expect(JSON.stringify([...f.room.doc.getMap('conflicts').entries()])).not.toContain('secret_customer')
      f.room.graphs.set('B', { version: 1, base: f.base, sourceFence: '1', sourceRev: 2, at: 2, status: 'ready', paths: [], edges: [], observed: [], truncated: false })
      await new ConflictSet(f.session('A')).reconcile('withdrawn')
      const slots = [...f.room.doc.getMap<any>('conflicts').entries()].filter(([, slot]) => slot.kind === 'contract')
      expect(slots).toHaveLength(1)
      expect(slots[0]![1]).toMatchObject({ status: 'unknown', settled: 'conflict', subject: '*', why: expect.stringContaining('not readable') })
      expect(JSON.stringify(slots)).not.toContain('secret_customer')
      expect(f.post.mock.calls.slice(beforeNotices).filter(call => call[1]?.type === 'contract').every(call => !JSON.stringify(call[1]).includes('secret_customer'))).toBe(true)
      live.stop()
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
        f.room.manifest.get(manifestKey(name, '1'))!.set(path, { change: 'A', state: 'shared', hash: gitBlobHash(text), at: 1, fence: '1' })
        f.room.setOverlay(manifestKey(name, '1'), path, text)
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

  it.each([
    { worker: 'carried\n', lead: undefined, expected: undefined, name: 'carried-only' },
    { worker: 'worker edit\n', lead: undefined, expected: 'possible', name: 'worker-modified' },
    { worker: 'carried\n', lead: 'old\n', expected: undefined, name: 'lead-reverted' },
  ])('compares $name merge candidates against the carried starting tree', async ({ worker, lead, expected }) => {
    const f = fixture()
    try {
      f.holder('W'); f.holder('B')
      writeFileSync(join(f.dir, 'x'), 'carried\n')
      execFileSync('git', ['-C', f.dir, 'add', 'x'])
      execFileSync('git', ['-C', f.dir, 'commit', '-qm', 'carried'])
      const carried = execFileSync('git', ['-C', f.dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      const git = f.room.participants.get('W\0git') as any
      f.room.participants.set('W\0git', { ...git, head: carried, base: carried, rev: git.rev + 1 })
      f.entry('W', worker)
      f.room.manifestHead.set('W', { ...f.room.manifestHead.get('W')!, base: carried })
      f.entry('B', lead, lead === undefined)
      const baseline = { worker: 'W', sha: carried, dir: f.dir, carriedCommit: true, untracked: new Map() }
      await new ConflictSet(f.session('W'), 'W', f.session('W'), () => {}, 0,
        person => person === 'W' ? { baseline, lead: 'B' } : undefined).reconcile('carried merge')
      expect(f.room.doc.getMap<any>('conflicts').get(slotKey('W', 'merge', 'B', 'x'))?.status).toBe(expected)
    } finally { f.cleanup() }
  })

  it('reports degraded carried contract coverage by deterministic id', async () => {
    const f = fixture()
    try {
      f.holder('W'); f.holder('B')
      f.entry('W', undefined); f.entry('B', undefined)
      const text = 'def call(a, b):\n    return a + b\n'
      f.room.manifest.get(manifestKey('B', '1'))!.set('api.py', { change: 'A', state: 'shared', hash: gitBlobHash(text), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('B', '1'), 'api.py', text)
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
