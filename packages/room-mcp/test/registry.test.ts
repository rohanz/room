import { publishFixture } from './fixtures/manifest.js'
/**
 * The session registry: which of a process's rooms holds a participant, a question or a worker;
 * attachments start on add and stop on remove; worker ids stay distinct across a reused tag.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { RoomDoc } from '@room/shared'
import type { Identity } from '@room/shared'
import { Rooms } from '../src/registry.js'
import { WorkerRegistry } from '../src/worker-registry.js'
import { statusOf, type WorkerRecord } from '../src/worker-status.js'
import { completionMessage } from '@room/shared'
import type { Session } from '../src/session.js'
import { testPolicyStore } from './policy-fixture.js'
import { hubSeam } from './fixtures/hub.js'
import { hubAppend } from '@room/shared/testing'

/** No release notices to send here. */
const ignore = () => {}

let dir: string, base: string
const lead: Identity = { name: 'rohanz', kind: 'agent', owner: 'rohanz' }
const worker: Identity = { name: 'rohanz+money', kind: 'agent', owner: 'rohanz', label: 'money' }

function pair() {
  const a = new Y.Doc(), b = new Y.Doc()
  a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
  b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u))
  return { a: new RoomDoc(a), b: new RoomDoc(b) }
}
function fakeSession(room: RoomDoc, me: Identity, roomName = 'local/x/main'): Session {
  const awareness = new Awareness(room.doc)
  awareness.setLocalState({ user: { ...me, color: '#000' }, status: 'idle' })
  return {
    room, awareness, me, dir, roomUrl: `ws://127.0.0.1:1/${encodeURIComponent(roomName)}`, roomName, browserUrl: 'http://x',
    ...hubSeam(room), provider: { synced: true, awareness } as unknown as Session['provider'],
    daemon: { touch() {}, async stop() {}, dir, name: me.name, roomDoc: room, provider: null as never, branch: 'main', base } as never,
    shareMax: 'full', shareRequested: 'full', policyStore: testPolicyStore(),
  } as Session
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'room-registry-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 'rohanz')
  writeFileSync(join(dir, 'app.py'), 'x = 1\n')
  git('add', '.'); git('commit', '-qm', 'init')
  base = git('rev-parse', 'HEAD').trim()
})

function registry() {
  let primary: Session | null = null
  const events: string[] = []
  const rooms = new Rooms({
    primary: () => primary, setPrimary: s => { primary = s },
    listCwdProcesses: () => [],
    observeClaims: s => events.push(`observe ${s.roomName}`),
    attach: (s, role) => { events.push(`attach ${role} ${s.roomName}`); return { stop: () => events.push(`stop ${role} ${s.roomName}`), flush: async () => { events.push(`flush ${s.roomName}`) } } },
  })
  return { rooms, events, primary: () => primary }
}

describe('Rooms: sessions and attachments', () => {
  it('add sets the primary, starts attachments once, and remove stops them and clears the primary', () => {
    const r = registry()
    const team = fakeSession(pair().a, lead, 'github.com/rohanz/x/main')
    r.rooms.add(team, 'primary')
    r.rooms.add(team, 'primary') // idempotent
    expect(r.primary()).toBe(team)
    expect(r.events).toEqual(['observe github.com/rohanz/x/main', 'attach primary github.com/rohanz/x/main'])
    const local = fakeSession(pair().a, lead)
    r.rooms.add(local, 'workers', team)
    expect(r.rooms.workers()).toBe(local)
    expect(r.rooms.all()).toEqual([team, local])
    expect(r.rooms.byName('local/x/main')).toBe(local)
    expect(r.rooms.roleOf(local)).toBe('workers')
    r.rooms.remove(local)
    expect(r.rooms.workers()).toBeNull()
    r.rooms.remove(team)
    expect(r.primary()).toBeNull()
    expect(r.events.slice(2)).toEqual(['observe local/x/main', 'attach workers local/x/main', 'stop workers local/x/main', 'stop primary github.com/rohanz/x/main'])
  })

  it('a second session in the same role replaces the first, whose attachments stop; track observes claims only', () => {
    const r = registry()
    const first = fakeSession(pair().a, lead, 'github.com/rohanz/x/main'), second = fakeSession(pair().a, lead, 'github.com/rohanz/x/feature')
    r.rooms.add(first, 'primary'); r.rooms.add(second, 'primary')
    expect(r.primary()).toBe(second)
    expect(r.events).toContain('stop primary github.com/rohanz/x/main')
    const tracked = fakeSession(pair().a, lead, 'local/other/main')
    r.rooms.track(tracked); r.rooms.track(tracked)
    expect(r.events.filter(e => e === 'observe local/other/main')).toHaveLength(1)
    expect(r.events.some(e => e.startsWith('attach') && e.endsWith('local/other/main'))).toBe(false)
  })

  it('flush reaches every attachment', async () => {
    const r = registry()
    const team = fakeSession(pair().a, lead, 'github.com/rohanz/x/main'), local = fakeSession(pair().a, lead)
    r.rooms.add(team, 'primary'); r.rooms.add(local, 'workers', team)
    await r.rooms.flush()
    expect(r.events.filter(e => e.startsWith('flush'))).toEqual(['flush github.com/rohanz/x/main', 'flush local/x/main'])
  })
})

describe('Rooms: who lives where', () => {
  function twoRooms() {
    const r = registry()
    const team = pair(), local = pair()
    team.a.setMeta({ repo: 'x', branch: 'main', base }); local.a.setMeta({ repo: 'x', branch: 'main', base })
    const t = fakeSession(team.a, lead, 'github.com/rohanz/x/main'), l = fakeSession(local.a, lead)
    r.rooms.add(t, 'primary'); r.rooms.add(l, 'workers', t)
    return { ...r, team, local, t, l }
  }

  it('holding: presence or work wins over a worker record, and the caller\'s own name stays put', () => {
    const x = twoRooms()
    // a worker present only in the local room
    publishFixture(x.local.b, 'rohanz+money', 'app.py', 'x = 2\n')
    expect(x.rooms.holding('rohanz+money', x.t)).toBe(x.l)
    expect(x.rooms.holding('rohanz', x.t)).toBe(x.t)
    // the same tag recorded in both rooms but active in the team room: the team room wins
    x.team.a.setWorker({ id: 'rohanz/tiers#1', tag: 'tiers', name: 'rohanz+tiers', host: 'claude', task: 't', dir, branch: 'room/tiers', pid: 1, startedAt: 1, status: 'running', lead: 'rohanz', gen: 1 }, ignore)
    x.local.a.setWorker({ id: 'rohanz/tiers#1', tag: 'tiers', name: 'rohanz+tiers', host: 'claude', task: 'l', dir, branch: 'room/tiers', pid: 2, startedAt: 1, status: 'running', lead: 'rohanz', gen: 1 }, ignore)
    expect(x.rooms.holding('rohanz+tiers', x.t)).toBe(x.t) // record in the caller's room, nobody active anywhere
    publishFixture(x.local.b, 'rohanz+tiers', 'app.py', 'y = 1\n')
    expect(x.rooms.holding('rohanz+tiers', x.t)).toBe(x.l) // now active in the local room
    expect(x.rooms.holding('nobody', x.t)).toBe(x.t)
  })

  it('holdingQuestion finds the room whose bus carries the id', () => {
    const x = twoRooms()
    const q = hubAppend(x.local.b, worker, { type: 'question', to: 'rohanz', text: 'which base?' })
    expect(x.rooms.holdingQuestion(q.id, x.t)).toBe(x.l)
    expect(x.rooms.holdingQuestion('m_missing', x.t)).toBeUndefined()
  })
})

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const token = { pid: 100, startTime: 'born', executable: 'node', sessionId: 'lead', nonce: 'lead' }
function record(root: string, id: string, tag = 'money'): WorkerRecord {
  return {
    v: 1, id, tag, name: `rohanz+${tag}`, mode: 'local', room: 'local/x/main',
    lead: { participant: 'rohanz', room: 'local/x/main', instance: token }, host: 'codex',
    budget: { threads: 1, memGb: 1, nice: 10 }, share: 'full', task: 'test',
    dir: join(root, '.room', 'workers', tag), outside: false, branch: `room/${tag}`,
    prep: { step: 'prepared' }, capabilities: { resume: false, signal: false, collect: 'delta' }, phase: 'active',
    runs: [{ n: 1, mode: 'fresh', intentAt: 1, nonce: id, busFrontier: [], promptMsgIds: [],
      launcher: token, logStart: 0, launch: { outcome: 'launched', pid: 101 } }],
    createdAt: 1, seq: 1,
  }
}
function storeRoot(): string { const root = mkdtempSync(join(tmpdir(), 'room-registry-status-')); roots.push(root); return root }

describe('worker identity and durable exits', () => {
  it('keeps process handles keyed by worker id and room', () => {
    const r = registry(), t = fakeSession(pair().a, lead), l = fakeSession(pair().a, lead)
    const first = { pid: 1, onExit() {}, kill: () => true }
    const later = { pid: 2, onExit() {}, kill: () => true }
    r.rooms.setHandle(t, 'w_first', first); r.rooms.setHandle(l, 'w_later', later)
    expect(r.rooms.handle(t, 'w_first')).toBe(first)
    expect(r.rooms.handle(l, 'w_later')).toBe(later)
    r.rooms.dropHandle(t, 'w_first', later)
    expect(r.rooms.handle(t, 'w_first')).toBe(first)
    r.rooms.dropHandle(t, 'w_first', first)
    expect(r.rooms.handle(t, 'w_first')).toBeUndefined()
  })

  it('reuses a tag only after retirement, with a fresh id; an old exit does not alter the new run', async () => {
    const root = storeRoot(), store = await WorkerRegistry.open(root, { migrate: false, watch: false,
      identity: token, liveness: () => 'alive' })
    const first = record(root, 'w_first'), next = record(root, 'w_next')
    await store.writeIntent({ ...first, phase: 'intent', runs: [{ ...first.runs[0], launch: undefined }] })
    await store.update(first.id, old => ({ ...old, phase: 'retired', cleanup: { [old.room]: 'done' }, seq: old.seq + 1 }))
    await store.writeIntent({ ...next, phase: 'intent', runs: [{ ...next.runs[0], launch: undefined }] })
    await store.update(next.id, old => ({ ...old, phase: 'active', runs: next.runs, seq: old.seq + 1 }))
    await store.writeExit(first.id, { run: 1, code: 1, at: 10, witnessed: true })
    expect(store.read(next.id)?.id).toBe('w_next')
    expect(store.status(next.id)?.status).toBe('running')
    store.close()
  })

  it('records an unwitnessed exit with unknown cause and no death interrupt', async () => {
    const root = storeRoot(), store = await WorkerRegistry.open(root, { migrate: false, watch: false,
      identity: token, liveness: () => 'dead' })
    const w = record(root, 'w_dead')
    await store.writeIntent({ ...w, phase: 'intent', runs: [{ ...w.runs[0], launch: undefined }] })
    await store.update(w.id, old => ({ ...old, phase: 'active', runs: w.runs, seq: old.seq + 1 }))
    await store.writeExit(w.id, { run: 1, code: null, at: 10, witnessed: false })
    expect(store.status(w.id)).toMatchObject({ status: 'failed', note: 'stopped while no session of yours was running' })
    expect(await store.postObservedFailure(w.id, 1, () => { throw new Error('false alarm') })).toBe(false)
    store.close()
  })

  it('keeps an identity-matched live process running; marks its witnessed exit failed after death', () => {
    const root = storeRoot(), w = record(root, 'w_pid')
    w.runs[0].launch = { outcome: 'launched', pid: 101,
      process: { pid: 101, startTime: 'born', executable: 'codex' } }
    const exit = [{ run: 1, code: 1, at: 10, witnessed: true }]
    expect(statusOf(w, w.runs, [], exit, () => 'alive').status).toBe('running')
    expect(statusOf(w, w.runs, [], exit, () => 'dead')).toMatchObject({ status: 'failed', exitCode: 1 })
  })

  it.each(['lead-session-ended', 'discarded'] as const)('an intentional %s stop has no death message', reason => {
    const root = storeRoot(), w = record(root, 'w_stopped')
    w.stop = { reason, at: 2, run: 1 }
    const status = statusOf(w, w.runs, [], [{ run: 1, code: null, at: 3, witnessed: true }], () => 'dead')
    expect(status.status).toBe('stopped')
    expect(completionMessage(w, w.runs[0], status)).toBeUndefined()
  })

  it.each([0, 1, null] as const)('a witnessed exit %s without room_done produces a failure interrupt', code => {
    const root = storeRoot(), w = record(root, 'w_exit')
    const status = statusOf(w, w.runs, [], [{ run: 1, code, at: 10, witnessed: true }], () => 'dead')
    expect(status.status).toBe('failed')
    const message = completionMessage(w, w.runs[0], status)
    expect(message?.id).toBe('wk:w_exit:1')
    expect(message?.body.type).toBe('note')
    expect(message?.body.priority).toBe('interrupt')
  })

  it('keeps a reported completion and its host session for explicit collection', () => {
    const root = storeRoot(), w = record(root, 'w_retained', 'review')
    w.hostSessionId = '550e8400-e29b-41d4-a716-446655440000'
    w.capabilities.resume = true
    const report = [{ run: 1, nonce: w.runs[0].nonce, chain: [], joinedAt: 2,
      done: { at: 3, summary: 'finished', changed: ['app.py'] } }]
    const status = statusOf(w, w.runs, report, [{ run: 1, code: 0, at: 4, witnessed: true }], () => 'dead')
    expect(status).toMatchObject({ status: 'done', summary: 'finished' })
    expect(w.hostSessionId).toBe('550e8400-e29b-41d4-a716-446655440000')
  })
})
