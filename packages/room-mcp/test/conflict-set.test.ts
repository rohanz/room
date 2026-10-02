import { describe, expect, it, vi } from 'vitest'
import { RoomDoc, formatMsg, snapshot } from '@room/shared'
import { digestPath, gitBlobHash, manifestKey } from '@room/shared'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ConflictSet, ConflictSlots, reconcileProjectedConflicts, slotKey, noticeId } from '../src/conflict-set.js'
import { GraphIndex } from '../src/graph-index.js'
import { epochPublication } from '@room/shared/testing'
import type { Session } from '../src/session.js'
import { registrySnapshotForDir } from '../src/worker-registry.js'

async function waitForGraph(room: RoomDoc, name: string, rev: number): Promise<void> {
  const deadline = Date.now() + 3000
  while (room.graphs.get(name)?.status !== 'ready' || room.graphs.get(name)?.sourceRev !== rev) {
    if (Date.now() >= deadline) throw new Error('graph did not publish expected revision')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitForGraphStatus(room: RoomDoc, name: string, status: 'ready' | 'error'): Promise<void> {
  const deadline = Date.now() + 3000
  while (room.graphs.get(name)?.status !== status) {
    if (Date.now() >= deadline) throw new Error(`graph did not become ${status}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function contractNoticeId(room: RoomDoc, key: string, epoch = 1): string {
  return noticeId(key, epoch, room.doc.getMap<{ episode?: string }>('conflicts').get(key)?.episode)
}

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
    expect(post.mock.calls.map(c => c[2].id)).toEqual([noticeId(key, 1), expect.stringMatching(/^cf:.*:clean$/), noticeId(key, 2)])
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
    expect(post.mock.calls.map(c => c[2].id)).toEqual([noticeId(key, 1), expect.stringMatching(/^cf:.*:clean$/), noticeId(key, 2)])
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

  it('deduplicates cleared notices for the same peer and path and leaves the path to the formatter', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, '1')
    for (const kind of ['merge', 'edit-in-claim'] as const) {
      const key = slotKey('A', kind, 'B', 'x', kind === 'edit-in-claim' ? 'c' : '')
      const base = { owner: 'A', other: 'B', kind, path: 'x', ...(kind === 'edit-in-claim' ? { subject: 'c' } : {}) }
      await slots.settle(key, { ...base, status: 'possible', inputs: 'one', factId: 'f' })
      await slots.settle(key, { ...base, status: 'clean', inputs: 'two', factId: '' })
    }
    const cleared = post.mock.calls.filter(c => c[1].clearedFrom)
    expect(new Set(cleared.map(c => c[2].id)).size).toBe(1)
    expect(cleared[0][1].text).toBe('the possible conflict with B cleared')
  })

  it('uses notify for the lead when the claim holder is its running worker', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    room.workerViews.set('w', { id: 'w', tag: 'w', name: 'A+w', lead: 'A', mode: 'here', host: 'codex', task: 't', branch: 'b', status: 'running', run: 1, startedAt: 1, fence: '1' })
    const slots = new ConflictSlots(room, post, '1')
    await slots.settle(slotKey('A', 'edit-in-claim', 'A+w', 'x', 'c'), { owner: 'A', other: 'A+w', kind: 'edit-in-claim', path: 'x', subject: 'c', status: 'conflict', inputs: 'i', factId: 'f' })
    await slots.settle(slotKey('A', 'edit-in-claim', 'A+w', 'x', 'd'), { owner: 'A', other: 'A+w', kind: 'edit-in-claim', path: 'x', subject: 'd', status: 'conflict', inputs: 'i', factId: 'f' })
    expect(post.mock.calls[0][1].priority).toBe('notify')
    expect(new Set(post.mock.calls.filter(c => c[1].to === 'A').map(c => c[2].id)).size).toBe(1)
  })

  it("tells the lead when its running worker's clean overlap stops merging, within one burst", async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    room.workerViews.set('w', { id: 'w', tag: 'w', name: 'A+w', lead: 'A', mode: 'here', host: 'codex', task: 't', branch: 'b', status: 'running', run: 1, startedAt: 1, fence: '1' })
    const slots = new ConflictSlots(room, post, '1')
    const key = slotKey('A', 'edit-in-claim', 'A+w', 'x', 'c'), base = { owner: 'A', other: 'A+w', kind: 'edit-in-claim' as const, path: 'x', subject: 'c', status: 'conflict' as const }
    await slots.settle(key, { ...base, inputs: 'i1', factId: 'clean', merges: 'clean' })
    await slots.settle(key, { ...base, inputs: 'i2', factId: 'conflicting' })
    const toLead = [...new Map(post.mock.calls.filter(c => c[1].to === 'A').map(c => [c[2].id, c[1]])).values()]
    expect(toLead.map(body => formatMsg({ id: 'm', from: 'room', fromKind: 'bot', at: 1, ...body } as any).replace(/:.*/, '')))
      .toEqual(['[notify] overlap on x', '[notify] CONFLICT on x'])
    // And back: the burst's versions merge again, and the lead is told so.
    await slots.settle(key, { ...base, inputs: 'i3', factId: 'clean again', merges: 'clean' })
    const ids = post.mock.calls.filter(c => c[1].to === 'A').map(c => c[2].id)
    expect(new Set(ids).size).toBe(3)
    expect(post.mock.calls.filter(c => c[1].to === 'A').at(-1)![1].text).toMatch(/; merges cleanly$/)
  })

  it('replays a cleared overlap under the same id and wording after an unreadable pass', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, '1')
    const key = slotKey('A', 'edit-in-claim', 'B', 'x', 'c'), base = { owner: 'A', other: 'B', kind: 'edit-in-claim' as const, path: 'x', subject: 'c' }
    await slots.settle(key, { ...base, status: 'conflict', inputs: 'i1', factId: 'f', merges: 'clean' })
    await slots.settle(key, { ...base, status: 'clean', inputs: 'reverted', factId: '' })
    const cleared = post.mock.calls.at(-1)!
    await slots.settle(key, { ...base, status: 'unknown', inputs: 'unreadable', factId: '', why: 'cannot map claim' })
    await slots.replay('A')
    const replayed = post.mock.calls.at(-1)!
    expect(replayed[2].id).toBe(cleared[2].id)
    expect(formatMsg({ id: 'm', from: 'room', fromKind: 'bot', at: 1, ...replayed[1] } as any)).toContain('overlap cleared on x: the overlap with B cleared')
  })

  it('keeps an overlap an overlap through an unreadable pass, so its release says "overlap cleared"', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, '1')
    const key = slotKey('A', 'edit-in-claim', 'B', 'x', 'c'), base = { owner: 'A', other: 'B', kind: 'edit-in-claim' as const, path: 'x', subject: 'c' }
    await slots.settle(key, { ...base, status: 'conflict', inputs: 'i1', factId: 'f', merges: 'clean' })
    await slots.settle(key, { ...base, status: 'unknown', inputs: 'i2', factId: '', why: 'cannot map claim' })
    await slots.settle(key, { ...base, status: 'clean', inputs: 'released', factId: '' })
    const last = post.mock.calls.filter(c => c[1].to === 'A').at(-1)![1]
    expect(formatMsg({ id: 'm', from: 'room', fromKind: 'bot', at: 1, ...last } as any)).toContain('overlap cleared on x: the overlap with B cleared')
  })

  it('describes an earlier committed edit as preceding a new claim', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true }), holder = vi.fn().mockResolvedValue({ ok: true })
    const slots = new ConflictSlots(room, post, '1', Date.now, () => {}, holder)
    await slots.settle(slotKey('A', 'edit-in-claim', 'B', 'x', 'c'), { owner: 'A', other: 'B', kind: 'edit-in-claim', path: 'x', subject: 'c', status: 'conflict', inputs: 'i', factId: 'f', earlierSha: 'abc1234' })
    expect(post.mock.calls[0][1].text).toContain("your earlier change to x (abc1234) overlaps B's new claim")
    expect(holder.mock.calls[0][1].text).toContain("A's earlier change to x (abc1234) overlaps your new claim")
  })

  it('never replays an edit-in-claim notice about an own finished worker', async () => {
    const room = new RoomDoc(), post = vi.fn().mockResolvedValue({ ok: true })
    room.workerViews.set('w', { id: 'w', tag: 'w', name: 'A+w', lead: 'A', mode: 'here', host: 'codex', task: 't', branch: 'b', status: 'done', run: 1, startedAt: 1, fence: '1' })
    const slots = new ConflictSlots(room, post, '1')
    await slots.settle(slotKey('A', 'edit-in-claim', 'A+w', 'x', 'c'), { owner: 'A', other: 'A+w', kind: 'edit-in-claim', path: 'x', subject: 'c', status: 'conflict', inputs: 'i', factId: 'f' })
    await slots.replay('A')
    expect(post).not.toHaveBeenCalled()
  })
})

describe('derived pair slots', () => {
  function fixture(baseFiles: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'room-slot-'))
    const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
    run('init', '-q'); run('config', 'user.email', 't@t'); run('config', 'user.name', 't')
    writeFileSync(join(dir, 'x'), 'old\n')
    for (const [path, content] of Object.entries(baseFiles)) writeFileSync(join(dir, path), content)
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
      room.manifestHead.set(name, { base, fence, coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true, ...(projectedBy ? { projectedBy, projectedFrom: 'w' } : {}) })
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

  it('retries unchanged pair inputs after merge file creation throws', async () => {
    const f = fixture()
    f.holder('A'); f.holder('B'); f.entry('A', 'A\n'); f.entry('B', 'B\n')
    const set = new ConflictSet(f.session('A'), 'A', f.session('A'), () => {}, 0, () => undefined)
    const mkdir = vi.spyOn(fs, 'mkdtempSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('temporary ENOSPC'), { code: 'ENOSPC' })
    })
    try {
      await expect(set.reconcile('failed evaluation')).rejects.toThrow('temporary ENOSPC')
      expect(f.room.doc.getMap('conflicts').get(slotKey('A', 'merge', 'B', 'x'))).toBeUndefined()
      mkdir.mockRestore()
      await set.reconcile('retry unchanged inputs')
      expect(f.room.doc.getMap('conflicts').get(slotKey('A', 'merge', 'B', 'x'))).toMatchObject({ status: 'conflict' })
    } finally { mkdir.mockRestore(); set.stop(); f.room.doc.destroy(); f.cleanup() }
  })

  it('forgets prior completion when a due retry throws after withdrawing its unknown slot', async () => {
    const f = fixture()
    f.holder('A'); f.holder('B'); f.entry('A', 'A\n'); f.entry('B', 'B\n')
    const set = new ConflictSet(f.session('A'), 'A', f.session('A'), () => {}, 0, () => undefined)
    const slots = f.room.doc.getMap<import('../src/conflict-set.js').ConflictSlot>('conflicts')
    const key = slotKey('A', 'merge', 'B', 'x'), unknown = slotKey('A', 'merge', 'B', '*')
    let mkdir: ReturnType<typeof vi.spyOn> | undefined
    try {
      await set.reconcile('prior completed evaluation')
      slots.set(unknown, { ...slots.get(key)!, path: '*', status: 'unknown', settled: 'none', inputs: 'retry', retryAt: 0 })
      slots.delete(key)
      mkdir = vi.spyOn(fs, 'mkdtempSync').mockImplementationOnce(() => { throw new Error('temporary ENOSPC') })
      await expect(set.reconcile('due retry')).rejects.toThrow('temporary ENOSPC')
      expect(slots.get(unknown)).toBeUndefined()
      mkdir.mockRestore()
      await set.reconcile('retry unchanged inputs again')
      expect(slots.get(key)).toMatchObject({ status: 'conflict' })
    } finally { mkdir?.mockRestore(); set.stop(); f.room.doc.destroy(); f.cleanup() }
  })

  it('bounds a flush when triggers arrive throughout the check', async () => {
    const f = fixture(), set = new ConflictSet(f.session('A'), 'A', f.session('A'), () => {}, 0)
    let calls = 0
    vi.spyOn(set as unknown as { run(reason: string): Promise<void> }, 'run').mockImplementation(async () => {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (++calls < 9) void set.reconcile('inputs changed')
    })
    try {
      await set.flush()
      console.log(JSON.stringify({ checksBeforeFlushReturns: calls }))
      expect(calls).toBeLessThanOrEqual(2)
    } finally { set.stop(); f.room.doc.destroy(); f.cleanup() }
  })

  it('does no pair work for six participants publishing disjoint files or refreshing metadata', async () => {
    const f = fixture(), sets: ConflictSet[] = []
    const names = ['A', 'B', 'C', 'D', 'E', 'F']
    const runs: ReturnType<typeof vi.spyOn>[] = []
    try {
      for (const name of names) {
        f.holder(name); f.entry(name, undefined)
        f.room.manifest.get(manifestKey(name, '1'))!.set(name, { change: 'A', state: 'shared', hash: gitBlobHash(name), at: 1, fence: '1' })
        f.room.setOverlay(manifestKey(name, '1'), name, name)
      }
      for (const name of names) {
        const set = new ConflictSet(f.session(name), name, f.session(name), () => {}, 0, () => undefined)
        sets.push(set)
        runs.push(vi.spyOn(set as unknown as { run(reason: string): Promise<void> }, 'run'))
        set.start(); await set.flush()
      }
      await new Promise(resolve => setTimeout(resolve, 30))
      for (const run of runs) run.mockClear()
      for (let round = 0; round < 10; round++) {
        f.room.doc.transact(() => {
          for (const name of names) {
            const text = name + round
            f.room.setOverlay(manifestKey(name, '1'), name, text)
            f.room.manifest.get(manifestKey(name, '1'))!.set(name, { change: 'A', state: 'shared', hash: gitBlobHash(text), at: round + 2, fence: '1' })
            const head = f.room.manifestHead.get(name)!
            f.room.manifestHead.set(name, { ...head, rev: head.rev + 1, semRev: head.semRev + 1, scannedAt: round + 2 })
            f.room.participants.set(name + '\0status', 'still editing ' + round)
            f.room.graphs.set(name, { version: 1, base: f.base, sourceFence: '1', sourceRev: head.rev + 1,
              at: round + 2, status: 'ready', paths: [name], edges: [], observed: [], truncated: false })
          }
        })
        // Let every scheduled reconcile finish; no sleeping to throttle the implementation.
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      const counts = runs.map(run => run.mock.calls.length)
      console.log(JSON.stringify({ disjointPublishRounds: 10, participants: 6, reconcileRuns: counts }))
      expect(counts).toEqual([0, 0, 0, 0, 0, 0])
      f.room.manifest.get(manifestKey('B', '1'))!.set('A', { change: 'A', state: 'shared', hash: gitBlobHash('overlap'), at: 99, fence: '1' })
      f.room.setOverlay(manifestKey('B', '1'), 'A', 'overlap')
      const head = f.room.manifestHead.get('B')!
      f.room.manifestHead.set('B', { ...head, rev: head.rev + 1, semRev: head.semRev + 1 })
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(runs[0]!.mock.calls.length).toBeGreaterThan(0)
      expect(runs[0]!.mock.calls.length).toBeLessThanOrEqual(2)
      expect(runs.slice(2).every(run => run.mock.calls.length === 0)).toBe(true)
      const idle = runs.map(run => run.mock.calls.length)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(runs.map(run => run.mock.calls.length)).toEqual(idle)
    } finally { for (const set of sets) set.stop(); f.room.doc.destroy(); f.cleanup() }
  })

  it('withdraws 1,000 contracts without per-slot full-text snapshots', () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B'); f.entry('A', 'A\n'); f.entry('B', 'B\n')
      for (let i = 0; i < 1_000; i++) f.room.setOverlay(manifestKey('B', '1'), `overlay-${i}`, 'x')
      const slots = f.room.doc.getMap<any>('conflicts')
      for (let i = 0; i < 1_000; i++) {
        const key = slotKey('A', 'contract', 'B', 'x', `symbol-${i}`)
        slots.set(key, { kind: 'contract', owner: 'A', other: 'B', path: 'x', subject: `symbol-${i}`,
          status: 'conflict', inputs: 'i', factId: 'f', settled: 'conflict', epoch: 1, fence: '1', checkedAt: 1,
          consumers: ['x'] })
      }
      const set = new ConflictSet(f.session('A'))
      const toString = vi.spyOn(Y.Text.prototype, 'toString')
      ;(set as any).withdrawUnauthorizedContracts()
      expect(toString.mock.calls.length).toBeLessThanOrEqual(1_002)
      toString.mockRestore()
      expect(slots.size).toBe(1_000)
    } finally { f.cleanup() }
  })

  it('skips unchanged pairs and yields among cached candidates when one held input changes', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B'); f.entry('A', 'A\n'); f.entry('B', undefined, true)
      const a = f.room.manifest.get(manifestKey('A', '1'))!
      const b = f.room.manifest.get(manifestKey('B', '1'))!
      for (let i = 0; i < 96; i++) {
        const path = `file-${String(i).padStart(3, '0')}`
        a.set(path, { change: 'M', state: 'shared', hash: gitBlobHash('A\n'), at: 1, fence: '1' })
        b.set(path, { change: 'M', state: 'held', held: 'scope', at: 1, fence: '1' })
        f.room.setOverlay(manifestKey('A', '1'), path, 'A\n')
      }
      const set = new ConflictSet(f.session('A'))
      await set.reconcile('populate')
      let turnRan = false, sawLast = false
      const slots = (set as unknown as { slots: ConflictSlots }).slots
      const original = slots.get.bind(slots)
      const spy = vi.spyOn(slots, 'get').mockImplementation(key => {
        if (key === slotKey('A', 'merge', 'B', 'file-000')) setImmediate(() => { turnRan = true })
        if (key === slotKey('A', 'merge', 'B', 'file-095')) sawLast = turnRan
        return original(key)
      })
      await set.reconcile('unchanged')
      expect(spy).not.toHaveBeenCalled()
      b.set('file-094', { change: 'M', state: 'held', held: 'binary', at: 1, fence: '1' })
      await set.reconcile('one changed input')
      expect(spy).toHaveBeenCalled()
      expect(sawLast).toBe(true)
    } finally { f.cleanup() }
  })

  it('reports one conservative unknown pair beyond the per-pair file budget', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B'); f.entry('A', 'A\n'); f.entry('B', 'B\n')
      const a = f.room.manifest.get(manifestKey('A', '1'))!
      const b = f.room.manifest.get(manifestKey('B', '1'))!
      for (let i = 0; i < 1001; i++) {
        const path = `file-${i}`
        a.set(path, { change: 'M', state: 'held', held: 'scope', at: 1, fence: '1' })
        b.set(path, { change: 'M', state: 'held', held: 'scope', at: 1, fence: '1' })
      }
      await new ConflictSet(f.session('A')).reconcile('bounded')
      expect(f.room.doc.getMap<any>('conflicts').get(slotKey('A', 'merge', 'B', '*'))).toMatchObject({
        status: 'unknown', why: 'too many changed paths to compare',
      })
      expect([...f.room.doc.getMap<any>('conflicts').values()].filter(slot => slot.kind === 'merge')).toHaveLength(1)
    } finally { f.cleanup() }
  })

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

  it('releases a finished own worker claim after its final file lands by hand without a conflict notice', async () => {
    const f = fixture(), workerDir = mkdtempSync(join(tmpdir(), 'room-worker-final-'))
    try {
      f.holder('L'); f.holder('L+w', 'L')
      writeFileSync(join(workerDir, 'x'), 'worker\n')
      writeFileSync(join(f.dir, 'x'), 'worker\n')
      f.entry('L', 'worker\n'); f.entry('L+w', 'worker\n', false, 'L')
      f.room.addClaim({ by: 'L+w', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'worker edit' })
      const state = { id: 'w_123', status: 'done', run: '1:first', seq: 2, busy: false }
      const set = new ConflictSet(f.session('L'), 'L', f.session('L'), () => {}, 0, undefined,
        async name => name === 'L+w' ? { ...state, dir: workerDir } : undefined,
        () => ({ ...state }))
      await set.reconcile('manual apply')
      expect(f.room.openClaims().filter(c => c.by === 'L+w')).toEqual([])
      expect(f.post.mock.calls.filter(c => c[1].type === 'conflict')).toEqual([])
      expect(f.post.mock.calls.filter(c => c[1].type === 'note' && c[1].text.includes("released L+w's claims"))).toHaveLength(1)
      await set.reconcile('again')
      expect(f.post.mock.calls.filter(c => c[1].type === 'note' && c[1].text.includes("released L+w's claims"))).toHaveLength(1)
    } finally { f.cleanup(); rmSync(workerDir, { recursive: true, force: true }) }
  })

  it('keeps claims when a reported, live run resumes during the trusted lookup', async () => {
    const f = fixture(), workerDir = mkdtempSync(join(tmpdir(), 'room-worker-lookup-race-'))
    try {
      f.holder('L'); f.holder('L+w', 'L')
      writeFileSync(join(workerDir, 'x'), 'worker\n')
      writeFileSync(join(f.dir, 'x'), 'worker\n')
      f.entry('L', 'worker\n'); f.entry('L+w', 'worker\n', false, 'L')
      const claim = f.room.addClaim({ by: 'L+w', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'worker edit' })
      const registry = registrySnapshotForDir(f.dir)
      const workers = join(f.dir, '.git', 'room', 'registry', 'workers')
      const runs = join(f.dir, '.git', 'room', 'registry', 'runs', 'w_123')
      mkdirSync(workers, { recursive: true }); mkdirSync(runs, { recursive: true })
      const token = { pid: process.pid, startTime: 'live', executable: 'node', sessionId: 'test', nonce: 'token' }
      const record = {
        v: 1, id: 'w_123', tag: 'w', name: 'L+w', mode: 'local', room: 'local/test',
        lead: { participant: 'L', room: 'local/test', instance: token }, host: 'codex',
        budget: { threads: 1, memGb: 1, nice: 10 }, share: 'declared', task: 'test',
        dir: workerDir, outside: false, branch: 'room/w', prep: { step: 'prepared' },
        capabilities: { resume: true, signal: true, collect: 'delta' }, phase: 'active',
        runs: [
          { n: 1, mode: 'fresh', intentAt: 1, nonce: 'first', busFrontier: 0, promptMsgIds: [], launcher: token,
            logStart: 0, launch: { outcome: 'launched', pid: 999999999 } },
          { n: 2, mode: 'resume', intentAt: 2, nonce: 'second', busFrontier: 0, promptMsgIds: [], launcher: token,
            logStart: 0, launch: { outcome: 'launched', pid: process.pid, process: token } },
        ], createdAt: 1, seq: 3,
      }
      const set = new ConflictSet(f.session('L'), 'L', f.session('L'), () => {}, 0, undefined,
        async () => {
          writeFileSync(join(workers, 'w_123.json'), JSON.stringify(record))
          writeFileSync(join(runs, '2.report.json'), JSON.stringify({ run: 2, nonce: 'second', chain: [], joinedAt: 2,
            done: { at: 3, summary: 'reported while host still running', changed: ['x'] } }))
          return { id: 'w_123', status: 'done', dir: workerDir, run: '1:first', seq: 2 }
        })
      expect(registry.freshness('w_123')).toBeUndefined()
      await (set as any).releaseLandedWorkerClaims('1')
      expect(registry.freshness('w_123')).toMatchObject({ reported: 'done', run: '2:second', seq: 3 })
      expect(f.room.claims.has(claim.id)).toBe(true)
      expect(f.post.mock.calls.filter(c => c[1].type === 'note' && c[1].text.includes("released L+w's claims"))).toHaveLength(0)
    } finally { f.cleanup(); rmSync(workerDir, { recursive: true, force: true }) }
  })

  it('keeps claims when the holder changes during the trusted lookup', async () => {
    const f = fixture(), workerDir = mkdtempSync(join(tmpdir(), 'room-worker-holder-race-'))
    try {
      f.holder('L'); f.holder('L+w', 'L')
      writeFileSync(join(workerDir, 'x'), 'worker\n')
      writeFileSync(join(f.dir, 'x'), 'worker\n')
      f.entry('L', 'worker\n'); f.entry('L+w', 'worker\n', false, 'L')
      const claim = f.room.addClaim({ by: 'L+w', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'worker edit' })
      const state = { id: 'w_123', name: 'L+w', lead: 'L', dir: workerDir, reported: 'done', run: '1:first', seq: 2, busy: false }
      const set = new ConflictSet(f.session('L'), 'L', f.session('L'), () => {}, 0, undefined,
        async () => {
          f.holder('L+w', 'L', 2)
          return { id: state.id, status: 'done', dir: workerDir, run: state.run, seq: state.seq }
        }, () => ({ ...state }))
      await (set as any).releaseLandedWorkerClaims('1')
      expect(f.room.claims.has(claim.id)).toBe(true)
      expect(f.post.mock.calls.filter(c => c[1].type === 'note' && c[1].text.includes("released L+w's claims"))).toHaveLength(0)
    } finally { f.cleanup(); rmSync(workerDir, { recursive: true, force: true }) }
  })

  it('releases when the registry records the worker dir through a symlink (/tmp vs /private/tmp)', async () => {
    const f = fixture(), workerDir = mkdtempSync(join(tmpdir(), 'room-worker-link-')), linked = `${workerDir}-link`
    try {
      symlinkSync(workerDir, linked)
      f.holder('L'); f.holder('L+w', 'L')
      writeFileSync(join(workerDir, 'x'), 'worker\n')
      writeFileSync(join(f.dir, 'x'), 'worker\n')
      f.entry('L', 'worker\n'); f.entry('L+w', 'worker\n', false, 'L')
      f.room.addClaim({ by: 'L+w', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'worker edit' })
      const state = { id: 'w_123', status: 'done', run: '1:first', seq: 2, busy: false }
      // trustedWorker reports the real path; the registry record keeps the path it was created with.
      const set = new ConflictSet(f.session('L'), 'L', f.session('L'), () => {}, 0, undefined,
        async name => name === 'L+w' ? { ...state, dir: workerDir } : undefined,
        () => ({ ...state, name: 'L+w', lead: 'L', dir: linked }))
      await set.reconcile('manual apply')
      expect(f.room.openClaims().filter(c => c.by === 'L+w')).toEqual([])
    } finally { f.cleanup(); rmSync(linked, { force: true }); rmSync(workerDir, { recursive: true, force: true }) }
  })

  it.each(['resumed', 'new run', 'new worker id', 'new holder', 'reanchored', 'anchor changed', 'added claim', 'removed claim', 'operation started'] as const)(
    'keeps landed worker claims when the worker is %s during disk reads', async change => {
      const f = fixture(), workerDir = mkdtempSync(join(tmpdir(), 'room-worker-race-'))
      try {
        f.holder('L'); f.holder('L+w', 'L')
        writeFileSync(join(workerDir, 'x'), 'worker\n')
        writeFileSync(join(f.dir, 'x'), 'worker\n')
        f.entry('L', 'worker\n'); f.entry('L+w', 'worker\n', false, 'L')
        const original = f.room.addClaim({ by: 'L+w', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'worker edit' })
        const state = { id: 'w_123', status: 'done', run: '1:first', seq: 2, busy: false }
        let unblock!: () => void, entered!: () => void
        const blocked = new Promise<void>(resolve => { unblock = resolve })
        const reading = new Promise<void>(resolve => { entered = resolve })
        const read = async (dir: string, path: string) => { entered(); await blocked; return dir === workerDir || dir === f.dir ? 'worker\n' : null }
        const set = new ConflictSet(f.session('L'), 'L', f.session('L'), () => {}, 0, undefined,
          async name => name === 'L+w' ? { ...state, dir: workerDir } : undefined,
          () => ({ ...state }), read)
        const pass = (set as any).releaseLandedWorkerClaims('1') as Promise<void>
        await reading
        if (change === 'resumed') { state.status = 'running'; state.run = '2:second' }
        if (change === 'new run') state.run = '2:second'
        if (change === 'new worker id') state.id = 'w_456'
        if (change === 'new holder') f.holder('L+w', 'L', 2)
        if (change === 'reanchored') f.room.claims.set(original.id, { ...f.room.claims.get(original.id)!, from: 3, to: 4, at: original.at + 1 })
        if (change === 'anchor changed') f.room.claims.set(original.id, { ...f.room.claims.get(original.id)!, anchor: { from: { assoc: -1 }, to: { assoc: 1 } } })
        if (change === 'added claim') f.room.addClaim({ by: 'L+w', byKind: 'agent', path: 'x', from: 3, to: 3, intent: 'more work' })
        if (change === 'removed claim') f.room.removeClaim(original.id)
        if (change === 'operation started') state.busy = true
        unblock()
        await pass
        expect(f.room.claims.has(original.id)).toBe(change !== 'removed claim')
        expect(f.post.mock.calls.filter(c => c[1].type === 'note' && c[1].text.includes("released L+w's claims"))).toHaveLength(0)
      } finally { f.cleanup(); rmSync(workerDir, { recursive: true, force: true }) }
    })

  it('treats an existing or unreadable worker operation lease as in progress', () => {
    const f = fixture()
    try {
      const registry = registrySnapshotForDir(f.dir)
      const operations = join(f.dir, '.git', 'room', 'registry', 'workers')
      mkdirSync(operations, { recursive: true })
      expect(registry.operationInProgress('w_123')).toBe(false)
      writeFileSync(join(operations, 'w_123.op'), '{invalid json')
      expect(registry.operationInProgress('w_123')).toBe(true)
      expect(registry.operationInProgress('../invalid')).toBe(true)
      rmSync(join(operations, 'w_123.op'))
      symlinkSync('missing', join(operations, 'w_123.op'))
      expect(registry.operationInProgress('w_123')).toBe(true)
    } finally { f.cleanup() }
  })

  it('revalidates only the trusted finished worker by id in a populated registry', async () => {
    const f = fixture(), workerDir = mkdtempSync(join(tmpdir(), 'room-worker-count-'))
    try {
      f.holder('L'); f.holder('L+w', 'L')
      writeFileSync(join(workerDir, 'x'), 'worker\n')
      writeFileSync(join(f.dir, 'x'), 'worker\n')
      f.entry('L', 'worker\n'); f.entry('L+w', 'worker\n', false, 'L')
      f.room.addClaim({ by: 'L+w', byKind: 'agent', path: 'x', from: 1, to: 1, intent: 'worker edit' })
      const workers = join(f.dir, '.git', 'room', 'registry', 'workers')
      const runs = join(f.dir, '.git', 'room', 'registry', 'runs', 'w_123')
      mkdirSync(workers, { recursive: true }); mkdirSync(runs, { recursive: true })
      const token = { pid: 1, startTime: '', executable: '', sessionId: 'test', nonce: 'token' }
      const record = (id: string, name: string) => ({
        v: 1, id, tag: id, name, mode: 'local', room: 'local/test',
        lead: { participant: 'L', room: 'local/test', instance: token }, host: 'codex',
        budget: { threads: 1, memGb: 1, nice: 10 }, share: 'declared', task: 'test',
        dir: workerDir, outside: false, branch: `room/${id}`, prep: { step: 'prepared' },
        capabilities: { resume: true, signal: true, collect: 'delta' }, phase: 'active',
        runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: 'run', busFrontier: 0,
          promptMsgIds: [], launcher: token, logStart: 0, launch: { outcome: 'launched', pid: 1 } }],
        createdAt: 1, seq: 2,
      })
      writeFileSync(join(workers, 'w_123.json'), JSON.stringify(record('w_123', 'L+w')))
      writeFileSync(join(runs, '1.report.json'), JSON.stringify({ run: 1, nonce: 'run', chain: [], joinedAt: 1,
        done: { at: 2, summary: 'done', changed: [] } }))
      writeFileSync(join(runs, '1.exit.json'), JSON.stringify({ run: 1, code: 0, at: 2, witnessed: true }))
      for (let i = 0; i < 1_000; i++) {
        const id = `w_history${i}`
        writeFileSync(join(workers, `${id}.json`), JSON.stringify(record(id, `L+history${i}`)))
      }
      const original = fs.readFileSync
      let recordReads = 0
      const read = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        if (typeof args[0] === 'string' && args[0].startsWith(`${workers}/`) && args[0].endsWith('.json')) recordReads++
        return original(...args)
      }) as typeof fs.readFileSync)
      try {
        const running = new ConflictSet(f.session('L'), 'L', f.session('L'), () => {}, 0, undefined,
          async () => ({ id: 'w_123', status: 'running', dir: workerDir }))
        await (running as any).releaseLandedWorkerClaims('1')
        expect(recordReads).toBe(0)
        const untrusted = new ConflictSet(f.session('L'), 'L', f.session('L'), () => {}, 0, undefined,
          async () => undefined)
        await (untrusted as any).releaseLandedWorkerClaims('1')
        expect(recordReads).toBe(0)
        const done = new ConflictSet(f.session('L'), 'L', f.session('L'), () => {}, 0, undefined,
          async () => ({ id: 'w_123', status: 'done', dir: workerDir, run: '1:run', seq: 2 }))
        await (done as any).releaseLandedWorkerClaims('1')
        expect(recordReads).toBe(2)
        expect(f.room.openClaims().filter(c => c.by === 'L+w')).toEqual([])
      } finally { read.mockRestore() }
    } finally { f.cleanup(); rmSync(workerDir, { recursive: true, force: true }) }
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
      expect(f.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: 'B', text: expect.stringContaining("W's earlier change to x overlaps your new claim") }), expect.anything())
    } finally { f.cleanup() }
  })

  it('reads a thousand projected paths with linear source text conversion and event turns', async () => {
    const f = fixture()
    const source = new RoomDoc()
    try {
      f.holder('L'); f.holder('W', 'L'); f.entry('W', undefined, false, 'L')
      source.participants.set('W\0holder', { sessionId: 'session-W', epoch: 2, workerId: 'w' })
      source.participants.set('W\0git', { branch: 'main', head: f.base, base: f.base, anchored: true, rev: 1, fence: '2' })
      source.manifestHead.set('W', { base: f.base, fence: '2', coverage: { kind: 'all' }, level: 'full', excluded: [], rev: 1, semRev: 1, scannedAt: 1, complete: true })
      const sourceEntries = new Y.Map<any>()
      source.manifest.set(manifestKey('W', '2'), sourceEntries)
      const projected = f.room.manifest.get(manifestKey('W', '1'))!
      for (let i = 0; i < 1000; i++) {
        const p = `file-${i}.ts`, hash = gitBlobHash(`value ${i}\n`)
        sourceEntries.set(p, { change: 'M', state: 'shared', hash, at: 1, fence: '2' })
        source.setOverlay(manifestKey('W', '2'), p, `value ${i}\n`)
        projected.set(p, { change: 'M', state: 'held', hash, held: 'worker', at: 1, fence: '1' })
      }
      const workers = { ...f.session('L'), room: source } as Session
      const set = new ConflictSet(f.session('L'), 'W', workers)
      const snap = snapshot(f.room, 'W', [])!
      const spy = vi.spyOn(Y.Text.prototype, 'toString')
      let turned = false
      setImmediate(() => { turned = true })
      for (let i = 0; i < 1000; i++) expect((await (set as any).read(snap, `file-${i}.ts`)).kind).toBe('text')
      expect(turned).toBe(true)
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1000)
      spy.mockRestore()
    } finally { source.doc.destroy(); f.cleanup() }
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

  it('keeps a claim in a middle too large to diff possible rather than certified', async () => {
    const f = fixture()
    try {
      f.holder('A'); f.holder('B')
      // Two 2,000-line rewrites between a shared head and tail: the middle cannot be diffed, so it maps approximately.
      const text = (tag: string, n: number) => ['head', ...Array.from({ length: n }, (_, i) => `${tag} ${i}`), 'tail'].join('\n') + '\n'
      f.entry('A', text('a', 2001)); f.entry('B', text('b', 2000))
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

  // rc9 dogfood: an edit inside another's claim that merged cleanly arrived as a CONFLICT notify.
  it.each([
    ['merges cleanly', 'a\nb\nc\nD4\n', false],
    ['conflicts', 'a\nX2\nc\nd\n', true],
  ] as const)('words an edit inside a claim by whether the two versions merge: %s', async (_, theirs, conflicts) => {
    const f = fixture({ x: 'a\nb\nc\nd\n' })
    try {
      f.holder('A'); f.holder('B')
      f.entry('A', 'a\nB2\nc\nd\n'); f.entry('B', theirs)
      const claim = f.room.addClaim({ by: 'B', byKind: 'agent', path: 'x', from: 1, to: 4, intent: 'rewrite x' })
      const set = new ConflictSet(f.session('A'))
      await set.reconcile('edit in claim')
      // The end-of-reconcile replay re-posts under the same id; the hub keeps one.
      const lines = () => [...new Map(f.post.mock.calls.filter(c => c[1].type === 'conflict').map(c => [c[2].id, c[1]])).values()]
        .map(body => ({ to: body.to, line: formatMsg({ id: 'm', from: 'room', fromKind: 'bot', at: 1, ...body } as any) }))
      const notices = lines()
      expect(notices.map(n => n.to).sort()).toEqual(['A', 'B'])
      for (const { line } of notices) {
        if (conflicts) {
          expect(line).toMatch(/CONFLICT on x: /)
          expect(line).not.toContain('merges cleanly')
        } else {
          expect(line).not.toContain('CONFLICT')
          expect(line).toMatch(/overlap on x: .*; merges cleanly$/)
        }
      }
      f.room.removeClaim(claim.id)
      await set.reconcile('released')
      const cleared = lines().slice(notices.length)
      expect(cleared).toHaveLength(1)
      expect(cleared[0]!.line).toContain(conflicts ? 'CONFLICT cleared on x: the conflict with B cleared' : 'overlap cleared on x: the overlap with B cleared')
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
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, level: 'full' })
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
      const firstId = contractNoticeId(f.room, key)
      f.room.graphs.set('B', graph('call(a) → call(a, b, c)'))
      await new ConflictSet(f.session('A')).reconcile('graph')
      expect(f.room.doc.getMap<{ epoch: number }>('conflicts').get(key)?.epoch).toBe(2)
      const secondId = contractNoticeId(f.room, key, 2)
      expect(secondId).not.toBe(firstId)
      expect(secondId.split(':').at(-1)).toBe(firstId.split(':').at(-1))
      expect(f.post.mock.calls.map(call => call[2].id)).toContain(secondId)
    } finally { f.cleanup() }
  })

  it('publishes no outside-area contract evidence and silently withdraws a path that leaves the area', async () => {
    const f = fixture({
      'outside.py': 'def private_call(a):\n    return a\n',
      'inside.py': 'def public_call(a):\n    return a\n',
    })
    let graph: GraphIndex | undefined, set: ConflictSet | undefined
    try {
      f.holder('A'); f.holder('B'); f.entry('A', undefined); f.entry('B', undefined)
      const consumer = 'from outside import private_call\nfrom inside import public_call\nprivate_call(1)\npublic_call(1)\n'
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', {
        change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1',
      })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', consumer)
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, level: 'declared', textPrefixes: ['inside.py'] })
      const outside = 'def private_call(a, secret_outside):\n    return a\n'
      const inside = 'def public_call(a, shared_arg):\n    return a\n'
      writeFileSync(join(f.dir, 'outside.py'), outside)
      writeFileSync(join(f.dir, 'inside.py'), inside)
      const entries = f.room.manifest.get(manifestKey('B', '1'))!
      entries.set('outside.py', { change: 'M', state: 'held', held: 'scope', at: 2, fence: '1' })
      entries.set('inside.py', { change: 'M', state: 'shared', hash: gitBlobHash(inside), at: 2, fence: '1' })
      f.room.setOverlay(manifestKey('B', '1'), 'inside.py', inside)
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, rev: 2, semRev: 2 })
      graph = new GraphIndex(f.room, 'B', f.dir, () => {}, { random: () => 0, minPublishMs: 0 })
      graph.start(); await graph.whenIdle(); await waitForGraph(f.room, 'B', 2)
      set = new ConflictSet(f.session('A')); set.start(); await set.reconcile('declared changes')
      const fresh = new RoomDoc()
      Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(f.room.doc))
      try {
        const evidence = JSON.stringify({ graphs: [...fresh.graphs.values()],
          conflicts: [...fresh.doc.getMap('conflicts').entries()], bus: fresh.messages(),
          baseText: [...fresh.doc.getMap('basetext').entries()], ownedBaseText: [...fresh.ownedBaseTexts.entries()] })
        expect(evidence).not.toContain('outside.py')
        expect(evidence).not.toContain('private_call')
        expect(evidence).not.toContain('secret_outside')
        expect(evidence).toContain('inside.py')
        expect(evidence).toContain('public_call')
        expect([...fresh.doc.getMap<any>('conflicts').values()].filter(slot => slot.kind === 'contract')).toHaveLength(1)
      } finally { fresh.doc.destroy() }
      const key = slotKey('A', 'contract', 'B', 'inside.py', 'public_call')
      expect(f.room.doc.getMap('conflicts').has(key)).toBe(true)
      const notices = f.post.mock.calls.filter(call => call[1]?.type === 'contract').length
      f.room.doc.transact(() => {
        entries.set('inside.py', { change: 'M', state: 'held', held: 'scope', at: 3, fence: '1' })
        f.room.clearOverlay(manifestKey('B', '1'), 'inside.py')
        f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, textPrefixes: [], rev: 3, semRev: 3 })
      })
      expect(f.room.doc.getMap('conflicts').has(key)).toBe(false)
      expect(JSON.stringify(f.room.graphs.get('B'))).not.toContain('public_call')
      expect(f.post.mock.calls.filter(call => call[1]?.type === 'contract')).toHaveLength(notices)
    } finally { set?.stop(); graph?.stop(); f.cleanup() }
  })

  it.each(['same', 'changed'] as const)('delivers a fresh accepted contract notice after %s-signature re-entry', async variant => {
    const f = fixture({ 'api.py': 'def call(a):\n    return a\n' })
    let graph: GraphIndex | undefined, set: ConflictSet | undefined
    try {
      f.holder('A'); f.holder('B'); f.entry('A', undefined); f.entry('B', undefined)
      const consumer = 'from api import call\ncall(1)\n'
      const initial = 'def call(a, b):\n    return a\n'
      const returned = variant === 'same' ? initial : 'def call(a, b, c):\n    return a\n'
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', {
        change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1',
      })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', consumer)
      const entries = f.room.manifest.get(manifestKey('B', '1'))!
      writeFileSync(join(f.dir, 'api.py'), initial)
      entries.set('api.py', { change: 'M', state: 'shared', hash: gitBlobHash(initial), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('B', '1'), 'api.py', initial)
      graph = new GraphIndex(f.room, 'B', f.dir, () => {}, { random: () => 0, minPublishMs: 0 })
      graph.start(); await graph.whenIdle(); await waitForGraph(f.room, 'B', 1)
      const accepted = new Map<string, unknown>()
      const post = vi.fn().mockImplementation(async (_from, body, opts) => {
        if (!accepted.has(opts.id)) accepted.set(opts.id, body)
        return { ok: true, msg: accepted.get(opts.id) }
      })
      set = new ConflictSet(f.session('A', post)); set.start(); await set.reconcile('initial conflict')
      const key = slotKey('A', 'contract', 'B', 'api.py', 'call')
      expect(f.room.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'conflict', epoch: 1 })
      expect([...accepted.values()].filter((body: any) => body.type === 'contract')).toHaveLength(1)

      f.room.doc.transact(() => {
        entries.set('api.py', { change: 'M', state: 'held', held: 'scope', at: 2, fence: '1' })
        f.room.clearOverlay(manifestKey('B', '1'), 'api.py')
        f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, level: 'declared', textPrefixes: [], rev: 2, semRev: 2 })
      })
      expect(f.room.doc.getMap('conflicts').has(key)).toBe(false)
      await graph.whenIdle(); await set.reconcile('withdrawn')
      expect([...accepted.values()].filter((body: any) => body.type === 'contract')).toHaveLength(1)

      writeFileSync(join(f.dir, 'api.py'), returned)
      f.room.doc.transact(() => {
        entries.set('api.py', { change: 'M', state: 'shared', hash: gitBlobHash(returned), at: 3, fence: '1' })
        f.room.setOverlay(manifestKey('B', '1'), 'api.py', returned)
        f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, textPrefixes: ['api.py'], rev: 3, semRev: 3 })
      })
      await graph.whenIdle(); await waitForGraph(f.room, 'B', 3)
      await set.reconcile('re-entry')
      expect(f.room.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'conflict', epoch: 1 })
      expect([...accepted.values()].filter((body: any) => body.type === 'contract')).toHaveLength(2)
      expect(new Set(post.mock.calls.filter(call => call[1]?.type === 'contract').map(call => call[2].id)).size).toBe(2)
      if (variant === 'changed') expect([...accepted.values()].at(-1)).toMatchObject({ text: expect.stringContaining('call(a, b, c)') })
    } finally { set?.stop(); graph?.stop(); f.cleanup() }
  })

  it('does not let an unrelated intent peer held path suppress an authorized full-provider contract', async () => {
    const f = fixture({ 'api.py': 'def call(a):\n    return a\n', 'private.py': 'def private():\n    pass\n' })
    let graph: GraphIndex | undefined, set: ConflictSet | undefined
    try {
      for (const person of ['A', 'B', 'C']) { f.holder(person); f.entry(person, undefined) }
      const consumer = 'from api import call\ncall(1)\n'
      const provider = 'def call(a, b):\n    return a\n'
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', {
        change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1',
      })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', consumer)
      writeFileSync(join(f.dir, 'api.py'), provider)
      f.room.manifest.get(manifestKey('B', '1'))!.set('api.py', {
        change: 'M', state: 'shared', hash: gitBlobHash(provider), at: 1, fence: '1',
      })
      f.room.setOverlay(manifestKey('B', '1'), 'api.py', provider)
      f.room.manifest.get(manifestKey('C', '1'))!.set('private.py', {
        change: 'M', state: 'held', held: 'scope', at: 1, fence: '1',
      })
      f.room.manifestHead.set('C', { ...f.room.manifestHead.get('C')!, level: 'intent', rev: 2, semRev: 2 })
      graph = new GraphIndex(f.room, 'B', f.dir, () => {}, { random: () => 0, minPublishMs: 0 })
      graph.start(); await graph.whenIdle(); await waitForGraph(f.room, 'B', 1)
      expect(f.room.graphs.get('B')).toMatchObject({ status: 'ready', observed: [expect.objectContaining({ path: 'api.py', symbol: 'call' })] })
      expect(f.room.graphs.get('B')?.paths).not.toContain('private.py')
      const fresh = new RoomDoc()
      Y.applyUpdate(fresh.doc, Y.encodeStateAsUpdate(f.room.doc))
      expect(fresh.graphs.get('B')?.status).toBe('ready')
      fresh.doc.destroy()
      set = new ConflictSet(f.session('A')); set.start(); await set.reconcile('authorized contract')
      const key = slotKey('A', 'contract', 'B', 'api.py', 'call')
      expect(f.room.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'conflict', epoch: 1 })
      const ids = f.post.mock.calls.filter(call => call[1]?.type === 'contract' && call[1]?.path === 'api.py').map(call => call[2].id)
      expect(new Set(ids).size).toBe(1)
      expect(ids[0]).toBe(noticeId(key, 1, f.room.doc.getMap<any>('conflicts').get(key).episode))
      const reader = new RoomDoc()
      Y.applyUpdate(reader.doc, Y.encodeStateAsUpdate(f.room.doc))
      expect(reader.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'conflict', epoch: 1 })
      reader.doc.destroy()
    } finally { set?.stop(); graph?.stop(); f.cleanup() }
  })

  it('refreshes held-path degradation as indexer and peer text grants narrow and widen', async () => {
    const f = fixture({ 'api.py': 'def call(a):\n    return a\n', 'private.py': 'def private():\n    pass\n' })
    let graph: GraphIndex | undefined
    try {
      f.holder('B'); f.holder('C'); f.entry('B', undefined); f.entry('C', undefined)
      const provider = 'def call(a, b):\n    return a\n'
      writeFileSync(join(f.dir, 'api.py'), provider)
      f.room.manifest.get(manifestKey('B', '1'))!.set('api.py', {
        change: 'M', state: 'shared', hash: gitBlobHash(provider), at: 1, fence: '1',
      })
      f.room.setOverlay(manifestKey('B', '1'), 'api.py', provider)
      f.room.manifest.get(manifestKey('C', '1'))!.set('private.py', {
        change: 'M', state: 'held', held: 'scope', at: 1, fence: '1',
      })
      graph = new GraphIndex(f.room, 'B', f.dir, () => {}, { random: () => 0, minPublishMs: 0 })
      graph.start(); await graph.whenIdle(); await waitForGraphStatus(f.room, 'B', 'error')

      const b = f.room.manifestHead.get('B')!
      f.room.manifestHead.set('B', { ...b, level: 'declared', textPrefixes: ['api.py'], rev: 2, semRev: 2 })
      await graph.whenIdle(); await waitForGraph(f.room, 'B', 2)
      expect(f.room.graphs.get('B')?.observed).toContainEqual(expect.objectContaining({ path: 'api.py', symbol: 'call' }))

      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, level: 'full', rev: 3, semRev: 3 })
      await graph.whenIdle(); await waitForGraphStatus(f.room, 'B', 'error')
      const c = f.room.manifestHead.get('C')!
      f.room.manifestHead.set('C', { ...c, level: 'intent', rev: 2, semRev: 2 })
      await graph.whenIdle(); await waitForGraph(f.room, 'B', 3)
      f.room.manifestHead.set('C', { ...f.room.manifestHead.get('C')!, level: 'declared', textPrefixes: ['private.py'], rev: 3, semRev: 3 })
      await graph.whenIdle(); await waitForGraphStatus(f.room, 'B', 'error')
      f.room.manifestHead.set('C', { ...f.room.manifestHead.get('C')!, textPrefixes: [], rev: 4, semRev: 4 })
      await graph.whenIdle(); await waitForGraph(f.room, 'B', 3)
    } finally { graph?.stop(); f.cleanup() }
  })

  it('drops a contract synchronously when its consumer leaves text sharing', async () => {
    const f = fixture({ 'api.py': 'def call(a):\n    return a\n' })
    let set: ConflictSet | undefined
    try {
      f.holder('A'); f.holder('B'); f.entry('A', undefined); f.entry('B', undefined)
      const consumer = 'from api import call\ncall(1)\n'
      const provider = 'def call(a, b):\n    return a\n'
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', {
        change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1',
      })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', consumer)
      f.room.manifest.get(manifestKey('B', '1'))!.set('api.py', {
        change: 'M', state: 'shared', hash: gitBlobHash(provider), at: 1, fence: '1',
      })
      f.room.setOverlay(manifestKey('B', '1'), 'api.py', provider)
      f.room.graphs.set('B', { version: 1, base: f.base, sourceFence: '1', sourceRev: 1, at: 1,
        status: 'ready', paths: ['api.py'], edges: [],
        observed: [{ path: 'api.py', symbol: 'call', kind: 'signature', detail: 'call(a) → call(a, b)' }], truncated: false })
      set = new ConflictSet(f.session('A')); set.start(); await set.reconcile('visible')
      const key = slotKey('A', 'contract', 'B', 'api.py', 'call')
      expect(f.room.doc.getMap('conflicts').has(key)).toBe(true)
      const notices = f.post.mock.calls.filter(call => call[1]?.type === 'contract').length
      f.room.doc.transact(() => {
        f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', {
          change: 'A', state: 'held', held: 'scope', at: 2, fence: '1',
        })
        f.room.clearOverlay(manifestKey('A', '1'), 'consumer.py')
        f.room.manifestHead.set('A', { ...f.room.manifestHead.get('A')!, level: 'declared', textPrefixes: [], rev: 2, semRev: 2 })
      })
      expect(f.room.doc.getMap('conflicts').has(key)).toBe(false)
      expect(f.post.mock.calls.filter(call => call[1]?.type === 'contract')).toHaveLength(notices)
    } finally { set?.stop(); f.cleanup() }
  })

  it('keeps one accepted contract notice across a graph revision lag and MCP restart', async () => {
    const f = fixture()
    let restarted: RoomDoc | undefined
    try {
      f.holder('A'); f.holder('B'); f.entry('A', undefined); f.entry('B', undefined)
      const consumer = 'from api import call\ncall(1)\n', provider = 'def call(a, b):\n    pass\n'
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, level: 'full' })
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', { change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', consumer)
      f.room.manifest.get(manifestKey('B', '1'))!.set('api.py', { change: 'A', state: 'shared', hash: gitBlobHash(provider), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('B', '1'), 'api.py', provider)
      const graph = (rev: number) => ({ version: 1 as const, base: f.base, sourceFence: '1', sourceRev: rev, at: rev, status: 'ready' as const,
        paths: ['api.py', 'consumer.py'], edges: [{ source: 'api.py', target: 'consumer.py', symbols: ['call'] }],
        observed: [{ path: 'api.py', symbol: 'call', kind: 'signature' as const, detail: 'call(a) → call(a, b)' }], truncated: false })
      f.room.graphs.set('B', graph(1))
      const accepted: string[] = [], seen = new Set<string>()
      f.post.mockImplementation(async (_from, _body, opts) => {
        if (!seen.has(opts.id)) { seen.add(opts.id); accepted.push(opts.id) }
        return { ok: true }
      })
      const set = new ConflictSet(f.session('A'))
      set.start()
      await set.reconcile('first')
      const key = slotKey('A', 'contract', 'B', 'api.py', 'call')
      const firstId = contractNoticeId(f.room, key)
      expect(accepted.filter(id => id.startsWith('cf:'))).toContain(firstId)
      const head = f.room.manifestHead.get('B')!
      f.room.manifestHead.set('B', { ...head, rev: 2, semRev: 2 })
      expect(f.room.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'unknown', settled: 'conflict', epoch: 1 })
      set.stop()
      restarted = new RoomDoc()
      Y.applyUpdate(restarted.doc, Y.encodeStateAsUpdate(f.room.doc))
      const resumed = new ConflictSet({ ...f.session('A'), room: restarted } as Session)
      await resumed.reconcile('still stale after restart')
      expect(restarted.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'unknown', settled: 'conflict', epoch: 1 })
      restarted.graphs.set('B', graph(2))
      await resumed.reconcile('provenance caught up after restart')
      expect(restarted.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'conflict', epoch: 1 })
      expect(accepted.filter(id => id.startsWith('cf:'))).toEqual([firstId])
    } finally { restarted?.doc.destroy(); f.cleanup() }
  })

  it('keeps one contract episode through README-only provenance catch-up in the running graph pipeline', async () => {
    const f = fixture({ 'api.py': 'def call(a):\n    pass\n' })
    let graph: GraphIndex | undefined, set: ConflictSet | undefined
    try {
      f.holder('A'); f.holder('B'); f.entry('A', undefined); f.entry('B', undefined)
      f.room.manifestHead.set('A', { ...f.room.manifestHead.get('A')!, level: 'full' })
      const consumer = 'from api import call\ncall(1)\n', provider = 'def call(a, b):\n    pass\n'
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, level: 'full' })
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', { change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', consumer)
      f.room.manifest.get(manifestKey('B', '1'))!.set('api.py', { change: 'M', state: 'shared', hash: gitBlobHash(provider), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('B', '1'), 'api.py', provider)
      writeFileSync(join(f.dir, 'api.py'), provider)
      const accepted: string[] = [], seen = new Set<string>()
      f.post.mockImplementation(async (_from, _body, opts) => {
        if (!seen.has(opts.id)) { seen.add(opts.id); accepted.push(opts.id) }
        return { ok: true }
      })
      graph = new GraphIndex(f.room, 'B', f.dir, () => {}, { random: () => 0, minPublishMs: 0 })
      graph.start()
      await graph.whenIdle()
      const key = slotKey('A', 'contract', 'B', 'api.py', 'call')
      const ready = async () => {
        const deadline = Date.now() + 3000
        while (f.room.graphs.get('B')?.sourceRev !== f.room.manifestHead.get('B')?.rev || f.room.graphs.get('B')?.status !== 'ready') {
          if (Date.now() >= deadline) throw new Error('graph provenance did not catch up')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
      await ready()
      set = new ConflictSet(f.session('A'))
      set.start()
      await set.reconcile('first graph')
      expect(f.room.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'conflict', epoch: 1 })
      const head = f.room.manifestHead.get('B')!
      writeFileSync(join(f.dir, 'README.md'), 'docs\n')
      f.room.doc.transact(() => {
        f.room.manifest.get(manifestKey('B', '1'))!.set('README.md', { change: 'A', state: 'shared', hash: gitBlobHash('docs\n'), at: 2, fence: '1' })
        f.room.setOverlay(manifestKey('B', '1'), 'README.md', 'docs\n')
        f.room.manifestHead.set('B', { ...head, rev: 2, semRev: 2 })
      })
      expect(f.room.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'unknown', epoch: 1 })
      await graph.whenIdle()
      await ready()
      await set.reconcile('graph caught up')
      expect(f.room.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'conflict', epoch: 1 })
      expect(accepted.filter(id => id.startsWith('cf:'))).toEqual([contractNoticeId(f.room, key)])
    } finally { set?.stop(); graph?.stop(); f.cleanup() }
  })

  it('notifies a consumer of an authorized whole-file deletion from the running graph', async () => {
    const f = fixture({ 'api.py': 'def call(a):\n    pass\n' })
    let graph: GraphIndex | undefined, reader: RoomDoc | undefined
    try {
      f.holder('A'); f.holder('B'); f.entry('A', undefined); f.entry('B', undefined)
      f.room.manifestHead.set('A', { ...f.room.manifestHead.get('A')!, level: 'full' })
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, level: 'full' })
      const consumer = 'from api import call\ncall(1)\n'
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', { change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', consumer)
      graph = new GraphIndex(f.room, 'B', f.dir, () => {}, { random: () => 0, minPublishMs: 0 })
      graph.start(); await graph.whenIdle()
      const ready = async (rev: number) => {
        const deadline = Date.now() + 3000
        while (f.room.graphs.get('B')?.status !== 'ready' || f.room.graphs.get('B')?.sourceRev !== rev) {
          if (Date.now() >= deadline) throw new Error('graph did not publish deletion revision')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
      await ready(1)
      expect(f.room.graphs.get('B')?.edges).toContainEqual(expect.objectContaining({ source: 'api.py', target: 'consumer.py' }))
      rmSync(join(f.dir, 'api.py'))
      f.room.doc.transact(() => {
        f.room.manifest.get(manifestKey('B', '1'))!.set('api.py', { change: 'D', state: 'shared', at: 2, fence: '1' })
        f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, rev: 2, semRev: 2 })
      })
      await graph.whenIdle(); await ready(2)
      reader = new RoomDoc()
      Y.applyUpdate(reader.doc, Y.encodeStateAsUpdate(f.room.doc))
      expect(reader.graphs.get('B')?.observed).toContainEqual(expect.objectContaining({ path: 'api.py', symbol: 'call', kind: 'delete' }))
      await new ConflictSet({ ...f.session('A'), room: reader } as Session).reconcile('deleted provider')
      const key = slotKey('A', 'contract', 'B', 'api.py', 'call')
      expect(reader.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'conflict', epoch: 1 })
      expect(f.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'contract', to: 'A' }), expect.objectContaining({ id: contractNoticeId(reader, key) }))
    } finally { graph?.stop(); reader?.doc.destroy(); f.cleanup() }
  })

  it('clears a deletion contract after the consumer actually removes its last reference', async () => {
    const f = fixture({ 'api.py': 'def call(a):\n    pass\n' })
    let graph: GraphIndex | undefined, reader: RoomDoc | undefined, set: ConflictSet | undefined
    try {
      f.holder('A'); f.holder('B'); f.entry('A', undefined); f.entry('B', undefined)
      const consumer = 'from api import call\ncall(1)\n'
      f.room.manifestHead.set('A', { ...f.room.manifestHead.get('A')!, level: 'full' })
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, level: 'full' })
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', { change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', consumer)
      graph = new GraphIndex(f.room, 'B', f.dir, () => {}, { random: () => 0, minPublishMs: 0 })
      graph.start(); await graph.whenIdle()
      await waitForGraph(f.room, 'B', 1)
      rmSync(join(f.dir, 'api.py'))
      f.room.doc.transact(() => {
        f.room.manifest.get(manifestKey('B', '1'))!.set('api.py', { change: 'D', state: 'shared', at: 2, fence: '1' })
        f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, rev: 2, semRev: 2 })
      })
      await graph.whenIdle()
      await waitForGraph(f.room, 'B', 2)
      reader = new RoomDoc()
      Y.applyUpdate(reader.doc, Y.encodeStateAsUpdate(f.room.doc))
      set = new ConflictSet({ ...f.session('A'), room: reader } as Session)
      set.start()
      await set.reconcile('deleted provider')
      const key = slotKey('A', 'contract', 'B', 'api.py', 'call')
      expect(reader.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'conflict', epoch: 1 })
      const noReference = 'print("done")\n'
      reader.doc.transact(() => {
        reader!.manifest.get(manifestKey('A', '1'))!.set('consumer.py', { change: 'A', state: 'shared', hash: gitBlobHash(noReference), at: 2, fence: '1' })
        reader!.setOverlay(manifestKey('A', '1'), 'consumer.py', noReference)
        reader!.manifestHead.set('A', { ...reader!.manifestHead.get('A')!, rev: 2, semRev: 2 })
      })
      await set.reconcile('last reference removed')
      expect(reader.doc.getMap<any>('conflicts').get(key)).toMatchObject({ status: 'clean', settled: 'clean', epoch: 1 })
      expect(f.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'contract', to: 'A' }),
        expect.objectContaining({ id: `${contractNoticeId(reader, key)}:clean` }))
    } finally { set?.stop(); graph?.stop(); reader?.doc.destroy(); f.cleanup() }
  })

  it('keeps an active contract episode when a clean sibling has no manifest entry, including after restart', async () => {
    const baseApi = 'def call(a):\n    pass\n', baseAux = 'def other(a):\n    pass\n'
    const f = fixture({ 'api.py': baseApi, 'aux.py': baseAux })
    let restarted: RoomDoc | undefined, set: ConflictSet | undefined
    try {
      f.holder('A'); f.holder('B'); f.entry('A', undefined); f.entry('B', undefined)
      const consumer = 'from api import call\nfrom aux import other\ncall(1)\nother(1)\n'
      const api = 'def call(a, b):\n    pass\n', aux = 'def other(a, b):\n    pass\n'
      const entries = f.room.manifest.get(manifestKey('B', '1'))!
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, level: 'full' })
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', { change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', consumer)
      for (const [path, value] of [['api.py', api], ['aux.py', aux]] as const) {
        entries.set(path, { change: 'M', state: 'shared', hash: gitBlobHash(value), at: 1, fence: '1' })
        f.room.setOverlay(manifestKey('B', '1'), path, value)
      }
      const graph = (rev: number, auxChanged: boolean) => ({ version: 1 as const, base: f.base, sourceFence: '1', sourceRev: rev, at: rev, status: 'ready' as const,
        paths: ['api.py', 'aux.py', 'consumer.py'],
        edges: [{ source: 'api.py', target: 'consumer.py', symbols: ['call'] },
          ...(auxChanged ? [{ source: 'aux.py', target: 'consumer.py', symbols: ['other'] }] : [])],
        observed: [{ path: 'api.py', symbol: 'call', kind: 'signature' as const, detail: 'call(a) → call(a, b)' },
          ...(auxChanged ? [{ path: 'aux.py', symbol: 'other', kind: 'signature' as const, detail: 'other(a) → other(a, b)' }] : [])], truncated: false })
      f.room.graphs.set('B', graph(1, true))
      const accepted: string[] = [], seen = new Set<string>()
      f.post.mockImplementation(async (_from, _body, opts) => {
        if (!seen.has(opts.id)) { seen.add(opts.id); accepted.push(opts.id) }
        return { ok: true }
      })
      set = new ConflictSet(f.session('A'))
      await set.reconcile('both changed')
      const activeKey = slotKey('A', 'contract', 'B', 'api.py', 'call')
      const cleanKey = slotKey('A', 'contract', 'B', 'aux.py', 'other')
      expect(f.room.doc.getMap<any>('conflicts').get(activeKey)).toMatchObject({ status: 'conflict', epoch: 1 })
      expect(f.room.doc.getMap<any>('conflicts').get(cleanKey)).toMatchObject({ status: 'conflict', epoch: 1 })
      const activeFact = f.room.doc.getMap<any>('conflicts').get(activeKey).factId
      f.room.doc.transact(() => {
        entries.delete('aux.py')
        f.room.clearOverlay(manifestKey('B', '1'), 'aux.py')
        f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, rev: 2, semRev: 2 })
        f.room.graphs.set('B', graph(2, false))
      })
      await set.reconcile('aux reverted')
      expect(f.room.doc.getMap<any>('conflicts').get(cleanKey)).toMatchObject({ status: 'clean', epoch: 1 })
      set.start()
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, rev: 3, semRev: 3 })
      expect(f.room.doc.getMap<any>('conflicts').get(activeKey)).toMatchObject({ status: 'unknown', subject: 'call', factId: activeFact, epoch: 1 })
      set.stop()
      restarted = new RoomDoc()
      Y.applyUpdate(restarted.doc, Y.encodeStateAsUpdate(f.room.doc))
      const resumed = new ConflictSet({ ...f.session('A'), room: restarted } as Session)
      await resumed.reconcile('stale after restart')
      restarted.graphs.set('B', graph(3, false))
      await resumed.reconcile('current after restart')
      expect(restarted.doc.getMap<any>('conflicts').get(activeKey)).toMatchObject({ status: 'conflict', epoch: 1 })
      expect(accepted.filter(id => id.startsWith(noticeId(activeKey, 1).slice(0, -1)))).toEqual([contractNoticeId(restarted, activeKey)])
    } finally { set?.stop(); restarted?.doc.destroy(); f.cleanup() }
  })

  it('keeps an active contract episode after a sibling reverts in the running graph pipeline', async () => {
    const baseApi = 'def call(a):\n    pass\n', baseAux = 'def other(a):\n    pass\n'
    const f = fixture({ 'api.py': baseApi, 'aux.py': baseAux })
    let graph: GraphIndex | undefined, set: ConflictSet | undefined
    try {
      f.holder('A'); f.holder('B'); f.entry('A', undefined); f.entry('B', undefined)
      f.room.manifestHead.set('A', { ...f.room.manifestHead.get('A')!, level: 'full' })
      const consumer = 'from api import call\nfrom aux import other\ncall(1)\nother(1)\n'
      const api = 'def call(a, b):\n    pass\n', aux = 'def other(a, b):\n    pass\n'
      const entries = f.room.manifest.get(manifestKey('B', '1'))!
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, level: 'full' })
      f.room.manifest.get(manifestKey('A', '1'))!.set('consumer.py', { change: 'A', state: 'shared', hash: gitBlobHash(consumer), at: 1, fence: '1' })
      f.room.setOverlay(manifestKey('A', '1'), 'consumer.py', consumer)
      for (const [path, value] of [['api.py', api], ['aux.py', aux]] as const) {
        entries.set(path, { change: 'M', state: 'shared', hash: gitBlobHash(value), at: 1, fence: '1' })
        f.room.setOverlay(manifestKey('B', '1'), path, value)
        writeFileSync(join(f.dir, path), value)
      }
      const accepted: string[] = [], seen = new Set<string>()
      f.post.mockImplementation(async (_from, _body, opts) => {
        if (!seen.has(opts.id)) { seen.add(opts.id); accepted.push(opts.id) }
        return { ok: true }
      })
      graph = new GraphIndex(f.room, 'B', f.dir, () => {}, { random: () => 0, minPublishMs: 0 })
      graph.start()
      const ready = async () => {
        await graph!.whenIdle()
        const deadline = Date.now() + 3000
        while (f.room.graphs.get('B')?.sourceRev !== f.room.manifestHead.get('B')?.rev || f.room.graphs.get('B')?.status !== 'ready') {
          if (Date.now() >= deadline) throw new Error('graph provenance did not catch up')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
      await ready()
      set = new ConflictSet(f.session('A'))
      await set.reconcile('both changed')
      const activeKey = slotKey('A', 'contract', 'B', 'api.py', 'call')
      const cleanKey = slotKey('A', 'contract', 'B', 'aux.py', 'other')
      expect(f.room.doc.getMap<any>('conflicts').get(activeKey)).toMatchObject({ status: 'conflict', epoch: 1 })
      expect(f.room.doc.getMap<any>('conflicts').get(cleanKey)).toMatchObject({ status: 'conflict', epoch: 1 })
      writeFileSync(join(f.dir, 'aux.py'), baseAux)
      f.room.doc.transact(() => {
        entries.delete('aux.py')
        f.room.clearOverlay(manifestKey('B', '1'), 'aux.py')
        f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, rev: 2, semRev: 2 })
      })
      await ready()
      await set.reconcile('aux reverted')
      expect(f.room.doc.getMap<any>('conflicts').get(cleanKey)).toMatchObject({ status: 'clean', epoch: 1 })
      set.start()
      writeFileSync(join(f.dir, 'README.md'), 'docs\n')
      f.room.doc.transact(() => {
        entries.set('README.md', { change: 'A', state: 'shared', hash: gitBlobHash('docs\n'), at: 3, fence: '1' })
        f.room.setOverlay(manifestKey('B', '1'), 'README.md', 'docs\n')
        f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, rev: 3, semRev: 3 })
      })
      expect(f.room.doc.getMap<any>('conflicts').get(activeKey)).toMatchObject({ status: 'unknown', subject: 'call', epoch: 1 })
      await ready()
      await set.reconcile('README catch-up')
      expect(f.room.doc.getMap<any>('conflicts').get(activeKey)).toMatchObject({ status: 'conflict', epoch: 1 })
      expect(accepted.filter(id => id.startsWith(noticeId(activeKey, 1).slice(0, -1)))).toEqual([contractNoticeId(f.room, activeKey)])
    } finally { set?.stop(); graph?.stop(); f.cleanup() }
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

  it('checks a worker against its carried baseline when the lead changes a definition', async () => {
    const f = fixture()
    try {
      f.holder('W'); f.holder('B')
      f.entry('W', undefined); f.entry('B', undefined)
      f.room.manifestHead.set('B', { ...f.room.manifestHead.get('B')!, textPrefixes: ['api.py'] })
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
