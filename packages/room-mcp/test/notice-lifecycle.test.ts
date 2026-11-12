import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoomDoc, owed, outgoing, type Claim } from '@room/shared'
import * as core from '@room/hub-core'
import { ConflictSlots, slotKey, type Evaluation } from '../src/conflict-set.js'
import * as lifecycleModule from '../src/notice-lifecycle.js'
import type { Session } from '../src/session.js'
import type { Post } from '../src/post.js'
import { HubClient, HubError } from '../src/hub-client.js'

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0)) fn() })
async function fixture(managed = true) {
  const room = new RoomDoc()
  let max: number | undefined, tick = 0, clock = Date.now()
  const hub = await core.startHub({ doc: room, mono: () => tick, wall: () => clock,
    store: core.serializedStore({ read: async () => max, write: async n => { max = n } }), log() {} })
  tick += core.SETTLE_MS
  let conn = {}
  const principal = { local: true } as const
  hub.handle(conn, { v: 1, id: 'h', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 'a' }, principal)
  if (managed) (hub as any).noticeContract?.(conn, { capabilities: { 'room.notice-lifecycle': 1 } })
  const grant = hub.handle(conn, { v: 1, id: 'a', op: 'acquire', name: 'A', holder: { sessionId: 'a', pid: 1, startTime: '', executable: '' } }, principal) as any
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
    contract: managed ? { capabilities: { 'room.notice-lifecycle': 1 } } : { capabilities: {} },
    hub: { noticeLifecycle: send, noticeIncarnation: () => hub.incarnation }, provider: { synced: true } } as unknown as Session
  // Before implementation the extra argument is ignored, so the baseline really publishes notices.
  const slots = new (ConflictSlots as any)(room, post, () => String(epoch), () => clock++, () => {}, post, () => valid, s) as ConflictSlots
  const pending = (name = 'A') => owed(room, { name }, { frontier: 0, routed: new Set() }, {}).map(m => m.id)
  const claim = (id: string): Claim => ({ id, by: 'B', byKind: 'agent', path: 'x', from: 1, to: 2, intent: 'edit', at: 1 })
  const add = (id: string) => room.claims.set(id, claim(id))
  const settle = (kind: Evaluation['kind'], status: Evaluation['status'], subject = '', keySubject = subject) => {
    const key = slotKey('A', kind, 'B', 'x', keySubject)
    return slots.settle(key, { owner: 'A', other: 'B', path: 'x', kind, ...(subject ? { subject } : {}),
      status, inputs: `${subject}:${status}`, factId: status === 'clean' ? '' : 'same' })
  }
  const drop = async (key: string) => { slots.drop(key); await slots.replay('A') }
  cleanup.push(() => { hub.stop(); room.doc.destroy() })
  const reacquire = (nextSession = 'a', lapse = false) => {
    if (lapse) tick += core.LEASE_TTL_MS + 1
    if (nextSession !== s.lease.sessionId) {
      conn = {}
      hub.handle(conn, { v: 1, id: 'h2', op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: nextSession }, principal)
      hub.noticeContract(conn, { capabilities: { 'room.notice-lifecycle': 1 } })
    }
    const grant = hub.handle(conn, { v: 1, id: 'a2', op: 'acquire', name: 'A', supersedes: epoch,
      holder: { sessionId: nextSession, pid: 1, startTime: '', executable: '' } }, principal) as any
    expect(grant.ok).toBe(true)
    epoch = grant.epoch
    const successor = nextSession === s.lease.sessionId ? s
      : { ...s, lease: { ...s.lease, sessionId: nextSession } } as Session
    return new ConflictSlots(room, post, () => String(epoch), () => clock++, () => {}, post, () => valid, successor)
  }
  return { room, hub, conn, s, slots, send, post, pending, add, settle, drop, reacquire,
    setValid: (value: boolean) => { valid = value }, lose: () => { epoch = undefined }, refuse: (value: boolean) => { refuse = value } }
}
function worker(f: Awaited<ReturnType<typeof fixture>>, id = 'w1') {
  expect(f.hub.handle(f.conn, { v: 1, id, op: 'acquire', name: 'B', holder: { sessionId: 'a', pid: 1, startTime: '', executable: '', workerId: id } }, { local: true })).toMatchObject({ ok: true })
}
function registry(phase: string, id = 'w1', seq = 1) {
  return { snapshot: async () => ({ available: true, revision: String(seq), blockers: [], workers: [{ record: {
    id, room: 'r', phase, seq, keptWorktree: phase === 'prepared' ? '/kept' : undefined,
    lead: { participant: 'A', instance: { nonce: 'origin' } },
  } }] }) }
}
const entries = (f: Awaited<ReturnType<typeof fixture>>) => [...f.room.doc.getMap<core.NoticeRecord>('noticeInventory').values()].flatMap(r => r.entries)

describe('retirement-only same-room registration', () => {
  it.each(['merge', 'edit-in-claim', 'claims', 'contract'] as const)('no live %s notice receives an ending from clean, unknown, drop, renewal or supersession', async kind => {
    const f = await fixture(); worker(f)
    f.add('old')
    await f.settle(kind, 'conflict', 'old', '')
    expect(entries(f).length).toBeGreaterThan(0)
    const initial = entries(f).map(e => e.id)
    f.room.claims.delete('old'); f.add('renewed')
    for (const state of ['possible', 'unknown', 'clean', 'conflict'] as const) {
      await f.settle(kind, state, 'renewed', '')
      await f.slots.replay('A')
      await lifecycleModule.retireNoticeDependencies(f.s, registry('active') as any, () => true)
      expect(f.room.outcomes.size).toBe(0)
      expect(entries(f).every(e => e.ended === undefined)).toBe(true)
    }
    await f.drop(slotKey('A', kind, 'B', 'x'))
    await lifecycleModule.retireNoticeDependencies(f.s, registry('active') as any, () => true)
    expect(f.room.outcomes.size).toBe(0)
    expect(initial.every(id => f.room.message(id))).toBe(true)
    expect(f.send.mock.calls.every(([intent]) => intent.action === 'register')).toBe(true)
    expect(f.room.doc.share.has('conflictEpisodes')).toBe(false)
    expect(f.slots.owned('A').some(([, slot]) => 'evaluated' in slot || 'noticeMembers' in slot)).toBe(false)
  })

  it('only the negotiated HubClient sends registration or retirement frames', async () => {
    const sent: string[] = [], listeners = new Set<(bytes: Uint8Array) => void>()
    let supported = false
    const transport = { connected: () => true, onReconnect: () => () => {}, onClose: () => () => {},
      onFrame: (fn: (bytes: Uint8Array) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      send: (bytes: Uint8Array) => {
        const req = core.decodeFrame(bytes) as any
        sent.push(req.op)
        queueMicrotask(() => { for (const listener of listeners) listener(core.encodeFrame({ v: 1, re: req.id, ok: true,
          ...(req.op === 'hello' ? { incarnation: 7 } : req.op === 'acquire' ? { epoch: 42, ttlMs: 45_000 } : { managed: true }) })) })
      } }
    const client = new HubClient({ transport, client: 'new', sessionId: 'new', noticeCapability: () => supported })
    cleanup.push(() => client.close())
    await client.hello(); await client.acquire('A', { sessionId: 'new', pid: 1, startTime: '', executable: '' })
    const intent = { action: 'retire' as const, producer: 'retirement', expected: 0, operation: 'retire', workerId: 'w1',
      targets: [], lease: { name: 'A', epoch: 42 } }
    await expect(client.noticeLifecycle(intent)).rejects.toThrow('unsupported')
    expect(sent).toEqual(['hello', 'acquire'])
    supported = true
    expect(await client.noticeLifecycle(intent)).toMatchObject({ ok: true, managed: true })
    expect(sent).toEqual(['hello', 'acquire', 'notice-lifecycle'])
  })

  it('old-hub fallback posts baseline messages and drops remain on TTL', async () => {
    const f = await fixture(false)
    await f.settle('merge', 'conflict')
    const original = f.pending()[0]!
    await f.drop(slotKey('A', 'merge', 'B', 'x'))
    expect(f.pending()).toContain(original)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.room.outcomes.size).toBe(0)
  })

  it.each(['retired', 'abandoned'])('a stable %s worker registry record ends its exact registered dependencies', async phase => {
    const f = await fixture(); worker(f)
    await f.settle('merge', 'conflict')
    const id = f.pending()[0]!
    expect(entries(f)[0].dependencies).toContainEqual({ workerId: 'w1', principal: 'local' })
    await lifecycleModule.retireNoticeDependencies(f.s, registry(phase) as any, () => true)
    expect(f.room.outcomes.has(id)).toBe(true)
    expect(f.pending()).not.toContain(id)
  })

  it('kept, stopped and then resumed worker records preserve registered ids until actual retirement', async () => {
    const f = await fixture(); worker(f)
    await f.settle('merge', 'conflict')
    const id = f.pending()[0]!
    for (const [phase, seq] of [['prepared', 2], ['active', 3], ['active', 4]] as const) {
      await lifecycleModule.retireNoticeDependencies(f.s, registry(phase, 'w1', seq) as any, () => true)
      expect(f.room.outcomes.has(id)).toBe(false)
    }
    await lifecycleModule.retireNoticeDependencies(f.s, registry('retired', 'w1', 5) as any, () => true)
    expect(f.room.outcomes.has(id)).toBe(true)
  })

  it('same-tag w1 retirement cannot end a newly registered w2 notice', async () => {
    const f = await fixture(); worker(f)
    await f.settle('merge', 'conflict')
    const first = entries(f)[0].id
    worker(f, 'w2')
    await f.slots.settle(slotKey('A', 'merge', 'B', 'x'), { owner: 'A', other: 'B', kind: 'merge', path: 'x',
      status: 'conflict', inputs: 'new conflict fact', factId: 'new conflict fact' })
    const second = entries(f).find(e => e.dependencies.some(d => d.workerId === 'w2'))!.id
    expect(second).not.toBe(first)
    await lifecycleModule.retireNoticeDependencies(f.s, registry('retired') as any, () => true)
    expect(f.room.outcomes.has(first)).toBe(true)
    expect(f.room.outcomes.has(second)).toBe(false)
    expect(f.pending()).toContain(second)
  })

  it('worker dependency registration uses private leases, never a forged worker view', async () => {
    const f = await fixture(); worker(f)
    f.room.workerViews.set('fake', { id: 'fake', name: 'B', lead: 'A', status: 'running' } as any)
    await f.settle('merge', 'conflict')
    expect(entries(f)[0].dependencies).toEqual([{ workerId: 'w1', principal: 'local' }])
    await lifecycleModule.retireNoticeDependencies(f.s, registry('retired', 'fake') as any, () => true)
    expect(f.room.outcomes.size).toBe(0)
  })

  it('registry incarnation/revision changes prevent stale retirement proposals', async () => {
    const f = await fixture(); worker(f)
    await f.settle('merge', 'conflict')
    let reads = 0
    const changing = { snapshot: async () => {
      const seq = ++reads === 1 ? 2 : 3
      return { available: true, revision: String(seq), blockers: [], workers: [{ record: {
        id: 'w1', room: 'r', phase: 'retired', seq, lead: { instance: { nonce: `origin-${seq}` } },
      } }] }
    } }
    await lifecycleModule.retireNoticeDependencies(f.s, changing as any, () => true)
    expect(f.room.outcomes.size).toBe(0)
    await lifecycleModule.retireNoticeDependencies(f.s, changing as any, () => true)
    expect(f.room.outcomes.size).toBe(1)
  })

  it('delayed inventory replication uses accepted replies and a new lease requires no evaluation adoption', async () => {
    const f = await fixture(); worker(f)
    await f.settle('contract', 'conflict', 'api')
    f.room.doc.getMap('noticeInventory').clear()
    await f.settle('contract', 'clean', 'api')
    expect(f.room.outcomes.size).toBe(0)
    f.reacquire('a')
    await f.settle('contract', 'conflict', 'another-api')
    expect(f.send.mock.calls.every(([intent]) => intent.action === 'register')).toBe(true)
    await lifecycleModule.retireNoticeDependencies(f.s, registry('retired') as any, () => true)
    expect(entries(f).every(e => e.ended !== undefined)).toBe(true)
  })

  it.each(['stale', 'capacity', 'unconfirmed', 'timeout', 'transport'])('a %s registration uses the baseline id for fallback, then registers a corrected replay once', async failure => {
    const f = await fixture(); worker(f)
    const actual = f.send.getMockImplementation()!
    f.send.mockImplementationOnce(async () => {
      if (failure === 'stale') throw new HubError('stale', 'replica binding refused')
      if (failure === 'capacity') return { ok: true, managed: false, fallback: 'capacity' } as any
      if (failure === 'unconfirmed') return { ok: true } as any
      throw new Error(failure === 'timeout' ? 'the hub did not answer' : 'hub unreachable')
    })
    await f.settle('merge', 'conflict')
    const baseline = f.pending()[0]!
    expect(baseline).not.toContain(':worker:')
    expect(f.post).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { id: baseline, auto: true })
    expect(entries(f)).toEqual([])
    f.send.mockImplementation(actual)
    for (let n = 0; n < 3; n++) await f.slots.replay('A')
    const bound = core.workerNoticeId(baseline, ['w1'])!
    expect(f.room.messages().map(m => m.id)).toEqual([baseline, bound])
    expect(entries(f).map(e => e.id)).toEqual([bound])
    await lifecycleModule.retireNoticeDependencies(f.s, registry('retired') as any, () => true)
    expect(f.room.outcomes.has(bound)).toBe(true)
    expect(f.room.outcomes.has(baseline)).toBe(false)
    expect(f.pending()).toEqual([baseline])
  })

  it('a lost acceptance reply falls back under the baseline id and replay deduplicates the accepted binding', async () => {
    const f = await fixture(); worker(f)
    const actual = f.send.getMockImplementation()!
    f.send.mockImplementationOnce(async intent => {
      expect(await actual(intent)).toMatchObject({ ok: true, managed: true })
      throw new Error('the hub did not answer')
    })
    await f.settle('merge', 'conflict')
    const ids = f.room.messages().map(m => m.id)
    expect(ids).toHaveLength(2)
    const baseline = ids.find(id => !id.includes(':worker:'))!
    const bound = core.workerNoticeId(baseline, ['w1'])!
    expect(ids).toEqual([bound, baseline])
    expect(f.post).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { id: baseline, auto: true })
    for (let n = 0; n < 3; n++) await f.slots.replay('A')
    expect(f.room.messages().map(m => m.id)).toEqual(ids)
    expect(entries(f).map(e => e.id)).toEqual([bound])
  })

  it('registration saturation falls back explicitly to TTL while admitted retirements retain capacity', async () => {
    const f = await fixture(); worker(f)
    const life = lifecycleModule.noticeLifecycle(f.s)!
    for (let n = 0; n < 200; n++) await life.register({ name: 'room', kind: 'agent' }, {
      type: 'contract', path: 'x', symbol: 'api', to: 'A', priority: 'notify', text: 'baseline notice',
    }, `cf:capacity-${n}`, ['A', 'B'], () => true)
    const admitted = entries(f).length
    expect(admitted).toBeGreaterThanOrEqual(64)
    expect(admitted).toBeLessThan(200)
    expect(f.room.messages()).toHaveLength(200)
    await lifecycleModule.retireNoticeDependencies(f.s, registry('retired') as any, () => true)
    expect(f.room.outcomes.size).toBe(admitted)
    expect(entries(f).every(e => e.ended !== undefined)).toBe(true)
  })
})
