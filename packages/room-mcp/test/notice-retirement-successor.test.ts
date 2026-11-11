import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { RoomDoc, gitBlobHash, manifestKey, owed, outgoing, participantRecord, supersededConflictNotices, type Claim } from '@room/shared'
import * as core from '@room/hub-core'
import { ConflictSet, ConflictSlots, slotKey, type Evaluation } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import type { Post } from '../src/post.js'
import { HubClient } from '../src/hub-client.js'
import { noticeLifecycle } from '../src/notice-lifecycle.js'
import { Ledger } from '../src/ledger.js'
import { retireNoticeDependencies } from '../src/notice-lifecycle.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0)) fn() })
async function fixture(managed = true, ownerWorker?: string) {
  const room = new RoomDoc()
  let max: number | undefined, tick = 0, clock = Date.now()
  const hub = await core.startHub({ doc: room, mono: () => tick, wall: () => clock,
    store: core.serializedStore({ read: async () => max, write: async n => { max = n } }), log() {} })
  tick += core.SETTLE_MS
  const conn = {}, principal = { local: true } as const
  hub.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 'a' }, principal)
  if (managed) (hub as any).noticeContract?.(conn, { capabilities: { 'room.notice-lifecycle': 1 } })
  const grant = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'A', holder: { sessionId: 'a', pid: 1, startTime: '', executable: '', ...(ownerWorker ? { workerId: ownerWorker } : {}) } }, principal) as any
  let epoch: number | undefined = grant.epoch, calls = 0, valid = true, refuse = false
  const send = vi.fn(async (intent: Record<string, unknown>) => {
    if (refuse) return { ok: false, reason: 'unavailable', text: 'test refusal' }
    return hub.handle(conn, { v: 1, id: `l${++calls}`, op: 'notice-lifecycle', generation: hub.incarnation,
      lease: { name: 'A', epoch }, ...intent }, principal)
  })
  const post: Post = vi.fn((from, body, options) => {
    const id = options?.id ?? 'missing'
    const msg = { ...outgoing(from, body, id), at: clock }
    const r = refuse ? { ok: false, reason: 'unavailable', text: 'test refusal' }
      : hub.handle(conn, { v: 1, id: `p${++calls}`, op: 'post', lease: { name: 'A', epoch }, auto: true,
        msg: outgoing(from, body, id) }, principal)
    return Object.assign(Promise.resolve({ ...r, msg }), { id })
  }) as Post
  const s = { room, me: { name: 'A', kind: 'agent' }, roomName: 'r', post,
    lease: { fence: () => epoch === undefined ? undefined : String(epoch), sessionId: 'a' },
    contract: managed ? { capabilities: { 'room.notice-lifecycle': 1 }, legacy: false } : { capabilities: {}, legacy: true },
    hub: { noticeLifecycle: send, noticeIncarnation: () => hub.incarnation }, provider: { synced: true } } as unknown as Session
  const slots = new ConflictSlots(room, post, () => String(epoch), () => clock++, () => {}, post, () => valid, s)
  const pending = (name = 'A') => owed(room, { name }, { frontier: 0, routed: new Set() }, {}).map(m => m.id)
  const claim = (id: string): Claim => ({ id, by: 'B', byKind: 'agent', path: 'x', from: 1, to: 2, intent: 'edit', at: 1 })
  const add = (id: string) => room.claims.set(id, claim(id))
  const settle = (kind: Evaluation['kind'], status: Evaluation['status'], subject = '', keySubject = subject) => {
    const key = slotKey('A', kind, 'B', 'x', keySubject)
    return slots.settle(key, { owner: 'A', other: 'B', path: 'x', kind, ...(subject ? { subject } : {}),
      status, inputs: `${subject}:${status}`, factId: status === 'clean' ? '' : 'same' })
  }
  const drop = async (key: string, reason = 'withdraw-authority') => { await (slots.drop as any)(key, reason); await slots.replay('A') }
  cleanup.push(() => { hub.stop(); room.doc.destroy() })
  const replaceOwner = (workerId: string) => {
    const grant = hub.handle(conn, { v: 1, id: workerId, op: 'acquire', name: 'A', holder: { sessionId: 'a', pid: 1, startTime: '', executable: '', workerId } }, principal)
    expect(grant.ok).toBe(true)
    epoch = Number(grant.epoch)
  }
  return { room, hub, conn, s, slots, send, post, pending, add, settle, drop, replaceOwner,
    setValid: (value: boolean) => { valid = value }, lose: () => { epoch = undefined }, refuse: (value: boolean) => { refuse = value } }
}

function publications(f: Awaited<ReturnType<typeof fixture>>) {
  const dir = mkdtempSync(join(tmpdir(), 'notice-stage1-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.email', 'test@test'); git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'x'), 'base\n'); git('add', 'x'); git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  f.hub.handle(f.conn, { v: 1, id: 'b', op: 'acquire', name: 'B', holder: { sessionId: 'a', pid: 1, startTime: '', executable: '', workerId: 'w1' } }, { local: true })
  f.room.ensureRoomSalt()
  f.s.dir = dir
  f.s.awareness = { getStates: () => new Map(['A', 'B'].map((name, index) => [index, { user: { name, kind: 'agent' }, sessionId: 'a' }])) } as any
  const entry = (name: string, text: string) => {
    const fence = String(participantRecord(f.room, name)!.holder!.epoch)
    f.room.participants.set(`${name}\0id`, { name, kind: 'agent' })
    f.room.participants.set(`${name}\0git`, { base, head: base, branch: 'main', rev: 1, anchored: true, fence })
    const prior = f.room.manifestHead.get(name), rev = (prior?.rev ?? 0) + 1
    f.room.manifestHead.set(name, { base, fence, rev, semRev: rev, level: 'full', coverage: { kind: 'all' }, complete: true, excluded: [], scannedAt: 1 })
    let entries = f.room.manifest.get(manifestKey(name, fence))
    if (!entries) { entries = new Y.Map(); f.room.manifest.set(manifestKey(name, fence), entries) }
    entries.set('x', { change: 'M', state: 'shared', hash: gitBlobHash(text), fence, at: 1 })
    f.room.setOverlay(manifestKey(name, fence), 'x', text)
  }
  entry('A', 'mine\n'); entry('B', 'peer\n')
  const replaceWorker = (id: string) => {
    expect(f.hub.handle(f.conn, { v: 1, id, op: 'acquire', name: 'B', holder: { sessionId: 'a', pid: 1, startTime: '', executable: '', workerId: id } }, { local: true }).ok).toBe(true)
    entry('B', 'peer\n')
  }
  const create = () => new ConflictSet(f.s, 'A', f.s, () => {}, 0, () => undefined, async () => undefined, () => undefined)
  let set = create()
  cleanup.push(() => set.stop())
  return { get set() { return set }, entry, replaceWorker, reconnect: () => { set.stop(); set = create() } }
}


const retiredW1 = { snapshot: async () => ({ available: true, revision: '1', blockers: [], workers: [{ record: {
  id: 'w1', room: 'r', phase: 'retired', seq: 1, lead: { participant: 'A', instance: { nonce: 'lead' } },
} }] }) }

it.each([false, true])('an unchanged conflict with same-tag successor survives old worker retirement (managed=%s)', async managed => {
  const f = await fixture(managed), p = publications(f), key = slotKey('A', 'merge', 'B', 'x')
  await p.set.reconcile('original worker conflict')
  const original = f.slots.get(key)!
  expect(original).toMatchObject({ status: 'conflict' })
  expect(f.pending()).toHaveLength(1)
  p.replaceWorker('w2')
  f.room.retireWorker('w1', { id: 'w1', name: 'B', lead: 'A', tag: 'B', task: '', summary: '', files: [], fileCount: 0, retiredAt: Date.now() } as any, () => {})
  await p.set.reconcile('successor has the same conflicting hunks')
  expect(f.slots.get(key)).toMatchObject({ status: 'conflict', factId: original.factId })
  expect(participantRecord(f.room, 'B')?.holder?.workerId).toBe('w2')
  await retireNoticeDependencies(f.s, retiredW1 as any, () => true)
  await p.set.reconcile('replay the still-open successor conflict after retirement')
  expect(f.slots.get(key)).toMatchObject({ status: 'conflict' })
  expect(f.pending()).toHaveLength(1)
})

it('nonterminal, absent and unavailable registry facts never propose an ending', async () => {
  const f = await fixture(), p = publications(f)
  await p.set.reconcile('live worker conflict')
  for (const phase of ['intent', 'preparing', 'prepared', 'active', 'collecting', 'discarding', 'retiring']) {
    const record = { ...(await retiredW1.snapshot()).workers[0].record, phase, keptWorktree: '/retained' }
    await retireNoticeDependencies(f.s, { snapshot: async () => ({ available: true, revision: '1', blockers: [], workers: [{ record }] }) } as any, () => true)
  }
  for (const snapshot of [{ available: true, revision: '1', blockers: [], workers: [] },
    { available: false, revision: '1', blockers: [], workers: [] },
    { ...(await retiredW1.snapshot()), blockers: ['unreadable record'] }])
    await retireNoticeDependencies(f.s, { snapshot: async () => snapshot } as any, () => true)
  expect(f.send.mock.calls.every(([intent]) => intent.action === 'register')).toBe(true)
  expect(f.room.outcomes.size).toBe(0)
  expect(f.pending()).toHaveLength(1)
})

it.each(['w1', 'owner-worker'])('retiring either endpoint (%s) ends both copies bound to that incarnation, and its successor delivers fresh copies', async retiredId => {
  const f = await fixture(true, 'owner-worker')
  const p = publications(f)
  expect(f.hub.handle(f.conn, { v: 1, id: 'unrelated', op: 'acquire', name: 'C', holder: {
    sessionId: 'a', pid: 1, startTime: '', executable: '', workerId: 'unrelated-worker',
  } }, { local: true }).ok).toBe(true)
  f.add('claim')
  await f.settle('edit-in-claim', 'conflict', 'claim')
  const entries = [...f.room.doc.getMap<core.NoticeRecord>('noticeInventory').values()].flatMap(r => r.entries)
  expect(entries.map(e => e.to).sort()).toEqual(['A', 'B'])
  for (const entry of entries) expect(entry.dependencies).toEqual([
    { workerId: 'owner-worker', principal: 'local' }, { workerId: 'w1', principal: 'local' },
  ])
  const record = { ...(await retiredW1.snapshot()).workers[0].record, id: 'unrelated-worker' }
  await retireNoticeDependencies(f.s, { snapshot: async () => ({ available: true, revision: '1', blockers: [], workers: [{ record }] }) } as any, () => true)
  expect(f.room.outcomes.size).toBe(0)
  const retired = { ...record, id: retiredId }
  await retireNoticeDependencies(f.s, { snapshot: async () => ({ available: true, revision: '1', blockers: [], workers: [{ record: retired }] }) } as any, () => true)
  expect(entries.every(e => f.room.outcomes.has(e.id))).toBe(true)
  expect(f.pending('A')).toEqual([])
  expect(f.pending('B')).toEqual([])
  if (retiredId === 'w1') p.replaceWorker('w2')
  else f.replaceOwner('owner-successor')
  await f.settle('edit-in-claim', 'conflict', 'claim')
  await f.slots.replay('A')
  const current = [...f.room.doc.getMap<core.NoticeRecord>('noticeInventory').values()].flatMap(r => r.entries).filter(e => !e.ended)
  expect(current.map(e => e.to).sort()).toEqual(['A', 'B'])
  expect(current.every(e => !entries.some(old => old.id === e.id))).toBe(true)
  for (const name of ['A', 'B']) expect(f.pending(name)).toEqual([current.find(e => e.to === name)!.id])
})


it('a successor can deliver the identical conflict after w1 already retired', async () => {
  const f = await fixture(), p = publications(f)
  await p.set.reconcile('w1')
  const first = f.pending()[0]!
  await retireNoticeDependencies(f.s, retiredW1 as any, () => true)
  expect(f.pending()).toEqual([])
  p.replaceWorker('w2')
  await p.set.reconcile('identical w2 conflict after terminal w1')
  const second = f.pending()[0]!
  expect(second).toBeDefined()
  expect(second).not.toBe(first)
  expect(f.room.outcomes.has(first)).toBe(true)
  expect(f.room.outcomes.has(second)).toBe(false)
  p.reconnect()
  await p.set.reconcile('reconnect')
  expect(f.pending()).toEqual([second])
})

it('upgrading an already-open worker conflict publishes one additional incarnation id, stable across reconnect', async () => {
  const f = await fixture(false), p = publications(f)
  await p.set.reconcile('legacy conflict')
  const baseline = f.pending()[0]!
  f.s.contract = { capabilities: { 'room.notice-lifecycle': 1 }, legacy: false } as any
  f.hub.noticeContract(f.conn, { capabilities: { 'room.notice-lifecycle': 1 } })
  p.reconnect()
  for (let n = 0; n < 3; n++) await p.set.reconcile('upgrade replay')
  const ids = f.room.messages().map(m => m.id)
  expect(ids).toHaveLength(2)
  expect(ids).toContain(baseline)
  const added = ids.find(id => id !== baseline)!
  expect(added).toMatch(/:worker:[0-9a-f]{64}$/)
  expect(added.startsWith(baseline + ':worker:')).toBe(true)
  p.reconnect()
  for (let n = 0; n < 3; n++) await p.set.reconcile('reconnect again')
  expect(f.room.messages().map(m => m.id)).toEqual(ids)
  expect(f.pending()).toEqual(ids)
  expect(supersededConflictNotices(f.room.messages())).toEqual(new Set([baseline]))
})

it.each(['merge', 'edit-in-claim', 'claims', 'contract', 'possible'] as const)('a %s notice binds both workers before their views arrive and replays the same ids', async kind => {
  const f = await fixture(true, 'owner-worker'); publications(f)
  f.add('claim')
  await f.settle(kind === 'possible' ? 'edit-in-claim' : kind, kind === 'possible' ? 'possible' : 'conflict', 'claim')
  const ids = f.room.messages().map(m => m.id)
  expect(ids.length).toBeGreaterThan(0)
  expect(ids.every(id => /:worker:[0-9a-f]{64}$/.test(id))).toBe(true)
  for (const [id, name] of [['owner-worker', 'A'], ['w1', 'B']])
    f.room.workerViews.set(id, { id, name, lead: 'elsewhere', status: 'running' } as any)
  const reconnected = new ConflictSlots(f.room, f.post, f.s.lease.fence()!, () => Date.now(), () => {}, f.post, () => true, f.s)
  for (let n = 0; n < 3; n++) await reconnected.replay('A')
  expect(f.room.messages().map(m => m.id)).toEqual(ids)
  const entries = [...f.room.doc.getMap<core.NoticeRecord>('noticeInventory').values()].flatMap(r => r.entries)
  expect(entries.map(e => e.id)).toEqual(ids)
  expect(entries.every(e => e.dependencies.length === 2)).toBe(true)
})

it('unknown worker identity stays on baseline TTL even if a worker view claims the name', async () => {
  const f = await fixture()
  f.room.workerViews.set('unverified', { id: 'unverified', name: 'B', lead: 'elsewhere', status: 'running' } as any)
  await f.settle('merge', 'conflict')
  expect(f.pending()).toHaveLength(1)
  expect(f.pending()[0]).not.toContain(':worker:')
  expect(f.send).not.toHaveBeenCalled()
  expect(f.room.doc.getMap('noticeInventory').size).toBe(0)
  await retireNoticeDependencies(f.s, retiredW1 as any, () => true)
  expect(f.pending()).toHaveLength(1)
})


it('a missing holder keeps the first post baseline, then the arriving identity produces one stable bound id', async () => {
  const f = await fixture(true, 'owner-worker'); publications(f)
  const holder = f.room.participants.get('B\0holder')!
  f.room.participants.delete('B\0holder')
  await f.settle('merge', 'conflict')
  const baseline = f.room.messages()[0]!.id
  expect(baseline).not.toContain(':worker:')
  expect(f.send).not.toHaveBeenCalled()
  // Simulate delayed replica delivery of the already-private worker identity.
  f.room.participants.set('B\0holder', holder)
  expect(participantRecord(f.room, 'B')?.holder?.workerId).toBe('w1')
  for (let n = 0; n < 3; n++) await f.slots.replay('A')
  const ids = f.room.messages().map(m => m.id)
  expect(ids).toHaveLength(2)
  expect(ids[1]).toBe(core.workerNoticeId(baseline, ['owner-worker', 'w1']))
  expect([...f.room.doc.getMap<core.NoticeRecord>('noticeInventory').values()].flatMap(r => r.entries).map(e => e.id)).toEqual([ids[1]])
})

it('a rejected replica worker binding cannot fall back to the retired predecessor id for a live successor conflict', async () => {
  const f = await fixture(), p = publications(f), key = slotKey('A', 'merge', 'B', 'x')
  await p.set.reconcile('w1 conflict')
  const first = f.pending()[0]!
  p.replaceWorker('w2')
  // Keep the current epoch and publication, but let a replica overwrite only
  // the public workerId. The private hub authority still says w2.
  const current = f.room.participants.get('B\0holder') as Record<string, unknown>
  f.room.participants.set('B\0holder', { ...current, workerId: 'w1' })
  await p.set.reconcile('same current conflict under a replica-corrupted holder')
  expect(f.slots.get(key)).toMatchObject({ status: 'conflict' })
  expect(await f.send.mock.results.at(-1)!.value).toMatchObject({ ok: false, reason: 'stale' })
  const baseline = first.replace(/:worker:[0-9a-f]{64}$/, '')
  expect(f.post).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { id: baseline, auto: true })
  await retireNoticeDependencies(f.s, retiredW1 as any, () => true)
  expect(f.room.outcomes.has(first)).toBe(true)
  // A refused binding must leave an unbound TTL notice, not silently dedup
  // against the predecessor's destructively managed id.
  expect(f.pending()).toEqual([baseline])
  expect(f.room.outcomes.has(baseline)).toBe(false)
  f.room.participants.set('B\0holder', current)
  for (let n = 0; n < 3; n++) await p.set.reconcile('repaired successor binding')
  const bound = core.workerNoticeId(baseline, ['w2'])!
  expect(f.room.messages().map(m => m.id)).toEqual([first, baseline, bound])
  expect(f.room.outcomes.has(bound)).toBe(false)
  const ledger = new Ledger({ sessionId: () => 'a', route: () => ({}) })
  ledger.bind(f.s)
  expect(ledger.candidates(f.s).map(m => m.id)).toEqual([bound])
  p.reconnect()
  for (let n = 0; n < 3; n++) await p.set.reconcile('reconnect after repair')
  expect(f.room.messages().map(m => m.id)).toEqual([first, baseline, bound])
})

it.each([false, true])('upgrade and capability flaps add one bound identity and preserve receipts (receipt before upgrade=%s)', async receipted => {
  const f = await fixture(false), p = publications(f)
  const ledger = new Ledger({ sessionId: () => 'a', route: () => ({}) })
  ledger.bind(f.s)
  await p.set.reconcile('baseline open conflict')
  const baseline = f.pending()[0]!
  if (receipted) {
    const batch = ledger.open('reply')
    expect(ledger.select(f.s, batch).map(m => m.id)).toEqual([baseline])
    ledger.commit(batch)
  }
  f.s.contract = { capabilities: { 'room.notice-lifecycle': 1 }, legacy: false } as any
  f.hub.noticeContract(f.conn, { capabilities: { 'room.notice-lifecycle': 1 } })
  p.reconnect()
  await p.set.reconcile('upgrade')
  const bound = core.workerNoticeId(baseline, ['w1'])!
  expect(f.room.messages().map(m => m.id)).toEqual([baseline, bound])
  expect(ledger.candidates(f.s).map(m => m.id)).toEqual([bound])
  const batch = ledger.open('reply')
  ledger.select(f.s, batch)
  ledger.commit(batch)
  for (const capable of [false, true, false, true]) {
    f.s.contract = { capabilities: capable ? { 'room.notice-lifecycle': 1 } : {}, legacy: !capable } as any
    const slots = new ConflictSlots(f.room, f.post, f.s.lease.fence()!, () => Date.now(), () => {}, f.post, () => true, f.s)
    await slots.replay('A')
    expect(f.room.messages().map(m => m.id)).toEqual([baseline, bound])
    expect(ledger.candidates(f.s)).toEqual([])
  }
})

it('bound per-peer partial clear retains notify plus fyi and full clear supersedes both', async () => {
  const f = await fixture(); publications(f)
  const ledger = new Ledger({ sessionId: () => 'a', route: () => ({}) })
  ledger.bind(f.s)
  const settle = (path: string, status: 'conflict' | 'clean') => f.slots.settle(slotKey('A', 'merge', 'B', path), {
    owner: 'A', other: 'B', path, kind: 'merge', status, inputs: path + status, factId: status === 'clean' ? '' : path,
  })
  await settle('x', 'conflict'); await settle('y', 'conflict')
  const notice = ledger.candidates(f.s)[0]!
  expect(ledger.candidates(f.s)).toHaveLength(1)
  await settle('x', 'clean')
  expect(ledger.candidates(f.s).map(m => m.priority)).toEqual(['notify', 'fyi'])
  expect(ledger.candidates(f.s).map(m => m.id)).toContain(notice.id)
  await settle('y', 'clean')
  expect(ledger.candidates(f.s)).toHaveLength(1)
  expect(ledger.candidates(f.s)[0]).toMatchObject({ priority: 'fyi', clearedFrom: 'conflict' })
})


it('late managed acceptance cannot resolve a different request or register the timeout fallback id', async () => {
  vi.useFakeTimers()
  let client: HubClient | undefined
  try {
    const f = await fixture()
    expect(f.hub.handle(f.conn, { v: 1, id: 'worker', op: 'acquire', name: 'B', holder: {
      sessionId: 'a', pid: 1, startTime: '', executable: '', workerId: 'w1',
    } }, { local: true }).ok).toBe(true)
    const listeners = new Set<(bytes: Uint8Array) => void>()
    const held: core.Reply[] = [], sent: core.Req[] = []
    const emit = (reply: core.Reply) => { for (const fn of listeners) fn(core.encodeFrame(reply)) }
    const transport = {
      connected: () => true, onReconnect: () => () => {}, onClose: () => () => {},
      onFrame: (fn: (bytes: Uint8Array) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      send: (bytes: Uint8Array) => {
        const req = core.decodeFrame(bytes) as core.Req
        sent.push(req)
        const reply = f.hub.handle(f.conn, req, { local: true })
        if (req.op === 'notice-lifecycle' && req.action === 'register') held.push(reply)
        else queueMicrotask(() => emit(reply))
      },
    }
    client = new HubClient({ transport, client: 'review', sessionId: 'a', local: true, noticeCapability: () => true })
    await client.hello()
    await client.acquire('A', { sessionId: 'a', pid: 1, startTime: '', executable: '' })
    const hubClient = client
    const post: Post = (async (from, body, options) => {
      const msg = outgoing(from, body, options!.id!)
      const reply = await hubClient.post(msg, { lease: { name: 'A', epoch: hubClient.lease('A')! }, auto: true })
      return { ...reply, msg: { ...msg, at: Date.now() } }
    }) as Post
    const s = { ...f.s, hub: client, post, lease: { sessionId: 'a', fence: () => {
      const epoch = hubClient.lease('A'); return epoch === undefined ? undefined : String(epoch)
    } } } as unknown as Session
    const lifecycle = noticeLifecycle(s)!
    const register = () => lifecycle.register({ name: 'room', kind: 'agent' }, {
      type: 'merge-conflict', to: 'A', path: 'x', priority: 'notify', text: 'x conflicts with B',
    }, 'cf:reply', ['A', 'B'], () => true)
    const first = register()
    await vi.advanceTimersByTimeAsync(1)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ ok: true, managed: true })
    const bound = core.workerNoticeId('cf:reply', ['w1'])!
    expect(f.room.messages().map(m => m.id)).toEqual([bound])
    await vi.advanceTimersByTimeAsync(core.REQUEST_TIMEOUT_LOCAL_MS + 1)
    expect(await first).toMatchObject({ ok: true, msg: { id: 'cf:reply' } })
    expect(f.room.messages().map(m => m.id)).toEqual([bound, 'cf:reply'])
    let secondSettled = false
    const second = register().then(value => { secondSettled = true; return value })
    await vi.advanceTimersByTimeAsync(1)
    expect(held).toHaveLength(2)
    expect(held[1].re).not.toBe(held[0].re)
    emit(held[0])
    emit({ v: 1, re: 'unrelated-request', ok: true, managed: true })
    await vi.advanceTimersByTimeAsync(1)
    expect(secondSettled).toBe(false)
    emit(held[1])
    expect(await second).toMatchObject({ ok: true, msg: { id: bound } })
    expect(sent.filter(req => req.op === 'post').map(req => req.msg.id)).toEqual(['cf:reply'])
    expect(f.room.messages().map(m => m.id)).toEqual([bound, 'cf:reply'])
    const entries = [...f.room.doc.getMap<core.NoticeRecord>('noticeInventory').values()].flatMap(r => r.entries)
    expect(entries.map(e => e.id)).toEqual([bound])
    await retireNoticeDependencies(s, retiredW1 as any, () => true)
    expect(f.room.outcomes.has(bound)).toBe(true)
    expect(f.room.outcomes.has('cf:reply')).toBe(false)
    expect(f.pending()).toEqual(['cf:reply'])
  } finally { client?.close(); vi.useRealTimers() }
})
