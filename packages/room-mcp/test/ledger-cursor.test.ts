import { slotKey } from '@room/shared'
import { mutateWorkerFixture } from './fixtures/worker-record.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SETTLE_MS, serializedStore, startHub, type Hub } from '@room/hub-core'
import { highestSeq, RoomDoc, trim, type Identity, type Msg, type PostBody } from '@room/shared'
import { hubAppend } from '@room/shared/testing'
import { Ledger } from '../src/ledger.js'
import type { Post } from '../src/post.js'
import { ConflictSlots } from '../src/conflict-set.js'
import type { Session } from '../src/session.js'
import { closeRegistryForDir, openWorkerReader, registryForDir } from '../src/worker-registry.js'
import { seedRegistryWorker } from './registry-fixture.js'

// Ledger "Cursor: a seq frontier (hub)": the frontier is the highest hub seq a session had observed at its
// first bind; hub §3 makes every later accepted seq larger, across hub restarts too.

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'room-cursor-')); execFileSync('git', ['-C', dir, 'init', '-q']) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(async () => { vi.unstubAllEnvs(); await closeRegistryForDir(dir) })

const session = (room: RoomDoc, name = 'pat'): Session => ({ room, me: { name, kind: 'agent' }, roomName: 'r', dir, provider: { synced: true } } as unknown as Session)
const ledger = (sessionDir?: string) => new Ledger({ sessionId: () => 'host-1', sessionDir: () => sessionDir, route: () => ({}) })
const ids = (messages: readonly Msg[]) => messages.map(m => m.id)

describe('event receipts in notice chunks', () => {
  it('persists each confirmed event and does not replay it when status text changes chunk boundaries', () => {
    const sessionDir = join(dir, 'notice-events')
    const events = ['a', 'b', 'c'].map(name => ({ identity: `w_${name}:1:100`, text: name.repeat(30) }))
    const first = ledger(sessionDir)
    first.noticeEvents('worker-restart', 'Recovery', events, 80)
    const batch = first.open('hook')
    expect(first.notices(batch, 80).map(n => n.text)).toEqual(['Recovery\n' + 'a'.repeat(30) + '\n' + 'b'.repeat(30)])
    first.commit(batch)
    const receipts = JSON.parse(readFileSync(join(sessionDir, 'notices.json'), 'utf8'))
    expect(Object.keys(receipts)).toHaveLength(2)
    expect(Object.keys(receipts).every(id => id.startsWith('n:worker-restart:') && !id.includes(':chunk:'))).toBe(true)
    const changed = events.map(e => ({ ...e, text: e.text.repeat(2) }))
    const second = ledger(sessionDir)
    second.noticeEvents('worker-restart', 'Recovery', changed, 80)
    const remaining = second.open('hook')
    expect(second.notices(remaining, 80).map(n => n.text)).toEqual(['Recovery\n' + 'c'.repeat(60)])
    second.commit(remaining)
    const third = ledger(sessionDir)
    third.noticeEvents('worker-restart', 'Recovery', changed, 80)
    expect(third.noticeCount()).toBe(0)
    // A subsequent run or another recorded stop is a distinct event for the same worker.
    third.noticeEvents('worker-restart', 'Recovery', [
      { identity: 'w_a:2:100', text: 'new run' }, { identity: 'w_a:2:101', text: 'new stop' },
    ], 80)
    const newer = third.open('reply')
    expect(third.notices(newer).map(n => n.text)).toEqual(['Recovery\nnew run\nnew stop'])
    third.commit(newer)
  })

  it('keeps unconfirmed events owed and does not queue them twice under a changed presentation', () => {
    const sessionDir = join(dir, 'notice-events-retry')
    const events = [{ identity: 'w_a:1:100', text: 'clean' }, { identity: 'w_b:1:100', text: 'dirty' }]
    const first = ledger(sessionDir)
    first.noticeEvents('worker-restart', 'Recovery', events, 80)
    const abandoned = first.open('hook')
    expect(first.notices(abandoned)).toHaveLength(1)
    first.discard(abandoned)
    first.commit(abandoned)
    expect(existsSync(join(sessionDir, 'notices.json'))).toBe(false)
    first.noticeEvents('worker-restart', 'Recovery', events.map(e => ({ ...e, text: 'unknown' })), 20)
    expect(first.noticeCount()).toBe(1)
    const retry = first.open('reply')
    expect(first.notices(retry)).toHaveLength(1)
    first.commit(retry)
    const replacement = ledger(sessionDir)
    replacement.noticeEvents('worker-restart', 'Recovery', events, 80)
    expect(replacement.noticeCount()).toBe(0)
  })
})

/** Post a broadcast through a hub, as a client's `post` request does (hub §2.3). */
function post(hub: Hub, id: string): number {
  const conn = {}
  expect(hub.handle(conn, { v: 1, id: `h-${id}`, op: 'hello', proto: 1, schema: 2, client: 'test', sessionId: 'poster' }, { local: true })).toMatchObject({ ok: true })
  const grant = hub.handle(conn, { v: 1, id: `a-${id}`, op: 'acquire', name: 'quinn', holder: { sessionId: 'poster', pid: process.pid, startTime: '', executable: '' } }, { local: true }) as { ok: boolean; epoch: number }
  expect(grant).toMatchObject({ ok: true })
  const reply = hub.handle(conn, { v: 1, id: `p-${id}`, op: 'post', auto: true, lease: { name: 'quinn', epoch: grant.epoch }, msg: { id, type: 'note', priority: 'notify', from: 'quinn', text: id } }, { local: true }) as { ok: boolean; seq: number }
  expect(reply).toMatchObject({ ok: true })
  return reply.seq
}

describe('the seq frontier', () => {
  it('a hub restart: a broadcast from a higher incarnation orders after every earlier seq, even when the wall clock went back', async () => {
    const room = new RoomDoc()
    let max: number | undefined
    const store = serializedStore({ read: async () => max, write: async v => { max = v } })
    let wall = Date.now(), offset = 0
    const host = { doc: room, mono: () => performance.now() + offset, wall: () => wall, log: () => {}, store }
    const first = await startHub(host)
    offset += SETTLE_MS
    const before = post(first, 'm_before')
    const s = session(room), l = ledger()
    l.bind(s)
    expect(l.frontier(s)).toBe(before)
    first.stop()
    wall -= 3_600_000
    const second = await startHub(host)
    offset += SETTLE_MS
    expect(second.incarnation).toBeGreaterThan(first.incarnation)
    const after = post(second, 'm_after')
    expect(after).toBeGreaterThan(before)
    expect(ids(l.candidates(s))).toEqual(['m_after'])
    second.stop()
  })

  it('an MCP restart in the same host session keeps the frontier (cursor.json)', () => {
    const room = new RoomDoc(), sessionDir = join(dir, 'session-a')
    hubAppend(room, { name: 'quinn', kind: 'agent' }, { type: 'note', priority: 'notify', text: 'before' })
    const s = session(room)
    ledger(sessionDir).bind(s)
    const during = hubAppend(room, { name: 'quinn', kind: 'agent' }, { type: 'note', priority: 'notify', text: 'while the MCP restarted' })
    const restarted = ledger(sessionDir)
    restarted.bind(s)
    expect(ids(restarted.candidates(s))).toEqual([during.id])
    // A new session takes the highest seq at its own first bind.
    const fresh = ledger(join(dir, 'session-b'))
    fresh.bind(s)
    expect(fresh.frontier(s)).toBe(highestSeq(room))
    expect(fresh.candidates(s)).toEqual([])
  })

  it('defers delivery and cursor persistence until malformed launch evidence is repaired', async () => {
    const room = new RoomDoc(), lead = { name: 'lead', kind: 'agent' as const }
    hubAppend(room, lead, { type: 'note', priority: 'notify', text: 'old chatter' })
    const atIntent = highestSeq(room)
    const { record, registry } = await seedRegistryWorker(dir, 'blocked-cursor', { name: 'lead+blocked-cursor', room: 'r' })
    await mutateWorkerFixture(registry, record.id, old => ({ ...old, runs: [{ ...old.runs[0], busFrontier: atIntent }], seq: old.seq + 1 }))
    const briefing = hubAppend(room, lead, { type: 'note', priority: 'notify', text: 'between launch and bind' })
    const file = join(registry.root, 'workers', `${record.id}.json`), bytes = readFileSync(file)
    const reader = await openWorkerReader(dir)
    writeFileSync(file, '{malformed')
    vi.stubEnv('ROOM_WORKER_ID', record.id)
    vi.stubEnv('ROOM_WORKER_RUN', '1')
    const s = session(room, record.name), sessionDir = join(dir, 'blocked-cursor'), l = ledger(sessionDir)
    l.supplyWorkers(s, await reader.snapshot())
    l.bind(s)
    expect(l.candidates(s)).toEqual([])
    expect(l.select(s, l.open('reply'))).toEqual([])
    expect(existsSync(join(sessionDir, 'cursor.json'))).toBe(false)
    writeFileSync(file, bytes)
    l.supplyWorkers(s, await reader.snapshot())
    expect(l.frontier(s)).toBe(atIntent)
    expect(ids(l.candidates(s))).toEqual([briefing.id])
    const restarted = ledger(sessionDir)
    restarted.supplyWorkers(s, await reader.snapshot())
    restarted.bind(s)
    expect(ids(restarted.candidates(s))).toEqual([briefing.id])
  })

  it("a spawned worker seeds from its own run record's busFrontier: the lead's later briefing is owed, earlier chatter is not", async () => {
    const room = new RoomDoc()
    const lead = { name: 'lead', kind: 'agent' as const }
    hubAppend(room, lead, { type: 'note', priority: 'notify', text: 'old chatter' })
    const atIntent = highestSeq(room)
    const { record } = await seedRegistryWorker(dir, 'money', { name: 'lead+money' })
    await mutateWorkerFixture((await registryForDir(dir)), record.id, old => ({ ...old, runs: [{ ...old.runs[0], busFrontier: atIntent }], seq: old.seq + 1 }))
    const briefing = hubAppend(room, lead, { type: 'note', priority: 'notify', text: 'also mind the rounding' })
    hubAppend(room, { name: 'quinn', kind: 'agent' }, { type: 'note', priority: 'notify', text: 'after the worker bound' })
    vi.stubEnv('ROOM_WORKER_ID', record.id)
    vi.stubEnv('ROOM_WORKER_RUN', '1')
    const s = session(room, 'lead+money'), l = ledger()
    l.supplyWorkers(s, await (await registryForDir(dir)).snapshot())
    l.bind(s)
    expect(l.frontier(s)).toBe(atIntent)
    expect(ids(l.candidates(s))).toContain(briefing.id)
    expect(l.candidates(s).map(m => 'text' in m ? m.text : '')).not.toContain('old chatter')
    // Anyone else, or another participant's record, takes the highest seq at first bind.
    const someone = session(room, 'someone')
    expect(ledger().frontier(someone)).toBe(highestSeq(room))
  })
})

describe('addressed messages to a reused worker name (rc9 dogfood)', () => {
  const lead = { name: 'lead', kind: 'agent' as const }
  const text = (messages: readonly Msg[]) => messages.map(m => 'text' in m ? m.text : '')

  /** An earlier batch's lead+docs was told things it never read; then a new worker is spawned under the same tag. */
  async function reusedName(room: RoomDoc, tag: string) {
    hubAppend(room, lead, { type: 'answer', to: 'lead+docs', inReplyTo: 'q-old', text: 'old answer: update doctor-entry.test.ts' })
    const mailed = hubAppend(room, lead, { type: 'note', to: 'lead+docs', text: 'old note, trimmed to mail' })
    room.doc.transact(() => { room.bus.delete(room.bus.toArray().findIndex(m => m.id === mailed.id), 1); room.mail.set(mailed.id, mailed) })
    const atIntent = highestSeq(room)
    const { record } = await seedRegistryWorker(dir, tag, { name: 'lead+docs', room: 'r' })
    const registry = await registryForDir(dir)
    await mutateWorkerFixture(registry, record.id, old => ({ ...old, runs: [{ ...old.runs[0], busFrontier: atIntent }], seq: old.seq + 1 }))
    const briefing = hubAppend(room, lead, { type: 'note', to: 'lead+docs', text: 'new briefing' })
    return { record, registry, briefing }
  }

  it("a new worker under a reused name is not owed the earlier worker's addressed messages or mail", async () => {
    const room = new RoomDoc()
    const { record } = await reusedName(room, 'docs')
    vi.stubEnv('ROOM_WORKER_ID', record.id)
    vi.stubEnv('ROOM_WORKER_RUN', '1')
    const s = session(room, 'lead+docs'), l = ledger()
    l.supplyWorkers(s, await (await registryForDir(dir)).snapshot())
    l.bind(s)
    expect(text(l.candidates(s))).toEqual(['new briefing'])
  })

  it('a first worker after a migration (spawn frontier 0) is not owed unsequenced 0.16 mail to its name', async () => {
    const room = new RoomDoc()
    // Migrated 0.16 history carries no hub seq.
    room.doc.transact(() => room.bus.push([{ id: 'm-016', type: 'answer', from: 'lead', fromKind: 'agent', to: 'lead+docs', inReplyTo: 'q-old', text: 'old 0.16 answer', at: 1 } as Msg]))
    expect(highestSeq(room)).toBe(0)
    const { record } = await seedRegistryWorker(dir, 'docs-zero', { name: 'lead+docs', room: 'r' })
    const registry = await registryForDir(dir)
    await mutateWorkerFixture(registry, record.id, old => ({ ...old, runs: [{ ...old.runs[0], busFrontier: 0 }], seq: old.seq + 1 }))
    hubAppend(room, lead, { type: 'note', to: 'lead+docs', text: 'new briefing' })
    vi.stubEnv('ROOM_WORKER_ID', record.id)
    vi.stubEnv('ROOM_WORKER_RUN', '1')
    const s = session(room, 'lead+docs'), l = ledger()
    l.supplyWorkers(s, await (await registryForDir(dir)).snapshot())
    l.bind(s)
    expect(text(l.candidates(s))).toEqual(['new briefing'])
  })

  it('a resumed worker is still owed what was sent to it while it was stopped', async () => {
    const room = new RoomDoc()
    const { record, registry } = await reusedName(room, 'docs-resumed')
    const whileStopped = hubAppend(room, lead, { type: 'question', to: 'lead+docs', text: 'did the rename land?' })
    const run2 = highestSeq(room)
    await mutateWorkerFixture(registry, record.id, old => ({ ...old, runs: [...old.runs, { ...old.runs[0], n: 2, mode: 'resume', busFrontier: run2 }], seq: old.seq + 1 }))
    vi.stubEnv('ROOM_WORKER_ID', record.id)
    vi.stubEnv('ROOM_WORKER_RUN', '2')
    const s = session(room, 'lead+docs'), l = ledger()
    l.supplyWorkers(s, await (await registryForDir(dir)).snapshot())
    l.bind(s)
    expect(ids(l.candidates(s))).toContain(whileStopped.id)
    expect(text(l.candidates(s))).not.toContain('old answer: update doctor-entry.test.ts')
  })

  it('a lead or human session still gets mail sent while it was offline', async () => {
    const room = new RoomDoc()
    await reusedName(room, 'docs-lead')
    const s = session(room, 'lead+docs'), l = ledger() // no worker environment: not a spawned worker
    l.bind(s)
    expect(text(l.candidates(s))).toEqual(['old note, trimmed to mail', 'old answer: update doctor-entry.test.ts', 'new briefing'])
  })
})


describe('conflict state after a name is reused', () => {
  it('ends notices about a retired worker before a new session takes the addressed name, but delivers a live conflict', async () => {
    const room = new RoomDoc(), name = 'rohanz+claude'
    for (const who of [name, 'lead+retired', 'lead+live']) room.participants.set(`${who}\0id`, { name: who, kind: 'agent' })
    const post: Post = <T extends Msg>(from: Identity, body: PostBody<T>, opts?: { id?: string }) => {
      const msg = hubAppend<T>(room, from, body, opts)
      return Object.assign(Promise.resolve({ ok: true as const, msg, seq: msg.seq! }), { id: msg.id })
    }
    const slots = new ConflictSlots(room, post, '1')
    for (const other of ['lead+retired', 'lead+live']) {
      const claim = room.addClaim({ by: other, byKind: 'agent', path: 'x.ts', from: 1, to: 2, intent: 'edit' })
      await slots.settle(slotKey(name, 'edit-in-claim', other, 'x.ts', claim.id), {
        owner: name, other, kind: 'edit-in-claim', path: 'x.ts', subject: claim.id,
        status: 'conflict', inputs: other, factId: other,
      })
      await slots.settle(slotKey(name, 'merge', other, 'x.ts'), {
        owner: name, other, kind: 'merge', path: 'x.ts', status: 'conflict', inputs: other, factId: other,
      })
    }
    const stale = room.messages().filter(m => m.to === name && 'text' in m && m.text.includes('lead+retired'))
    expect(stale).toHaveLength(2)
    // One old notice has already rolled off the bus into mail.
    room.mail.set(stale[0].id, stale[0])
    room.bus.delete(room.messages().findIndex(m => m.id === stale[0].id), 1)
    room.retireWorker('w_old', { id: 'w_old', name: 'lead+retired', tag: 'retired', lead: 'lead', host: 'codex',
      task: 'old task', summary: 'done', files: [], fileCount: 0, startedAt: 1, finishedAt: 2, retiredAt: 3, outcome: 'clean' }, () => {})
    const s = session(room, name), l = ledger()
    l.bind(s)
    expect(l.candidates(s)).toHaveLength(2)
    expect(l.candidates(s).every(m => 'text' in m && m.text.includes('lead+live'))).toBe(true)
    trim(room, Date.now(), { conflictsReady: true })
    for (const m of stale) expect(room.outcomes.get(m.id)).toMatchObject({ to: name, outcome: 'expired' })
    expect(room.mail.has(stale[0].id)).toBe(false)
    expect(l.candidates(s)).toHaveLength(2)
  })
})


it('does not drop a conflict before its provider has finished syncing the subject', () => {
  const room = new RoomDoc(), s = session(room), l = ledger()
  const notice = hubAppend(room, { name: 'room', kind: 'agent' }, { type: 'conflict', to: 'pat', path: 'x', text: 'current conflict', claimId: 'not-yet-synced', otherClaimId: '' }, { id: 'cf:abc:1' })
  const provider = s.provider as unknown as { synced: boolean }
  provider.synced = false
  l.bind(s)
  expect(ids(l.candidates(s))).toEqual([notice.id])
  provider.synced = true
  expect(l.candidates(s)).toEqual([])
})
