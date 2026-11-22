import { afterEach, expect, it, vi } from 'vitest'
import { RoomDoc, outgoing, gitBlobHash, manifestKey, participantRecord, formatMsg, type ManifestEntry, type Msg, type PostBody } from '@room/shared'
import { ConflictSet, ConflictSlots, peerNoticeId, slotKey, type Evaluation } from '../src/conflict-set.js'
import type { Post } from '../src/post.js'
import type { Session } from '../src/session.js'
import { Ledger } from '../src/ledger.js'
import * as core from '@room/hub-core'
import * as Y from 'yjs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rooms: RoomDoc[] = []
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
  for (const room of rooms.splice(0)) room.doc.destroy()
})

function fixture() {
  const room = new RoomDoc()
  rooms.push(room)
  let fence = '1'
  const post = vi.fn((from, body, opts) => Object.assign(Promise.resolve({ ok: true,
    msg: { ...outgoing(from, body, opts!.id!), at: 1 } }), { id: opts!.id! })) as unknown as Post & ReturnType<typeof vi.fn>
  const make = () => new ConflictSlots(room, post, () => fence)
  const slots = make()
  const result: Evaluation = { owner: 'A', other: 'B', kind: 'merge', path: 'x', status: 'conflict', inputs: 'first', factId: 'first', lines: [2] }
  const settle = (changes: Partial<Evaluation> = {}, target = slots) => {
    const next = { ...result, ...changes }
    return target.settle(slotKey(next.owner, next.kind, next.other, next.path), next)
  }
  const priorities = () => post.mock.calls.map(c => c[1].priority)
  return { room, post, make, slots, settle, priorities, setFence: (next: string) => { fence = next } }
}

it('keeps line moves and joining files quiet, preserves unknowns, and separates peers', async () => {
  const f = fixture()
  await f.settle()
  await f.settle({ inputs: 'lines moved', factId: 'lines moved', lines: [9] })
  await f.settle({ path: 'y' })
  await f.settle({ status: 'clean' })
  await f.settle({ path: 'y', status: 'unknown', inputs: 'unreadable' })
  await f.settle({ path: 'y', inputs: 'readable', factId: 'moved', lines: [12] })
  await f.settle({ other: 'C' })
  expect(f.priorities()).toEqual(['notify', 'fyi', 'fyi', 'fyi', 'fyi', 'notify'])
  expect(new Set(f.post.mock.calls.map(c => c[2].id)).size).toBe(6)
})

it.each(['refused', 'thrown'] as const)('never treats a %s post as an accepted first notification', async failure => {
  const f = fixture()
  if (failure === 'refused') f.post.mockResolvedValueOnce({ ok: false, text: 'hub unreachable' })
  else f.post.mockRejectedValueOnce(new Error('interrupted post'))
  await f.settle()
  // Even an update that only clears files must notify if no earlier notify was accepted.
  f.slots.deferPeerNotices = true
  await f.settle({ path: 'y' })
  await f.settle({ status: 'clean' })
  await f.slots.replay('A')
  await f.settle({ path: 'y', inputs: 'moved', factId: 'moved', lines: [8] })
  await f.slots.replay('A')
  expect(f.priorities()).toEqual(['notify', 'notify', 'fyi'])
})

it('requires acceptance after a pass stops before posting, and after a producer restart', async () => {
  const f = fixture()
  f.slots.deferPeerNotices = true
  await f.settle()
  await f.settle({ path: 'y' })
  expect(f.post).not.toHaveBeenCalled()
  await f.slots.replay('A')
  const restarted = f.make()
  restarted.deferPeerNotices = true
  await restarted.replay('A')
  // Ordinary shared slots do not carry acceptance evidence across restart.
  expect(f.priorities()).toEqual(['notify', 'notify'])
  expect(f.post.mock.calls[0][2].id).toBe(f.post.mock.calls[1][2].id)
  await f.settle({ path: 'y', inputs: 'new', factId: 'new' }, restarted)
  await restarted.replay('A')
  expect(f.priorities()).toEqual(['notify', 'notify', 'fyi'])
})

it('notifies after all slots clear without a clearance post, or are removed externally', async () => {
  const f = fixture()
  await f.settle()
  f.slots.deferPeerNotices = true
  await f.settle({ status: 'clean' })
  await f.settle({ inputs: 'reopened', factId: 'reopened' })
  await f.slots.replay('A')
  f.room.doc.getMap('conflicts').clear()
  await f.settle()
  await f.slots.replay('A')
  expect(f.priorities()).toEqual(['notify', 'notify', 'notify'])
})

it('does not carry an in-flight acknowledgement onto replacement slots', async () => {
  const f = fixture()
  let accept!: () => void
  f.post.mockImplementationOnce((from, body: PostBody<Msg>, opts) => new Promise(resolve => {
    accept = () => resolve({ ok: true, msg: { ...outgoing(from, body, opts.id), at: 1 } })
  }))
  const pending = f.settle()
  f.slots.drop(slotKey('A', 'merge', 'B', 'x'))
  f.slots.deferPeerNotices = true
  await f.settle()
  accept()
  await pending
  await f.slots.replay('A')
  expect(f.priorities()).toEqual(['notify', 'notify'])
})

it('defaults to notify when a lease or exact worker identity changes', async () => {
  const f = fixture()
  await f.settle()
  f.setFence('2')
  await f.settle({ inputs: 'lease changed', factId: 'lease changed' })
  f.room.participants.set('B\0holder', { sessionId: 'next', epoch: 1, workerId: 'w_next' })
  await f.settle({ inputs: 'worker changed', factId: 'new lines' })
  expect(f.priorities()).toEqual(['notify', 'notify', 'notify'])
})

it.each(['fyi', 'notify'] as const)('does not mistake a duplicate %s proposal without its replica for an accepted notify', async priority => {
  const f = fixture()
  f.post.mockImplementationOnce((from, body, opts) => Promise.resolve({ ok: true, duplicate: true,
    msg: { ...outgoing(from, { ...body, priority }, opts.id), at: 1 } }))
  await f.settle()
  await f.settle({ inputs: 'new', factId: 'new' })
  expect(f.priorities()).toEqual(['notify', 'notify'])
})


/** Real reconciler and hub, with independently controllable hub-to-producer replication. */
async function hubFixture(managed: boolean, separateReplica = false) {
  const room = new RoomDoc(), hubRoom = separateReplica ? new RoomDoc() : room
  rooms.push(room)
  if (separateReplica) rooms.push(hubRoom)
  let max: number | undefined, tick = 0, request = 0
  const hub = await core.startHub({ doc: hubRoom, mono: () => tick, wall: Date.now,
    store: core.serializedStore({ read: async () => max, write: async n => { max = n } }), log() {} })
  cleanup.push(() => hub.stop())
  tick += core.SETTLE_MS
  const conn = {}, principal = { local: true } as const
  hub.handle(conn, { v: 1, id: 'hello', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 'a' }, principal)
  if (managed) hub.noticeContract(conn, { capabilities: { 'room.notice-lifecycle': 1 } })
  const holder = (workerId?: string) => ({ sessionId: 'a', pid: 1, startTime: '', executable: '', ...(workerId ? { workerId } : {}) })
  const grant = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'A', holder: holder() }, principal)
  expect(grant.ok).toBe(true)
  const worker = (id: string) => {
    expect(hub.handle(conn, { v: 1, id, op: 'acquire', name: 'B', holder: holder(id) }, principal).ok).toBe(true)
    if (separateReplica) Y.applyUpdate(room.doc, Y.encodeStateAsUpdate(hubRoom.doc))
  }
  worker('w1')
  const publish = () => { if (separateReplica) Y.applyUpdate(hubRoom.doc, Y.encodeStateAsUpdate(room.doc)) }
  let refuse = false
  const post: Post = (from, body, opts) => {
    publish()
    const id = opts!.id!
    const reply = refuse ? { ok: false, reason: 'unreachable', text: 'not sent' } : hub.handle(conn, { v: 1, id: `p${++request}`, op: 'post', lease: { name: 'A', epoch: Number(grant.epoch) },
      auto: true, msg: outgoing(from, body, id) }, principal)
    return Object.assign(Promise.resolve({ ...reply, msg: { ...outgoing(from, body, id), at: Date.now() } }) as ReturnType<Post>, { id })
  }
  const s = { room, me: { name: 'A', kind: 'agent' }, roomName: 'quiet', post,
    lease: { fence: () => String(grant.epoch), sessionId: 'a' }, provider: { synced: true },
    contract: { capabilities: managed ? { 'room.notice-lifecycle': 1 } : {} },
    hub: { noticeIncarnation: () => hub.incarnation, noticeLifecycle: async (intent: Record<string, unknown>) => {
      publish()
      if (refuse) throw new Error('not sent')
      return hub.handle(conn, { v: 1, id: `n${++request}`, op: 'notice-lifecycle', generation: hub.incarnation, ...intent }, principal)
    } },
    awareness: { getStates: () => new Map(['A', 'B'].map((name, i) => [i, { user: { name, kind: 'agent' }, sessionId: 'a' }])) },
  } as unknown as Session
  const dir = mkdtempSync(join(tmpdir(), 'quiet-hub-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.email', 'test@test'); git('config', 'user.name', 'test')
  for (const path of ['x', 'y', 'z']) writeFileSync(join(dir, path), 'base\n')
  git('add', '.'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  room.ensureRoomSalt()
  s.dir = dir
  const entry = (name: string, paths: string[]) => {
    const fence = String(participantRecord(room, name)!.holder!.epoch)
    room.participants.set(`${name}\0id`, { name, kind: 'agent' })
    room.participants.set(`${name}\0git`, { base, head: base, branch: 'main', rev: 1, anchored: true, fence })
    const rev = (room.manifestHead.get(name)?.rev ?? 0) + 1
    room.manifestHead.set(name, { base, fence, rev, semRev: rev, level: 'full', coverage: { kind: 'all' }, complete: true, excluded: [], scannedAt: 1 })
    const entries = new Y.Map<ManifestEntry>()
    room.manifest.set(manifestKey(name, fence), entries)
    for (const path of paths) {
      const text = `${name}\n`
      entries.set(path, { change: 'M', state: 'shared', hash: gitBlobHash(text), fence, at: 1 })
      room.setOverlay(manifestKey(name, fence), path, text)
    }
  }
  const makeSet = () => new ConflictSet(s, 'A', s, () => {}, 0, () => undefined, async () => undefined, () => undefined)
  let set = makeSet()
  cleanup.push(() => set.stop())
  const change = async (paths: string[]) => {
    entry('A', paths); entry('B', paths)
    await set.reconcile('test update')
  }
  const ledger = new Ledger({ sessionId: () => 'a', route: () => ({}) })
  ledger.bind(s)
  return { room, hubRoom, s, set, ledger, worker, change, messages: () => hubRoom.messages().filter(m => m.type === 'merge-conflict'),
    restart: () => { set.stop(); set = makeSet() },
    refuse: (value: boolean) => { refuse = value } }
}

it('keeps a fallback successor wake deliverable after an undelivered quiet update with the same files', async () => {
  const f = await hubFixture(false)
  await f.change(['x'])
  const batch = f.ledger.open('reply')
  expect(f.ledger.select(f.s, batch).map(m => m.priority)).toEqual(['notify'])
  f.ledger.commit(batch)
  await f.change(['x', 'y'])
  const quiet = f.messages().at(-1)!
  expect(quiet.priority).toBe('fyi')
  f.room.retireWorker('w1', { id: 'w1', name: 'B', lead: 'A', tag: 'B', task: '', summary: '', files: [], fileCount: 0, retiredAt: Date.now() }, () => {})
  f.worker('w2')
  await f.change(['x', 'y'])
  await f.set.reconcile('unchanged retry')
  const pending = f.ledger.candidates(f.s)
  expect(pending.map(m => m.priority)).toContain('notify')
  const waking = pending.find(m => m.priority === 'notify')!
  expect(waking.id).not.toBe(quiet.id)
  expect(waking.id).toBe(peerNoticeId('A', 'B', 1, [{ path: 'x', epoch: 1 }, { path: 'y', epoch: 1 }], []))
})

it.each(['receipted', 'superseded'] as const)('does not use a predecessor\'s %s notify as proof of a successor wake', async previous => {
  const f = await hubFixture(false)
  await f.change(['x'])
  const original = f.messages().at(-1)!
  expect(original.priority).toBe('notify')
  if (previous === 'receipted') {
    const batch = f.ledger.open('reply')
    expect(f.ledger.select(f.s, batch).map(m => m.id)).toEqual([original.id])
    f.ledger.commit(batch)
  } else {
    // No receipt: a full clearance supersedes the old waking presentation instead.
    await f.change([])
  }
  expect(f.ledger.candidates(f.s).some(m => m.priority === 'notify')).toBe(false)
  f.room.retireWorker('w1', { id: 'w1', name: 'B', lead: 'A', tag: 'B', task: '', summary: '', files: [], fileCount: 0, retiredAt: Date.now() }, () => {})
  f.worker('w2')
  await f.change(['x'])
  // The baseline ID is intentionally reused and the hub retains the old notify body.
  expect(f.messages().filter(m => m.id === original.id)).toEqual([original])
  expect(f.ledger.candidates(f.s).some(m => m.priority === 'notify')).toBe(false)
  await f.change(['x', 'y'])
  const waking = f.ledger.candidates(f.s).filter(m => m.priority === 'notify')
  expect(waking.map(m => m.id)).toEqual([peerNoticeId('A', 'B', 1, [{ path: 'x', epoch: 1 }, { path: 'y', epoch: 1 }], [])])
  await f.change(['x', 'y', 'z'])
  expect(f.messages().at(-1)!.priority).toBe('fyi')
})

it('uses acknowledged managed notices before their separate hub replica reaches the producer', async () => {
  const f = await hubFixture(true, true)
  await f.change(['x'])
  await f.change(['x', 'y'])
  await f.change(['x', 'y', 'z'])
  expect(f.room.messages()).toEqual([])
  expect(f.messages().map(m => m.priority)).toEqual(['notify', 'fyi', 'fyi'])
  expect(f.messages().every(m => m.id.includes(':worker:'))).toBe(true)
  await f.change([])
  await f.change(['x'])
  expect(f.messages().map(m => m.priority)).toEqual(['notify', 'fyi', 'fyi', 'fyi', 'notify'])
})

it.each([false, true])('requires fresh acceptance after producer restart with managed registration %s', async managed => {
  const f = await hubFixture(managed, true)
  await f.change(['x'])
  f.restart()
  await f.change(['x'])
  expect(f.messages().map(m => m.priority)).toEqual(['notify'])
  await f.change(['x', 'y'])
  expect(f.messages().map(m => m.priority)).toEqual(['notify', 'notify'])
  await f.change(['x', 'y', 'z'])
  expect(f.messages().map(m => m.priority)).toEqual(['notify', 'notify', 'fyi'])
})

it('labels a certified single-file quiet update as CONFLICT', async () => {
  const f = fixture()
  await f.settle()
  await f.settle({ inputs: 'moved', factId: 'moved', lines: [8] })
  const [from, body, opts] = f.post.mock.calls.at(-1)!
  const msg = { ...outgoing(from, body, opts.id), at: 1 } as Msg
  expect(formatMsg(msg)).toBe("[fyi] CONFLICT on x: x conflicts with B's version at lines 8")
})

it('requires a real acknowledgement when managed registration and fallback are both unsent', async () => {
  const f = await hubFixture(true, true)
  f.refuse(true)
  await f.change(['x'])
  expect(f.messages()).toEqual([])
  f.refuse(false)
  await f.change(['x', 'y'])
  expect(f.messages().map(m => m.priority)).toEqual(['notify'])
  await f.change(['x', 'y', 'z'])
  expect(f.messages().map(m => m.priority)).toEqual(['notify', 'fyi'])
})


it('replays an unchanged accepted waking presentation with its original urgency and id', async () => {
  const f = fixture()
  await f.settle()
  await f.slots.replay('A')
  expect(f.priorities()).toEqual(['notify', 'notify'])
  expect(f.post.mock.calls[1][2].id).toBe(f.post.mock.calls[0][2].id)
  await f.settle({ path: 'y' })
  await f.slots.replay('A')
  expect(f.priorities()).toEqual(['notify', 'notify', 'fyi', 'fyi'])
  expect(f.post.mock.calls[3][2].id).toBe(f.post.mock.calls[2][2].id)
})
